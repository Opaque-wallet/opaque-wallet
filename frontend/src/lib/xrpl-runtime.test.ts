// The XRPL runtime with the mesh replaced by an answering machine (the
// external sink); everything else, from the note vault to localStorage's
// records, is the wallet's own code.

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { MeshQuery, PoolScope } from '@opaque/protocol-types';
import { toHex } from '@opaque/protocol-types/codecs.js';
import { createNoteSecret, deriveCommitment } from '@opaque/zk';

import { accountOf, scopeOf } from '../../../backend/xrpl/protocol.ts';
import { xrplDeployment } from '../../../deployments/xrpl.ts';
import { startXrplWallet, type Relays, type XrplStackConfig } from './xrpl-runtime.ts';
import { accountKeys, stream } from './xrpl-keys.ts';

const items = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, String(v)),
    removeItem: (k: string) => void items.delete(k), key: (i: number) => [...items.keys()][i] ?? null, get length() { return items.size; },
  },
});

const account = accountKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 0);
const pool = xrplDeployment.pools[0]!;
const size = pool.sizes[0]!;
const scope = scopeOf(xrplDeployment.network.networkId, pool.account, size);
const counters = `opaque:xrpl:${account.id}:note-counters:v1`;
const secretOf = (i: number) => createNoteSecret(stream(account.key, `note/${xrplDeployment.network.name}/${pool.account}/${size}/${i}`));
const mine = (i: number) => deriveCommitment(secretOf(i), scope) as string;
const others = Array.from({ length: 7 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, 'e')}`);
const CONFIG = { cre: { publicKey: '0x00', encryptionKeyId: 'test', policyVersion: 'test' }, buy: false } as unknown as XrplStackConfig;

const same = (a: PoolScope, b: PoolScope) => a.pool.toLowerCase() === b.pool.toLowerCase() && a.denomination === b.denomination;
/** The pool's deposit log: `inRing` in this test's size, nothing in any other. */
const ringOf = (s: PoolScope, inRing: readonly string[]) => ({
  scope: s, indexedThroughBlock: 1n, observedAt: 1n, policyVersion: 'test',
  candidates: (same(s, scope) ? inRing : []).map((commitment) => ({ commitment, enrolledAtBlock: 1n, timesUsedInRing: 0, fundingCluster: null, hasOtherActivity: null })),
});
/** Relays that answer each query with `answer`, and say what was asked. */
function relays(answer: (request: MeshQuery) => Promise<unknown>) {
  const asked: string[] = [];
  const mesh: Relays = () => ({
    transport: { query: async (request: MeshQuery) => { asked.push(request.kind); return { kind: request.kind, value: await answer(request) }; } } as never,
    pathFor: async () => [] as never,
    snapshot: () => ({ nodes: [] }) as never,
  });
  return { mesh, asked };
}
const offline = () => Promise.reject(new Error('not answered in this test'));
const prover = (closed = { count: 0 }) => ({ prove: () => { throw new Error('no proofs in this test'); }, verify: () => false, close: () => { closed.count++; } });
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };
const ourNotes = (notes: readonly { commitment: string }[]) => notes.filter((n) => [0, 1, 2].map(mine).includes(n.commitment)).length;

// ── overlord F-55, F-58, F-62 (2026-10-26) ──────────────────────────────────

test('F-55: two payments at once never pick the same note', async () => {
  items.clear();
  const bigints = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v);
  const notes = Object.fromEntries([0, 1].map((i) => [`note-${i}`, { id: `note-${i}`, scope, commitment: mine(i), secret: toHex(secretOf(i)), state: 'AVAILABLE', depositTx: null, createdAtBlock: 1n, reservation: null }]));
  items.set(`opaque:xrpl:${account.id}:notes:v1`, JSON.stringify(notes, bigints));
  // Each payment waits at its credential, after it has picked its notes; then both are let go, unpaid.
  let refuse!: () => void;
  const credential = new Promise<never>((_, reject) => { refuse = () => reject(new Error('no credential in this test')); });
  credential.catch(() => undefined);
  const { mesh } = relays(async (r) => (r.kind === 'RING_SNAPSHOT' ? ringOf(r.scope, [mine(0), mine(1), ...others]) : r.kind === 'CREDENTIAL' ? credential : offline()));
  const wallet = await startXrplWallet(CONFIG, account, { prover, mesh });
  const pay = () => wallet.send({ symbol: pool.symbol, amount: size / 1_000_000, destination: { account: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', tag: null }, waitForPrivacy: false, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) as never });
  const both = Promise.allSettled([pay(), pay()]);
  for (let i = 0; i < 1000 && wallet.activity().length < 2; i++) await new Promise((r) => setImmediate(r));
  const picked = wallet.activity().map((s) => s.notes[0]!.noteId);
  refuse();
  await both;
  assert.equal(picked.length, 2);
  assert.notEqual(picked[0], picked[1], 'both payments were handed the same note');
  await wallet.close();
});

test('F-58: a rescan alongside the first look keeps each note once', async () => {
  items.clear();
  const { mesh } = relays(async (r) => (r.kind === 'RING_SNAPSHOT' ? ringOf(r.scope, [mine(0), mine(1), mine(2), ...others]) : offline()));
  const wallet = await startXrplWallet(CONFIG, account, { prover, mesh });
  // The first open's look, and Rescan pressed while it runs.
  await Promise.all([wallet.recover(), wallet.recover()]);
  assert.equal(ourNotes(await wallet.notes()), 3, 'each note found was kept twice');
  await wallet.close();
});

test('F-58: a note drawn while the look runs keeps its number taken', async () => {
  items.clear();
  let answer!: () => void;
  const logs = new Promise<void>((r) => { answer = r; });
  const { mesh } = relays(async (r) => { if (r.kind !== 'RING_SNAPSHOT') return offline(); await logs; return ringOf(r.scope, [mine(0), ...others]); });
  const wallet = await startXrplWallet(CONFIG, account, { prover, mesh });
  const looking = wallet.recover();
  await settle();
  // Meanwhile a receive draws notes 0 to 4 of another pool's size, as newNote() does.
  const elsewhere = `${xrplDeployment.pools[1]!.account}/${xrplDeployment.pools[1]!.sizes[0]}`;
  items.set(counters, JSON.stringify({ ...JSON.parse(items.get(counters) ?? '{}'), [elsewhere]: 5 }));
  answer();
  await looking;
  const after = JSON.parse(items.get(counters)!) as Record<string, number>;
  assert.equal(after[elsewhere], 5, 'the look wrote its old count back: note 0 of that size would be drawn again');
  assert.equal(after[`${accountOf(scope.pool)}/${size}`], 1);
  await wallet.close();
});

test('F-62: close() stops the relays\' poll and the prover', async () => {
  items.clear();
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const { mesh, asked } = relays(async (r) => (r.kind === 'RELAY_SNAPSHOT' ? { nodes: [], directoryVersion: '1', observedAt: 1n } : offline()));
    const closed = { count: 0 };
    const wallet = await startXrplWallet(CONFIG, account, { prover: () => prover(closed), mesh });
    const polls = () => asked.filter((k) => k === 'RELAY_SNAPSHOT').length;
    await settle();
    mock.timers.tick(120_000);
    await settle();
    assert.equal(polls(), 2, 'one look at start, one two minutes on');
    await wallet.close();
    mock.timers.tick(600_000);
    await settle();
    assert.equal(polls(), 2, 'the poll went on after close()');
    assert.equal(closed.count, 1, 'the prover was left running');
  } finally {
    mock.timers.reset();
  }
});
