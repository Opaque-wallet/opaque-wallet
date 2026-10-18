import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Wallet } from 'xrpl';

import { sweepKey } from '../sweep.ts';

test('a family seed gives its account: the genesis seed, the genesis address', () => {
  assert.equal(sweepKey('  snoPBrXtMeMyMHUVTgbuqAfg1SUTb ').address, 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh');
});

test('a phrase gives the account xrpl.js gives it, on XRPL\'s path', () => {
  const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const reference = Wallet.fromMnemonic(phrase, { mnemonicEncoding: 'bip39' });
  const ours = sweepKey(phrase.toUpperCase());
  assert.equal(ours.address, reference.address);
  assert.equal(ours.publicKey, reference.publicKey);
  assert.equal(ours.privateKey, reference.privateKey);
});

test('anything else is refused before a key is made', () => {
  assert.throws(() => sweepKey('not a secret'), /not an XRPL secret/);
  assert.throws(() => sweepKey('snoPBrXtMeMyMHUVTgbuqAfg1SUTc'), /not valid/);
  assert.throws(() => sweepKey('abandon abandon abandon'), /not an XRPL secret/);
});
