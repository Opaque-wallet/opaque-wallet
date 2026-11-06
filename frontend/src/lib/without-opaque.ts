// Opaque without Opaque: a note leaves its pool with nothing of Opaque's in the path.
//
// Normally every read and UserOperation crosses Opaque's relay mesh to Opaque's exit,
// and a private payment needs Opaque's attester and settler. If those are gone (or
// refuse someone), a note in an exitable pool still leaves (backend/chain/ring-exit.ts):
// two UserOperations the account's own FORS+C key signs, sent to the public bundler,
// with reads from a public RPC; every request through EF's anon-rpc, so neither learns
// who asks. The answerer that builds and relays the operations is the same code
// Opaque's exit runs (backend/chain/wallet-rpc.ts), here in the browser.
//
// What it costs: that note's privacy (its secret becomes public), and gas in the
// account's own ETH. What it needs: this browser's keys and notes, and Ethereum.

import { deriveNullifier } from '@opaque/zk';

import { ARC_AUTHORITY, createPqAccountOps, livePqWalletOptions, pendingDeployment } from '../../../backend/chain/pq-wallet-chain.ts';
import { exitablePools, exitClient, ringExit, type ExitPool } from '../../../backend/chain/ring-exit.ts';
import { browserPayer } from '../../../backend/chain/wallet-chain.ts';
import { createWalletRpcAnswerer } from '../../../backend/chain/wallet-rpc.ts';
import { adoptWallet, createPqWallet } from '../../../packages/pq-wallet/src/wallet.ts';
import { anonFetch } from './anon-rpc.ts';
import { arcStorageOf, forsSeed } from './arc-keys.ts';
import { keyStoreName } from './backup.ts';
import { SealedSignerStore } from './lock.ts';
import { localNoteStorage } from './note-storage.ts';
import type { AccountKeys } from './wallet-keys.ts';

type Hex = `0x${string}`;

export interface ExitNote {
  readonly id: string;
  readonly pool: ExitPool;
  readonly commitment: Hex;
  readonly nullifier: Hex;
  /** held: not announced; waiting: announced, pays at `payableAt`; payable; spent. */
  readonly state: 'held' | 'waiting' | 'payable' | 'spent';
  readonly payableAt?: number;
}

export interface WithoutOpaque {
  notes(): Promise<readonly ExitNote[]>;
  announce(note: ExitNote): Promise<string>;
  withdraw(note: ExitNote): Promise<string>;
  ethBalance(): Promise<bigint>;
}

const bytesOf = (hex: string) => Uint8Array.from((hex.slice(2).match(/../g) ?? []).map((b) => parseInt(b, 16)));

/** `address`'s exits, through anon-rpc: none of Opaque's servers is asked anything. */
export async function withoutOpaque(account: AccountKeys, address: Hex): Promise<WithoutOpaque> {
  const fetchFn = anonFetch();
  const client = exitClient(fetchFn);
  const walletRpc = createWalletRpcAnswerer({
    publicClient: client, bundlerUrl: ARC_AUTHORITY.bundlerUrl, entryPoint: ARC_AUTHORITY.entryPoint,
    accountImplementation: ARC_AUTHORITY.accountImplementation, factory: ARC_AUTHORITY.factory, fetch: fetchFn, bundlerTimeoutMs: 90_000,
  });
  const names = arcStorageOf(account, keyStoreName());
  const keys = new SealedSignerStore(names.keys);
  const walletOptions = livePqWalletOptions({
    signerStore: keys, walletStore: keys, publicClient: client as never, payer: browserPayer(undefined), walletRpc,
    seedFor: (epoch: bigint) => forsSeed(account, epoch),
  });
  const wallet = createPqWallet(walletOptions);
  // The key in force, from the chain, and the wallet's own signing log: no key signs twice.
  await adoptWallet({ ...walletOptions, signerStore: keys });
  const ops = createPqAccountOps({ wallet, account: address.toLowerCase() as never, authority: ARC_AUTHORITY, walletRpc, deployment: () => pendingDeployment(wallet, keys) });
  const exit = ringExit(client, address);
  const storage = localNoteStorage(names.notes);
  const pools = new Map(exitablePools().map((p) => [p.address.toLowerCase(), p]));
  const held = async () => (await storage.all())
    .filter((n) => pools.has((n.scope.pool as string).toLowerCase()) && (n.state === 'AVAILABLE' || n.state === 'RESERVED'));
  const secretOf = async (id: string) => (await held()).find((n) => n.id === id)!.secret as Hex;
  const send = (call: { to: Hex; data: Hex }) => ops.execute([{ to: call.to.toLowerCase() as never, data: call.data as never }]);

  return {
    async notes() {
      const now = Math.floor(Date.now() / 1000);
      return Promise.all((await held()).map(async (n): Promise<ExitNote> => {
        const pool = pools.get((n.scope.pool as string).toLowerCase())!;
        const nullifier = deriveNullifier(bytesOf(n.secret), n.scope) as unknown as Hex;
        const s = await exit.state(pool.address, n.secret as Hex, nullifier);
        const state = s.spent ? 'spent' : s.payableAt === undefined ? 'held' : now >= s.payableAt ? 'payable' : 'waiting';
        return { id: n.id as string, pool, commitment: n.commitment as unknown as Hex, nullifier, state, ...(s.payableAt === undefined ? {} : { payableAt: s.payableAt }) };
      }));
    },
    async announce(note) {
      return send(await exit.announceCall(note.pool.address, await secretOf(note.id), note.nullifier));
    },
    async withdraw(note) {
      return send(await exit.withdrawCall(note.pool, note.commitment, await secretOf(note.id)));
    },
    ethBalance: () => client.getBalance({ address }),
  };
}
