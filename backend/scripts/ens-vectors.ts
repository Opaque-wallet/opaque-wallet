// Signatures for contracts/test/PQNameController.t.sol, made by packages/pq-wallet
// as a wallet makes them, never by Solidity: the test then exercises the real
// cross-language path.
//
//   node scripts/ens-vectors.ts      writes contracts/test/fixtures/ens-controller-vectors.json

import { writeFileSync } from 'node:fs';

import { keyGen, pkCommitment } from '@opaque/pq-wallet';
import { encodeFunctionData, keccak256, parseAbi, stringToBytes, type Address } from 'viem';

import { signExecute } from '../ethereum/ens.ts';

const CHAIN = 31337n;
// Where the test places the controller and the record keeper (forge-std deployCodeTo).
const CONTROLLER: Address = '0x000000000000000000000000000000000000e5e0';
const TARGET: Address = '0x0000000000000000000000000000000000007a46';
const DEADLINE = 2_000_000_000n;
const seed = (s: string) => keccak256(stringToBytes(s), 'bytes');
const [a, b, wrong] = [keyGen(seed('ens-controller-test/a')), keyGen(seed('ens-controller-test/b')), keyGen(seed('ens-controller-test/wrong'))];
const SET_TEXT = parseAbi(['function setText(bytes32 node, string key, string value)']);
const node = keccak256(stringToBytes('opaquepq.eth'));
const call0 = encodeFunctionData({ abi: SET_TEXT, functionName: 'setText', args: [node, 'pq-key', pkCommitment(a.publicKey) as string] });
const call1 = encodeFunctionData({ abi: SET_TEXT, functionName: 'setText', args: [node, 'url', 'https://opaque.credit'] });

writeFileSync(new URL('../../contracts/test/fixtures/ens-controller-vectors.json', import.meta.url), `${JSON.stringify({
  controller: CONTROLLER, target: TARGET, deadline: Number(DEADLINE),
  pkA: pkCommitment(a.publicKey), pkB: pkCommitment(b.publicKey),
  call0, call1,
  sig0: signExecute(a, CHAIN, CONTROLLER, 0n, TARGET, call0, DEADLINE),
  sig1: signExecute(a, CHAIN, CONTROLLER, 1n, TARGET, call1, DEADLINE),
  sigWrongKey: signExecute(wrong, CHAIN, CONTROLLER, 0n, TARGET, call0, DEADLINE),
}, null, 2)}\n`);
console.log('wrote contracts/test/fixtures/ens-controller-vectors.json');
