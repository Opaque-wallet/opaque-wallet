import assert from 'node:assert/strict';
import { test } from 'node:test';

import { asPolicy, DAY_MS, DEFAULT_POLICY, judge, type Spend } from '../src/policy.ts';

const NOW = 1_800_000_000_000;
const to = '0x1111111111111111111111111111111111111111';

test('under every limit, it goes; over askAbove, it asks', () => {
  assert.deepEqual(judge(DEFAULT_POLICY, [], { asset: 'arc:USDC', amount: 5, to }, NOW), { ok: true, ask: false });
  assert.deepEqual(judge(DEFAULT_POLICY, [], { asset: 'arc:USDC', amount: 6, to }, NOW), { ok: true, ask: true });
});

test('over a payment\'s limit, or the day\'s, it is refused', () => {
  assert.equal(judge(DEFAULT_POLICY, [], { asset: 'arc:USDC', amount: 11, to }, NOW).ok, false);
  const spends: Spend[] = [{ at: NOW - 1_000, asset: 'arc:USDC', amount: 45, to }];
  assert.match((judge(DEFAULT_POLICY, spends, { asset: 'arc:USDC', amount: 6, to }, NOW) as { why: string }).why, /a day/);
  // Spends older than a day no longer count.
  assert.equal(judge(DEFAULT_POLICY, [{ ...spends[0]!, at: NOW - DAY_MS }], { asset: 'arc:USDC', amount: 6, to }, NOW).ok, true);
  // Nor do another asset's.
  assert.equal(judge(DEFAULT_POLICY, spends, { asset: 'xrpl:XRP', amount: 6, to }, NOW).ok, true);
});

test('an asset with no limit can\'t be paid at all', () => {
  assert.match((judge(DEFAULT_POLICY, [], { asset: 'arc:EURC', amount: 1, to }, NOW) as { why: string }).why, /no limit/);
});

test('with recipients listed, only they are paid, and the account\'s own deployers', () => {
  const policy = { ...DEFAULT_POLICY, recipients: [to.toUpperCase().replace('0X', '0x')] };
  assert.equal(judge(policy, [], { asset: 'arc:USDC', amount: 1, to }, NOW).ok, true);
  assert.equal(judge(policy, [], { asset: 'arc:USDC', amount: 1, to: '0x2222222222222222222222222222222222222222' }, NOW).ok, false);
  assert.equal(judge(policy, [], { asset: 'arc:USDC', amount: 1, to: '0x2222222222222222222222222222222222222222', own: true }, NOW).ok, true);
});

test('a policy typed back is checked', () => {
  assert.deepEqual(asPolicy(DEFAULT_POLICY), DEFAULT_POLICY);
  assert.throws(() => asPolicy({ limits: { USDC: { perPayment: 1, perDay: 1, askAbove: 1 } }, recipients: [] }), /isn't an asset/);
  assert.throws(() => asPolicy({ limits: { 'arc:USDC': { perPayment: -1, perDay: 1, askAbove: 1 } }, recipients: [] }), /0 or more/);
});

test('F-44: a limit must be a finite number', () => {
  assert.throws(() => asPolicy({ limits: { 'arc:USDC': { perPayment: 1e999, perDay: 1, askAbove: 1 } }, recipients: [] }), /0 or more/);
  assert.throws(() => asPolicy({ ...DEFAULT_POLICY, operationsPerDay: 1.5 }), /whole number/);
});
