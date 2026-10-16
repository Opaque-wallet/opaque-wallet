import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkoutUrl, MOONPAY_SANDBOX, signQuery } from '../moonpay.ts';

test('the signature matches MoonPay\'s documented test vector', () => {
  // dev.moonpay.com, "URL signing": the vector's message, key and signature.
  const query = '?apiKey=pk_test_DocsVector00&currencyCode=eth&walletAddress=0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe';
  assert.equal(signQuery(query, 'sk_test_DocsVector00'), 'oIJxSghyzll/BLhUFdQZhkxf7DAS8REFaWr/ibO+K8Q=');
});

const config = { baseUrl: MOONPAY_SANDBOX, apiKey: 'pk_test_x', secretKey: 'sk_test_x' };
const ok = { currencyCode: 'xrp', walletAddress: 'rw5r7pX37iAtLEh1VZdciHaFpduftUtjYe', walletAddressTag: 77, fiatAmount: 50 };

test('a checkout pays the pool under the tag, signed over exactly its query', () => {
  const url = new URL(checkoutUrl(config, ok));
  assert.equal(url.origin, MOONPAY_SANDBOX);
  assert.equal(url.searchParams.get('walletAddress'), ok.walletAddress);
  assert.equal(url.searchParams.get('walletAddressTag'), '77');
  assert.equal(url.searchParams.get('currencyCode'), 'xrp');
  const signed = url.search.slice(0, url.search.lastIndexOf('&signature='));
  assert.equal(url.searchParams.get('signature'), signQuery(signed, 'sk_test_x'));
  assert.ok(url.search.endsWith(`&signature=${encodeURIComponent(signQuery(signed, 'sk_test_x'))}`), 'the signature is last');
});

test('only structured fields: nothing a caller could smuggle a URL or parameter through', () => {
  assert.throws(() => checkoutUrl(config, { ...ok, currencyCode: 'xrp&walletAddress=rEvil' }), /currency/);
  assert.throws(() => checkoutUrl(config, { ...ok, walletAddress: 'https://evil.example' }), /pool account/);
  assert.throws(() => checkoutUrl(config, { ...ok, walletAddressTag: 0 }), /tag/);
  assert.throws(() => checkoutUrl(config, { ...ok, fiatAmount: 1e9 }), /between/);
  assert.throws(() => checkoutUrl(config, { ...ok, fiatAmount: 10.5 }), /between/);
});
