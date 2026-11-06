import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { openAnnouncement, stealthAccountOf, stealthKeys, stealthPayment } from '../stealth.ts';

test('the address a sender pays is the one only its recipient finds', () => {
  const alice = stealthKeys(randomBytes(64));
  const bob = stealthKeys(randomBytes(64));
  const paid = stealthPayment(alice.metaAddress);
  const announced = { stealthAddress: paid.address, ephemeralPubKey: paid.ephemeralPubKey, metadata: paid.metadata };

  const found = openAnnouncement(alice.secretKey, announced);
  assert.equal(found?.address, paid.address, 'alice finds it');
  assert.equal(openAnnouncement(bob.secretKey, announced), undefined, 'bob does not');
  // Kept as its shared secret, the account comes back whole: same address, same keys.
  assert.equal(stealthAccountOf(found!.secret).address, paid.address);
  assert.deepEqual(stealthAccountOf(found!.secret).seedFor(0n), found!.seedFor(0n));

  // Two payments to one meta-address: two unrelated addresses.
  assert.notEqual(stealthPayment(alice.metaAddress).address, paid.address);
  // An announcement pointing elsewhere is not alice's, whatever its ciphertext.
  assert.equal(openAnnouncement(alice.secretKey, { ...announced, stealthAddress: `0x${'11'.repeat(20)}` as const }), undefined);
});

test('the same phrase seed gives the same meta-address', () => {
  const seed = randomBytes(64);
  assert.equal(stealthKeys(seed).metaAddress, stealthKeys(Uint8Array.from(seed)).metaAddress);
  assert.equal((stealthKeys(seed).metaAddress.length - 2) / 2, 1184);
});
