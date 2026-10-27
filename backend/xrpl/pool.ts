// The deposit log of an XRPL pool account, read from its own ledger history.
//
// A deposit is a validated, successful Payment to the pool, counted by what it
// DELIVERED (meta.delivered_amount), never its Amount: a partial payment can
// claim 100 RLUSD and deliver 0.01.
//
//   tag 0 + InvoiceID   one note. The InvoiceID is its commitment, and the
//                       delivered amount must be exactly one note size. Anyone
//                       can check these from the ledger alone.
//   a registered tag    credited to the commitments the wallet registered for
//                       that tag, in order: the amount is split greedily into
//                       note sizes, each note takes the next unused commitment
//                       of its size, and a remainder below the smallest size is
//                       carried forward on the tag until more arrives.
//   anything else       unmatched, held for the refund rule.
//
// The log is a pure function of (payments in ledger order, tag table), so two
// attesters with the same registrations compute the same log. A registration
// that arrived late could credit a payment someone else made, so a tag that has
// already received anything is refused (registerTag), unless its owner adds to it.
//
// A REUSABLE ADDRESS is a tag with an owner: registered with the end of a
// SHA-256 hash chain (the anchor), it takes more commitments only from whoever
// reveals the anchor's preimage, which then becomes the anchor. The address is
// public, so without this anyone could append their own commitments and catch
// its payments. Hashes only: nothing here a quantum computer breaks.
// Commitments are appended per size, so a payment's credits never move and a
// carried remainder is credited as soon as there are notes for it.

import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, truncateSync, writeSync } from 'node:fs';

import type { Client } from 'xrpl';

import { ProtocolFailure, type NoteCommitment, type Nullifier, type PoolScope, type RingSnapshot, type UnixSeconds } from '@opaque/protocol-types';
import { asNoteCommitment } from '@opaque/protocol-types/codecs.js';

import { commitmentOfInvoice, credentialTypeOf, INVOICE_TAG, splitAmount, unitsDelivered, type XrplAsset } from './protocol.ts';

export interface IncomingPayment {
  readonly hash: string;
  readonly ledgerIndex: number;
  readonly from: string;
  /** Delivered, in the pool's units. */
  readonly units: bigint;
  readonly tag: number | null;
  readonly invoiceId: string | null;
}

export interface Deposit {
  readonly commitment: NoteCommitment;
  readonly denomination: number;
  readonly ledgerIndex: number;
  readonly hash: string;
  readonly from: string;
  readonly tag: number | null;
}

/** Per note size (as a decimal string of units), the commitments to credit, in order. */
export type TagRegistration = Readonly<Record<string, readonly NoteCommitment[]>>;
/**
 * When a tag's notes took effect: after ledger `at`, each size's list was `len`
 * long. `ladder`: payments from then on split payably (protocol-types
 * splitAmount), so every amount stays payable; before it, largest first.
 */
export interface TagEvent { readonly at: number; readonly len: Readonly<Record<string, number>>; readonly ladder?: true }
/** A reusable tag's owner: the current end of its hash chain, and how many top-ups it has taken. */
export interface TagOwner { readonly anchor: string; readonly depth: number }
/** A first registration may name an owner; a top-up reveals the next link instead. */
export type TagAuth = { readonly owner: string } | { readonly reveal: string };

export interface DepositLog {
  readonly deposits: readonly Deposit[];
  /** Per tag: received, not yet a whole note. */
  readonly carried: ReadonlyMap<number, bigint>;
  readonly unmatched: readonly IncomingPayment[];
}

/** The ring proves membership over 128-bit images; anything wider can never sit in a ring. */
const RING_IMAGE = /^0x[0-9a-f]{32}0{32}$/;
const MAX_TAG = 0xffff_ffff;
/** Per registration. A wallet asks for 9 of each smaller size and a few of the largest. */
export const MAX_REGISTERED = 64;
const MAX_TAGS = 100_000;
/** One reusable tag's commitments, all top-ups together. */
const MAX_TAG_NOTES = 4096 * MAX_REGISTERED;
const HASH = /^0x[0-9a-f]{64}$/;
const sha256Hex = (hex: string) => `0x${createHash('sha256').update(Buffer.from(hex.slice(2), 'hex')).digest('hex')}`;

const refuse = (message: string): never => { throw new ProtocolFailure('INVALID_INPUT', message); };

/**
 * The pool's notes, from its payments and the tags' registrations. A tag with
 * a history takes its notes as they were registered: a payment splits only
 * into notes registered before it, and a later registration credits only what
 * was carried. So a note, once credited, stays credited, whatever is added
 * after. A tag from before histories takes every note it holds from the start,
 * as it always did.
 */
export function creditDeposits(
  payments: readonly IncomingPayment[],
  sizes: readonly number[],
  tags: ReadonlyMap<number, TagRegistration>,
  history: ReadonlyMap<number, readonly TagEvent[]> = new Map(),
): DepositLog {
  const descending = [...sizes].sort((a, b) => b - a);
  const deposits: Deposit[] = [];
  const credited = new Set<string>();
  const carried = new Map<number, bigint>();
  const nextOf = new Map<number, Map<number, number>>();
  const unmatched: IncomingPayment[] = [];
  const credit = (p: IncomingPayment, commitment: NoteCommitment, denomination: number) => {
    credited.add(commitment);
    deposits.push({ commitment, denomination, ledgerIndex: p.ledgerIndex, hash: p.hash, from: p.from, tag: p.tag });
  };

  // Per tag: how many of each size it may take so far (tags with a history), and the last payment.
  const avail = new Map<number, Readonly<Record<string, number>>>();
  const ladderOf = new Map<number, boolean>();
  const applied = new Map<number, number>();
  const last = new Map<number, IncomingPayment>();
  /** Into the tag's next notes, as its latest registration says (greedy or ladder); what is left over. */
  const split = (tag: number, registration: TagRegistration, p: IncomingPayment, from: bigint): bigint => {
    const next = nextOf.get(tag) ?? new Map<number, number>();
    nextOf.set(tag, next);
    const take = (size: number): boolean => {
      const list = registration[String(size)] ?? [];
      const limit = history.has(tag) ? Math.min(list.length, avail.get(tag)?.[String(size)] ?? 0) : list.length;
      while ((next.get(size) ?? 0) < limit) {
        const commitment = list[next.get(size) ?? 0]!;
        next.set(size, (next.get(size) ?? 0) + 1);
        // A commitment credited once already would be a second note nobody can
        // spend (one secret, one nullifier): skip it, keep the value.
        if (credited.has(commitment)) continue;
        credit(p, commitment, size);
        return true;
      }
      return false;
    };
    return splitAmount(from, descending, ladderOf.get(tag) === true, take);
  };
  /** Applies the tag's registrations made before ledger `until`, each crediting what was carried. */
  const advance = (tag: number, registration: TagRegistration, until: number) => {
    const events = history.get(tag) ?? [];
    let i = applied.get(tag) ?? 0;
    for (; i < events.length && events[i]!.at < until; i++) {
      avail.set(tag, events[i]!.len);
      ladderOf.set(tag, events[i]!.ladder === true);
      const p = last.get(tag);
      if (p !== undefined && (carried.get(tag) ?? 0n) > 0n) carried.set(tag, split(tag, registration, p, carried.get(tag)!));
    }
    applied.set(tag, i);
  };

  // Every tag's registrations, in ledger order: each takes effect before every payment after it,
  // whoever made that payment, so nothing paid later (an InvoiceID deposit of the same
  // commitment) can change what a registration credited from a tag's carry.
  const queue = [...history].flatMap(([tag, events]) => (tags.has(tag) ? events.map((e) => ({ tag, at: e.at })) : [])).sort((a, b) => a.at - b.at || a.tag - b.tag);
  let next = 0;
  const applyBefore = (ledger: number) => {
    for (; next < queue.length && queue[next]!.at < ledger; next++) advance(queue[next]!.tag, tags.get(queue[next]!.tag)!, ledger);
  };

  for (const p of payments) {
    applyBefore(p.ledgerIndex);
    if (p.tag === INVOICE_TAG) {
      const commitment = p.invoiceId === null ? null : commitmentOfInvoice(p.invoiceId);
      const size = descending.find((s) => BigInt(s) === p.units);
      if (commitment !== null && RING_IMAGE.test(commitment) && size !== undefined && !credited.has(commitment)) credit(p, commitment, size);
      else unmatched.push(p);
      continue;
    }
    const registration = p.tag === null ? undefined : tags.get(p.tag);
    if (registration === undefined) {
      unmatched.push(p);
      continue;
    }
    const tag = p.tag!;
    advance(tag, registration, p.ledgerIndex);
    last.set(tag, p);
    carried.set(tag, split(tag, registration, p, (carried.get(tag) ?? 0n) + p.units));
  }
  // Registrations after the last payment to a tag credit what it carried.
  for (const [tag, registration] of tags) advance(tag, registration, Infinity);
  return { deposits, carried, unmatched };
}

/** The candidates a wallet draws decoys from, for one note size of the pool. */
export function ringSnapshotOf(input: {
  readonly scope: PoolScope;
  readonly log: DepositLog;
  readonly indexedThrough: number;
  readonly timesUsed: (commitment: NoteCommitment) => number;
  readonly now: UnixSeconds;
}): RingSnapshot {
  return {
    scope: input.scope,
    candidates: input.log.deposits
      .filter((d) => d.denomination === input.scope.denomination)
      .map((d) => ({
        commitment: d.commitment,
        enrolledAtBlock: BigInt(d.ledgerIndex),
        timesUsedInRing: input.timesUsed(d.commitment),
        // The paying account, which is what links deposits on XRPL.
        fundingCluster: d.from,
        hasOtherActivity: null,
      })),
    indexedThroughBlock: BigInt(input.indexedThrough),
    observedAt: input.now,
    policyVersion: 'xrpl-deposit-log-v1',
  };
}

const DEPOSIT_TYPES = new Set(['Payment', 'AccountDelete']);

/** One account_tx entry, as a deposit candidate, or null when it is not one. */
export function incomingOf(pool: string, asset: XrplAsset, entry: Record<string, unknown>): IncomingPayment | null {
  const tx = (entry['tx_json'] ?? entry['tx']) as Record<string, unknown> | undefined;
  const meta = entry['meta'] as Record<string, unknown> | undefined;
  if (entry['validated'] !== true || tx === undefined || typeof meta !== 'object' || meta === null) return null;
  // AccountDelete is how a closed app account pays its XRP back in.
  if (!DEPOSIT_TYPES.has(String(tx['TransactionType'])) || tx['Destination'] !== pool || tx['Account'] === pool) return null;
  if (meta['TransactionResult'] !== 'tesSUCCESS') return null;
  // ponytail: a payment in another asset (XRP into a token pool) is ignored,
  // not refunded; it only adds to the pool's XRP for reserves.
  const units = unitsDelivered(asset, pool, meta['delivered_amount']);
  if (units === null || units <= 0n) return null;
  const tag = tx['DestinationTag'];
  const invoice = tx['InvoiceID'];
  return {
    hash: String(entry['hash'] ?? tx['hash']),
    ledgerIndex: Number(entry['ledger_index'] ?? tx['ledger_index']),
    from: String(tx['Account']),
    units,
    tag: typeof tag === 'number' ? tag : null,
    invoiceId: typeof invoice === 'string' ? invoice : null,
  };
}

export interface PoolConfig {
  readonly account: string;
  readonly asset: XrplAsset;
  /** Note sizes in units. */
  readonly sizes: readonly number[];
  readonly deployedAtLedger: number;
}

export interface PoolSource {
  readonly config: PoolConfig;
  /** Reads the pool's new validated transactions. Concurrent calls share one read. */
  sync(): Promise<void>;
  log(): DepositLog;
  indexedThrough(): number;
  /** `payable`: payments after this registration split payably (the registrant sized its notes for it); otherwise largest first. */
  registerTag(tag: number, registration: TagRegistration, auth?: TagAuth, payable?: boolean): void;
  registered(tag: number): boolean;
  registration(tag: number): TagRegistration | undefined;
  owner(tag: number): TagOwner | undefined;
  /** The ledger's answer: does the pool hold a credential for this nullifier? */
  isSpent(nullifier: Nullifier): Promise<boolean>;
  /** Counts each member of a ring an attester verified, for decoy selection's reuse limit. */
  noteRing(ring: readonly NoteCommitment[]): void;
  timesUsed(commitment: NoteCommitment): number;
}

/**
 * What registrations may hold before anything has paid for them, per pool
 * (F-52): commitments not yet credited, plus each registration beyond the
 * notes credited to its tag, at what it costs in memory (a history event is
 * about six commitments). Registering is free and anonymous, and every
 * registration is kept and replayed at boot, so this is what bounds the table;
 * a credited note was paid for, and makes its room again. Nothing registered
 * is ever dropped, since a tag may still be paid: past this, a registration is
 * refused, retryably, until deposits arrive. About 75 MB of heap per pool.
 * ponytail: one budget for everyone, so a flood of free registrations holds
 * new ones back (as MAX_TAGS did) while paid tags keep working; expire tags
 * never paid if that is ever seen.
 */
const MAX_UNPAID = 1 << 19;
const EVENT_COST = 6;

/**
 * ponytail: the log is recomputed from every payment when a read finds new
 * ones (and when a top-up credits a tag's carry), O(n) in the pool's history;
 * make it incremental once a pool passes ~100k payments.
 * The tag table persists to `tagFile`; payments are re-read from the ledger.
 */
export function createPoolSource(options: {
  readonly client: Client;
  readonly config: PoolConfig;
  readonly tagFile?: string;
  readonly log?: (line: string) => void;
}): PoolSource {
  const { client, config } = options;
  const payments: IncomingPayment[] = [];
  const tagsSeen = new Set<number>();
  // ── the tag table: its files from before the log, read once, then the log ──
  // Each registration is one line of `tags-<pool>.log`, written and synced to disk
  // before it changes anything here: a crash keeps it whole or not at all, with its
  // history, and a registration costs its own size, never a rewrite of the table.
  const load = <T>(file: string | undefined): [number, T][] =>
    file !== undefined && existsSync(file) ? Object.entries(JSON.parse(readFileSync(file, 'utf8')) as Record<string, T>).map(([t, v]) => [Number(t), v]) : [];
  const tags = new Map<number, TagRegistration>(load<TagRegistration>(options.tagFile));
  const owners = new Map<number, TagOwner>(load<TagOwner>(options.tagFile?.replace(/\.json$/, '.owners.json')));
  // When each tag's notes took effect (creditDeposits), so a later registration never re-splits an earlier payment.
  const history = new Map<number, TagEvent[]>(load<TagEvent[]>(options.tagFile?.replace(/\.json$/, '.history.json')));
  /** Every commitment registered to any tag: a new one is checked against it, not against the whole table. */
  const registeredCommitments = new Set<string>([...tags.values()].flatMap((r) => Object.values(r).flat()));
  const lengths = (r: TagRegistration) => Object.fromEntries(Object.entries(r).map(([size, list]) => [size, list.length]));
  /** One registration: its new commitments per size, the owner it leaves, the events it adds. */
  type Entry = { readonly tag: number; readonly add: TagRegistration; readonly owner?: TagOwner; readonly events: readonly TagEvent[] };
  const apply = (e: Entry) => {
    const before = tags.get(e.tag) ?? {};
    const merged: Record<string, readonly NoteCommitment[]> = { ...before };
    // Appended per size: earlier payments keep the notes they were credited.
    for (const [size, list] of Object.entries(e.add)) {
      merged[size] = [...(before[size] ?? []), ...list];
      for (const c of list) registeredCommitments.add(c);
    }
    tags.set(e.tag, merged);
    if (e.owner !== undefined) owners.set(e.tag, e.owner);
    history.set(e.tag, [...(history.get(e.tag) ?? []), ...e.events]);
  };
  const logFile = options.tagFile?.replace(/\.json$/, '.log');
  if (logFile !== undefined && existsSync(logFile)) {
    const text = readFileSync(logFile, 'utf8');
    // A last line a crash cut short never took effect: dropped, so the next write starts a line of its own.
    const whole = text.lastIndexOf('\n') + 1;
    if (whole < text.length) truncateSync(logFile, Buffer.byteLength(text.slice(0, whole)));
    // A line that does not parse is what a refused write left and could not take back
    // (write, below): never a registration anyone was told of, since those are whole lines.
    // Reported and left in place, never a reason not to boot (F-61).
    let unreadable = 0;
    for (const line of text.slice(0, whole).split('\n')) {
      if (line === '') continue;
      let entry: Entry;
      try { entry = JSON.parse(line) as Entry; } catch { unreadable += 1; continue; }
      apply(entry);
    }
    if (unreadable > 0) options.log?.(`  ${logFile}: skipped ${unreadable} unreadable line(s), left by registrations that were refused`);
  }
  /** False while the log ends in a fragment a refused write could not take back. */
  let ended = true;
  const write = (e: Entry) => {
    if (logFile === undefined) return;
    // After a fragment, a NUL and a newline first: the fragment, even one missing only its
    // newline, can then never parse, and this line starts a line of its own.
    const line = Buffer.from(`${ended ? '' : '\0\n'}${JSON.stringify(e)}\n`);
    const fd = openSync(logFile, 'a', 0o600);
    try {
      const size = fstatSync(fd).size;
      try {
        // A full disk writes short, and says so only in what it returns (F-61).
        if (writeSync(fd, line) !== line.length) throw new Error('short write');
        fsyncSync(fd);
        ended = true;
      } catch {
        // Not on disk whole, so not registered: take back whatever part reached the file.
        try { ftruncateSync(fd, size); } catch { ended = false; }
        throw new ProtocolFailure('MESH_UNAVAILABLE', 'the pool could not record this registration: try again', true);
      }
    } finally {
      closeSync(fd);
    }
  };
  const rings = new Map<string, number>();
  let through = config.deployedAtLedger - 1;
  let inFlight: Promise<void> | undefined;

  let current: DepositLog = { deposits: [], carried: new Map(), unmatched: [] };
  /** Every commitment the log has credited: a registration may not name one. */
  let depositCommitments = new Set<string>();
  /** Per tag, the notes the log has credited it; and what every tag holds that nothing has paid for (MAX_UNPAID). */
  let creditedTo = new Map<number, number>();
  let unpaid = 0;
  const held = (r: TagRegistration | undefined) => Object.values(r ?? {}).reduce((n, list) => n + list.length, 0);
  /** What `tag` holds unpaid, with `more` commitments and `events` registrations added. */
  const unpaidOf = (tag: number, more = 0, events = 0) => {
    const credited = creditedTo.get(tag) ?? 0;
    return Math.max(0, held(tags.get(tag)) + more - credited) + EVENT_COST * Math.max(0, (history.get(tag)?.length ?? 0) + events - credited);
  };
  const recompute = () => {
    current = creditDeposits(payments, config.sizes, tags, history);
    depositCommitments = new Set(current.deposits.map((d) => d.commitment as string));
    creditedTo = new Map();
    for (const d of current.deposits) if (d.tag !== null && d.tag !== INVOICE_TAG) creditedTo.set(d.tag, (creditedTo.get(d.tag) ?? 0) + 1);
    unpaid = 0;
    for (const tag of tags.keys()) unpaid += unpaidOf(tag);
  };
  recompute();

  // Every payment once, by hash, whatever reads overlap.
  const seenPayments = new Set<string>();
  async function read(): Promise<void> {
    let marker: unknown;
    let max = through;
    // Only a whole read counts: its payments and `through` are kept together, after its
    // last page. A page that fails keeps nothing, so the next read starts from the same
    // ledger and never adds a payment twice (a payment counted twice credits notes
    // nobody paid for).
    const fresh: IncomingPayment[] = [];
    do {
      const response = await client.request({
        command: 'account_tx', account: config.account, ledger_index_min: through + 1, ledger_index_max: -1,
        forward: true, limit: 400, ...(marker === undefined ? {} : { marker }),
      } as never).catch((error: { data?: { error?: string } }) => {
        // Asked from past the newest validated ledger: nothing new yet.
        if (error.data?.error === 'invalidLgrRange') return null;
        throw error;
      }) as { result: { transactions: Record<string, unknown>[]; ledger_index_max: number; marker?: unknown } } | null;
      if (response === null) return;
      for (const entry of response.result.transactions) {
        const p = incomingOf(config.account, config.asset, entry);
        if (p !== null) fresh.push(p);
      }
      max = response.result.ledger_index_max;
      marker = response.result.marker;
    } while (marker !== undefined);
    let added = 0;
    for (const p of fresh) {
      if (seenPayments.has(p.hash)) continue;
      seenPayments.add(p.hash);
      payments.push(p);
      added += 1;
      if (p.tag !== null) tagsSeen.add(p.tag);
    }
    through = Math.max(through, max);
    // Nothing new read, nothing new to credit: anyone can ask for a read (F-52).
    if (added > 0) recompute();
  }

  return {
    config,
    sync() {
      inFlight ??= read().finally(() => { inFlight = undefined; });
      return inFlight;
    },
    log: () => current,
    indexedThrough: () => through,
    registerTag(tag, registration, auth, payable = false) {
      if (!Number.isInteger(tag) || tag <= INVOICE_TAG || tag > MAX_TAG) refuse('a tag is 1 to 2^32-1; 0 is for InvoiceID deposits');
      const topUp = auth !== undefined && 'reveal' in auth;
      if (topUp) {
        const owner = owners.get(tag);
        if (owner === undefined) refuse('only a reusable address takes more notes');
        if (typeof auth.reveal !== 'string' || !HASH.test(auth.reveal) || sha256Hex(auth.reveal) !== owner!.anchor) refuse('that is not this address\'s next key');
      } else {
        if (tags.has(tag) || tagsSeen.has(tag)) refuse('that tag is already in use; pick another');
        // Anyone can register through the mesh, so the table is bounded.
        // ponytail: a hard cap; expire tags that were never paid if it is reached.
        if (tags.size >= MAX_TAGS) refuse('this pool takes no new tags right now');
        if (auth !== undefined && (typeof auth.owner !== 'string' || !HASH.test(auth.owner))) refuse('an owner is a 32-byte hash');
      }
      const fresh = new Set<string>();
      let count = 0;
      for (const [size, list] of Object.entries(registration)) {
        if (!config.sizes.includes(Number(size))) refuse(`this pool has no ${size} note`);
        if (!Array.isArray(list)) refuse('commitments come as a list per note size');
        for (const raw of list) {
          const c = asNoteCommitment(raw);
          if (!RING_IMAGE.test(c)) refuse('a commitment must be a 128-bit image');
          if (fresh.has(c) || depositCommitments.has(c)) refuse('a commitment is registered twice');
          fresh.add(c);
          count += 1;
        }
      }
      if (count === 0 || count > MAX_REGISTERED) refuse(`a registration names 1 to ${MAX_REGISTERED} commitments`);
      // Which, by name: the same account in another browser drew these numbers
      // for a tag nobody paid, and the wallet keeps them (its own) and draws
      // again for only these. No one learns more: only their owner can name them.
      const taken = [...fresh].filter((c) => registeredCommitments.has(c));
      if (taken.length > 0) throw Object.assign(new ProtocolFailure('INVALID_INPUT', 'a commitment is already registered to another tag'), { taken });
      const ladder = payable ? { ladder: true as const } : {};
      let entry: Entry;
      if (topUp) {
        const before = tags.get(tag)!;
        const total = Object.values(before).reduce((n, l) => n + l.length, 0) + count;
        if (total > MAX_TAG_NOTES) refuse('this address holds all the notes it can');
        const after = Object.fromEntries(Object.entries(before).map(([size, list]) => [size, list.length]));
        for (const [size, list] of Object.entries(registration)) after[size] = (after[size] ?? 0) + list.length;
        // Taking effect after every payment read so far (the caller syncs first). A tag from
        // before histories keeps what it held as registered from the start.
        entry = {
          tag, add: registration, owner: { anchor: (auth as { reveal: string }).reveal, depth: owners.get(tag)!.depth + 1 },
          events: [...(history.has(tag) ? [] : [{ at: 0, len: lengths(before) }]), { at: through, len: after, ...ladder }],
        };
      } else {
        entry = {
          tag, add: registration, ...(auth === undefined ? {} : { owner: { anchor: (auth as { owner: string }).owner, depth: 0 } }),
          events: [{ at: through, len: lengths(registration), ...ladder }],
        };
      }
      const growth = unpaidOf(tag, count, entry.events.length) - unpaidOf(tag);
      if (growth > 0 && unpaid + growth > MAX_UNPAID) {
        throw new ProtocolFailure('MESH_UNAVAILABLE', 'this pool holds all the unpaid notes it can: try again once deposits arrive', true);
      }
      // On disk first: what a wallet is told was registered survives any restart.
      write(entry);
      apply(entry);
      // Every payment to the tag was read before this takes effect, so only what it
      // carries can be credited now; with nothing carried the log stands as it is.
      if ((current.carried.get(tag) ?? 0n) > 0n) recompute();
      else unpaid += growth;
    },
    registered: (tag) => tags.has(tag),
    registration: (tag) => tags.get(tag),
    owner: (tag) => owners.get(tag),
    async isSpent(nullifier) {
      const response = await client.request({
        command: 'ledger_entry', ledger_index: 'validated',
        credential: { subject: config.account, issuer: config.account, credential_type: credentialTypeOf(nullifier) },
      } as never).catch((error: { data?: { error?: string } }) => {
        if (error.data?.error === 'entryNotFound') return null;
        throw error;
      });
      return response !== null;
    },
    noteRing(ring) { for (const c of ring) rings.set(c, (rings.get(c) ?? 0) + 1); },
    timesUsed: (commitment) => rings.get(commitment) ?? 0,
  };
}
