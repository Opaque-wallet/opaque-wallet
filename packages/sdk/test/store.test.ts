import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { initializeSigner, exportSigner } from '../../pq-wallet/src/signer-state.ts';
import { FORS_C_DEFAULT } from '../../pq-wallet/src/fors.ts';
import { keyKeeper } from '../src/arc.ts';
import { FileKeyStore } from '../src/keys.ts';
import { FileStore } from '../src/store.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'opaque-sdk-'));
const PASSWORD = 'correct horse battery';

test('the wallet file keeps what is set, sealed: nothing readable on disk', () => {
  const d = dir();
  const store = FileStore.create(d, PASSWORD);
  store.setItem('opaque:notes:v1:x', '{"secret":"0xfeedface"}');
  store.close();
  assert.doesNotMatch(readFileSync(join(d, 'wallet.enc'), 'utf8'), /feedface|opaque:notes/);
  const again = FileStore.open(d, PASSWORD);
  assert.equal(again.getItem('opaque:notes:v1:x'), '{"secret":"0xfeedface"}');
  assert.equal(again.length, 1);
  again.close();
});

test('a wrong password opens nothing, and leaves the wallet openable', () => {
  const d = dir();
  FileStore.create(d, PASSWORD).close();
  assert.throws(() => FileStore.open(d, 'not the password'), /doesn't open/);
  FileStore.open(d, PASSWORD).close();
});

test('one process at a time: a second open is refused while the first holds it', () => {
  const d = dir();
  const first = FileStore.create(d, PASSWORD);
  assert.throws(() => FileStore.open(d, PASSWORD), /another process/);
  // Another process, too.
  const other = spawnSync(process.execPath, ['-e', `import('${new URL('../src/store.ts', import.meta.url).href}').then(m => { try { m.FileStore.open(${JSON.stringify(d)}, ${JSON.stringify(PASSWORD)}); console.log('opened'); } catch (e) { console.log(e.message); } })`], { encoding: 'utf8' });
  assert.match(other.stdout, /another process/);
  first.close();
  FileStore.open(d, PASSWORD).close();
});

test('a lock left by a process that died is taken over', () => {
  const d = dir();
  FileStore.create(d, PASSWORD).close();
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(d, 'wallet.lock'), dead);
  FileStore.open(d, PASSWORD).close();
});

test('a made wallet is never made over', () => {
  const d = dir();
  FileStore.create(d, PASSWORD).close();
  assert.throws(() => FileStore.create(d, PASSWORD), /already/);
});

test('Arc keys outlive a restart, with every signing index they reserved', async () => {
  const kv = new Map<string, string>();
  const host = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v) };
  const first = new FileKeyStore(host, 'acct');
  const id = await initializeSigner(first, { keyEpoch: 0n, maxUses: 32n, lifecycleReserve: 2n, params: FORS_C_DEFAULT, seed: new Uint8Array(32).fill(7) });
  // A reservation, as signing makes one before it signs.
  await first.transact(id, (current) => ({ record: { ...current!, revision: current!.revision + 1n, reservations: [...current!.reservations, { index: 1n, digest: `0x${'ab'.repeat(32)}` as never }] }, result: undefined }));
  const wallet = { version: 1 as const, revision: 0n, accountAddress: `0x${'11'.repeat(20)}` as never, authorityId: `0x${'22'.repeat(32)}` as never,
    active: id, next: `0x${'33'.repeat(32)}` as never, rotationDeadline: 0n, lastChainUseCount: 0n, lastObservedBlock: 5n, registered: false };
  assert.equal(await first.compareAndSwapWallet('w', undefined, wallet), true);

  const second = new FileKeyStore(host, 'acct');
  const record = await second.read(id);
  assert.equal(record?.reservations.length, 1);
  assert.equal(record?.reservations[0]!.index, 1n);
  assert.equal((await exportSigner(second, id)).seed, (await exportSigner(first, id)).seed);
  assert.equal((await second.readWallet('w'))?.lastObservedBlock, 5n);
  // A stale revision is refused, as the browser's store refuses it.
  assert.equal(await second.compareAndSwapWallet('w', undefined, wallet), false);
});

// ── overlord F-33, F-36, F-37 (2026-10-22) ──────────────────────────────────

test('F-36: a slow save can\'t land after a later one and drop its reservation from disk', async () => {
  const kv = new Map<string, string>();
  const host = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v) };
  const store = new FileKeyStore(host, 'acct');
  const id = await initializeSigner(store, { keyEpoch: 0n, maxUses: 64n, lifecycleReserve: 2n, params: FORS_C_DEFAULT, seed: new Uint8Array(32).fill(9) });
  const reserve = () => store.transact(id, (current) => ({
    record: { ...current!, revision: current!.revision + 1n, reservations: [...current!.reservations, { index: BigInt(current!.reservations.length + 1), digest: `0x${String(current!.reservations.length).padStart(64, '0')}` as never }] },
    result: undefined,
  }));
  // The first save's decrypt (the crypto boundary) is held until released: the PoC's slow thread.
  const subtle = crypto.subtle as unknown as { decrypt: (...a: unknown[]) => Promise<ArrayBuffer> };
  const real = subtle.decrypt.bind(crypto.subtle);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let first = true;
  subtle.decrypt = async (...a: unknown[]) => { if (first) { first = false; await held; } return real(...a); };
  try {
    const one = reserve();
    while (first) await new Promise((r) => setImmediate(r));
    const two = reserve();
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); // the second has every chance to save first
    release();
    await Promise.all([one, two]);
  } finally {
    subtle.decrypt = real;
  }
  assert.equal((await new FileKeyStore(host, 'acct').read(id))?.reservations.length, 2);
});

test('F-37: a lock naming a live process is refused, and says how to clear a stuck one', () => {
  const d = dir();
  FileStore.create(d, PASSWORD).close();
  writeFileSync(join(d, 'wallet.lock'), String(process.ppid));
  assert.throws(() => FileStore.open(d, PASSWORD), /another process .* delete/);
});

test('F-37: closing never deletes a lock another process now holds', () => {
  const d = dir();
  const store = FileStore.create(d, PASSWORD);
  writeFileSync(join(d, 'wallet.lock'), String(process.ppid)); // taken over meanwhile
  store.close();
  assert.equal(readFileSync(join(d, 'wallet.lock'), 'utf8'), String(process.ppid));
});

test('F-37: a dead holder\'s lock is taken over cleanly, nothing left beside it', () => {
  const d = dir();
  FileStore.create(d, PASSWORD).close();
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(d, 'wallet.lock'), dead);
  const store = FileStore.open(d, PASSWORD);
  assert.equal(readFileSync(join(d, 'wallet.lock'), 'utf8'), String(process.pid));
  assert.deepEqual(readdirSync(d).filter((f) => f.startsWith('wallet.lock')), ['wallet.lock']);
  store.close();
  assert.deepEqual(readdirSync(d).filter((f) => f.startsWith('wallet.lock')), []);
});

test('F-33: the key rotates once a quarter of its signatures are left, once per open, and a failure is kept', async () => {
  let reserved = 20n;
  let key = 'k1';
  let rotations = 0;
  let fail = false;
  const app = {
    walletState: async () => ({ active: true, maxUses: 32n, localSigningReservations: reserved, pkCommitment: key }),
    rotateWallet: async () => { rotations++; if (fail) throw new Error('bundler said no'); key = `k${rotations + 1}`; reserved = 0n; },
  };
  const keeper = keyKeeper(app, async () => undefined);
  await keeper.fresh();
  assert.equal(rotations, 0, 'twelve left of 32: not yet');
  reserved = 24n;
  await keeper.fresh();
  assert.equal(rotations, 1, 'eight left: rotated');
  reserved = 30n;
  await keeper.fresh();
  assert.equal(rotations, 1, 'never twice in one open');
  const failing = keyKeeper(app, async () => undefined);
  fail = true;
  await failing.fresh();
  await failing.fresh();
  assert.equal(rotations, 2, 'a failed rotation is not retried');
  assert.equal((await failing.status()).rotationError, 'bundler said no');
});

// ── overlord F-59 (2026-10-26) ──────────────────────────────────────────────

test('F-59: two operations starting together rotate the key once', async () => {
  let reserved = 24n;
  let key = 'k1';
  let rotations = 0;
  // The key's state is read across the mesh: both operations are waiting on it when it arrives.
  let answer!: () => void;
  const read = new Promise<void>((r) => { answer = r; });
  const app = {
    walletState: async () => { await read; return { active: true, maxUses: 32n, localSigningReservations: reserved, pkCommitment: key }; },
    rotateWallet: async () => { rotations++; key = `k${rotations + 1}`; reserved = 0n; },
  };
  const keeper = keyKeeper(app, async () => undefined);
  const both = Promise.all([keeper.fresh(), keeper.fresh()]);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  answer();
  await both;
  assert.equal(rotations, 1, 'each operation rotated the key: the second spends the other signature held back for it');
});
