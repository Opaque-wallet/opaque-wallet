// The recovery phrase, and the accounts it makes.
//
// A wallet is one 12-word phrase (BIP-39). Each account of it, Account 1, 2, …,
// is a private wallet of its own: its notes, its deposit tags and its apps'
// accounts. Every secret an account holds is drawn from the phrase, never from
// the browser's randomness, so the same phrase finds the same notes and the
// same app accounts in the extension, on the website or on a phone:
//
//   root        HMAC-SHA256("opaque/xrpl/v1", BIP-39 seed)
//   account n   HMAC-SHA256(root, "account/n")
//   a secret    HMAC-SHA256(account, "<label>#<block>"), block by block
//
// Labels: `note/<network>/<pool>/<size>/<i>` per note, `site/<origin>` per app.
// Nothing here leaves the page. The phrase sits in this origin's storage beside
// the notes, which are secrets of the same weight.

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

import { scoped } from './storage-name.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Spaces and case don't matter in a phrase someone types back. */
export const normalizePhrase = (phrase: string): string => phrase.trim().toLowerCase().split(/\s+/).join(' ');
export const newPhrase = (): string => generateMnemonic(wordlist, 128);
export const isPhrase = (phrase: string): boolean => validateMnemonic(normalizePhrase(phrase), wordlist);

export interface AccountKeys {
  /** 0 for Account 1. */
  readonly index: number;
  /** Secret: what every secret of this account is drawn from. */
  readonly key: Uint8Array;
  /** Public and stable: names the account's storage, and nothing else. */
  readonly id: string;
  /** Set for an account brought in by its key: its place among the imported ones. */
  readonly imported?: number;
}

// The BIP-39 seed takes 2048 rounds of PBKDF2: once per phrase per page, not once per account.
const roots = new Map<string, Uint8Array>();
function rootOf(phrase: string): Uint8Array {
  const normal = normalizePhrase(phrase);
  let root = roots.get(normal);
  if (root === undefined) {
    if (!validateMnemonic(normal, wordlist)) throw new Error('that is not a 12-word recovery phrase');
    root = hmac(sha256, utf8('opaque/xrpl/v1'), mnemonicToSeedSync(normal));
    roots.set(normal, root);
  }
  return root;
}

export function accountKeys(phrase: string, index: number): AccountKeys {
  const key = hmac(sha256, rootOf(phrase), utf8(`account/${index}`));
  return { index, key, id: hex(sha256(key)).slice(0, 16) };
}

/** Bytes that are the same every time for the same account and label: what a derived secret draws from. */
export function stream(key: Uint8Array, label: string): (n: number) => Uint8Array {
  let block = 0;
  let buffer = new Uint8Array(0);
  return (n) => {
    while (buffer.length < n) {
      const next = hmac(sha256, key, utf8(`${label}#${block++}`));
      const joined = new Uint8Array(buffer.length + next.length);
      joined.set(buffer);
      joined.set(next, buffer.length);
      buffer = joined;
    }
    const out = buffer.slice(0, n);
    buffer = buffer.slice(n);
    return out;
  };
}

// ── one account's key: the account without the phrase ─────────────────────
// `opq1`, the 32-byte key in hex, and 4 bytes of checksum: a typo is caught
// instead of opening an empty account, and the prefix keeps it from passing
// for another chain's private key.
const keyCheck = (key: Uint8Array) => hex(sha256(new Uint8Array([...utf8('opaque/xrpl/account-key'), ...key]))).slice(0, 8);
const idOfKey = (key: Uint8Array) => hex(sha256(key)).slice(0, 16);

/** An account's key as text. Whoever holds it can spend that account, as the phrase can spend them all. */
export const accountKeyText = (account: AccountKeys): string => `opq1${hex(account.key)}${keyCheck(account.key)}`;
export const isAccountKeyText = (text: string): boolean => /^opq1[0-9a-f]{72}$/i.test(text.trim());

function keyFromText(text: string): Uint8Array {
  const t = text.trim().toLowerCase();
  if (!/^opq1[0-9a-f]{72}$/.test(t)) throw new Error('an account key is opq1 and then 72 letters and digits');
  const key = Uint8Array.from(t.slice(4, 68).match(/../g)!.map((b) => parseInt(b, 16)));
  if (keyCheck(key) !== t.slice(68)) throw new Error('that account key has a typo: its last 8 characters don\'t match the rest');
  return key;
}
export const accountFromKeyText = (text: string, slot: number): AccountKeys => {
  const key = keyFromText(text);
  return { index: slot, key, id: idOfKey(key), imported: slot };
};

// ── what this browser holds ───────────────────────────────────────────────

const PHRASE_KEY = scoped('opaque:xrpl-phrase:v1');
const IMPORTED_KEY = scoped('opaque:xrpl-imported:v1');
const STATE_KEY = scoped('opaque:xrpl-accounts:v1');

/** A phrase account's number; 'browser', the wallet from before recovery phrases; or an imported account's place. */
export type ActiveAccount = number | 'browser' | `imported:${number}`;
export interface WalletState {
  /** How many accounts of the phrase are shown: Account 1 to Account `count`. */
  readonly count: number;
  readonly active: ActiveAccount;
  /** The last XRP balance each account showed, by account id ('browser' for the browser wallet), for the account list. */
  readonly balances: Readonly<Record<string, number>>;
  /** Brought from elsewhere: its accounts' notes are looked for on the ledger, each the first time it opens. */
  readonly imported: boolean;
  /** Accounts already looked for, by id. */
  readonly scanned: Readonly<Record<string, boolean>>;
}

const read = <T>(key: string): T | null => { try { return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null; } catch { return null; } };

export const storedPhrase = (): string | null => read<string>(PHRASE_KEY);
export const walletState = (): WalletState => ({ count: 1, active: 0, balances: {}, imported: false, scanned: {}, ...read<Partial<WalletState>>(STATE_KEY) });
export const saveWalletState = (next: Partial<WalletState>): void => localStorage.setItem(STATE_KEY, JSON.stringify({ ...walletState(), ...next }));

/** Stores a phrase: a new wallet, or one brought from elsewhere (`imported`), which opens on `active`. */
export function savePhrase(phrase: string, imported: boolean, active: ActiveAccount = 0): void {
  if (!isPhrase(phrase)) throw new Error('that is not a 12-word recovery phrase');
  localStorage.setItem(PHRASE_KEY, JSON.stringify(normalizePhrase(phrase)));
  saveWalletState({ count: 1, active, imported, scanned: {} });
}

export const importedAccounts = (): AccountKeys[] => (read<string[]>(IMPORTED_KEY) ?? []).map((text, slot) => accountFromKeyText(text, slot));

/** Keeps an account brought in by its key and makes it the one that opens; refuses one already here. */
export function importAccountKey(text: string): AccountKeys {
  const key = keyFromText(text);
  const id = idOfKey(key);
  const phrase = storedPhrase();
  if (phrase !== null) {
    for (let n = 0; n < walletState().count; n++) if (accountKeys(phrase, n).id === id) throw new Error(`that is Account ${n + 1}, already here`);
  }
  const list = read<string[]>(IMPORTED_KEY) ?? [];
  if (importedAccounts().some((a) => a.id === id)) throw new Error('that account is already here');
  localStorage.setItem(IMPORTED_KEY, JSON.stringify([...list, text.trim().toLowerCase()]));
  saveWalletState({ active: `imported:${list.length}` });
  return { index: list.length, key, id, imported: list.length };
}

export const accountLabel = (account: AccountKeys | 'browser'): string =>
  (account === 'browser' ? 'Browser account' : account.imported !== undefined ? `Imported ${account.imported + 1}` : `Account ${account.index + 1}`);

/** The account the wallet opens: a phrase's, an imported one, the browser wallet, or null before any exists. */
export function activeAccount(hasBrowserWallet: boolean): AccountKeys | 'browser' | null {
  const phrase = storedPhrase();
  const { active, count } = walletState();
  const imported = importedAccounts();
  if (typeof active === 'string' && active.startsWith('imported:')) {
    const chosen = imported[Number(active.slice('imported:'.length))];
    if (chosen !== undefined) return chosen;
  }
  if (phrase !== null && typeof active === 'number') return accountKeys(phrase, Math.min(active, count - 1));
  if (hasBrowserWallet) return 'browser';
  if (phrase !== null) return accountKeys(phrase, 0);
  return imported[0] ?? null;
}
