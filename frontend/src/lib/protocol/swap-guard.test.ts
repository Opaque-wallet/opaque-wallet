// F-3 (overlord): the quote signed at click time must be the one previewed.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { swapHoldsPreview } from './index.ts';

test('a signed quote worse than the preview, or with a floor near nothing, is not signed (F-3)', () => {
  const preview = { toAmountMin: '1301746' };
  assert.equal(swapHoldsPreview(preview, { toAmount: '1308289', toAmountMin: '1301746' }), true, 'the same quote');
  assert.equal(swapHoldsPreview(preview, { toAmount: '1305000', toAmountMin: '1298000' }), true, 'moved 0.3%: still the swap shown');
  // OMEGA's PoC: genuine calldata asked with slippage 0.99, so its least is 1% of its estimate.
  assert.equal(swapHoldsPreview(preview, { toAmount: '1308289', toAmountMin: '13083' }), false);
  assert.equal(swapHoldsPreview(preview, { toAmount: '1250000', toAmountMin: '1243750' }), false, 'the price moved 4.5% against the user');
  assert.equal(swapHoldsPreview(preview, { toAmount: '1400000', toAmountMin: '1302000' }), false, 'a 7% slippage floor, even above the preview');
});

// F-24 (overlord): amounts that go into a field are grouped the same in every language.
test('an amount for a field reads the same in German as in English (F-24)', async () => {
  const { fromUnits } = await import('./index.ts');
  // OMEGA's PoC: in de-DE, Max on 1234 EURC filled in "1.234". Here the browser's own default is German.
  const plain = BigInt.prototype.toLocaleString;
  BigInt.prototype.toLocaleString = function (this: bigint, locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) { return plain.call(this, locales ?? 'de-DE', options); };
  try {
    assert.equal(fromUnits(1_234_000_000n, 6), '1,234');
    assert.equal(fromUnits(1_234_500_000n, 6), '1,234.5');
  } finally {
    BigInt.prototype.toLocaleString = plain;
  }
});
