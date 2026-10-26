// A note's reservation is what keeps one note from paying twice. The chain is
// asked whether the note is spent before it is reserved, a mesh round trip of
// seconds; nothing another payment does in those seconds may get the note too.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { IdempotencyKey, NoteId, PoolScope } from '@opaque/protocol-types';
import { createNoteVault, memoryNoteStorage, type ChainObserver, type NoteStorage } from '../src/note-vault.ts';

const scope = { chainId: 5042002n, pool: `0x${'ab'.repeat(20)}`, denomination: 100_000_000 } as unknown as PoolScope;
const key = (k: string) => k as IdempotencyKey;
const answers = (spent: boolean | Error): ChainObserver => ({
  observeCommitment: async () => ({ blockNumber: 1n }),
  isNullifierSpent: async () => { if (spent instanceof Error) throw spent; return spent; },
});
/** The chain, answering one question at a time when the test says: the seconds a mesh round trip takes. */
function heldChain() {
  const waiting: ((spent: boolean) => void)[] = [];
  const chain: ChainObserver = { observeCommitment: async () => ({ blockNumber: 1n }), isNullifierSpent: () => new Promise((r) => waiting.push(r)) };
  return { chain, answer: () => waiting.shift()?.(false) };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

async function fundedNote(storage: NoteStorage): Promise<NoteId> {
  const vault = createNoteVault({ storage, chain: answers(false) });
  const note = await vault.create(scope);
  await vault.recordDeposit(note.id, `0x${'11'.repeat(32)}` as never);
  assert.equal((await vault.reconcile(note.id)).state, 'AVAILABLE');
  return note.id;
}

// ── overlord F-55 (2026-10-26) ──────────────────────────────────────────────

test('F-55: two payments reserving one note at once: one holds it, the other is refused', async () => {
  const storage = memoryNoteStorage();
  const id = await fundedNote(storage);
  const held = heldChain();
  const vault = createNoteVault({ storage, chain: held.chain });
  // As ring-client's buildSpend does: reserve, then borrow the secret for the proof.
  const spend = async (k: string) => { await vault.reserve(id, key(k)); return vault.useSecret(id, key(k), () => k); };
  const both = Promise.allSettled([spend('pay-A'), spend('pay-B')]);
  // The first answer arrives, and its proof begins, before the second's.
  await settle();
  held.answer();
  await settle();
  held.answer();
  const results = await both;
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'both payments were lent the note\'s secret');
  assert.equal(((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as { code: string }).code, 'NOTE_RESERVED');
  // The payment that holds it may ask again (a retry): its reservation stands.
  const holder = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<string>).value;
  const again = vault.reserve(id, key(holder));
  await settle();
  held.answer();
  assert.equal((await again).state, 'RESERVED');
});

test('F-55: another tab\'s vault sees the note taken while the first is still asking the chain', async () => {
  const storage = memoryNoteStorage();
  const id = await fundedNote(storage);
  const held = heldChain();
  const mine = createNoteVault({ storage, chain: held.chain }).reserve(id, key('pay-A'));
  await settle();
  await assert.rejects(createNoteVault({ storage, chain: answers(false) }).reserve(id, key('pay-B')), { code: 'NOTE_RESERVED' });
  held.answer();
  assert.equal((await mine).state, 'RESERVED');
  assert.equal((await storage.read(id))?.reservation, 'pay-A');
});

test('F-55: a reservation the chain could not confirm is undone; one it says is spent is marked so', async () => {
  const storage = memoryNoteStorage();
  const id = await fundedNote(storage);
  await assert.rejects(createNoteVault({ storage, chain: answers(new Error('mesh down')) }).reserve(id, key('pay-A')), /mesh down/);
  assert.deepEqual([(await storage.read(id))?.state, (await storage.read(id))?.reservation], ['AVAILABLE', null]);
  await assert.rejects(createNoteVault({ storage, chain: answers(true) }).reserve(id, key('pay-B')), { code: 'NULLIFIER_SPENT' });
  assert.deepEqual([(await storage.read(id))?.state, (await storage.read(id))?.reservation], ['SPENT', null]);
});

test('F-55: in a browser, the look and the mark run under the note\'s Web Lock, so tabs take turns', async () => {
  const storage = memoryNoteStorage();
  const id = await fundedNote(storage);
  const asked: string[] = [];
  const queues = new Map<string, Promise<unknown>>();
  const locks = {
    request<T>(name: string, run: () => Promise<T>): Promise<T> {
      asked.push(name);
      const next = (queues.get(name) ?? Promise.resolve()).then(run, run);
      queues.set(name, next.catch(() => undefined));
      return next;
    },
  };
  Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
  try {
    assert.equal((await createNoteVault({ storage, chain: answers(false) }).reserve(id, key('pay-A'))).state, 'RESERVED');
  } finally {
    delete (globalThis.navigator as { locks?: unknown }).locks;
  }
  assert.deepEqual(asked, [`opaque:note:${String(id)}`]);
});
