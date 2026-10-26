// The Arc and XRPL clients over a stand-in runtime (where the mesh and the
// chain would be), and the account's operations over a stand-in wallet RPC:
// what two calls at once may and may not share, and what a client leaves
// running once it is closed or fails to open.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ARC_AUTHORITY, createPqAccountOps } from '../../../backend/chain/pq-wallet-chain.ts';
import type { WalletRuntime } from '../../../frontend/src/lib/runtime.ts';
import type { XrplWallet } from '../../../frontend/src/lib/xrpl-runtime.ts';
import { accountKeys } from '../../../frontend/src/lib/xrpl-keys.ts';
import { openArc } from '../src/arc.ts';
import type { FileStore } from '../src/store.ts';
import { openXrpl } from '../src/xrpl.ts';

const items = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, String(v)),
    removeItem: (k: string) => void items.delete(k), key: (i: number) => [...items.keys()][i] ?? null, get length() { return items.size; },
  },
});

const account = accountKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 0);
const TO = '0x1111111111111111111111111111111111111111';
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };
const scope = { chainId: 5042002n, pool: `0x${'ab'.repeat(20)}`, denomination: 1_000_000 };

/** An Arc runtime holding `notes`; `credential` holds each payment at its credential, once its notes are picked. */
function arcRuntime(notes: readonly { id: string }[], options: { credential?: Promise<void>; open?: () => Promise<void> } = {}) {
  const submitted: string[] = [];
  const closed = { count: 0 };
  let credentials = 0;
  const rt = {
    scopes: [scope], sentKey: 'opaque:sent:v1:test',
    open: options.open ?? (async () => undefined),
    recover: async () => 0,
    readRing: async () => ({ candidates: Array.from({ length: 8 }, () => ({})) }),
    obtainCredential: async (to: string) => { credentials++; await options.credential; return to; },
    accountFunds: async () => ({ usdc: 0, prepaidGas: 0 }),
    app: {
      walletState: async () => ({ accountAddress: `0x${'22'.repeat(20)}`, active: true, maxUses: 32n, localSigningReservations: 0n, pkCommitment: 'k1' }),
      listNotes: async () => notes.map((n) => ({ ...n, scope, state: 'AVAILABLE' })),
      submitPayment: async (request: { noteId: string }) => { submitted.push(request.noteId); return { statusHandle: `h-${request.noteId}` }; },
    },
    close: async () => { closed.count++; },
  };
  return { begin: async () => rt as unknown as WalletRuntime, submitted, closed, credentials: () => credentials };
}

/** An XRPL runtime whose first look for notes does what `recover` does. */
function xrplRuntime(recover: () => Promise<number>) {
  const closed = { count: 0 };
  const wallet = { pools: [], recover, close: async () => { closed.count++; } };
  return { begin: async () => wallet as unknown as XrplWallet, closed };
}

// ── overlord F-55, F-59, F-62 (2026-10-26) ──────────────────────────────────

test('F-55: two Arc payments at once pay from different notes', async () => {
  items.clear();
  let release!: () => void;
  const credential = new Promise<void>((r) => { release = r; });
  const runtime = arcRuntime([{ id: 'note-a' }, { id: 'note-b' }], { credential });
  const arc = await openArc(undefined as unknown as FileStore, account, runtime.begin);
  const both = Promise.all([arc.send(TO, 1), arc.send(TO, 1)]);
  for (let i = 0; i < 1000 && runtime.credentials() < 2; i++) await new Promise((r) => setImmediate(r));
  release();
  await both;
  assert.deepEqual([...runtime.submitted].sort(), ['note-a', 'note-b'], 'both payments spent the same note');
});

test('F-62: an XRPL client that fails to open leaves nothing running', async () => {
  items.clear();
  const runtime = xrplRuntime(async () => { throw new Error('the mesh is down'); });
  await assert.rejects(openXrpl(account, runtime.begin), /mesh is down/);
  assert.equal(runtime.closed.count, 1, 'its relays\' poll and prover were left behind');
});

test('F-62: an Arc client that fails to open leaves nothing running', async () => {
  items.clear();
  const runtime = arcRuntime([], { open: async () => { throw new Error('the mesh is down'); } });
  await assert.rejects(openArc(undefined as unknown as FileStore, account, runtime.begin), /mesh is down/);
  assert.equal(runtime.closed.count, 1, 'its relays\' poll and prover were left behind');
});

test('F-62: closing a client closes its runtime', async () => {
  items.clear();
  const xrplSide = xrplRuntime(async () => 0);
  await (await openXrpl(account, xrplSide.begin)).close();
  assert.equal(xrplSide.closed.count, 1);
  const arcSide = arcRuntime([]);
  await (await openArc(undefined as unknown as FileStore, account, arcSide.begin)).close();
  assert.equal(arcSide.closed.count, 1);
});

test('F-59: two account operations at once are signed one after the other, each for its own nonce', async () => {
  // The account's wallet RPC: the EntryPoint's nonce is how many operations have landed.
  const hex = (value: unknown) => `0x${Buffer.from(JSON.stringify({ result: value })).toString('hex')}`;
  const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
  let landed = 0n;
  const nonces: bigint[] = [];
  const send = async (operation: string, encoded: string) => {
    if (operation === 'STATE') {
      const { calls } = JSON.parse(Buffer.from(encoded.slice(2), 'hex').toString()) as { calls: unknown[] };
      if (calls.length === 1) { nonces.push(landed); return hex({ blockNumber: '1', timestamp: '1', results: [word(landed)] }); }
      return hex({ blockNumber: '1', timestamp: '1', results: [word(10n ** 12n), word(0n)] });
    }
    if (operation === 'ESTIMATE') return hex({ standard: { maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1' }, callGasLimit: '0x1', verificationGasLimit: '0x1', preVerificationGas: '0x1' });
    if (operation === 'SUBMIT_USER_OPERATION') return hex(`0x${'aa'.repeat(32)}`);
    if (operation === 'USER_OPERATION_RECEIPT') { landed++; return hex({ success: true, receipt: { transactionHash: `0x${'bb'.repeat(32)}` } }); }
    throw new Error(`no ${operation} here`);
  };
  const wallet = { signUserOperation: async () => ({ signature: '0x01' }) };
  // As the runtime makes them: a fresh set of operations for each call.
  const ops = () => createPqAccountOps({ wallet: wallet as never, account: `0x${'33'.repeat(20)}` as never, authority: ARC_AUTHORITY, walletRpc: send as never });
  const call = { to: TO as never, data: '0x' as const };
  await Promise.all([ops().execute([call]), ops().execute([call])]);
  assert.deepEqual(nonces, [0n, 1n], 'both operations were signed for one nonce: a few-time signature burnt for one that can\'t land');
});
