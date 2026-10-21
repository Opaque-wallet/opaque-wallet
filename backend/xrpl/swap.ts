// Private swaps between pools, on the ledger's own exchange.
//
// A swap is a payment like any other: notes of one pool, spent through a ring,
// paid to another Opaque pool under a fresh deposit tag of the wallet's. What
// makes it a swap is that the destination is a pool of another asset, so the
// payout is a cross-currency Payment: SendMax the notes' value, DeliverMin the
// least the wallet accepts, partial so everything the notes buy arrives. The
// ledger routes it through its AMMs (XRP to a token directly, token to token
// through XRP), and the other pool credits the tag with what was delivered.
//
// The wallet and the attesters both import this file: the wallet quotes with
// it to set DeliverMin, and each attester quotes again before it signs, so a
// coordinator cannot settle a swap far below the market. The wallet page
// imports it too, so it uses the ledger through a `read` it is given and never
// the xrpl package.

import { ProtocolFailure } from '@opaque/protocol-types';

import { splitAmount, UNIT, type XrplAsset } from './protocol.ts';

/** A ledger read: rippled's command and its parameters, answered with its result. */
export type LedgerRead = <T>(command: string, params: Record<string, unknown>) => Promise<T>;

/** What a wallet accepts below the quote: 2%. */
export const SWAP_SLIPPAGE_BPS = 200n;
/** What an attester accepts: a DeliverMin no lower than half its own quote. */
export const ATTESTER_FLOOR = 2n;

const refuse = (message: string): never => { throw new ProtocolFailure('INVALID_INPUT', message); };
const sameAsset = (a: XrplAsset, b: XrplAsset): boolean =>
  a.kind === b.kind && (a.kind === 'XRP' || (a.kind === 'IOU' && b.kind === 'IOU' && a.currency === b.currency && a.issuer === b.issuer)
    || (a.kind === 'MPT' && b.kind === 'MPT' && a.issuanceId === b.issuanceId));
export { sameAsset as sameXrplAsset };

/** Out of a constant-product pool for `amountIn`, its fee in 1/100,000 taken from what goes in. */
export function ammOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, fee: number): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const kept = amountIn * BigInt(100_000 - fee);
  return (reserveOut * kept) / (reserveIn * 100_000n + kept);
}

/** "12.3456789" in a token's 6-decimal units, rounded down. */
const unitsOf = (value: string): bigint => {
  const [whole, frac = ''] = value.split('.');
  return BigInt(whole || '0') * UNIT + BigInt((frac + '000000').slice(0, 6));
};

interface Reserves { readonly xrp: bigint; readonly token: bigint; readonly fee: number }

/** The XRP/token AMM's two reserves, in drops and the token's units. */
async function reservesOf(read: LedgerRead, token: XrplAsset): Promise<Reserves> {
  if (token.kind !== 'IOU') return refuse(`no swaps for ${token.kind === 'MPT' ? 'MPTs' : 'XRP'} yet: swaps run through XRP/token AMMs`);
  const result = await read<{ amm?: { amount: string | { value: string }; amount2: string | { value: string }; trading_fee: number } }>('amm_info', {
    asset: { currency: 'XRP' }, asset2: { currency: token.currency, issuer: token.issuer },
  }).catch(() => ({ amm: undefined }));
  const amm = result.amm ?? refuse('there is no AMM for this pair on the ledger yet');
  // amm_info names the pair in the order it was created; XRP is the one that is a string.
  const [xrp, other] = typeof amm.amount === 'string' ? [amm.amount, amm.amount2] : [amm.amount2, amm.amount];
  return { xrp: BigInt(xrp as string), token: unitsOf((other as { value: string }).value), fee: amm.trading_fee };
}

/** XRP's price in `token`, from the ledger's XRP/token AMM: the ratio of its reserves, the mid price. */
export async function xrpPriceIn(read: LedgerRead, token: XrplAsset): Promise<number> {
  const r = await reservesOf(read, token);
  return Number(r.token) / Number(r.xrp);
}

/** One AMM on the way, as the trade sees it: what goes in, what comes out. */
interface Hop { reserveIn: bigint; reserveOut: bigint; readonly fee: number }

/** The AMMs a swap passes through: one when either side is XRP, two through XRP when both are tokens. */
async function routeOf(read: LedgerRead, from: XrplAsset, to: XrplAsset): Promise<Hop[]> {
  if (sameAsset(from, to)) return refuse('a swap is between two different assets');
  if (from.kind === 'XRP') { const r = await reservesOf(read, to); return [{ reserveIn: r.xrp, reserveOut: r.token, fee: r.fee }]; }
  const a = await reservesOf(read, from);
  const first: Hop = { reserveIn: a.token, reserveOut: a.xrp, fee: a.fee };
  if (to.kind === 'XRP') return [first];
  const b = await reservesOf(read, to);
  return [first, { reserveIn: b.xrp, reserveOut: b.token, fee: b.fee }];
}

/** Trades `units` along `route`, moving its reserves as the ledger would; returns what comes out. */
function trade(route: Hop[], units: bigint): bigint {
  let amount = units;
  for (const hop of route) {
    const out = ammOut(amount, hop.reserveIn, hop.reserveOut, hop.fee);
    hop.reserveIn += amount;
    hop.reserveOut -= out;
    amount = out;
  }
  return amount;
}
const copy = (route: readonly Hop[]): Hop[] => route.map((h) => ({ ...h }));

/** What `units` of `from` buy of `to` now, through the ledger's AMMs. */
export async function quoteSwap(read: LedgerRead, from: XrplAsset, to: XrplAsset, units: bigint): Promise<bigint> {
  return trade(await routeOf(read, from, to), units);
}

/**
 * A swap of several notes: each settles as a payout of its own, in an order
 * nobody fixes, so each is quoted as if it settled LAST, after every other
 * note has moved the price. `total` is what they bring settled one by one.
 */
export async function quoteNotes(read: LedgerRead, from: XrplAsset, to: XrplAsset, nets: readonly bigint[]): Promise<{ readonly each: bigint[]; readonly total: bigint }> {
  const route = await routeOf(read, from, to);
  const each = nets.map((units, i) => {
    const r = copy(route);
    nets.forEach((other, j) => { if (j !== i) trade(r, other); });
    return trade(r, units);
  });
  const r = copy(route);
  return { each, total: nets.reduce((sum, units) => sum + trade(r, units), 0n) };
}

/**
 * The notes a swap's tag must hold, by size. A swap arrives as one payment per
 * note spent, and the pool credits each (with what the last ones left over)
 * greedily, largest size first: so many small payments need many small notes.
 * Counted for every order the payments might land in, with `headroom` over the
 * quotes, since the ledger may deliver more than quoted.
 */
export function notesForPayments(outs: readonly bigint[], sizes: readonly number[], headroomBps = 500n): Map<number, number> {
  const descending = [...sizes].sort((a, b) => b - a);
  const padded = outs.map((o) => (o * (10_000n + headroomBps)) / 10_000n);
  const orders = [padded, [...padded].reverse(), [...padded].sort((a, b) => (a < b ? -1 : 1)), [...padded].sort((a, b) => (a > b ? -1 : 1))];
  const need = new Map(descending.map((s) => [s, 0]));
  // Split greedily or as a ladder, whichever the tag's registrations say: enough for both.
  for (const ladder of [false, true]) {
    for (const order of orders) {
      const counts = new Map(descending.map((s) => [s, 0]));
      let carried = 0n;
      for (const out of order) carried = splitAmount(carried + out, descending, ladder, (s) => { counts.set(s, counts.get(s)! + 1); return true; });
      for (const s of descending) need.set(s, Math.max(need.get(s)!, counts.get(s)!));
    }
  }
  // One spare of the smallest, for what the last payments leave over together.
  const smallest = descending[descending.length - 1]!;
  need.set(smallest, need.get(smallest)! + 1);
  return need;
}

/** The DeliverMin a wallet asks for: the quote, less SWAP_SLIPPAGE_BPS. */
export const deliverMinOf = (quote: bigint): bigint => (quote * (10_000n - SWAP_SLIPPAGE_BPS)) / 10_000n;

/**
 * A payout's swap, when its destination is a pool of another asset: that
 * asset, and the spend's DeliverMin. Without one it is refused for good, since
 * a pool ignores a payment in another asset and the notes would be lost.
 */
export function swapInto(pools: ReadonlyMap<string, { readonly source: { readonly config: { readonly asset: XrplAsset } } }>, asset: XrplAsset, destination: string, spend: { readonly deliverMin?: unknown }): { asset: XrplAsset; min: bigint } | undefined {
  const target = pools.get(destination);
  if (target === undefined || sameAsset(target.source.config.asset, asset)) return undefined;
  const min = spend.deliverMin;
  if (typeof min !== 'string' || !/^[1-9][0-9]{0,30}$/.test(min)) {
    throw new ProtocolFailure('INVALID_INPUT', 'a payment into another pool is a swap, and must name the least it delivers');
  }
  return { asset: target.source.config.asset, min: BigInt(min) };
}
