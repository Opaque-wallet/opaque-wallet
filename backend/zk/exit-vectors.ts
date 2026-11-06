// Generates contracts/test/fixtures/exit-vectors.json: AES-128 and a pool's note
// derivations, from the same code the wallet and the ring circuit use, so
// ExitableRingVerifier's on-chain AES is checked against them byte for byte.
//
//   cd backend && node zk/exit-vectors.ts

import { writeFileSync } from 'node:fs';

import type { PoolScope } from '@opaque/protocol-types';
import { asAddress, asChainId, poolId, toHex } from '@opaque/protocol-types/codecs.js';

import { aes128Encrypt } from './aes.ts';
import { deriveCommitment, deriveNullifier, noteBlock, nullifierBlock } from './statement.ts';

const hex = (b: Uint8Array) => toHex(b);
const bytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

// FIPS-197 Appendix C.1, and three more pairs from the wallet's own AES.
const fips = { key: '000102030405060708090a0b0c0d0e0f', block: '00112233445566778899aabbccddeeff', out: '69c4e0d86a7b0430d8cdb78070b4c55a' };
if (hex(aes128Encrypt(bytes(fips.key), bytes(fips.block))).slice(2) !== fips.out) throw new Error('aes128Encrypt disagrees with FIPS-197');
const pairs = [
  ['2b7e151628aed2a6abf7158809cf4f3c', '6bc1bee22e409f96e93d7e117393172a'],
  ['ffffffffffffffffffffffffffffffff', '00000000000000000000000000000000'],
  ['0f1e2d3c4b5a69788796a5b4c3d2e1f0', 'deadbeefcafef00d0123456789abcdef'],
].map(([key, block]) => ({ key: `0x${key}`, block: `0x${block}`, out: hex(aes128Encrypt(bytes(key!), bytes(block!))) }));

const scope = { chainId: asChainId(11155111n), pool: asAddress('0x6cfd137c68f2eab5bdb7209f77efbf5876f126ea'), denomination: 5_000_000 } as unknown as PoolScope;
const secrets = ['00112233445566778899aabbccddeeff', 'a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5'];
const out = {
  fips: { key: `0x${fips.key}`, block: `0x${fips.block}`, out: `0x${fips.out}` },
  pairs,
  pool: {
    poolId: poolId(scope), denomination: scope.denomination,
    noteBlock: hex(noteBlock(scope)), nullifierBlock: hex(nullifierBlock(scope)),
    notes: secrets.map((s) => ({ secret: `0x${s}`, commitment: deriveCommitment(bytes(s), scope), nullifier: deriveNullifier(bytes(s), scope) })),
  },
};
writeFileSync(new URL('../../contracts/test/fixtures/exit-vectors.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log('contracts/test/fixtures/exit-vectors.json');
