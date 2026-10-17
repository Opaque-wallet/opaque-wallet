import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApprovedNamespaces } from '@walletconnect/utils';

import { xrplNamespaces } from './walletconnect.ts';

const proposal = (required: object, optional: object) => ({
  id: 1, expiryTimestamp: 0, relays: [], pairingTopic: 't', requiredNamespaces: required, optionalNamespaces: optional,
  proposer: { publicKey: '00', metadata: { name: 'app', description: '', url: 'https://app.example', icons: [] } },
}) as never;
const ns = (chain: string, method: string) => ({ [chain.split(':')[0]!]: { chains: [chain], methods: [method], events: [] } });
const fits = (p: never) => xrplNamespaces(buildApprovedNamespaces, p, 'xrpl:1', 'rrrrrrrrrrrrrrrrrrrrrhoLvTp');

test('an app on another chain is turned away, required or optional', () => {
  assert.equal(fits(proposal(ns('eip155:1329', 'eth_sendTransaction'), {})), undefined);
  assert.equal(fits(proposal({}, ns('eip155:1329', 'eth_sendTransaction'))), undefined);
  assert.equal(fits(proposal(ns('xrpl:0', 'xrpl_signTransaction'), {})), undefined, 'XRPL mainnet, while Opaque is on testnet');
});

test('an XRPL testnet app gets the account', () => {
  for (const p of [proposal(ns('xrpl:1', 'xrpl_signTransaction'), {}), proposal({}, ns('xrpl:1', 'xrpl_signTransaction'))]) {
    assert.deepEqual(fits(p)?.['xrpl']?.accounts, ['xrpl:1:rrrrrrrrrrrrrrrrrrrrrhoLvTp']);
  }
});
