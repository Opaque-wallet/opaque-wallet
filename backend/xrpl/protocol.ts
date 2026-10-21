// XRPL on the frozen §2 contract, with no change to it. The browser wallet and
// the attesters both import this file, so the two can never disagree on bytes.
//
//   PoolScope.chainId  the XRPL network id, lifted to 2^64 + id. EIP-2294 caps
//                      EVM chain ids below 2^63, so no EVM chain can share a
//                      poolId with an XRPL pool.
//   PoolScope.pool     the pool account's 20-byte AccountID, lower-case hex.
//   denomination       the note's size in 6-decimal units: drops for XRP,
//                      micro-units for a trust-line token. XRPL pools use the
//                      frozen sizes 1, 10 and 100; a 1,000 note needs a
//                      protocol-types change first.
//   recipient          20 bytes binding the destination account AND its tag.
//                      The proof binds the recipient, so a relay cannot re-tag
//                      a payment to an exchange, or to someone else's notes in
//                      a pool. The account and tag travel beside the spend, and
//                      every attester recomputes this before it signs.
//   nullifier          is the CredentialType of the credential the pool issues
//                      to itself when the note is spent. The ledger refuses a
//                      second one (tecDUPLICATE), and the Batch with it.
//   commitment         is the InvoiceID of a deposit from the depositor's own
//                      account (DestinationTag 0).

import { keccak_256 } from '@noble/hashes/sha3.js';
// The codec alone, not xrpl: the wallet page imports this file, and xrpl.js
// would bring 2 MB of confidential-MPT WebAssembly it never uses.
import { classicAddressToXAddress, decodeAccountID, encodeAccountID, isValidClassicAddress } from 'ripple-address-codec';

import { ProtocolFailure, type Address, type ChainId, type Denomination, type NoteCommitment, type Nullifier, type PoolScope } from '@opaque/protocol-types';
import { asAddress, asChainId, asDenomination, asNoteCommitment, fromHex, toHex } from '@opaque/protocol-types/codecs.js';

export const XRPL_CHAIN_BASE = 1n << 64n;
const RECIPIENT_DOMAIN = 'opaque/v1/xrpl/recipient';
/** The tag a deposit from one's own account carries: its InvoiceID names the note. */
export const INVOICE_TAG = 0;
/** Drops for XRP; micro-units for tokens. */
export const UNIT = 1_000_000n;

const refuse = (message: string): never => { throw new ProtocolFailure('INVALID_INPUT', message); };
const utf8 = (s: string) => new TextEncoder().encode(s);

export const xrplChainId = (networkId: number): ChainId => asChainId(XRPL_CHAIN_BASE + BigInt(networkId));
export const isXrplScope = (scope: PoolScope): boolean => scope.chainId >= XRPL_CHAIN_BASE;

export const addressOf = (account: string): Address => {
  if (!isValidClassicAddress(account)) refuse(`${account} is not an XRPL classic address`);
  return asAddress(toHex(decodeAccountID(account)));
};
export const accountOf = (address: Address): string => encodeAccountID(fromHex(address));
/** A classic address, checksum included. */
export const isAccount = (value: string): boolean => isValidClassicAddress(value);

export const scopeOf = (networkId: number, poolAccount: string, denomination: number): PoolScope => ({
  chainId: xrplChainId(networkId),
  pool: addressOf(poolAccount),
  denomination: asDenomination(denomination),
});

// ── recipients ───────────────────────────────────────────────────────────

export interface XrplDestination {
  readonly account: string;
  /** null: no tag. 0 is a tag. */
  readonly tag: number | null;
}

export function asDestination(value: unknown): XrplDestination {
  if (typeof value !== 'object' || value === null) refuse('a destination is { account, tag }');
  const { account, tag } = value as Record<string, unknown>;
  if (typeof account !== 'string' || !isValidClassicAddress(account)) refuse('destination account must be a classic address');
  if (tag !== null && (typeof tag !== 'number' || !Number.isInteger(tag) || tag < 0 || tag > 0xffff_ffff)) {
    refuse('destination tag must be a 32-bit unsigned integer or null');
  }
  return { account: account as string, tag: tag as number | null };
}

/** Length-prefixed, so "no tag" and every tag hash apart. */
export function recipientFor(destination: XrplDestination): Address {
  const tag = destination.tag === null ? new Uint8Array(0) : new Uint8Array([
    destination.tag >>> 24, (destination.tag >>> 16) & 0xff, (destination.tag >>> 8) & 0xff, destination.tag & 0xff,
  ]);
  const fields = [utf8(RECIPIENT_DOMAIN), decodeAccountID(destination.account), tag];
  const out = new Uint8Array(fields.reduce((n, f) => n + 4 + f.length, 0));
  let at = 0;
  for (const f of fields) {
    new DataView(out.buffer).setUint32(at, f.length, false);
    out.set(f, at + 4);
    at += 4 + f.length;
  }
  return asAddress(toHex(keccak_256(out).subarray(0, 20)));
}

// ── ledger encodings ─────────────────────────────────────────────────────

/** The ledger stores CredentialType as upper-case hex. */
export const credentialTypeOf = (nullifier: Nullifier): string => (nullifier as string).slice(2).toUpperCase();
export const invoiceIdOf = (commitment: NoteCommitment): string => (commitment as string).slice(2).toUpperCase();
export const commitmentOfInvoice = (invoiceId: string): NoteCommitment => asNoteCommitment(`0x${invoiceId.toLowerCase()}`);

// ── assets and amounts ───────────────────────────────────────────────────

export type XrplAsset =
  | { readonly kind: 'XRP' }
  /** currency is the 3-letter code or the 40-hex form the ledger uses for longer ones (RLUSD). */
  | { readonly kind: 'IOU'; readonly currency: string; readonly issuer: string }
  /**
   * A Multi-Purpose Token: integer amounts in its own AssetScale. A pool's
   * 6-decimal units divide into it exactly only for a scale of 0 to 6.
   */
  | { readonly kind: 'MPT'; readonly issuanceId: string; readonly scale: number };

export type XrplAmount =
  | string
  | { readonly currency: string; readonly issuer: string; readonly value: string }
  | { readonly mpt_issuance_id: string; readonly value: string };

/** Pool units per MPT base unit. */
const mptStep = (scale: number): bigint => {
  if (!Number.isInteger(scale) || scale < 0 || scale > 6) refuse('an MPT pool needs an AssetScale of 0 to 6');
  return 10n ** BigInt(6 - scale);
};

/** Units as the ledger writes them: drops, a token's decimal value, or an MPT's base units. */
export function amountOf(asset: XrplAsset, units: bigint): XrplAmount {
  if (units <= 0n) refuse('an amount must be positive');
  if (asset.kind === 'XRP') return units.toString(10);
  if (asset.kind === 'MPT') {
    const step = mptStep(asset.scale);
    if (units % step !== 0n) refuse('the amount is finer than this token\'s scale');
    return { mpt_issuance_id: asset.issuanceId, value: (units / step).toString(10) };
  }
  const whole = units / UNIT;
  const frac = (units % UNIT).toString(10).padStart(6, '0').replace(/0+$/, '');
  return { currency: asset.currency, issuer: asset.issuer, value: frac === '' ? `${whole}` : `${whole}.${frac}` };
}

/**
 * A ledger decimal ("12.5", "1e-7", "1.25e3") in micro-units, rounded down.
 * ponytail: a token's dust below 1e-6 is dropped (it stays in the pool), which
 * is below any note and any fee; carry it exactly if a pool ever needs that.
 */
export function unitsOfDecimal(value: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (m === null) return refuse(`not a ledger decimal: ${value}`);
  if (m[1] === '-') refuse('a delivered amount cannot be negative');
  const digits = `${m[2]}${m[3] ?? ''}`;
  const shift = Number(m[4] ?? '0') - (m[3]?.length ?? 0) + 6;
  return shift >= 0 ? BigInt(digits) * 10n ** BigInt(shift) : BigInt(digits) / 10n ** BigInt(-shift);
}

const sameCurrency = (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase();

/**
 * What a payment delivered to `pool`, in that pool's asset and units, or null
 * when it delivered something else. A token delivered "issued by the pool" is
 * the destination-as-issuer spelling; the pool holds one trust line, so it can
 * only have arrived through the configured issuer.
 */
export function unitsDelivered(asset: XrplAsset, pool: string, delivered: unknown): bigint | null {
  if (asset.kind === 'XRP') return typeof delivered === 'string' && /^\d+$/.test(delivered) ? BigInt(delivered) : null;
  if (typeof delivered !== 'object' || delivered === null) return null;
  if (asset.kind === 'MPT') {
    const m = delivered as { mpt_issuance_id?: unknown; value?: unknown };
    if (typeof m.mpt_issuance_id !== 'string' || m.mpt_issuance_id.toUpperCase() !== asset.issuanceId.toUpperCase()) return null;
    return typeof m.value === 'string' && /^\d+$/.test(m.value) ? BigInt(m.value) * mptStep(asset.scale) : null;
  }
  const d = delivered as { currency?: unknown; issuer?: unknown; value?: unknown };
  if (typeof d.currency !== 'string' || typeof d.value !== 'string' || !sameCurrency(d.currency, asset.currency)) return null;
  if (d.issuer !== asset.issuer && d.issuer !== pool) return null;
  return unitsOfDecimal(d.value);
}

export type { Denomination };

/** An address and its destination tag as one string (XLS-5), which most XRPL wallets and exchanges take. */
export const xAddressOf = (account: string, tag: number, test: boolean): string => classicAddressToXAddress(account, tag, test);


/** protocol-types' split, where XRPL code looks for it: `true` is the payable split. */
export { splitAmount } from '@opaque/protocol-types';
