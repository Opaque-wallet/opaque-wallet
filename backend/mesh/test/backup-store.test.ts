// The passkey backup store: a blob kept under an id, written only with the
// token that first wrote it, and refused when it would not fit the mesh.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { createBackupStore, MAX_BLOB, movingFrom } from '../backup-store.ts';
import { decodeMeshQuery } from '../queries.ts';

const id = 'a1'.repeat(32);
const token = 'b2'.repeat(32);
const ask = async (store: ReturnType<typeof createBackupStore>, op: 'GET' | 'PUT' | 'DELETE', request: unknown) =>
  JSON.parse(new TextDecoder().decode(fromHex(await store(op, toHex(new TextEncoder().encode(JSON.stringify(request))))))) as { result?: any; error?: { message: string } };

test('a backup is kept, read back, guarded by its token, and forgotten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opaque-backup-'));
  try {
    const store = createBackupStore(dir);
    assert.equal((await ask(store, 'GET', { id })).result, null, 'nothing yet');
    assert.ok((await ask(store, 'PUT', { id, token, blob: 'c2VhbGVk' })).result.savedAt > 0);
    assert.equal((await ask(store, 'GET', { id })).result.blob, 'c2VhbGVk');
    // Kept on disk: a restart finds it.
    assert.equal((await ask(createBackupStore(dir), 'GET', { id })).result.blob, 'c2VhbGVk');

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
    const store = createBackupStore(dir);
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
    const before = createBackupStore(a);
    const moving = movingFrom(createBackupStore(b), before);
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
