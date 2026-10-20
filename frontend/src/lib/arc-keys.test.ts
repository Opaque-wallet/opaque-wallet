import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveCommitment } from '@opaque/zk';

import { deployment } from '../../../deployments/index.ts';
import { addressOfKey, arcAddressOf, deployerKey, findNotes, forsSeed, NOTE_GAP, noteSecret } from './arc-keys.ts';
import { accountKeys } from './xrpl-keys.ts';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const pool = deployment.pools.find((p) => p.proofMode === 'RING_8')!;
const scope = { chainId: BigInt(deployment.network.chainId), pool: pool.address, denomination: pool.denomination } as never;

// Known answers. If these change, every phrase loses its Arc account and notes: never edit them to match new code.
test('the Arc derivation never changes', () => {
  const account = accountKeys(PHRASE, 0);
  assert.equal(deployment.network.chainId, 5042002, 'pinned on Arc testnet');
  assert.equal(hex(forsSeed(account, 0n)).slice(0, 16), 'bd1a4aa15cea31eb');
  assert.equal(arcAddressOf(account), '0xf4e4e95484b594527212b0316199f575ae98299c');
});

test('each account, epoch and note draws its own secret', () => {
  const [a, b] = [accountKeys(PHRASE, 0), accountKeys(PHRASE, 1)];
  assert.notEqual(hex(forsSeed(a, 0n)), hex(forsSeed(a, 1n)));
  assert.notEqual(hex(forsSeed(a, 0n)), hex(forsSeed(b, 0n)));
  assert.notEqual(hex(noteSecret(a, scope, 0)), hex(noteSecret(a, scope, 1)));
  assert.equal(noteSecret(a, scope, 0).length, 16);
  assert.notEqual(arcAddressOf(a), arcAddressOf(b));
});

test('a deployer is an ordinary address, its own per account and index', () => {
  // web3.js's documented key and address.
  assert.equal(addressOfKey('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'), '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
  const [a, b] = [accountKeys(PHRASE, 0), accountKeys(PHRASE, 1)];
  assert.match(deployerKey(a, 0), /^0x[0-9a-f]{64}$/);
  assert.equal(deployerKey(a, 0), deployerKey(accountKeys(PHRASE, 0), 0), 'the phrase brings it back');
  assert.notEqual(deployerKey(a, 0), deployerKey(a, 1));
  assert.notEqual(deployerKey(a, 0), deployerKey(b, 0));
  assert.notEqual(addressOfKey(deployerKey(a, 0)).toLowerCase(), arcAddressOf(a), 'not the account itself');
});

test('a scan finds the account\'s notes among a pool\'s deposits, across a gap a failed deposit left', async () => {
  const account = accountKeys(PHRASE, 0);
  const at = (i: number) => deriveCommitment(noteSecret(account, scope, i), scope).toLowerCase();
  const deposits = new Set([at(0), at(1), at(30), '0xother']);
  const all = await findNotes(account, scope, deposits, 0, 0);
  assert.deepEqual(all.found.map((n) => n.i), [0, 1, 30]);
  assert.equal(all.next, 31);
  // From where this browser is, only what came after: a deposit from another device.
  const later = await findNotes(account, scope, new Set([...deposits, at(31)]), 31, 31);
  assert.deepEqual(later.found.map((n) => n.i), [31]);
  // Past the gap is past the end.
  assert.equal((await findNotes(account, scope, new Set([at(NOTE_GAP + 5)]), 0, 0)).found.length, 0);
});
