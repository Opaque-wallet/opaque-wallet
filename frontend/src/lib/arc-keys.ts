// Arc accounts from the recovery phrase.
//
// The phrase's accounts (lib/xrpl-keys.ts) hold Arc money too: one phrase, one
// list of accounts, on every chain. An Arc account draws everything it holds
// from its account key, under labels of its own:
//
//   arc/<chain id>/fors/<epoch>        its PQ key at each epoch: the first,
//                                      the next, and every rotation's after
//   arc/<chain id>/note/<pool>/<i>     the i-th note it makes in a pool
//
// So the phrase alone gives back the address (CREATE2 commits it to the first
// two keys and a fixed deadline), the key in force (adoptWallet finds it on
// chain however many rotations later), and every note (findNotes, against the
// pool's deposits). Each chain id has keys of its own: a few-time key must
// never sign on two chains. Nothing here leaves the page.

import type { NoteCommitment, PoolScope } from '@opaque/protocol-types';
import { deriveCommitment, SECRET_BYTES } from '@opaque/zk';

import { FORS_C_DEFAULT, keyGen, pkCommitment } from '../../../packages/pq-wallet/src/fors.ts';
import { accountSalt, predictAccount } from '../../../backend/chain/pq-account.ts';
import { ACCOUNT_MAX_USES, ARC_AUTHORITY, PHRASE_ROTATION_DEADLINE } from '../../../backend/chain/pq-wallet-chain.ts';
import { deployment } from '../../../deployments/index.ts';
import { scoped } from './storage-name.ts';
import { stream, type AccountKeys } from './xrpl-keys.ts';

const CHAIN = deployment.network.chainId;

/** The seed of the account's PQ key at `epoch`. */
export const forsSeed = (account: AccountKeys, epoch: bigint): Uint8Array => stream(account.key, `arc/${CHAIN}/fors/${epoch}`)(32);

/** The secret of the account's i-th note in this pool. */
export const noteSecret = (account: AccountKeys, scope: PoolScope, i: number): Uint8Array =>
  stream(account.key, `arc/${CHAIN}/note/${scope.pool.toLowerCase()}/${i}`)(SECRET_BYTES);

// ── what this browser keeps per Arc account ───────────────────────────────

const STATE_KEY = scoped('opaque:arc-accounts:v1');
export interface ArcState {
  /** Each account's address, by account id: two key generations each to work out. */
  readonly addresses: Readonly<Record<string, string>>;
  /** The last private balance each account showed, in USDC, for the account list ('browser' for the browser account). */
  readonly balances: Readonly<Record<string, number>>;
  /** Accounts whose notes were looked for on chain in this browser. */
  readonly scanned: Readonly<Record<string, boolean>>;
  /** Bumped when an account's keys are rebuilt from the chain: its store starts afresh. */
  readonly generations: Readonly<Record<string, number>>;
  /** Set on the first visit since Arc took phrases. */
  readonly seen?: boolean;
}
const read = <T>(key: string, fallback: T): T => { try { return (JSON.parse(localStorage.getItem(key) ?? 'null') as T | null) ?? fallback; } catch { return fallback; } };
export const arcState = (): ArcState => ({ addresses: {}, balances: {}, scanned: {}, generations: {}, ...read<Partial<ArcState>>(STATE_KEY, {}) });
export const saveArcState = (next: Partial<ArcState>): void => localStorage.setItem(STATE_KEY, JSON.stringify({ ...arcState(), ...next }));

/** Where an Arc account's keys, notes, note counters and sent payments live in this browser. */
export function arcStorageOf(account: AccountKeys | 'browser', browserKeys: string): { keys: string; notes: string; counters: string; sent: string } {
  if (account === 'browser') return { keys: browserKeys, notes: scoped('opaque:notes:v1'), counters: '', sent: scoped('opaque:sent:v1') };
  const generation = arcState().generations[account.id] ?? 0;
  return {
    keys: scoped(`opaque-pq-account-v1-${account.id}${generation === 0 ? '' : `-${generation}`}`),
    notes: scoped(`opaque:notes:v1:${account.id}`),
    counters: scoped(`opaque:arc-note-next:v1:${account.id}`),
    sent: scoped(`opaque:sent:v1:${account.id}`),
  };
}

/** The account's address on this chain: the same anywhere its phrase is. */
export function arcAddressOf(account: AccountKeys): `0x${string}` {
  const cached = arcState().addresses[account.id];
  if (cached !== undefined) return cached as `0x${string}`;
  const commitmentAt = (epoch: bigint) => {
    const seed = forsSeed(account, epoch);
    try { return pkCommitment(keyGen(seed, FORS_C_DEFAULT).publicKey); } finally { seed.fill(0); }
  };
  const address = predictAccount(ARC_AUTHORITY.factory, ARC_AUTHORITY.accountImplementation,
    accountSalt(commitmentAt(0n), commitmentAt(1n), ACCOUNT_MAX_USES, PHRASE_ROTATION_DEADLINE)).toLowerCase() as `0x${string}`;
  try { saveArcState({ addresses: { ...arcState().addresses, [account.id]: address } }); } catch { /* a cache: worked out again next time */ }
  return address;
}

// ── notes ─────────────────────────────────────────────────────────────────

/** The next note index per pool. Never handed out twice: a reused secret is a deposit the pool refuses. */
export function noteCounters(key: string) {
  const all = () => read<Record<string, number>>(key, {});
  return {
    next: (scope: PoolScope): number => all()[scope.pool.toLowerCase()] ?? 0,
    /** Moves a pool's counter forward to `n`; never back. */
    raise(scope: PoolScope, n: number): void {
      const counts = all();
      const pool = scope.pool.toLowerCase();
      if (n > (counts[pool] ?? 0)) localStorage.setItem(key, JSON.stringify({ ...counts, [pool]: n }));
    },
  };
}

/**
 * How far past the last note found a scan keeps deriving. A deposit makes at
 * most 27 notes, and one that failed leaves its indices unused.
 */
export const NOTE_GAP = 40;

export interface FoundNote { readonly i: number; readonly secret: Uint8Array; readonly commitment: NoteCommitment }

/**
 * The account's notes among a pool's deposits: index `from` onwards, until
 * NOTE_GAP in a row past both the last found and `known` (what this browser
 * has already handed out) are not there. `next` is the first index after them.
 */
export async function findNotes(account: AccountKeys, scope: PoolScope, deposits: ReadonlySet<string>, from: number, known: number): Promise<{ readonly found: readonly FoundNote[]; readonly next: number }> {
  const found: FoundNote[] = [];
  let next = known;
  for (let i = from; i < Math.max(next, from) + NOTE_GAP; i++) {
    // A commitment takes a few milliseconds: let the page breathe.
    if ((i - from) % 20 === 19) await new Promise((resolve) => setTimeout(resolve));
    const secret = noteSecret(account, scope, i);
    const commitment = deriveCommitment(secret, scope);
    if (deposits.has(commitment.toLowerCase())) { found.push({ i, secret, commitment }); next = Math.max(next, i + 1); }
  }
  return { found, next };
}
