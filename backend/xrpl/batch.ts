// The payout: one Batch, ALLORNOTHING, from the pool account.
//
//   CredentialCreate × n   Account = Subject = pool, CredentialType = nullifier,
//                          and NEVER an Expiration: an expired credential can be
//                          deleted by anyone, and the note spent again.
//   Payment                pool → destination, the notes' value less the fee.
//   SignerListSet          the attesters' next single-use keys.
//
// A reused nullifier fails its CredentialCreate with tecDUPLICATE and nothing in
// the Batch applies — proven on testnet by spike.ts. The outer Batch still
// reports tesSUCCESS, and a failed ALLORNOTHING batch records none of its inner
// transactions, so success is read from the inner Payment's own result.

import { BatchFlags, GlobalFlags, type Batch, type SignerListSet, type SubmittableTransaction } from 'xrpl';

import { ProtocolFailure, type Nullifier } from '@opaque/protocol-types';

import { amountOf, credentialTypeOf, type XrplAsset, type XrplDestination } from './protocol.ts';

/** 8 inner transactions at most: n credentials, the payment, the rotation. */
export const MAX_NOTES_PER_BATCH = 6;

export interface Payout {
  readonly pool: string;
  readonly asset: XrplAsset;
  readonly nullifiers: readonly Nullifier[];
  readonly destination: XrplDestination;
  /** What the destination receives, in the pool's units. */
  readonly units: bigint;
  readonly nextSigners: readonly string[];
  readonly quorum: number;
}

const inner = (tx: SubmittableTransaction) => ({ RawTransaction: { ...tx, Flags: GlobalFlags.tfInnerBatchTxn } as SubmittableTransaction });

export const signerListOf = (signers: readonly string[], quorum: number) => ({
  SignerQuorum: quorum,
  SignerEntries: [...signers].sort().map((Account) => ({ SignerEntry: { Account, SignerWeight: 1 } })),
});

export function payoutBatch(p: Payout): Batch {
  if (p.nullifiers.length === 0 || p.nullifiers.length > MAX_NOTES_PER_BATCH) {
    throw new ProtocolFailure('INVALID_INPUT', `a payout spends 1 to ${MAX_NOTES_PER_BATCH} notes`);
  }
  if (new Set(p.nullifiers).size !== p.nullifiers.length) throw new ProtocolFailure('INVALID_INPUT', 'a payout repeats a nullifier');
  return {
    TransactionType: 'Batch',
    Account: p.pool,
    Flags: BatchFlags.tfAllOrNothing,
    RawTransactions: [
      ...p.nullifiers.map((n) => inner({ TransactionType: 'CredentialCreate', Account: p.pool, Subject: p.pool, CredentialType: credentialTypeOf(n) })),
      inner({
        TransactionType: 'Payment', Account: p.pool, Destination: p.destination.account, Amount: amountOf(p.asset, p.units) as never,
        ...(p.destination.tag === null ? {} : { DestinationTag: p.destination.tag }),
      }),
      inner({ TransactionType: 'SignerListSet', Account: p.pool, ...signerListOf(p.nextSigners, p.quorum) }),
    ],
  };
}

/**
 * The rotation alone, for when a payout's own did not apply: a Batch that was
 * refused, expired, or validated with its inner transactions failed has still
 * shown the public keys that signed it, and they must not stay listed.
 */
export const rotationOf = (pool: string, nextSigners: readonly string[], quorum: number): SignerListSet =>
  // Flags explicit: autofill adds Flags 0 where there are none, and the proposal must match exactly.
  ({ TransactionType: 'SignerListSet', Account: pool, Flags: 0, ...signerListOf(nextSigners, quorum) });

// ── what an attester checks before it signs ───────────────────────────────

const AUTOFILLED = ['Sequence', 'Fee', 'LastLedgerSequence', 'NetworkID', 'SigningPubKey', 'Signers'];

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
};

const withoutAutofill = (tx: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(tx).filter(([k]) => !AUTOFILLED.includes(k)));

type Proposal = Batch | SignerListSet;
const innersOf = (t: Proposal): Batch['RawTransactions'] => (t.TransactionType === 'Batch' ? t.RawTransactions : []);

/**
 * Refuses a proposed (autofilled) payout Batch or rotation that is anything
 * but `expected` plus the fields autofill adds, and bounds those: the pool's
 * next sequence and the ones after it, a fee cap, and a short validity window.
 * Returns nothing; throws.
 */
export function checkProposal(input: {
  readonly expected: Proposal;
  readonly proposed: Proposal;
  readonly poolSequence: number;
  readonly maxFeeDrops: bigint;
  readonly maxLastLedger: number;
  /** The network the pool lives on: a signature must not be good on any other. */
  readonly networkId: number;
}): void {
  const { expected, proposed } = input;
  const bad = (why: string): never => { throw new ProtocolFailure('INVALID_INPUT', `refusing to sign: ${why}`); };
  // Networks 0..1024 (mainnet, testnet, devnet) carry no NetworkID; others must name theirs.
  const network = input.networkId > 1024 ? input.networkId : undefined;
  const txs = [proposed as Record<string, unknown>, ...innersOf(proposed).map((r) => r.RawTransaction as Record<string, unknown>)];
  if (txs.some((t) => t['NetworkID'] !== network)) bad('the batch names another network');
  const strip = (t: Proposal) => JSON.stringify(canonical({
    ...withoutAutofill(t as never),
    ...(t.TransactionType === 'Batch' ? { RawTransactions: innersOf(t).map((r) => ({ RawTransaction: withoutAutofill(r.RawTransaction as never) })) } : {}),
  }));
  if (strip(proposed) !== strip(expected)) bad('the batch is not the payout that was verified');
  if (proposed.Sequence !== input.poolSequence) bad('the batch is not at the pool\'s next sequence');
  innersOf(proposed).forEach((r, i) => {
    const t = r.RawTransaction as Record<string, unknown>;
    if (t['Sequence'] !== input.poolSequence + 1 + i) bad('inner sequences must follow the batch');
    if (t['Fee'] !== '0' || t['SigningPubKey'] !== '') bad('inner transactions carry no fee and no key');
  });
  if (typeof proposed.Fee !== 'string' || !/^\d+$/.test(proposed.Fee) || BigInt(proposed.Fee) > input.maxFeeDrops) bad('fee above the cap');
  if (typeof proposed.LastLedgerSequence !== 'number' || proposed.LastLedgerSequence > input.maxLastLedger) bad('validity window too long');
}
