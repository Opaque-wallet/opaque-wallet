// Private swaps between pools, offline: the AMM quote, the payout a swap
// becomes, and the refusals that keep a payment in another asset from being
// lost or settled far below the market.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GlobalFlags, PaymentFlags } from 'xrpl';

import { payoutBatch } from '../batch.ts';
import { UNIT, type XrplAsset } from '../protocol.ts';
import { ammOut, deliverMinOf, notesForPayments, quoteNotes, quoteSwap, swapInto, type LedgerRead } from '../swap.ts';
import { creditDeposits } from '../pool.ts';

const XRP: XrplAsset = { kind: 'XRP' };
const USD: XrplAsset = { kind: 'IOU', currency: 'USD', issuer: 'rDzYkrDBG8uLa5EotddkzhZnAuFXXxf8Bu' };
const EUR: XrplAsset = { kind: 'IOU', currency: 'EUR', issuer: 'rpEJVjwRVZ8Q2ddgpHVukxgWKz9L9UwFzF' };
/** Two AMMs, XRP/USD and XRP/EUR, 1,000 XRP each at 1:1, with a 0.3% fee. */
const read: LedgerRead = async <T>(_command: string, params: Record<string, unknown>) => {
  const token = params['asset2'] as { currency: string; issuer: string };
  return { amm: { amount: '1000000000', amount2: { ...token, value: '1000' }, trading_fee: 300 } } as T;
};

test('the constant-product quote, fee taken from what goes in', () => {
  assert.equal(ammOut(10n * UNIT, 1000n * UNIT, 1000n * UNIT, 0), 9_900_990n);
  assert.ok(ammOut(10n * UNIT, 1000n * UNIT, 1000n * UNIT, 300) < 9_900_990n);
  assert.equal(ammOut(0n, 1n, 1n, 0), 0n);
});

test('token to token goes through XRP, and costs both fees', async () => {
  const direct = await quoteSwap(read, XRP, USD, 10n * UNIT);
  const through = await quoteSwap(read, EUR, USD, 10n * UNIT);
  assert.ok(through < direct && through > 9n * UNIT, `${through} through XRP, ${direct} direct`);
  await assert.rejects(quoteSwap(read, USD, USD, 1n), /different assets/);
});

test('each note is quoted as if it settled last, so its minimum holds in any order', async () => {
  const nets = [100n * UNIT, 10n * UNIT, 1n * UNIT];
  const { each, total } = await quoteNotes(read, XRP, USD, nets);
  const alone = await Promise.all(nets.map((n) => quoteSwap(read, XRP, USD, n)));
  each.forEach((e, i) => assert.ok(e < alone[i]!, 'after the others, a note buys less than alone'));
  assert.ok(each.reduce((a, b) => a + b, 0n) <= total, 'last-in-line minimums never add up past the real total');
  assert.equal(deliverMinOf(1000n), 980n, '2% under the quote');
});

test('a payment into another pool of another asset is a swap, and must name its minimum', () => {
  const pools = new Map([['rUSDpool', { source: { config: { asset: USD } } }], ['rXRPpool', { source: { config: { asset: XRP } } }]]);
  assert.deepEqual(swapInto(pools, XRP, 'rUSDpool', { deliverMin: '9500000' }), { asset: USD, min: 9_500_000n });
  assert.equal(swapInto(pools, XRP, 'rXRPpool', {}), undefined, 'into a pool of the same asset: an ordinary payment');
  assert.equal(swapInto(pools, XRP, 'rSomeoneElse', {}), undefined, 'to anyone else: an ordinary payment');
  assert.throws(() => swapInto(pools, XRP, 'rUSDpool', {}), /least it delivers/, 'otherwise the other pool would ignore it and the notes be lost');
  assert.throws(() => swapInto(pools, XRP, 'rUSDpool', { deliverMin: '0' }), /least it delivers/);
});

test('a swap payout is partial, spends at most the notes, and delivers at least the minimum', () => {
  const base = { pool: 'rw5r7pX37iAtLEh1VZdciHaFpduftUtjYe', nullifiers: [`0x${'11'.repeat(32)}`] as never, destination: { account: 'rfyGTnEH8fLeucbBxxpy24dsgXoFQnHJMZ', tag: 7 }, nextSigners: [], quorum: 2 };
  const pay = (asset: XrplAsset, deliver: { asset: XrplAsset; min: bigint }) =>
    payoutBatch({ ...base, asset, units: 9_799_900n, deliver }).RawTransactions.find((r) => r.RawTransaction.TransactionType === 'Payment')!.RawTransaction as unknown as Record<string, unknown>;
  const xrpToUsd = pay(XRP, { asset: USD, min: 9_500_000n });
  assert.equal(xrpToUsd['SendMax'], '9799900');
  assert.deepEqual(xrpToUsd['DeliverMin'], { currency: 'USD', issuer: USD.kind === 'IOU' ? USD.issuer : '', value: '9.5' });
  assert.equal(xrpToUsd['Flags'], PaymentFlags.tfPartialPayment | GlobalFlags.tfInnerBatchTxn);
  assert.equal(xrpToUsd['DestinationTag'], 7);
  assert.equal(xrpToUsd['Paths'], undefined, 'XRP to a token: one AMM, the default path');
  assert.deepEqual(pay(EUR, { asset: USD, min: 1n })['Paths'], [[{ currency: 'XRP' }]], 'token to token: through XRP');
  // An ordinary payout is unchanged.
  const plain = payoutBatch({ ...base, asset: XRP, units: 9_799_900n }).RawTransactions.find((r) => r.RawTransaction.TransactionType === 'Payment')!.RawTransaction as unknown as Record<string, unknown>;
  assert.equal(plain['Amount'], '9799900');
  assert.equal(plain['Flags'], GlobalFlags.tfInnerBatchTxn);
  assert.equal(plain['SendMax'], undefined);
});

test('a swap\'s tag holds enough small notes for many small payments, in any order', () => {
  // 15 XRP as 10 + 5×1: one payment of ~8.3 USDC and five of ~0.68. A tag made
  // for one 12.9 USDC payment ran out of 1-USDC notes and left 3.9 carried.
  const outs = [8_300_000n, ...Array.from({ length: 5 }, () => 680_000n)];
  const sizes = [1_000_000, 10_000_000, 100_000_000];
  const need = notesForPayments(outs, sizes);
  for (const order of [outs, [...outs].reverse()]) {
    const tags = new Map([[7, Object.fromEntries(sizes.map((s) => [String(s), Array.from({ length: need.get(s)! }, (_, i) => `0x${s.toString(16).padStart(8, '0')}${i.toString(16).padStart(56, '0')}`)]))]]);
    const log = creditDeposits(order.map((units, i) => ({ hash: `h${i}`, ledgerIndex: i, from: 'rPool', units, tag: 7, invoiceId: null })), sizes, tags as never);
    const credited = log.deposits.reduce((n, d) => n + BigInt(d.denomination), 0n);
    assert.ok(log.carried.get(7)! < 1_000_000n, `all but a remainder under one note is credited (${credited}, carried ${log.carried.get(7)})`);
  }
  assert.ok(need.get(1_000_000)! >= 12, `${need.get(1_000_000)} one-USDC notes`);
});


// F-29 (overlord): the ledger writes large IOU values in exponent form; quotes read them.
test('AMM reserves written as "1.2e11" are read, not thrown on (F-29)', async () => {
  const usd: XrplAsset = { kind: 'IOU', currency: 'USD', issuer: 'rDzYkrDBG8uLa5EotddkzhZnAuFXXxf8Bu' };
  let asked: Record<string, unknown> = {};
  // OMEGA's PoC: an AMM whose token reserve is "1.2e11".
  const read: LedgerRead = async <T,>(_command: string, params: Record<string, unknown>) => {
    asked = params;
    return { amm: { amount: String(60_000_000_000n * UNIT), amount2: { value: '1.2e11' }, trading_fee: 500 } } as T;
  };
  const out = await quoteSwap(read, { kind: 'XRP' }, usd, 1_000n * UNIT);
  // 1,000 XRP at 1:2, less the 0.5% fee: 1,990 USD, a hair under.
  assert.ok(out > 1_989n * UNIT && out < 1_990n * UNIT, `1,000 XRP at 1:2 less 0.5% (${out})`);
  // F-14: the reserves come from the validated ledger, not the open one.
  assert.equal(asked['ledger_index'], 'validated');
});

// F-14 (overlord): an attester holds a swap to within 10% of its own quote, not half.
test('a DeliverMin shaved below the floor is refused; the wallet\'s own slippage passes (F-14)', async () => {
  const { ATTESTER_FLOOR_BPS, SWAP_SLIPPAGE_BPS } = await import('../swap.ts');
  const fair = 1_000_000n;
  const accepts = (min: bigint) => !(min * 10_000n < fair * (10_000n - ATTESTER_FLOOR_BPS));
  // OMEGA's PoC: the executor lowers DeliverMin to fair / 2.
  assert.equal(accepts(fair / 2n), false);
  assert.equal(accepts((fair * (10_000n - SWAP_SLIPPAGE_BPS)) / 10_000n), true, 'what an honest wallet asks');
  assert.equal(accepts(890_000n), false, '11% under: refused');
});
