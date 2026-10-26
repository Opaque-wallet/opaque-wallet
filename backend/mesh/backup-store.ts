// Encrypted wallet backups (protocol-types BackupOperation), kept for passkeys.
//
// What is kept: an id, a hash of a write token, and a blob. The wallet works
// out the id and the token from its passkey (frontend/src/lib/passkey-backup.ts)
// and seals the blob before it leaves the page, so this store holds
// ciphertext it cannot open, under ids it cannot link to anyone. It asks
// through three relays like every other query: the exit learns the question,
// never the questioner.
//
// One store serves every chain, since one recovery phrase does. The service
// with the volume keeps it (opaque-mainnet, mounted at backend/.backups); the
// others forward to it (STORE_URL), server to server, so a wallet still talks
// only to its own relays. BACKUP_DIR and BACKUP_URL move it.

import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ProtocolFailure, type BackupOperation, type Hex } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { BASE_BITS, workBits, zeroBits } from './backup-work.ts';
import { rateLimit } from './limit.ts';
import { BACKUP_OPERATIONS } from './queries.ts';

export type BackupSend = (operation: BackupOperation, encodedRequest: Hex) => Promise<Hex>;

/** A blob's most, in base64 characters: what fits one mesh message as hex, with room to spare. */
export const MAX_BLOB = 24_000;
/**
 * How many backups are kept (24 KB each at most, so ~240 MB). Anyone may keep
 * one, so a new id costs work (backup-work.ts) that rises as the store fills,
 * and at capacity a backup not saved for STALE_MS makes room: filling the
 * store is expensive and never permanent. The wallet saves its backup again
 * at least every month (passkey-backup.ts), so a wallet in use is never the
 * one that makes room.
 */
const MAX_RECORDS = 10_000;
const STALE_MS = 90 * 24 * 60 * 60 * 1000;

export interface BackupStoreOptions {
  readonly maxRecords?: number;
  /** Bits of work a new backup needs in an empty store. */
  readonly baseBits?: number;
  /** false: a store kept for reading while backups move; it takes no new ids, only its owners' updates and removals. */
  readonly acceptNew?: boolean;
  readonly staleMs?: number;
  readonly now?: () => number;
}

interface Record { readonly blob: string; readonly auth: string; readonly savedAt: number }

const refuse = (message: string): never => { throw new ProtocolFailure('INVALID_INPUT', message); };
const hex32 = (v: unknown, label: string): string => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : refuse(`${label} must be 32 bytes of lower-case hex`));
const hashOf = (token: string) => createHash('sha256').update(Buffer.from(token, 'hex')).digest('hex');
const json = (value: unknown): Hex => toHex(new TextEncoder().encode(JSON.stringify(value)));

/** The store, on disk under `dir`: one file per id. */
export function createBackupStore(dir: string, options: BackupStoreOptions = {}): BackupSend {
  const max = options.maxRecords ?? MAX_RECORDS;
  const now = options.now ?? Date.now;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let count = readdirSync(dir).filter((f) => f.endsWith('.json')).length;
  const file = (id: string) => join(dir, `${id}.json`);
  const read = (id: string): Record | null => (existsSync(file(id)) ? JSON.parse(readFileSync(file(id), 'utf8')) as Record : null);
  const owned = (record: Record, token: string) => timingSafeEqual(Buffer.from(record.auth, 'hex'), Buffer.from(hashOf(token), 'hex'));
  /** At capacity: the backup saved longest ago goes, if that was more than STALE_MS ago. */
  const makeRoom = (): boolean => {
    let oldest: { id: string; at: number } | undefined;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const at = (read(f.slice(0, -5))?.savedAt) ?? 0;
      if (oldest === undefined || at < oldest.at) oldest = { id: f.slice(0, -5), at };
    }
    if (oldest === undefined || now() - oldest.at <= (options.staleMs ?? STALE_MS)) return false;
    unlinkSync(file(oldest.id));
    count--;
    return true;
  };

  const handlers: { [op in BackupOperation]: (r: { [k: string]: unknown }) => unknown } = {
    GET(r) {
      const record = read(hex32(r['id'], 'id'));
      return record === null ? null : { blob: record.blob, savedAt: record.savedAt };
    },
    PUT(r) {
      const id = hex32(r['id'], 'id');
      const token = hex32(r['token'], 'token');
      const raw = r['blob'];
      const blob = typeof raw === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(raw) ? raw : refuse('blob must be base64');
      if (blob.length > MAX_BLOB) refuse(`a backup is at most ${MAX_BLOB} characters`);
      const record = read(id);
      if (record !== null && !owned(record, token)) refuse('that backup was made by another passkey');
      if (record === null) {
        if (options.acceptNew === false) refuse('this store keeps earlier backups only: send yours to the store they moved to');
        const bits = workBits(count, max, options.baseBits);
        const work = typeof r['work'] === 'string' && /^([0-9a-f]{2}){1,32}$/.test(r['work']) ? r['work'] : '';
        if (zeroBits(id, work) < bits) refuse(`a new backup needs ${bits} bits of work`);
        if (count >= max && !makeRoom()) throw new ProtocolFailure('MESH_UNAVAILABLE', 'the backup store is full', true);
      }
      const savedAt = now();
      // Written whole, then moved into place: a crash leaves the old backup, never half of a new one.
      writeFileSync(`${file(id)}.tmp`, JSON.stringify({ blob, auth: record?.auth ?? hashOf(token), savedAt } satisfies Record), { mode: 0o600 });
      renameSync(`${file(id)}.tmp`, file(id));
      if (record === null) count++;
      return { savedAt };
    },
    DELETE(r) {
      const id = hex32(r['id'], 'id');
      const token = hex32(r['token'], 'token');
      const record = read(id);
      if (record === null) return { deleted: false };
      if (!owned(record, token)) refuse('that backup was made by another passkey');
      unlinkSync(file(id));
      count--;
      return { deleted: true };
    },
  };

  return async (operation, encodedRequest) => {
    try {
      const request = JSON.parse(new TextDecoder().decode(fromHex(encodedRequest))) as unknown;
      if (typeof request !== 'object' || request === null) refuse('a request is an object');
      return json({ result: handlers[operation](request as { [k: string]: unknown }) });
    } catch (error) {
      // An answer carries its own error, as XRPL's do: a failed query would leave the wallet waiting out its deadline.
      // Only this store's own refusals say why; anything else (a disk error, with its path) says only that it failed.
      const e = error instanceof ProtocolFailure ? error : new ProtocolFailure('MESH_UNAVAILABLE', 'the backup store failed', true);
      return json({ error: { code: e.code, message: e.publicMessage, retryable: e.retryable } });
    }
  };
}

/** A service without the volume: the store, asked over HTTPS where it is kept. */
export function remoteBackupStore(url: string): BackupSend {
  return async (operation, encodedRequest) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, encodedRequest }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return json({ error: { code: 'MESH_UNAVAILABLE', message: `the backup store answered ${response.status}`, retryable: true } });
    const { value } = await response.json() as { value?: unknown };
    return typeof value === 'string' && /^0x[0-9a-f]*$/.test(value) ? value as Hex : json({ error: { code: 'MESH_UNAVAILABLE', message: 'the backup store answered nonsense', retryable: true } });
  };
}

/** POST /v1/backup, where the store is kept: { operation, encodedRequest } in, { value } out. */
export function backupHttpHandler(send: BackupSend): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > 128 * 1024) req.destroy(); else chunks.push(c); });
    req.on('end', () => void (async () => {
      try {
        const { operation, encodedRequest } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { operation?: unknown; encodedRequest?: unknown };
        if (typeof operation !== 'string' || !BACKUP_OPERATIONS.has(operation as BackupOperation)) refuse('no such backup operation');
        if (typeof encodedRequest !== 'string' || !/^0x[0-9a-f]*$/.test(encodedRequest)) refuse('encodedRequest must be hex');
        const value = await send(operation as BackupOperation, encodedRequest as Hex);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ value }));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: error instanceof ProtocolFailure ? error.publicMessage : 'a backup request is { operation, encodedRequest }' }));
      }
    })());
  };
}

/** Where the store is kept: opaque-mainnet, the service with the backup volume. */
export const STORE_URL = 'https://opaque-mainnet-production-28a9.up.railway.app/v1/backup';
/** Where it was kept first (20 October 2026), on the XRPL service's volume. */
export const MOVED_FROM_URL = 'https://opaque-xrpl-testnet-production.up.railway.app/v1/backup';
/** The volume's mount: a service that has it keeps the store. */
const VOLUME = join(dirname(fileURLToPath(import.meta.url)), '..', '.backups');

/**
 * While backups move to a new store: a backup not found there yet is read
 * from the old one, and a removal removes both, so nothing removed comes back.
 * Each wallet sends its backup again once (passkey-backup.ts STORE), after
 * which the old store has nothing anyone needs.
 */
// ponytail: read-through to the first store; drop it once wallets have re-sent theirs (a few weeks).
export function movingFrom(store: BackupSend, before: BackupSend, reads: () => boolean = rateLimit(120), writes: () => boolean = rateLimit(120), bits = BASE_BITS): BackupSend {
  const answerOf = (a: Hex) => JSON.parse(new TextDecoder().decode(fromHex(a))) as { result?: unknown; error?: unknown };
  const isNone = (a: Hex) => answerOf(a).result === null;
  const isError = (a: Hex | null) => a === null || answerOf(a).error !== undefined;
  const failed = (message: string) => json({ error: { code: 'MESH_UNAVAILABLE', message, retryable: true } });
  const busy = failed('the backup store is busy: try again in a minute');
  const fieldsOf = (encodedRequest: Hex): { id?: string; work: string } => {
    try {
      const { id, work } = JSON.parse(new TextDecoder().decode(fromHex(encodedRequest))) as { id?: unknown; work?: unknown };
      return { ...(typeof id === 'string' ? { id } : {}), work: typeof work === 'string' && /^([0-9a-f]{2}){1,32}$/.test(work) ? work : '' };
    } catch { return { work: '' }; }
  };
  // Each call to the first store is one a stranger can make for free: at most so many a minute.
  // Reads and writes are counted apart: one allowance let 120 GETs of made-up ids a minute
  // refuse every new backup (F-64).
  const first = (operation: BackupOperation, encodedRequest: Hex) => before(operation, encodedRequest).catch(() => null);
  return async (operation, encodedRequest) => {
    if (operation === 'GET') {
      const answer = await store('GET', encodedRequest);
      if (!isNone(answer)) return answer;
      if (!reads()) return busy;
      const old = await first('GET', encodedRequest);
      return isError(old) ? answer : old!;
    }
    if (operation === 'PUT') {
      // An id the first store still holds is its owner's: the first store checks the token
      // before this one takes it. Unsure whether it holds it, this store takes nothing.
      const { id, work } = fieldsOf(encodedRequest);
      if (id !== undefined && isNone(await store('GET', json({ id })))) {
        // The least work any new id needs, checked before a write is spent: refused only by
        // the store, 120 made-up ids a minute with no work spent every write and refused
        // every real backup (F-64). `bits` is the store's own floor, BASE_BITS unless set.
        if (zeroBits(id, work) < bits) return json({ error: { code: 'INVALID_INPUT', message: `a new backup needs ${bits} bits of work`, retryable: false } });
        if (!writes()) return busy;
        const old = await first('GET', json({ id }));
        if (isError(old)) return failed('the earlier backup store did not answer: try again');
        if (!isNone(old!)) {
          const checked = await first('PUT', encodedRequest);
          if (checked === null) return failed('the earlier backup store did not answer: try again');
          if (isError(checked)) return checked;
        }
      }
      return store('PUT', encodedRequest);
    }
    // DELETE: from the first store, then this one. If the first fails, nothing is removed
    // and the wallet asks again, so a removed backup never comes back from the first store.
    if (!writes()) return busy;
    if (isError(await first('DELETE', encodedRequest))) return failed('the earlier copy could not be removed: try again');
    return store('DELETE', encodedRequest);
  };
}

/**
 * The store this service uses: asked elsewhere (BACKUP_URL); kept here, on
 * BACKUP_DIR or the backup volume; asked at STORE_URL when `hosted`; or, on
 * a laptop, kept under `laptopDir`.
 */
export function backupFromEnv(laptopDir: string, hosted: boolean): { readonly send: BackupSend; readonly kept: boolean } {
  const url = process.env['BACKUP_URL'];
  if (url) return { send: remoteBackupStore(url), kept: false };
  const dir = process.env['BACKUP_DIR'] || (existsSync(VOLUME) ? VOLUME : undefined);
  if (dir !== undefined) return { send: movingFrom(createBackupStore(dir), remoteBackupStore(MOVED_FROM_URL)), kept: true };
  if (hosted) return { send: remoteBackupStore(STORE_URL), kept: false };
  return { send: createBackupStore(laptopDir), kept: true };
}
