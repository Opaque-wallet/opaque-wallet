// A passkey backup: what this browser alone holds of the wallet, sealed here
// and kept by Opaque, so clearing the browser costs nothing.
//
// The passkey (Touch ID, Face ID, a phone or a password manager, synced by
// iCloud Keychain, Google Password Manager or 1Password) gives the page the
// same secret every time, through WebAuthn's PRF extension. From it the page
// works out the id the backup is kept under, the token that lets it write
// there, and the key that wraps the backup's own key. Opaque's store
// (backend/mesh/backup-store.ts) is asked through the relays and keeps
// ciphertext under an id it cannot link to anyone.
//
//   backup = 1 ‖ AES-GCM(wrap key, data key) ‖ AES-GCM(data key, gzip(contents))
//
// The data key stays in this browser, so a deposit re-seals the backup without
// asking for the passkey; once the browser is cleared, the passkey unwraps it.
//
// Contents: the recovery phrase, imported accounts' keys, and the XRPL browser
// account's unspent notes, deposit tags and app accounts. Arc's browser
// account is left out: its few-time signing key must never come back from a
// copy older than its last signature.

import type { BackupOperation, Hex } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { BASE_BITS, findWork } from '../../../backend/mesh/backup-work.ts';
import { importedKeyTexts, restoreImportedKeys, savePhrase, saveWalletState, storedPhrase, walletState } from './wallet-keys.ts';

export type BackupTransport = (operation: BackupOperation, encodedRequest: Hex) => Promise<Hex>;

/** What this browser keeps to re-seal the backup without the passkey. Secret, like the phrase beside it. */
interface Local {
  readonly id: string;
  readonly token: string;
  readonly dataKey: string;
  readonly wrapped: string;
  readonly credential: string;
  /** The contents last sent, hashed: unchanged contents are not sent again. */
  readonly hash?: string;
  readonly savedAt?: number;
  /** The browser account's notes made the backup too big to keep, and were left out. */
  readonly leftOut?: boolean;
  /** Which store it was last sent to (STORE). */
  readonly store?: string;
  /** The work a new id cost (backend/mesh/backup-work.ts), kept for sending it to a new store. */
  readonly work?: string;
}
interface Contents { readonly v: 1; readonly phrase: string | null; readonly imported: readonly string[]; readonly xrpl: Readonly<Record<string, string>>; readonly accounts?: number }

const LOCAL = 'opaque:passkey-backup:v1';
/** The store backups are kept in now: a backup last sent to an earlier one is sent again, once. */
const STORE = 'mainnet-1';
/** backend/mesh/backup-store.ts MAX_BLOB. */
const MAX_BLOB = 24_000;
/** The XRPL browser account's records: xrpl/runtime.ts storageOf(null). */
const XRPL_BROWSER = /^opaque:xrpl-(notes|tags|sites):v1(@[a-z-]+)?$/;
const WRAPPED = 12 + 32 + 16;
/** Saved again at least this often, so the store never counts it stale (backup-store.ts STALE_MS). */
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (b: Uint8Array) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => unb64(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const through = async (b: Uint8Array, stream: GenericTransformStream) => new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());
const aes = (raw: Uint8Array) => crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
async function seal(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = random(12);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data as BufferSource));
  return new Uint8Array([...iv, ...sealed]);
}
const open = async (key: CryptoKey, box: Uint8Array) => new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.slice(0, 12) }, key, box.slice(12)));

export const backupState = (): Local | null => { try { return JSON.parse(localStorage.getItem(LOCAL) ?? 'null') as Local | null; } catch { return null; } };
const saveLocal = (local: Local) => localStorage.setItem(LOCAL, JSON.stringify(local));

/** opaque.credit's passkeys serve www and the bare domain; elsewhere, the page's own host. */
const rpId = (): string | undefined => (/(^|\.)opaque\.credit$/.test(location.hostname) ? 'opaque.credit' : undefined);
const SALT = utf8('opaque/passkey-backup/v1');
const NO_PRF = 'This passkey can\'t make the secret a backup needs. Use a recent browser with iCloud Keychain, Google Password Manager, 1Password or a security key.';

/** Whether this browser could make one; false only when it says so outright. */
export async function passkeySupported(): Promise<boolean> {
  if (typeof PublicKeyCredential === 'undefined' || !isSecureContext) return false;
  const capabilities = await (PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> })
    .getClientCapabilities?.().catch(() => undefined);
  return capabilities?.['extension:prf'] !== false;
}

/** Whether there is anything the browser alone holds: a phrase, an imported key, or browser-account notes. */
export const hasSomethingToBackUp = (): boolean => storedPhrase() !== null || importedKeyTexts().length > 0 || Object.keys(contents(true).xrpl).some((k) => k.includes('-notes:'));

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

/** Asks for a passkey (one of `allow`, or any of this site's) and its PRF secret. */
async function usePasskey(allow: readonly Uint8Array[] | null): Promise<{ credential: Uint8Array; prf: Uint8Array }> {
  const id = rpId();
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: random(32), userVerification: 'required', ...(id === undefined ? {} : { rpId: id }),
      ...(allow === null ? {} : { allowCredentials: allow.map((c) => ({ type: 'public-key' as const, id: c as BufferSource })) }),
      extensions: { prf: { eval: { first: SALT } } } as AuthenticationExtensionsClientInputs,
    },
  }).catch((error: unknown) => {
    // The browser says only "not allowed", whether the prompt was closed or it has no passkey for this site.
    throw (error as Error).name === 'NotAllowedError' ? new Error('No passkey was chosen, or this browser has no Opaque passkey.') : error;
  }) as PublicKeyCredential | null;
  if (credential === null) throw new Error('No passkey was chosen.');
  const first = (credential.getClientExtensionResults() as PrfResults).prf?.results?.first;
  if (first === undefined) throw new Error(NO_PRF);
  return { credential: new Uint8Array(credential.rawId), prf: new Uint8Array(first) };
}

/** Makes a passkey for this wallet and returns its PRF secret: at once if the authenticator gives it, else by using it. */
async function newPasskey(): Promise<{ credential: Uint8Array; prf: Uint8Array }> {
  const id = rpId();
  const made = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Opaque', ...(id === undefined ? {} : { id }) },
      user: { id: random(16), name: `Opaque wallet · ${new Date().toLocaleDateString()}`, displayName: 'Opaque wallet' },
      challenge: random(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      extensions: { prf: { eval: { first: SALT } } } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null;
  if (made === null) throw new Error('No passkey was made.');
  const credential = new Uint8Array(made.rawId);
  const prf = (made.getClientExtensionResults() as PrfResults).prf;
  if (prf?.enabled === false) { forget(credential); throw new Error(NO_PRF); }
  const first = prf?.results?.first;
  return first === undefined ? usePasskey([credential]) : { credential, prf: new Uint8Array(first) };
}

/** Tells the password manager a passkey is no use any more, where the browser can (Chrome 132+). */
function forget(credential: Uint8Array): void {
  const signal = (PublicKeyCredential as unknown as { signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void> }).signalUnknownCredential;
  void signal?.call(PublicKeyCredential, { rpId: rpId() ?? location.hostname, credentialId: b64url(credential) }).catch(() => undefined);
}

/** The backup's id, its write token and its wrap key: the same from the same passkey, anywhere. */
async function keysOf(prf: Uint8Array): Promise<{ id: string; token: string; wrap: CryptoKey }> {
  const base = await crypto.subtle.importKey('raw', prf as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = async (info: string) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) }, base, 256));
  return { id: hex(await bits('opaque/backup/id')), token: hex(await bits('opaque/backup/token')), wrap: await aes(await bits('opaque/backup/wrap')) };
}

async function call<T>(send: BackupTransport, operation: BackupOperation, request: unknown): Promise<T> {
  const answer = JSON.parse(new TextDecoder().decode(fromHex(await send(operation, toHex(utf8(JSON.stringify(request))))))) as { result?: T; error?: { message: string } };
  if (answer.error !== undefined) throw new Error(answer.error.message);
  return answer.result as T;
}

/** What the backup holds. A spent note is left out: it can't be spent again, and the backup stays small. */
function contents(withBrowser: boolean): Contents {
  const xrpl: Record<string, string> = {};
  for (let i = 0; withBrowser && i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    const value = localStorage.getItem(key);
    if (!XRPL_BROWSER.test(key) || value === null) continue;
    if (!key.includes('-notes:')) { xrpl[key] = value; continue; }
    const notes = Object.entries(JSON.parse(value) as Record<string, { state?: string }>).filter(([, n]) => n.state !== 'SPENT');
    if (notes.length > 0) xrpl[key] = JSON.stringify(Object.fromEntries(notes));
  }
  return { v: 1, phrase: storedPhrase(), imported: importedKeyTexts(), xrpl, accounts: walletState().count };
}

async function blobOf(local: Local, body: Uint8Array): Promise<string> {
  const sealed = await seal(await aes(unhex(local.dataKey)), await through(body, new CompressionStream('gzip')));
  return b64(new Uint8Array([1, ...unb64(local.wrapped), ...sealed]));
}

/**
 * Sends the backup again if what it holds has changed (or `force`). The
 * browser account's notes are left out when they would make it too big:
 * `leftOut` says so, and the page tells the person.
 */
export async function syncBackup(send: BackupTransport, force = false): Promise<Local | null> {
  const local = backupState();
  if (local === null) return null;
  const body = utf8(JSON.stringify(contents(true)));
  const hash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', body)));
  if (!force && hash === local.hash && local.store === STORE && Date.now() - (local.savedAt ?? 0) < REFRESH_MS) return local;
  let blob = await blobOf(local, body);
  const leftOut = blob.length > MAX_BLOB;
  if (leftOut) blob = await blobOf(local, utf8(JSON.stringify(contents(false))));
  const work = await put(send, local, blob);
  const saved = { ...local, hash, savedAt: Date.now(), leftOut, store: STORE, ...(work === undefined ? {} : { work }) };
  saveLocal(saved);
  return saved;
}

/**
 * PUT, with the work a new id costs: the store says how many bits it wants
 * when what was sent falls short (it rises as the store fills), and the work
 * is done then. An update to a backup already kept needs none.
 */
async function put(send: BackupTransport, local: Local, blob: string): Promise<string | undefined> {
  let work = local.work;
  for (let attempt = 0; ; attempt++) {
    try {
      await call(send, 'PUT', { id: local.id, token: local.token, blob, ...(work === undefined ? {} : { work }) });
      return work;
    } catch (error) {
      const bits = /needs (\d+) bits of work/.exec((error as Error).message)?.[1];
      if (bits === undefined || attempt >= 3) throw error;
      work = await findWork(local.id, Number(bits));
    }
  }
}

/** Makes a passkey and the first backup under it. */
export async function createBackup(send: BackupTransport): Promise<Local> {
  const { credential, prf } = await newPasskey();
  try {
    const keys = await keysOf(prf);
    const dataKey = random(32);
    // A new id costs work: done now, at the least the store asks, while the passkey prompt is fresh.
    const work = await findWork(keys.id, BASE_BITS);
    saveLocal({ id: keys.id, token: keys.token, dataKey: hex(dataKey), wrapped: b64(await seal(keys.wrap, dataKey)), credential: b64url(credential), work });
    return (await syncBackup(send, true))!;
  } catch (error) {
    localStorage.removeItem(LOCAL);
    forget(credential);
    throw error;
  }
}

/** Brings back what a passkey's backup holds; refuses to replace another wallet's phrase. */
export async function restoreFromPasskey(send: BackupTransport): Promise<{ readonly phrase: boolean; readonly imported: number; readonly browser: boolean }> {
  const { credential, prf } = await usePasskey(null);
  const keys = await keysOf(prf);
  const kept = await call<{ blob: string } | null>(send, 'GET', { id: keys.id });
  if (kept === null) throw new Error('That passkey has no Opaque backup. It may have been removed, or made on another Opaque site.');
  const box = unb64(kept.blob);
  if (box[0] !== 1) throw new Error('That backup was made by a newer Opaque: reload the page and try again.');
  const wrapped = box.slice(1, 1 + WRAPPED);
  const dataKey = await open(keys.wrap, wrapped);
  const c = JSON.parse(new TextDecoder().decode(await through(await open(await aes(dataKey), box.slice(1 + WRAPPED)), new DecompressionStream('gzip')))) as Contents;
  const here = storedPhrase();
  if (c.phrase !== null && here !== null && here !== c.phrase) throw new Error('This browser holds another wallet\'s recovery phrase. Restore in a browser without one.');
  if (c.phrase !== null && here === null) savePhrase(c.phrase, true, 0);
  // Every account it showed, Account 2 included, even one that never received anything.
  if (c.phrase !== null && c.accounts !== undefined && c.accounts > walletState().count) saveWalletState({ count: c.accounts });
  restoreImportedKeys(c.imported);
  for (const [key, value] of Object.entries(c.xrpl)) if (XRPL_BROWSER.test(key) && localStorage.getItem(key) === null) localStorage.setItem(key, value);
  // Kept here again, so the next change re-seals it without the passkey.
  saveLocal({ id: keys.id, token: keys.token, dataKey: hex(dataKey), wrapped: b64(wrapped), credential: b64url(credential) });
  return { phrase: c.phrase !== null, imported: c.imported.length, browser: Object.keys(c.xrpl).length > 0 };
}

/** Removes the backup from Opaque's store, and its passkey from the password manager where the browser can. */
export async function removeBackup(send: BackupTransport): Promise<void> {
  const local = backupState();
  if (local === null) return;
  await call(send, 'DELETE', { id: local.id, token: local.token });
  localStorage.removeItem(LOCAL);
  forget(unb64url(local.credential));
}
