// The passkey backup store: a blob kept under an id, written only with the
// token that first wrote it, and refused when it would not fit the mesh.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { createBackupStore, MAX_BLOB, movingFrom } from '../backup-store.ts';
import { rateLimit } from '../limit.ts';
import { decodeMeshQuery } from '../queries.ts';

// No work asked: these tests are about what is kept; the work a new id costs has its own.
const FREE = { baseBits: 0 };
const id = 'a1'.repeat(32);
const token = 'b2'.repeat(32);
const ask = async (store: ReturnType<typeof createBackupStore>, op: 'GET' | 'PUT' | 'DELETE', request: unknown) =>
  JSON.parse(new TextDecoder().decode(fromHex(await store(op, toHex(new TextEncoder().encode(JSON.stringify(request))))))) as { result?: any; error?: { message: string } };

test('a backup is kept, read back, guarded by its token, and forgotten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opaque-backup-'));
  try {
    const store = createBackupStore(dir, FREE);
    assert.equal((await ask(store, 'GET', { id })).result, null, 'nothing yet');
    assert.ok((await ask(store, 'PUT', { id, token, blob: 'c2VhbGVk' })).result.savedAt > 0);
    assert.equal((await ask(store, 'GET', { id })).result.blob, 'c2VhbGVk');
    // Kept on disk: a restart finds it.
    assert.equal((await ask(createBackupStore(dir, FREE), 'GET', { id })).result.blob, 'c2VhbGVk');

    const stranger = 'c3'.repeat(32);
    assert.match((await ask(store, 'PUT', { id, token: stranger, blob: 'b3RoZXI=' })).error!.message, /another passkey/);
    assert.match((await ask(store, 'DELETE', { id, token: stranger })).error!.message, /another passkey/);
    assert.equal((await ask(store, 'GET', { id })).result.blob, 'c2VhbGVk', 'untouched by the stranger');

    assert.ok((await ask(store, 'PUT', { id, token, blob: 'bmV3ZXI=' })).result.savedAt > 0, 'its own token replaces it');
    assert.equal((await ask(store, 'DELETE', { id, token })).result.deleted, true);
    assert.equal((await ask(store, 'GET', { id })).result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('what the store refuses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opaque-backup-'));
  try {
    const store = createBackupStore(dir, FREE);
    assert.match((await ask(store, 'PUT', { id, token, blob: 'A'.repeat(MAX_BLOB + 4) })).error!.message, /at most/);
    assert.match((await ask(store, 'PUT', { id, token, blob: 'not base64!' })).error!.message, /base64/);
    assert.match((await ask(store, 'GET', { id: '../etc/passwd' })).error!.message, /32 bytes/, 'an id is never a path');
    assert.match((await ask(store, 'PUT', { id, blob: 'c2VhbGVk' })).error!.message, /token/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('while backups move, a miss is read from the first store, and a removal removes both', async () => {
  const [a, b] = [mkdtempSync(join(tmpdir(), 'opaque-backup-')), mkdtempSync(join(tmpdir(), 'opaque-backup-'))];
  try {
    const before = createBackupStore(a, FREE);
    const moving = movingFrom(createBackupStore(b, FREE), before, undefined, undefined, 0);
    await ask(before, 'PUT', { id, token, blob: 'Zmlyc3Q=' });
    assert.equal((await ask(moving, 'GET', { id })).result.blob, 'Zmlyc3Q=', 'found where it was first kept');
    await ask(moving, 'PUT', { id, token, blob: 'bW92ZWQ=' });
    assert.equal((await ask(moving, 'GET', { id })).result.blob, 'bW92ZWQ=', 'sent again: the new store answers');
    await ask(moving, 'DELETE', { id, token });
    assert.equal((await ask(moving, 'GET', { id })).result, null, 'removed from both: nothing comes back');
    assert.equal((await ask(before, 'GET', { id })).result, null);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('the exit decodes a BACKUP query, and only its three operations', () => {
  const q = decodeMeshQuery({ kind: 'BACKUP', operation: 'GET', encodedRequest: '0x7b7d' });
  assert.deepEqual(q, { kind: 'BACKUP', operation: 'GET', encodedRequest: '0x7b7d' });
  assert.throws(() => decodeMeshQuery({ kind: 'BACKUP', operation: 'LIST', encodedRequest: '0x7b7d' }), /no backup operation/);
});

// ── overlord regressions ────────────────────────────────────────────────────

test('a new backup costs work, more as the store fills, and a full store makes room only from stale backups (F-5)', async () => {
  const { findWork, workBits } = await import('../backup-work.ts');
  const dir = mkdtempSync(join(tmpdir(), 'opaque-backup-'));
  try {
    let clock = 1_000_000;
    const store = createBackupStore(dir, { maxRecords: 3, baseBits: 4, staleMs: 1_000, now: () => clock });
    const rid = (n: number) => n.toString(16).padStart(64, '0');
    // OMEGA's PoC: a flood of random ids with blob "AA==" and no work.
    assert.match((await ask(store, 'PUT', { id: rid(1), token, blob: 'AA==' })).error!.message, /needs 4 bits of work/);
    assert.equal(workBits(0, 3, 4), 4);
    assert.equal(workBits(2, 3, 4), 9, 'more work as it fills');
    for (let n = 1; n <= 3; n++) {
      const bits = workBits(n - 1, 3, 4);
      assert.ok((await ask(store, 'PUT', { id: rid(n), token, blob: 'AA==', work: await findWork(rid(n), bits) })).result.savedAt > 0);
    }
    const work4 = await findWork(rid(4), workBits(3, 3, 4));
    assert.match((await ask(store, 'PUT', { id: rid(4), token, blob: 'AA==', work: work4 })).error!.message, /full/, 'full, and nothing stale');
    // Its owner saves rid(1) again later; rid(2) and rid(3) go stale.
    clock += 2_000;
    assert.ok((await ask(store, 'PUT', { id: rid(1), token, blob: 'QkI=' })).result.savedAt > 0, 'an owner\'s update needs no work');
    assert.ok((await ask(store, 'PUT', { id: rid(4), token, blob: 'AA==', work: work4 })).result.savedAt > 0, 'a stale backup made room');
    assert.equal((await ask(store, 'GET', { id: rid(1) })).result.blob, 'QkI=', 'the one in use was kept');
    assert.equal((await ask(store, 'GET', { id: rid(2) })).result, null, 'the stalest went');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the first store, kept for reading, takes no new backups but its owners\' updates and removals (F-6)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opaque-backup-'));
  try {
    await ask(createBackupStore(dir, FREE), 'PUT', { id, token, blob: 'Zmlyc3Q=' });
    const old = createBackupStore(dir, { acceptNew: false });
    // OMEGA's PoC: the flood against the XRPL service's /v1/backup.
    assert.match((await ask(old, 'PUT', { id: 'c4'.repeat(32), token, blob: 'AA==' })).error!.message, /earlier backups only/);
    assert.ok((await ask(old, 'PUT', { id, token, blob: 'dXBkYXRlZA==' })).result.savedAt > 0, 'its owner may still update it');
    assert.equal((await ask(old, 'DELETE', { id, token })).result.deleted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('while backups move, an id the first store holds is taken only with its owner\'s token (F-15)', async () => {
  const [a, b] = [mkdtempSync(join(tmpdir(), 'opaque-backup-')), mkdtempSync(join(tmpdir(), 'opaque-backup-'))];
  try {
    const before = createBackupStore(a, FREE);
    const moving = movingFrom(createBackupStore(b, FREE), before, undefined, undefined, 0);
    await ask(before, 'PUT', { id, token, blob: 'dmljdGlt' });
    // OMEGA's PoC: knowing the victim's id, PUT it to the new store under the attacker's token first.
    const attacker = 'd5'.repeat(32);
    assert.match((await ask(moving, 'PUT', { id, token: attacker, blob: 'YXR0YWNr' })).error!.message, /another passkey/);
    assert.equal((await ask(moving, 'GET', { id })).result.blob, 'dmljdGlt', 'still the victim\'s');
    assert.ok((await ask(moving, 'PUT', { id, token, blob: 'bW92ZWQ=' })).result.savedAt > 0, 'its owner carries it over');
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('a removal that cannot reach the first store removes nothing, so nothing comes back (F-16)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opaque-backup-'));
  try {
    const kept = createBackupStore(dir, FREE);
    await ask(kept, 'PUT', { id, token, blob: 'a2VwdA==' });
    // OMEGA's PoC: the first store is down when DELETE arrives.
    const moving = movingFrom(kept, async () => { throw new Error('ECONNREFUSED'); });
    const answer = await ask(moving, 'DELETE', { id, token });
    assert.match(answer.error!.message, /could not be removed/);
    assert.equal((await ask(kept, 'GET', { id })).result.blob, 'a2VwdA==', 'kept until both can remove it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read-through to the first store is rate limited: a flood of made-up ids is not a flood of calls (F-17)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opaque-backup-'));
  try {
    let calls = 0;
    let allowed = 2;
    const moving = movingFrom(createBackupStore(dir, FREE), async (_op, req) => { calls++; return createBackupStore(dir, FREE)('GET', req); }, () => allowed-- > 0);
    // OMEGA's PoC: GETs of random ids, each a miss.
    for (let n = 0; n < 5; n++) await ask(moving, 'GET', { id: n.toString(16).padStart(64, '0') });
    assert.equal(calls, 2, 'two calls through, three refused here');
    assert.match((await ask(moving, 'GET', { id: 'e6'.repeat(32) })).error!.message, /busy/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a disk error is answered without its path (F-26)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opaque-backup-'));
  const store = createBackupStore(dir, FREE);
  rmSync(dir, { recursive: true, force: true });
  // OMEGA's PoC: an fs error (here ENOENT) whose message names the file.
  const answer = await ask(store, 'PUT', { id, token, blob: 'AA==' });
  assert.equal(answer.error!.message, 'the backup store failed');
  assert.ok(!JSON.stringify(answer).includes(dir));
});

test('a flood of reads for made-up ids does not refuse new backups (F-64)', async () => {
  const [a, b] = [mkdtempSync(join(tmpdir(), 'opaque-backup-')), mkdtempSync(join(tmpdir(), 'opaque-backup-'))];
  try {
    const moving = movingFrom(createBackupStore(b, FREE), createBackupStore(a, FREE), rateLimit(120, () => 0), undefined, 0);
    // OMEGA's PoC: 120 GETs of random ids in a minute, each a miss.
    for (let n = 0; n < 120; n++) await ask(moving, 'GET', { id: n.toString(16).padStart(64, '0') });
    assert.match((await ask(moving, 'GET', { id: 'e6'.repeat(32) })).error!.message, /busy/, 'reads are spent');
    const put = await ask(moving, 'PUT', { id: 'f7'.repeat(32), token, blob: 'bmV3' });
    assert.ok(put.result?.savedAt > 0, `a new backup was refused: ${put.error?.message}`);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('a flood of new-id PUTs with no work does not refuse a real worked one (F-64)', async () => {
  const { findWork, workBits } = await import('../backup-work.ts');
  const [a, b] = [mkdtempSync(join(tmpdir(), 'opaque-backup-')), mkdtempSync(join(tmpdir(), 'opaque-backup-'))];
  try {
    // 16 bits: few enough hashes to find here, too many for a made-up id to pass by luck.
    const moving = movingFrom(createBackupStore(b, { baseBits: 16 }), createBackupStore(a, FREE), undefined, rateLimit(120, () => 0), 16);
    // OMEGA's PoC: 120 PUTs a minute of made-up ids and no work. Each used to
    // spend a write before the store looked at the work.
    for (let n = 0; n < 120; n++) {
      assert.match((await ask(moving, 'PUT', { id: n.toString(16).padStart(64, '0'), token, blob: 'AA==' })).error!.message, /work/);
    }
    const real = 'f8'.repeat(32);
    const put = await ask(moving, 'PUT', { id: real, token, blob: 'cmVhbA==', work: await findWork(real, workBits(0, 10_000, 16)) });
    assert.ok(put.result?.savedAt > 0, `a worked backup was refused: ${put.error?.message}`);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
