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

// ── what this browser holds ───────────────────────────────────────────────

const PHRASE_KEY = scoped('opaque:xrpl-phrase:v1');
const STATE_KEY = scoped('opaque:xrpl-accounts:v1');

/** 'browser' is the wallet from before recovery phrases: random notes, backed up by file. */
export type ActiveAccount = number | 'browser';
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

export const accountLabel = (account: AccountKeys | 'browser'): string => (account === 'browser' ? 'Browser account' : `Account ${account.index + 1}`);

/** The account the wallet opens: a phrase's, the browser wallet, or null before either exists. */
export function activeAccount(hasBrowserWallet: boolean): AccountKeys | 'browser' | null {
  const phrase = storedPhrase();
  const { active, count } = walletState();
  if (phrase !== null && active !== 'browser') return accountKeys(phrase, Math.min(active, count - 1));
  if (hasBrowserWallet) return 'browser';
  return phrase === null ? null : accountKeys(phrase, 0);
}
