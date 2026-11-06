// Post-quantum stealth payments in the wallet (backend/chain/stealth.ts holds the scheme).
//
// Receiving: this account's ML-KEM-768 key, drawn from its phrase and published once in
// ERC-6538's registry. Announcements are read across the mesh a page at a time; each one
// this key opens is a payment at a one-time PQ account, swept into this wallet's notes
// once it holds USDC. Only announcements are kept here, never a secret: the key that
// opened one opens it again.
//
// Paying: a payee with a meta-address is paid at a fresh address, announced by the
// exit, so neither the payer's account nor the payee's appears beside it.

import { ARC_AUTHORITY, createPqAccountOps, livePqWalletOptions, pendingDeployment } from '../../../backend/chain/pq-wallet-chain.ts';
import { META_REGISTRY, openAnnouncement, registerCall, SCHEME_ID, stealthKeys, stealthPayment, type Announcement, type StealthAccount } from '../../../backend/chain/stealth.ts';
import { browserPayer, type DepositMany } from '../../../backend/chain/wallet-chain.ts';
import { ethBalance, readOne, STEALTH_GAS_WEI, stealthCall, type WalletRpcSend } from '../../../backend/chain/wallet-rpc.ts';
import { deployment } from '../../../deployments/index.ts';
import { createPqWallet } from '../../../packages/pq-wallet/src/wallet.ts';
import { stealthSeed } from './arc-keys.ts';
import type { RestorableSignerStore } from '../../../packages/pq-wallet/src/signer-state.ts';
import type { WalletStateStore } from '../../../packages/pq-wallet/src/wallet-state.ts';
import type { AccountKeys } from './wallet-keys.ts';

type Address = `0x${string}`;
type Hex = `0x${string}`;

/** A payment this key opened: its announcement, and how far it got. */
export interface StealthPayment extends Announcement {
  readonly block: number;
  /** waiting: announced, nothing swept yet; swept: in this wallet's notes. */
  readonly state: 'waiting' | 'swept';
  readonly sweptTx?: string;
  readonly usdc?: number;
}

export interface Stealth {
  /** This account's ML-KEM-768 encapsulation key, as published. */
  readonly metaAddress: Hex;
  /** Whether the registry holds this account's meta-address. */
  isOn(account: Address): Promise<boolean>;
  /** The registry call that turns it on, made by the account. */
  readonly turnOnCall: { readonly to: Address; readonly data: Hex };
  /**
   * A fresh address for `recipient`, announced, if it receives privately;
   * undefined if it publishes no meta-address.
   */
  addressFor(recipient: Address): Promise<Address | undefined>;
  /** Reads announcements not read yet; returns every payment found so far. */
  scan(): Promise<readonly StealthPayment[]>;
  payments(): readonly StealthPayment[];
  /** Whole USDC at a found address now. */
  held(payment: StealthPayment): Promise<number>;
  /** That USDC into this wallet's notes: gas from the exit, then one operation the found account's key signs. */
  sweep(payment: StealthPayment, deposit: (depositMany: DepositMany) => Promise<unknown>): Promise<string>;
}

interface Saved { readonly cursor?: { readonly fromBlock: string; readonly skip: number }; readonly found: StealthPayment[] }

export function createStealth(deps: {
  readonly account: AccountKeys;
  readonly walletRpc: WalletRpcSend;
  readonly keys: RestorableSignerStore & WalletStateStore;
  readonly publicClient: Parameters<typeof livePqWalletOptions>[0]['publicClient'];
  readonly storageKey: string;
}): Stealth {
  const { walletRpc } = deps;
  const { metaAddress, secretKey } = stealthKeys(stealthSeed(deps.account));
  const load = (): Saved => { try { return JSON.parse(localStorage.getItem(deps.storageKey) ?? '{"found":[]}') as Saved; } catch { return { found: [] }; } };
  const save = (s: Saved) => localStorage.setItem(deps.storageKey, JSON.stringify(s));
  const update = (address: string, change: Partial<StealthPayment>) => {
    const s = load();
    save({ ...s, found: s.found.map((p) => p.stealthAddress === address ? { ...p, ...change } : p) });
  };
  const accountOf = (p: StealthPayment): StealthAccount => {
    const found = openAnnouncement(secretKey, p);
    if (found === undefined) throw new Error('that announcement is not this wallet\'s');
    return found;
  };
  const usdcAt = async (address: Address) => (await readOne(walletRpc, deployment.tokens.usdc.address as never, 'balanceOf', [address])).value as bigint;

  /** The found account as a wallet of its own: its keys from the shared secret, kept in this browser's store. */
  async function opsOf(found: StealthAccount) {
    const walletId = `stealth:${found.address}`;
    const wallet = createPqWallet(livePqWalletOptions({
      signerStore: deps.keys, walletStore: deps.keys, publicClient: deps.publicClient, payer: browserPayer(undefined), walletRpc,
      walletId, seedFor: found.seedFor,
    }));
    // The getState inside reads the chain: an account the sender already took over fails here, unsigned.
    const state = await wallet.create();
    if (state.accountAddress.toLowerCase() !== found.address) throw new Error('these keys make a different account');
    return createPqAccountOps({ wallet, account: found.address as never, authority: ARC_AUTHORITY, walletRpc, deployment: () => pendingDeployment(wallet, deps.keys, walletId) });
  }

  return {
    metaAddress,
    turnOnCall: registerCall(metaAddress) as { to: Address; data: Hex },
    async isOn(account) {
      const held = (await readOne(walletRpc, META_REGISTRY, 'stealthMetaAddressOf', [account, SCHEME_ID])).value as Hex;
      return held.toLowerCase() === metaAddress.toLowerCase();
    },
    async addressFor(recipient) {
      const meta = (await readOne(walletRpc, META_REGISTRY, 'stealthMetaAddressOf', [recipient, SCHEME_ID])).value as Hex;
      if (meta === '0x') return undefined;
      const paid = stealthPayment(meta);
      // Announced before paying: a payment nobody announced is one its payee never finds.
      await stealthCall(walletRpc, { action: 'announce', stealthAddress: paid.address, ephemeralPubKey: paid.ephemeralPubKey, metadata: paid.metadata });
      return paid.address;
    },
    async scan() {
      let s = load();
      let cursor = s.cursor ?? { fromBlock: String(deployment.stealth!.fromBlock), skip: 0 };
      // ponytail: 50 pages a call (500k blocks or 400 announcements); the next scan goes on from there.
      for (let page = 0; page < 50; page++) {
        const r = await stealthCall(walletRpc, { action: 'scan', ...cursor }) as {
          announcements: (Announcement & { blockNumber: string })[]; next: { fromBlock: string; skip: number }; done: boolean };
        const known = new Set(s.found.map((p) => p.stealthAddress));
        const mine = r.announcements.filter((a) => !known.has(a.stealthAddress) && openAnnouncement(secretKey, a) !== undefined)
          .map((a): StealthPayment => ({ stealthAddress: a.stealthAddress, ephemeralPubKey: a.ephemeralPubKey, metadata: a.metadata, block: Number(a.blockNumber), state: 'waiting' }));
        cursor = r.next;
        s = { cursor, found: [...s.found, ...mine] };
        save(s);
        if (r.done) break;
      }
      return s.found;
    },
    payments: () => load().found,
    held: async (p) => Number((await usdcAt(p.stealthAddress)) / 10n ** BigInt(deployment.tokens.usdc.decimals)),
    async sweep(p, deposit) {
      const found = accountOf(p);
      const ops = await opsOf(found);
      const address = found.address as Address;
      if ((await ethBalance(walletRpc, address as never)) < STEALTH_GAS_WEI) {
        // From the exit: ETH from this wallet's own account would tie the two together.
        await stealthCall(walletRpc, { action: 'gas', account: address });
        for (let i = 0; i < 30 && (await ethBalance(walletRpc, address as never)) === 0n; i++) await new Promise((r) => setTimeout(r, 4_000));
      }
      const usdc = Number(await usdcAt(address)) / 10 ** deployment.tokens.usdc.decimals;
      let tx = '';
      await deposit(async (groups) => (tx = await ops.deposit(groups)));
      update(p.stealthAddress, { state: 'swept', sweptTx: tx, usdc });
      return tx;
    },
  };
}
