// A wallet's records on disk, for a host without a browser: one file sealed
// with AES-256-GCM under a key scrypt draws from a password, written whole on
// every change (temp file, fsync, rename), so a crash leaves the old file or
// the new one, never half of either.
//
// It has localStorage's shape, so the wallet's own code (frontend/src/lib)
// runs unchanged: installStorage() makes it the global one. One process holds
// a wallet at a time (a lock file): two would each spend the same notes and
// sign with the same few-time keys.

import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { join } from 'node:path';

const FILE = 'wallet.enc';
const LOCK = 'wallet.lock';
const AAD = Buffer.from('opaque/sdk/wallet/v1');
const KDF = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

interface Sealed { readonly v: 1; readonly salt: string; readonly iv: string; readonly tag: string; readonly data: string }

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

const pidIn = (path: string): number | null => {
  try { return Number(readFileSync(path, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
};

/**
 * Takes the wallet's lock. It appears only already naming this process
 * (written aside, then hard-linked in: atomic, and refused if one is there),
 * so a rival never reads an empty lock as a dead one. A dead holder's lock is
 * moved aside, which only one process can do, and checked to be that one.
 * ponytail: three processes racing over one dead holder's lock can still both
 * win; the cure is an OS lock (flock), which Node lacks.
 */
function takeLock(dir: string): void {
  const path = join(dir, LOCK);
  const mine = join(dir, `${LOCK}.${process.pid}.${randomBytes(4).toString('hex')}`);
  writeFileSync(mine, String(process.pid), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      try { linkSync(mine, path); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const holder = pidIn(path);
      if (holder === null) continue; // let go meanwhile
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) {
        throw new Error(`another process (${holder}) has the wallet in ${dir} open: one at a time, or both would spend the same notes. If no Opaque process is running, delete ${path}`);
      }
      const aside = join(dir, `${LOCK}.stale.${randomBytes(4).toString('hex')}`);
      try { renameSync(path, aside); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      // Taken after the look: a live lock moved by mistake goes straight back.
      if (pidIn(aside) !== holder) { try { linkSync(aside, path); } catch { /* another took its place */ } }
      unlinkSync(aside);
    }
    throw new Error(`could not lock the wallet in ${dir}`);
  } finally {
    unlinkSync(mine);
  }
}

/** Lets the lock go, only if it is still this process's. */
function dropLock(dir: string): void {
  const path = join(dir, LOCK);
  if (pidIn(path) === process.pid) unlinkSync(path);
}

function unseal(dir: string, password: string): { items: Map<string, string>; key: Buffer; salt: Buffer } {
  const sealed = JSON.parse(readFileSync(join(dir, FILE), 'utf8')) as Sealed;
  if (sealed.v !== 1) throw new Error(`the wallet in ${dir} is from a newer Opaque`);
  const salt = Buffer.from(sealed.salt, 'base64');
  const key = scryptSync(password, salt, 32, KDF);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  d.setAAD(AAD);
  d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  let plain: string;
  try { plain = Buffer.concat([d.update(Buffer.from(sealed.data, 'base64')), d.final()]).toString('utf8'); } catch { throw new Error('that password doesn\'t open this wallet'); }
  return { items: new Map(JSON.parse(plain) as [string, string][]), key, salt };
}

export class FileStore {
  readonly dir: string;
  #items: Map<string, string>;
  #key: Buffer;
  #salt: Buffer;
  #locked = true;
  readonly #release = () => this.close();

  private constructor(dir: string, items: Map<string, string>, key: Buffer, salt: Buffer) {
    this.dir = dir; this.#items = items; this.#key = key; this.#salt = salt;
    process.once('exit', this.#release);
  }

  static exists(dir: string): boolean { return existsSync(join(dir, FILE)); }

  /** A new, empty wallet file in `dir`. Refuses one that is there already. */
  static create(dir: string, password: string): FileStore {
    if (password.length < 8) throw new Error('use a password of 8 characters or more');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (FileStore.exists(dir)) throw new Error(`there is a wallet in ${dir} already`);
    takeLock(dir);
    const salt = randomBytes(16);
    const store = new FileStore(dir, new Map(), scryptSync(password, salt, 32, KDF), salt);
    store.#save();
    return store;
  }

  static open(dir: string, password: string): FileStore {
    if (!FileStore.exists(dir)) throw new Error(`there is no wallet in ${dir}: make one first`);
    takeLock(dir);
    try {
      const { items, key, salt } = unseal(dir, password);
      return new FileStore(dir, items, key, salt);
    } catch (error) {
      dropLock(dir);
      throw error;
    }
  }

  /** What the wallet holds, read without taking it: for a look while another process has it open. Never written. */
  static peek(dir: string, password: string): ReadonlyMap<string, string> {
    if (!FileStore.exists(dir)) throw new Error(`there is no wallet in ${dir}: make one first`);
    return unseal(dir, password).items;
  }

  get closed(): boolean { return !this.#locked; }
  get length(): number { return this.#items.size; }
  key(i: number): string | null { return [...this.#items.keys()][i] ?? null; }
  getItem(name: string): string | null { return this.#items.get(name) ?? null; }
  setItem(name: string, value: string): void { this.#items.set(name, String(value)); this.#save(); }
  removeItem(name: string): void { if (this.#items.delete(name)) this.#save(); }
  clear(): void { this.#items.clear(); this.#save(); }

  /** Lets the wallet go: another process may open it. */
  close(): void {
    if (!this.#locked) return;
    this.#locked = false;
    dropLock(this.dir);
    process.off('exit', this.#release);
  }

  #save(): void {
    if (!this.#locked) throw new Error('this wallet is closed');
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#key, iv);
    c.setAAD(AAD);
    const data = Buffer.concat([c.update(JSON.stringify([...this.#items])), c.final()]);
    const sealed: Sealed = { v: 1, salt: this.#salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
    const tmp = join(this.dir, `${FILE}.tmp`);
    const fd = openSync(tmp, 'w', 0o600);
    try { writeSync(fd, JSON.stringify(sealed)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, join(this.dir, FILE));
    const d = openSync(this.dir, 'r');
    try { fsyncSync(d); } finally { closeSync(d); }
  }
}

/**
 * Makes `store` this process's localStorage, which the wallet's code reads.
 * ponytail: one wallet per process; a second needs the runtimes to take a
 * store instead of the global.
 */
export function installStorage(store: FileStore): void {
  const current = (globalThis as { localStorage?: unknown }).localStorage;
  if (current instanceof FileStore && current !== store && !current.closed) {
    throw new Error('this process has another Opaque wallet open: one per process');
  }
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
}
