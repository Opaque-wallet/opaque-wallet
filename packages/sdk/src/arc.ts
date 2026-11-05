// Arc, from Node: the wallet page's runtime (frontend/src/lib/runtime.ts) with
// its keys in the wallet file and its proofs on a worker thread, and the
// page's flows (deposit, send, deployers, contracts, swaps) without the page.

import type { IntentStatus, NoteSummary, PrivacyScore, StatusHandle, TxHash, UnixSeconds } from '@opaque/protocol-types';

import { deployment, type SwapToken } from '../../../deployments/index.ts';
import { addressOfKey, arcState, deployerKey, saveArcState } from '../../../frontend/src/lib/arc-keys.ts';
import { asHexBytes, CREATE2_FACTORY, deployment as deployCall, MAX_INITCODE, newSalt, riskOfCall } from '../../../frontend/src/lib/contracts.ts';
import { paymentDeadline } from '../../../frontend/src/lib/payment-deadline.ts';
import { runPaymentLanes } from '../../../frontend/src/lib/payment-lanes.ts';
import { makeAmount, MAX_NOTES_PER_DEPOSIT } from '../../../frontend/src/lib/protocol/index.ts';
import { startWallet, type WalletRuntime } from '../../../frontend/src/lib/runtime.ts';
import { oneOperationAtATime } from '../../../backend/chain/pq-wallet-chain.ts';
import type { SwapQuote } from '../../../backend/chain/wallet-rpc.ts';
import type { AccountKeys } from '../../../frontend/src/lib/wallet-keys.ts';
import { FileKeyStore } from './keys.ts';
import { nodeProver } from './prover.ts';
import type { FileStore } from './store.ts';

// The page's numbers (frontend/src/app.ts), so both behave alike.
const RING_SIZE = 8;
/** USDC a deposit leaves in the account for its gas; what is over pays the next one. */
const DEPOSIT_GAS_USDC = 0.2;
/** A payment that waits for privacy settles when the mesh reaches this score. */
const MIN_FRESHNESS = 70;
const LANES = 4;

export type Hex = `0x${string}`;
export interface ArcBalance {
  /** USDC in private notes. */
  readonly private: number;
  /** Of those, notes whose pool doesn't hold a full ring yet: they wait for other deposits. */
  readonly waiting: number;
  readonly notes: number;
  /** USDC at the account's public address: what a deposit draws from, and what pays gas. */
  readonly public: number;
}
export interface ArcPayment { readonly handle: string; readonly usdc: number }
export interface Deployer { readonly index: number; readonly address: Hex; readonly key: Hex }
export interface SendOptions {
  /** Hold each payment until the pool's privacy is high, settling by `deadline`. Default: settle on arrival. */
  readonly waitForPrivacy?: boolean;
  readonly deadline?: Date;
}
interface Sent { readonly handle: string; readonly recipient: string; readonly at: number; readonly group: string; readonly usdc: number }

export type ArcClient = Awaited<ReturnType<typeof openArc>>;

/** What the account's key has left, and why it couldn't rotate if it tried. */
export interface KeyStatus { readonly left: number; readonly max: number; readonly rotationError?: string }
interface KeyedApp {
  walletState(): Promise<{ readonly active: boolean; readonly maxUses: bigint; readonly localSigningReservations: bigint; readonly pkCommitment: string }>;
  rotateWallet(): Promise<unknown>;
}

/**
 * Rotates the account's few-time key once a quarter of its signatures are
 * left, as the page does (app.ts autoRotate), before an operation signs. At
 * most ONCE per open: a rotation spends one of the two signatures held back
 * for it whether or not it lands, and a retry loop would spend the other.
 * A failure is kept for keyStatus(); the operation goes on with what is left.
 * One look at a time: two operations starting together would each find the
 * key low and each rotate it (F-59), and the second waits for the first's
 * rotation rather than sign with the key it replaces.
 */
export function keyKeeper(app: KeyedApp, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  let tried = false;
  let rotationError: string | undefined;
  let looking: Promise<void> = Promise.resolve();
  const status = async (): Promise<KeyStatus> => {
    const s = await app.walletState();
    const max = Number(s.maxUses);
    return { left: Math.max(0, max - Number(s.localSigningReservations)), max, ...(rotationError === undefined ? {} : { rotationError }) };
  };
  async function look(): Promise<void> {
    if (tried) return;
    const s = await app.walletState();
    const { left, max } = await status();
    if (!s.active || left > Math.ceil(max / 4)) return;
    tried = true;
    try {
      await app.rotateWallet();
      for (let i = 0; i < 10 && (await app.walletState()).pkCommitment === s.pkCommitment; i++) await wait(2_000);
    } catch (error) {
      rotationError = (error as Error).message;
    }
  }
  return {
    status,
    fresh: (): Promise<void> => (looking = looking.then(look, look)),
  };
}

export async function openArc(store: FileStore, account: AccountKeys,
  begin = (): Promise<WalletRuntime> => startWallet(undefined, account, { keys: (name) => new FileKeyStore(store, name), prover: nodeProver })) {
  const rt = await begin();
  // One that fails to open leaves nothing running: opened again, it starts afresh (F-62).
  try { return await clientOf(rt, account); } catch (error) { await rt.close(); throw error; }
}

async function clientOf(rt: WalletRuntime, account: AccountKeys) {
  await rt.open();
  // The first time this wallet opens the account: the notes it already holds, found on chain, as the page does.
  if (arcState().scanned?.[account.id] !== true) await rt.recover(true);
  const address = (await rt.app.walletState()).accountAddress as Hex;
  const usdcOf = (n: NoteSummary) => Number(n.scope.denomination) / 1e6;
  const tokenOf = (symbol: string): SwapToken => {
    const token = deployment.swap.tokens.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase());
    if (token === undefined) throw new Error(`no swap token ${symbol} on ${deployment.network.displayName}: ${deployment.swap.tokens.map((t) => t.symbol).join(', ')}`);
    return token;
  };
  /** Deposits in each pool; a read that fails counts as a full ring, as on the page. */
  const poolSizes = async () => new Map(await Promise.all(rt.scopes.map(async (s) =>
    [s.pool as string, await rt.readRing(s).then((r) => r.candidates.length, () => RING_SIZE)] as const)));
  const listNotes = async () => (await Promise.all(rt.scopes.map((s) => rt.app.listNotes(s)))).flat();
  const sent = (): Sent[] => JSON.parse(localStorage.getItem(rt.sentKey) ?? '[]') as Sent[];
  // A rotation waits for the account's operation under way, and the next waits for it.
  const key = keyKeeper({ walletState: () => rt.app.walletState(), rotateWallet: () => oneOperationAtATime(address as never, () => rt.app.rotateWallet()) } as unknown as KeyedApp);
  const names = Object.fromEntries([...deployment.swap.tokens.map((t) => [t.address.toLowerCase(), t.symbol]), [deployment.tokens.usdc.address.toLowerCase(), 'USDC']]);
  /** Notes a payment under way has taken: another, alongside it, takes others (F-55). */
  const spending = new Set<string>();
  /**
   * The notes `usdc` would spend (undefined if the spendable ones can't make it
   * exactly), and what is spendable. `take`: taken for this payment, with
   * nothing awaited since they were chosen; send() gives them back.
   */
  async function plan(usdc: number, take = false): Promise<{ readonly queue: NoteSummary[] | undefined; readonly spendable: number }> {
    const [notes, sizes] = await Promise.all([listNotes(), poolSizes()]);
    const ready = notes.filter((n) => n.state === 'AVAILABLE' && !spending.has(n.id) && (sizes.get(n.scope.pool) ?? RING_SIZE) >= RING_SIZE);
    const have = new Map<number, number>();
    for (const n of ready) have.set(usdcOf(n), (have.get(usdcOf(n)) ?? 0) + 1);
    const pick = makeAmount(usdc, rt.scopes.map((s) => Number(s.denomination) / 1e6), have);
    const queue = pick && [...pick].flatMap(([size, n]) => ready.filter((note) => usdcOf(note) === size).slice(0, n));
    if (take) for (const n of queue ?? []) spending.add(n.id);
    return { queue, spendable: ready.reduce((t, n) => t + usdcOf(n), 0) };
  }

  const arc = {
    network: deployment.network.displayName,
    /** The account's public address: send USDC here, then deposit it. */
    address,

    async balance(): Promise<ArcBalance> {
      const [notes, sizes, funds] = await Promise.all([listNotes(), poolSizes(), rt.accountFunds(address)]);
      const available = notes.filter((n) => n.state === 'AVAILABLE');
      const sum = (list: readonly NoteSummary[]) => list.reduce((t, n) => t + usdcOf(n), 0);
      return {
        private: sum(available),
        waiting: sum(available.filter((n) => (sizes.get(n.scope.pool) ?? RING_SIZE) < RING_SIZE)),
        notes: available.length,
        public: funds.usdc,
      };
    },

    /** Turns `usdc` (whole) of the address's USDC into private notes, in one operation the PQ key signs. */
    async deposit(usdc: number): Promise<{ readonly notes: Readonly<Record<number, number>>; readonly pending: number }> {
      if (!Number.isInteger(usdc) || usdc < 1) throw new Error('deposit a whole amount of USDC, 1 or more');
      const have = (await rt.accountFunds(address)).usdc;
      if (have < usdc + DEPOSIT_GAS_USDC) {
        throw new Error(`the address holds ${have.toFixed(2)} USDC; ${usdc} USDC of notes and gas needs ${(usdc + DEPOSIT_GAS_USDC).toFixed(2)}. Send USDC to ${address}`);
      }
      // Only sizes whose pool holds a ring already, so every note can be sent at once; 1 USDC always.
      const sizes = await poolSizes();
      const ready = rt.scopes.filter((s) => Number(s.denomination) === 1_000_000 || (sizes.get(s.pool) ?? 0) >= RING_SIZE).map((s) => Number(s.denomination) / 1e6);
      const counts = makeAmount(usdc, ready)!;
      const count = [...counts.values()].reduce((a, b) => a + b, 0);
      if (count > MAX_NOTES_PER_DEPOSIT) throw new Error(`${usdc} USDC is ${count} notes; one deposit holds up to ${MAX_NOTES_PER_DEPOSIT}. Deposit it in parts`);
      // Notes are drawn from the account key: catch up with any another host made, so no index is used twice.
      await rt.recover(false);
      await key.fresh();
      const made = await rt.app.depositNotes(rt.scopes
        .filter((s) => counts.has(Number(s.denomination) / 1e6))
        .map((s) => ({ scope: s, count: counts.get(Number(s.denomination) / 1e6)! })));
      return { notes: Object.fromEntries(counts), pending: made.filter((n) => n.state !== 'AVAILABLE').length };
    },

    /**
     * Pays `usdc` (whole) to `to` from private notes, each note its own payment
     * with its own proof, across the mesh. Returns a handle per note: status()
     * says when each settles.
     */
    async send(to: string, usdc: number, options: SendOptions = {}): Promise<readonly ArcPayment[]> {
      const recipient = to.trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(recipient)) throw new Error('the recipient is an address: 0x and 40 hex digits');
      if (!Number.isInteger(usdc) || usdc < 1) throw new Error('send a whole amount of USDC, 1 or more');
      const waitForPrivacy = options.waitForPrivacy === true;
      const deadline = () => paymentDeadline({ waitForPrivacy, nowMs: Date.now(), ...(options.deadline ? { selectedMs: options.deadline.getTime() } : {}) }) as UnixSeconds;
      deadline(); // a past or missing deadline fails here, before anything is spent
      const { queue, spendable } = await plan(usdc, true);
      if (queue === undefined) throw new Error(`the spendable notes (${spendable} USDC) can't make exactly ${usdc} USDC: each is sent whole, with no change`);
      try {
        // Before paying, out of band: the authority learns a recipient, never a payment.
        const credentialHandle = await rt.obtainCredential(recipient as Hex);
        const group = `send-${Date.now()}`;
        const payments: ArcPayment[] = [];
        const results = await runPaymentLanes(queue, LANES, async (note) => {
          const ref = await rt.app.submitPayment({
            noteId: note.id, recipient: recipient as never,
            minPrivacyScore: (waitForPrivacy ? MIN_FRESHNESS * 100 : 0) as PrivacyScore,
            deadline: deadline(), credentialHandle,
            idempotencyKey: `pay-${note.id}-${Date.now()}` as never,
          });
          const payment = { handle: ref.statusHandle as string, usdc: usdcOf(note) };
          payments.push(payment);
          localStorage.setItem(rt.sentKey, JSON.stringify([{ ...payment, recipient, at: Date.now(), group }, ...sent()]));
        });
        const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed.length > 0) {
          const why = (failed[0]!.reason as Error).message;
          if (payments.length === 0) throw new Error(`not sent: ${why}`);
          throw Object.assign(new Error(`sent ${payments.length} of ${queue.length} notes; the rest failed: ${why}`), { payments });
        }
        return payments;
      } finally {
        for (const n of queue) spending.delete(n.id);
      }
    },

    /** Looks on chain for every note of the account: ones another host made, say. Returns how many were new. */
    rescan: (): Promise<number> => rt.recover(true),
    /** Whether the spendable notes make exactly `usdc`: a payment that can't is refused before anything is spent. */
    canPay: async (usdc: number): Promise<boolean> => Number.isInteger(usdc) && usdc >= 1 && (await plan(usdc)).queue !== undefined,
    /** The key's signatures left, and a rotation's failure if one failed. */
    keyStatus: (): Promise<KeyStatus> => key.status(),
    /** Where a payment is: PENDING until the pool settles it, then SETTLED (or why not). */
    status: (handle: string): Promise<IntentStatus> => rt.readStatus(handle as StatusHandle),
    /** Payments this wallet has sent, newest first. */
    activity: (): readonly Sent[] => sent(),

    /** Everything the address holds, less this operation's gas, to `to`. Public, like a deposit. */
    withdraw: async (to: Hex): Promise<TxHash> => { await key.fresh(); return rt.withdraw(address, to); },

    /**
     * The account's i-th deployer: an ordinary Arc key, for forge or hardhat.
     * Fund it with fundDeployer: the pool pays it, so nothing on chain ties it
     * to this account. One per project; a deployer used twice links what it deployed.
     */
    deployer(index: number): Deployer {
      if (!Number.isInteger(index) || index < 0) throw new Error('a deployer is numbered 0, 1, 2…');
      const key = deployerKey(account, index);
      return { index, address: addressOfKey(key), key };
    },
    /** A deployer nothing has used, here or on another host. */
    async nextDeployer(): Promise<Deployer> {
      let i = arcState().deployers?.[account.id] ?? 0;
      while (await rt.inUse(arc.deployer(i).address)) i++;
      saveArcState({ deployers: { ...arcState().deployers, [account.id]: i + 1 } });
      return arc.deployer(i);
    },
    /** A private payment to a deployer. */
    fundDeployer: (index: number, usdc: number, options?: SendOptions) => arc.send(arc.deployer(index).address, usdc, options),
    /** USDC at any address, read through the mesh: a deployer's, say. */
    fundsAt: async (at: Hex): Promise<number> => (await rt.accountFunds(at)).usdc,

    /**
     * Deploys `initcode` from the account, through the CREATE2 factory: signed
     * by its post-quantum key, gas from its USDC. The address is known before
     * it is sent; the same salt and code land at the same place on every chain.
     */
    async deploy(initcode: string, salt: Hex = newSalt()): Promise<{ readonly address: Hex; readonly tx: TxHash }> {
      if (CREATE2_FACTORY === null) throw new Error(`contracts can't be deployed on ${deployment.network.displayName} yet`);
      const { call, address: at } = deployCall(asHexBytes(salt, 'salt', 32), asHexBytes(initcode, 'bytecode', MAX_INITCODE));
      await key.fresh();
      return { address: at, tx: await rt.execute(address, [call]) };
    },
    /** What a call would do with the account's tokens, in words, or null if it hands nothing over. Read from the bytes call() would sign. */
    riskOf: (to: Hex, data: string): string | null => riskOfCall(to, asHexBytes(data, 'calldata', MAX_INITCODE), names),
    /** Calls a contract from the account. One that hands its tokens over is refused unless `allowRisk`. */
    async call(to: Hex, data: string, options: { readonly allowRisk?: boolean } = {}): Promise<TxHash> {
      if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('the contract is an address: 0x and 40 hex digits');
      const calldata = asHexBytes(data, 'calldata', MAX_INITCODE);
      if (calldata.length < 10) throw new Error('calldata starts with a 4-byte function selector');
      const risk = arc.riskOf(to, calldata);
      if (risk !== null && options.allowRisk !== true) throw new Error(`${risk} Pass { allowRisk: true } to sign it anyway.`);
      await key.fresh();
      return rt.execute(address, [{ to, data: calldata }]);
    },

    /** What the account can swap between, with each token's decimals. */
    swapTokens: deployment.swap.tokens as readonly SwapToken[],
    /** Each swap token at the address, in its smallest units. */
    tokens: (): Promise<Record<string, bigint>> => rt.tokenBalances(address),
    /** LI.FI's route for `amount` (smallest units) of `from` into `to`, asked through the mesh and checked. */
    swapQuote: (from: string, to: string, amount: bigint): Promise<SwapQuote> => rt.swapQuote(address, tokenOf(from), tokenOf(to), amount),
    /** The quoted swap, signed by the PQ key: approve exactly `amount`, the call, then the approval back to 0. */
    swap: async (from: string, to: string, amount: bigint, quote: SwapQuote): Promise<TxHash> => { await key.fresh(); return rt.swap(address, tokenOf(from), tokenOf(to), amount, quote); },

    /** Stops what this client started: its relays' poll and its prover's thread. */
    close: (): Promise<void> => rt.close(),
  };
  return arc;
}
