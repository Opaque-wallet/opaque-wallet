import assert from 'node:assert/strict';
import { test } from 'node:test';

import { accountFromKeyText, accountKeys, accountKeyText, isAccountKeyText, isPhrase, newPhrase, normalizePhrase, stream } from './wallet-keys.ts';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

test('a new phrase is 12 valid words, and a typed one is forgiven its spacing and case', () => {
  const phrase = newPhrase();
  assert.equal(phrase.split(' ').length, 12);
  assert.ok(isPhrase(phrase));
  assert.ok(isPhrase(`  ${phrase.toUpperCase().replaceAll(' ', '   ')} `));
  assert.equal(normalizePhrase(' A  b '), 'a b');
  assert.ok(!isPhrase('abandon abandon abandon'));
  assert.ok(!isPhrase(PHRASE.replace('about', 'abandon'))); // a wrong checksum word
  assert.throws(() => accountKeys('not a phrase', 0));
});

// Known answers. If these change, every phrase stops finding its notes: never edit them to match new code.
test('the derivation never changes', () => {
  assert.equal(accountKeys(PHRASE, 0).id, '8a655e3055794a9e');
  assert.equal(accountKeys(PHRASE, 1).id, '20c220e2b141a95e');
  assert.equal(hex(stream(accountKeys(PHRASE, 0).key, 'note/xrpl-testnet/rPool/1000000/0')(32)), '2e4fed71f02fa7724d52c2f3a46e45002845262fb553a04cf41b6b7e01e1bde5');
});

test('each account and label draws its own bytes, the same however they are read', () => {
  const { key } = accountKeys(PHRASE, 0);
  const whole = stream(key, 'site/https://a.example')(80);
  const parts = stream(key, 'site/https://a.example');
  assert.equal(hex(new Uint8Array([...parts(16), ...parts(64)])), hex(whole));
  assert.notEqual(hex(stream(key, 'site/https://b.example')(32)), hex(whole.slice(0, 32)));
  assert.notEqual(hex(stream(accountKeys(PHRASE, 1).key, 'site/https://a.example')(32)), hex(whole.slice(0, 32)));
});

test('an account key carries one account, and a typo in it is caught', () => {
  const account = accountKeys(PHRASE, 2);
  const text = accountKeyText(account);
  assert.match(text, /^opq1[0-9a-f]{72}$/);
  assert.ok(isAccountKeyText(` ${text.toUpperCase()} `));
  const back = accountFromKeyText(text.toUpperCase(), 0);
  assert.equal(back.id, account.id);
  assert.equal(hex(back.key), hex(account.key));
  assert.equal(back.imported, 0);
  const typo = `${text.slice(0, 20)}${text[20] === 'a' ? 'b' : 'a'}${text.slice(21)}`;
  assert.throws(() => accountFromKeyText(typo, 0), /typo/);
  assert.throws(() => accountFromKeyText(hex(account.key), 0), /opq1/);
});
