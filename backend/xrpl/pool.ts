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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import type { Client } from 'xrpl';

import { ProtocolFailure, type NoteCommitment, type Nullifier, type PoolScope, type RingSnapshot, type UnixSeconds } from '@opaque/protocol-types';
import { asNoteCommitment } from '@opaque/protocol-types/codecs.js';

import { commitmentOfInvoice, credentialTypeOf, INVOICE_TAG, unitsDelivered, type XrplAsset } from './protocol.ts';

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

export function creditDeposits(
  payments: readonly IncomingPayment[],
  sizes: readonly number[],
  tags: ReadonlyMap<number, TagRegistration>,
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

  for (const p of payments) {
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
    const next = nextOf.get(tag) ?? new Map<number, number>();
    nextOf.set(tag, next);
    let remaining = (carried.get(tag) ?? 0n) + p.units;
    for (const size of descending) {
      const list = registration[String(size)] ?? [];
      while (remaining >= BigInt(size) && (next.get(size) ?? 0) < list.length) {
        const commitment = list[next.get(size) ?? 0]!;
        next.set(size, (next.get(size) ?? 0) + 1);
        // A commitment credited once already would be a second note nobody can
        // spend (one secret, one nullifier): skip it, keep the value.
        if (credited.has(commitment)) continue;
        credit(p, commitment, size);
        remaining -= BigInt(size);
      }
    }
    carried.set(tag, remaining);
  }
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
  registerTag(tag: number, registration: TagRegistration, auth?: TagAuth): void;
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
 * ponytail: the log is recomputed from every payment on each change, O(n) in
 * the pool's history; make it incremental once a pool passes ~100k payments.
 * The tag table persists to `tagFile`; payments are re-read from the ledger.
 */
export function createPoolSource(options: { readonly client: Client; readonly config: PoolConfig; readonly tagFile?: string }): PoolSource {
  const { client, config } = options;
  const payments: IncomingPayment[] = [];
  const tagsSeen = new Set<number>();
  const tags = new Map<number, TagRegistration>(
    options.tagFile !== undefined && existsSync(options.tagFile)
      ? Object.entries(JSON.parse(readFileSync(options.tagFile, 'utf8')) as Record<string, TagRegistration>).map(([t, r]) => [Number(t), r])
      : [],
  );
  const ownerFile = options.tagFile?.replace(/\.json$/, '.owners.json');
  const owners = new Map<number, TagOwner>(
    ownerFile !== undefined && existsSync(ownerFile)
      ? Object.entries(JSON.parse(readFileSync(ownerFile, 'utf8')) as Record<string, TagOwner>).map(([t, o]) => [Number(t), o])
      : [],
  );
  const persist = () => {
    if (options.tagFile !== undefined) writeFileSync(options.tagFile, JSON.stringify(Object.fromEntries(tags)), { mode: 0o600 });
    if (ownerFile !== undefined) writeFileSync(ownerFile, JSON.stringify(Object.fromEntries(owners)), { mode: 0o600 });
  };
  const rings = new Map<string, number>();
  let through = config.deployedAtLedger - 1;
  let current: DepositLog = creditDeposits([], config.sizes, tags);
  let inFlight: Promise<void> | undefined;

  const recompute = () => { current = creditDeposits(payments, config.sizes, tags); };

  async function read(): Promise<void> {
    let marker: unknown;
    let max = through;
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
        if (p === null) continue;
        payments.push(p);
        if (p.tag !== null) tagsSeen.add(p.tag);
      }
      max = response.result.ledger_index_max;
      marker = response.result.marker;
    } while (marker !== undefined);
    through = Math.max(through, max);
    recompute();
  }

  return {
    config,
    sync() {
      inFlight ??= read().finally(() => { inFlight = undefined; });
      return inFlight;
    },
    log: () => current,
    indexedThrough: () => through,
    registerTag(tag, registration, auth) {
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
          if (fresh.has(c) || current.deposits.some((d) => d.commitment === c)) refuse('a commitment is registered twice');
          fresh.add(c);
          count += 1;
        }
      }
      if (count === 0 || count > MAX_REGISTERED) refuse(`a registration names 1 to ${MAX_REGISTERED} commitments`);
      for (const r of tags.values()) for (const list of Object.values(r)) if (list.some((c) => fresh.has(c))) refuse('a commitment is already registered to another tag');
      if (topUp) {
        const before = tags.get(tag)!;
        const total = Object.values(before).reduce((n, l) => n + l.length, 0) + count;
        if (total > MAX_TAG_NOTES) refuse('this address holds all the notes it can');
        // Appended per size: earlier payments keep the notes they were credited.
        const merged: Record<string, readonly NoteCommitment[]> = { ...before };
        for (const [size, list] of Object.entries(registration)) merged[size] = [...(before[size] ?? []), ...list];
        tags.set(tag, merged);
        owners.set(tag, { anchor: (auth as { reveal: string }).reveal, depth: owners.get(tag)!.depth + 1 });
      } else {
        tags.set(tag, registration);
        if (auth !== undefined) owners.set(tag, { anchor: (auth as { owner: string }).owner, depth: 0 });
      }
      persist();
      recompute();
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
