// The wallet password: everything this browser keeps that is secret, or says
// what you hold and whom you paid, sealed under it.
//
// A random data key seals each such record in local storage (the recovery
// phrase, imported keys, note secrets, app accounts, the passkey backup's
// keys, balances and payment history) and adds a layer to the Arc signing keys
// in IndexedDB. The password, stretched by PBKDF2, only wraps the data key, so
// changing it re-wraps one value. Unlocked, the data key sits in this tab's
// session (in the extension, chrome.storage.session, which never touches the
// disk), and goes after 15 idle minutes, with the tab, or with Lock now.
//
// Records are sealed and opened by the storage calls themselves: this module
// replaces localStorage's getItem and setItem, so every reader (the runtimes,
// the note vault, the backups) stays as it was. Locked, reading or writing one
// of them throws, and a page opens nothing until unlockGate() has the password.
//
// Import it before anything that reads storage.

import { gcm } from '@noble/ciphers/aes';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

import { IndexedDbSignerStore } from '../../../packages/pq-wallet/src/indexeddb-store.ts';
import type { SignerRecord } from '../../../packages/pq-wallet/src/signer-state.ts';

/** Every record that holds a secret, or says what you hold or whom you paid. */
export const SECRET = /^opaque:(xrpl-phrase|xrpl-imported|passkey-backup|xrpl-accounts|arc-accounts|xrpl-(notes|tags|activity|sites|note-counters|addresses|swap-tags)|xrpl:[0-9a-f]+:[a-z-]+|notes|sent|arc-note-next):v1/;
/** Arc's signing keys: backup.ts DEFAULT_STORE and arc-keys.ts arcStorageOf. */
const ARC_STORES = /^opaque-pq-account-v1/;
const META = 'opaque:lock:v1';
const SESSION = 'opaque:unlocked:v1';
const SEALED = 'sealed:v1:';
const IDLE_MS = 15 * 60_000;
const ITERATIONS = 600_000;
export const MIN_PASSWORD = 8;

/** `id` names the data key, not secret: a tab whose key is no longer the stored one (reset, or a new password from scratch elsewhere) locks. */
interface Meta { readonly v: 1; readonly id: string; readonly salt: string; readonly iterations: number; readonly wrapped: string }

const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const join = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

/** AES-256-GCM, synchronous, so a write is sealed before the call returns: a reload never loses it. */
export const sealWith = (key: Uint8Array, data: Uint8Array): Uint8Array => { const iv = random(12); return join(iv, gcm(key, iv).encrypt(data)); };
export const openWith = (key: Uint8Array, box: Uint8Array): Uint8Array => gcm(key, box.slice(0, 12)).decrypt(box.slice(12));

let dataKey: Uint8Array | null = null;
/** Meta.id of the data key this tab holds. */
let keyId: string | null = null;
const native = typeof Storage === 'undefined' ? undefined : { get: Storage.prototype.getItem, set: Storage.prototype.setItem };
const rawGet = (name: string): string | null => native!.get.call(localStorage, name);
const meta = (): Meta | null => { try { return JSON.parse(rawGet(META) ?? 'null') as Meta | null; } catch { return null; } };
let locking = native !== undefined && meta() !== null;

export const hasPassword = (): boolean => locking;
export const isLocked = (): boolean => locking && dataKey === null;
const locked = () => new Error('Opaque is locked: unlock it with your password');
/** This tab's key is the stored one; if another tab reset the wallet or made a new one, this tab locks rather than seal under a key nobody can open. */
function current(): Uint8Array {
  if (dataKey === null) throw locked();
  if (meta()?.id !== keyId) { dataKey = null; void lockNow(); throw locked(); }
  return dataKey;
}

// ── the storage calls, sealing and opening as they go ─────────────────────
const opened = new Map<string, readonly [string, string]>();
if (native !== undefined) {
  Storage.prototype.getItem = function (this: Storage, name: string): string | null {
    const value = native.get.call(this, name);
    if (value === null || !value.startsWith(SEALED)) return value;
    const key = current();
    const hit = opened.get(name);
    if (hit?.[0] === value) return hit[1];
    const plain = new TextDecoder().decode(openWith(key, unb64(value.slice(SEALED.length))));
    opened.set(name, [value, plain]);
    return plain;
  };
  Storage.prototype.setItem = function (this: Storage, name: string, value: string): void {
    if (locking && this === localStorage && SECRET.test(name)) {
      const sealed = SEALED + b64(sealWith(current(), utf8(String(value))));
      opened.set(name, [sealed, String(value)]);
      value = sealed;
    }
    native.set.call(this, name, value);
  };
}

// Another tab set a password, reset the wallet or made a new one: this tab
// follows at once, onto the lock screen or onboarding, rather than read or
// seal under a key that is no longer the wallet's.
if (native !== undefined) {
  addEventListener('storage', (e) => {
    if (e.key !== META && e.key !== null) return;
    locking = meta() !== null;
    if ((meta()?.id ?? null) !== keyId) void lockNow();
  });
}

// ── Arc's signing keys: a second layer on the seed's ciphertext ───────────
// The same length, so the signing package's own checks pass, and the same
// for the same key, so a record stays itself from one write to the next.
const keystream = (id: string, iv: Uint8Array): Uint8Array =>
  join(hmac(sha256, dataKey!, join(utf8(`arc-seed/${id}/0/`), iv)), hmac(sha256, dataKey!, join(utf8(`arc-seed/${id}/1/`), iv))).slice(0, 48);
type Sealable = SignerRecord & { readonly sealed?: 1 };
const xorSeed = (r: SignerRecord): Uint8Array<ArrayBuffer> => { const k = keystream(r.id, r.iv); return Uint8Array.from(r.encryptedSeed, (b, i) => b ^ k[i]!); };
function sealRecord(r: Sealable): Sealable {
  if (!locking || r.sealed === 1) return r;
  current();
  return { ...r, encryptedSeed: xorSeed(r), sealed: 1 };
}
function openRecord(r: Sealable | undefined): SignerRecord | undefined {
  if (r === undefined || r.sealed !== 1) return r;
  current();
  const { sealed: _, ...plain } = { ...r, encryptedSeed: xorSeed(r) };
  return plain;
}

type Id = Parameters<IndexedDbSignerStore['read']>[0];
/** Arc's key store, sealed under the password once there is one. Use it wherever the plain one was. */
export class SealedSignerStore extends IndexedDbSignerStore {
  override async read(id: Id): Promise<SignerRecord | undefined> { return openRecord(await super.read(id)); }
  override transact<T>(id: Id, update: (current: SignerRecord | undefined) => { record: SignerRecord; result: T }): Promise<T> {
    return super.transact(id, (current) => {
      const change = update(openRecord(current));
      return { record: sealRecord(change.record), result: change.result };
    });
  }
  override restore(id: Id, record: SignerRecord): Promise<void> { return super.restore(id, sealRecord(record)); }
}

/** Every IndexedDB database of Arc keys this browser holds. */
const arcStores = async (): Promise<string[]> => ((await indexedDB.databases?.()) ?? []).map((d) => d.name ?? '').filter((n) => ARC_STORES.test(n));

/** Runs `change` over every Arc key record, in one transaction per database. */
async function eachArcRecord(change: (r: Sealable) => Sealable | undefined): Promise<void> {
  for (const name of await arcStores()) {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('signers')) { db.close(); resolve(); return; }
        const tx = db.transaction('signers', 'readwrite', { durability: 'strict' });
        const cursor = tx.objectStore('signers').openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (c === null) return;
          const next = change(c.value as Sealable);
          if (next !== undefined) c.update(next);
          c.continue();
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }
}

/** Seals whatever is still in the clear: records from before the password, or a write a crash cut short. */
async function sealRemaining(): Promise<void> {
  for (let i = 0; i < localStorage.length; i++) {
    const name = localStorage.key(i)!;
    const value = rawGet(name);
    if (SECRET.test(name) && value !== null && !value.startsWith(SEALED)) localStorage.setItem(name, value);
  }
  await eachArcRecord((r) => (r.sealed === 1 ? undefined : sealRecord(r)));
}

// ── the password ──────────────────────────────────────────────────────────
async function stretch(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, base, 256));
}
async function wrap(password: string, key: Uint8Array, id: string): Promise<Meta> {
  const salt = random(16);
  return { v: 1, id, salt: b64(salt), iterations: ITERATIONS, wrapped: b64(sealWith(await stretch(password, salt, ITERATIONS), key)) };
}
/** The data key the password opens, or null for the wrong password. */
async function unwrap(password: string, m: Meta): Promise<Uint8Array | null> {
  try { return openWith(await stretch(password, unb64(m.salt), m.iterations), unb64(m.wrapped)); } catch { return null; }
}

/** Locks this wallet with a password: everything secret it holds is sealed under it now. */
export async function setPassword(password: string): Promise<void> {
  if (locking) throw new Error('this wallet has a password already');
  if (password.length < MIN_PASSWORD) throw new Error(`a password is at least ${MIN_PASSWORD} characters`);
  const key = random(32);
  const m = await wrap(password, key, b64(random(9)));
  dataKey = key;
  keyId = m.id;
  native!.set.call(localStorage, META, JSON.stringify(m));
  locking = true;
  await sealRemaining();
  await keepSession();
}

export async function changePassword(current: string, next: string): Promise<void> {
  const m = meta();
  if (m === null || dataKey === null) throw locked();
  if (next.length < MIN_PASSWORD) throw new Error(`a password is at least ${MIN_PASSWORD} characters`);
  const key = await unwrap(current, m);
  if (key === null || b64(key) !== b64(dataKey)) throw new Error('that is not the current password');
  native!.set.call(localStorage, META, JSON.stringify(await wrap(next, key, m.id)));
}

// ── the unlocked session ──────────────────────────────────────────────────
type Session = { readonly key: string; readonly id: string; readonly until: number };
const extensionSession = (globalThis as { chrome?: { storage?: { session?: {
  get(k: string): Promise<Record<string, unknown>>; set(o: Record<string, unknown>): Promise<void>; remove(k: string): Promise<void>;
} } } }).chrome?.storage?.session;
async function readSession(): Promise<Session | null> {
  try {
    return extensionSession !== undefined ? ((await extensionSession.get(SESSION))[SESSION] as Session | undefined) ?? null
      : JSON.parse(sessionStorage.getItem(SESSION) ?? 'null') as Session | null;
  } catch { return null; }
}
async function keepSession(): Promise<void> {
  if (dataKey === null) return;
  const s: Session = { key: b64(dataKey), id: keyId ?? '', until: Date.now() + IDLE_MS };
  try { if (extensionSession !== undefined) await extensionSession.set({ [SESSION]: s }); else sessionStorage.setItem(SESSION, JSON.stringify(s)); } catch { /* this page stays unlocked */ }
}
async function dropSession(): Promise<void> {
  try { if (extensionSession !== undefined) await extensionSession.remove(SESSION); else sessionStorage.removeItem(SESSION); } catch { /* gone with the tab */ }
}

/** Locks now: the data key is forgotten here and in the session, and the page opens on the lock screen. */
export async function lockNow(): Promise<void> {
  dataKey = null;
  keyId = null;
  opened.clear();
  await dropSession();
  location.reload();
}

/** Forgotten password: removes this wallet from this browser, to be restored from its phrase or passkey. */
async function reset(): Promise<void> {
  for (const name of Object.keys(localStorage)) if (SECRET.test(name) || name === META) localStorage.removeItem(name);
  for (const name of await arcStores()) indexedDB.deleteDatabase(name);
  locking = false;
  dataKey = null;
  await dropSession();
  location.reload();
}

/** After IDLE_MS without a key or a tap, locks; until then, keeps the session alive. */
function lockWhenIdle(): void {
  let last = Date.now();
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(type, () => { last = Date.now(); }, { passive: true });
  setInterval(() => {
    if (Date.now() - last > IDLE_MS) void lockNow();
    else void keepSession();
  }, 30_000);
}

/** Keys or notes in this browser: a phrase, an imported account key, notes, or Arc signing keys. */
async function holdsWallet(): Promise<boolean> {
  const held = Object.keys(localStorage).some((name) => /^opaque:(xrpl-phrase|xrpl-imported|xrpl-notes|notes):v1/.test(name)
    && !['{}', '[]', 'null', '""'].includes(rawGet(name) ?? 'null'));
  if (held) return true;
  let signers = false;
  await eachArcRecord(() => { signers = true; return undefined; });
  return signers;
}

/**
 * Before anything reads the wallet: an empty browser goes on to onboarding,
 * which sets the password; a wallet without one (made before passwords) must
 * set one now; with one, the data key from this session, or the lock screen.
 */
export async function unlockGate(): Promise<void> {
  // Says on the page whether it is past the lock (for the browser tests, and nothing else).
  const opened = () => { document.documentElement.dataset['lock'] = 'open'; };
  if (!locking && !(await holdsWallet())) { opened(); return; }
  if (!locking) await askNewPassword();
  if (dataKey === null) {
    const s = await readSession();
    if (s !== null && s.until > Date.now() && s.id === meta()?.id) { dataKey = unb64(s.key); keyId = s.id; }
  }
  if (dataKey === null) await askPassword();
  await keepSession();
  await sealRemaining();
  lockWhenIdle();
  opened();
}

const MARK = '<svg viewBox="0 0 40 40" aria-hidden="true"><g fill="#070608"><rect x="9" y="18" width="22" height="16" rx="3.5"/><path d="M13.5 18v-4.5a6.5 6.5 0 0 1 13 0V18" fill="none" stroke="#070608" stroke-width="3.4"/></g></svg>';

/** A card over everything: the lock screen, or the first password. */
function cover(inner: string): HTMLElement {
  const screen = document.createElement('section');
  screen.className = 'lock';
  screen.innerHTML = `<form class="lock-card" novalidate><div class="ob-mark still">${MARK}</div>${inner}</form>`;
  document.body.append(screen);
  return screen;
}

/** A wallet from before passwords: no way past this until it has one. */
function askNewPassword(): Promise<void> {
  const screen = cover(`<h1 class="ob-title">Set a password</h1>
    <p class="lede">Your recovery phrase and keys are in this browser unencrypted. A password encrypts them, and Opaque asks for it when it opens. It can't be recovered: your recovery phrase brings the wallet back without it.</p>
    <label class="field" for="lock-new"><span>Password, at least ${MIN_PASSWORD} characters</span><input id="lock-new" type="password" autocomplete="new-password" required></label>
    <label class="field" for="lock-new2"><span>Again</span><input id="lock-new2" type="password" autocomplete="new-password" required></label>
    <button class="primary" id="lock-new-go" type="submit">Encrypt this wallet</button>
    <p class="status" id="lock-status" role="status"></p>`);
  const [pass, again] = ['#lock-new', '#lock-new2'].map((q) => screen.querySelector<HTMLInputElement>(q)!) as [HTMLInputElement, HTMLInputElement];
  const status = screen.querySelector<HTMLElement>('#lock-status')!;
  const go = screen.querySelector<HTMLButtonElement>('#lock-new-go')!;
  pass.focus();
  return new Promise((resolve) => {
    screen.querySelector('form')!.addEventListener('submit', (e) => void (async () => {
      e.preventDefault();
      if (pass.value.length < MIN_PASSWORD) { status.textContent = `At least ${MIN_PASSWORD} characters.`; return; }
      if (pass.value !== again.value) { status.textContent = 'The two passwords don\'t match.'; return; }
      go.disabled = true;
      status.textContent = 'Encrypting this wallet under it…';
      try { await setPassword(pass.value); } catch (error) { status.textContent = `Not set: ${(error as Error).message}`; go.disabled = false; return; }
      screen.remove();
      resolve();
    })());
  });
}

/**
 * The password again, before the phrase or an account key is shown: true once
 * it is given, false if cancelled. A modal dialog, so it sits above any other.
 */
export function confirmPassword(what: string): Promise<boolean> {
  const m = meta();
  if (m === null) return Promise.resolve(true);
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `<form class="lock-card" method="dialog" novalidate>
    <div class="ob-mark still">${MARK}</div>
    <p class="lede">Your password, to show ${what}.</p>
    <label class="field" for="confirm-password"><span>Password</span><input id="confirm-password" type="password" autocomplete="current-password" required></label>
    <div class="dialog-actions"><button class="secondary" id="confirm-cancel" type="button">Cancel</button><button class="primary" id="confirm-go" type="submit">Show</button></div>
    <p class="status" id="confirm-status" role="status"></p>
  </form>`;
  document.body.append(dialog);
  const input = dialog.querySelector<HTMLInputElement>('#confirm-password')!;
  const status = dialog.querySelector<HTMLElement>('#confirm-status')!;
  const go = dialog.querySelector<HTMLButtonElement>('#confirm-go')!;
  dialog.showModal();
  return new Promise((resolve) => {
    const done = (ok: boolean) => { dialog.close(); dialog.remove(); resolve(ok); };
    dialog.addEventListener('cancel', () => done(false));
    dialog.querySelector('#confirm-cancel')!.addEventListener('click', () => done(false));
    dialog.querySelector('form')!.addEventListener('submit', (e) => void (async () => {
      e.preventDefault();
      go.disabled = true;
      status.textContent = 'Checking…';
      const key = await unwrap(input.value, m);
      go.disabled = false;
      if (key === null || dataKey === null || b64(key) !== b64(dataKey)) { status.textContent = 'That isn\'t the password.'; input.select(); return; }
      done(true);
    })());
  });
}

/** The lock screen, over everything, until the password opens the data key. */
function askPassword(): Promise<void> {
  const screen = cover(`
    <h1 class="ob-title">Welcome back</h1>
    <p class="lede">Opaque is locked. Your password opens it.</p>
    <label class="field" for="lock-password"><span>Password</span><input id="lock-password" type="password" autocomplete="current-password" required></label>
    <button class="primary" id="lock-go" type="submit">Unlock</button>
    <p class="status" id="lock-status" role="status"></p>
    <button class="link lock-forgot" id="lock-forgot" type="button">Forgot your password?</button>
    <div class="lock-reset" id="lock-reset" hidden>
      <p>Opaque can't recover it. Reset removes this wallet from this browser; restore it after with your recovery phrase or passkey. Notes kept only in this browser, in a Browser account, are lost unless a passkey backup holds them.</p>
      <button class="secondary" id="lock-reset-go" type="button">Reset this browser's wallet</button>
    </div>`);
  const input = screen.querySelector<HTMLInputElement>('#lock-password')!;
  const status = screen.querySelector<HTMLElement>('#lock-status')!;
  const go = screen.querySelector<HTMLButtonElement>('#lock-go')!;
  input.focus();
  screen.querySelector('#lock-forgot')!.addEventListener('click', () => { screen.querySelector<HTMLElement>('#lock-reset')!.hidden = false; });
  screen.querySelector('#lock-reset-go')!.addEventListener('click', () => {
    if (confirm('Remove this wallet from this browser? You will need your recovery phrase or passkey to bring it back.')) void reset();
  });
  return new Promise((resolve) => {
    screen.querySelector('form')!.addEventListener('submit', (e) => void (async () => {
      e.preventDefault();
      go.disabled = true;
      status.textContent = 'Unlocking…';
      const key = await unwrap(input.value, meta()!);
      go.disabled = false;
      if (key === null) { status.textContent = 'That password doesn\'t open this wallet.'; input.select(); return; }
      dataKey = key;
      keyId = meta()!.id;
      screen.remove();
      resolve();
    })());
  });
}
