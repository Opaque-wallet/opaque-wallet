import assert from 'node:assert/strict';
import { test } from 'node:test';

import { asHexBytes, CREATE2_FACTORY, create2Address, deployment } from './contracts.ts';

const zero32 = `0x${'00'.repeat(32)}` as const;

test('CREATE2 addresses match EIP-1014\'s examples', () => {
  assert.equal(create2Address(`0x${'00'.repeat(20)}`, zero32, '0x00'), '0x4D1A2e2bB4F88F0250f26Ffff098B0b30B26BF38');
  assert.equal(create2Address('0xdeadbeef00000000000000000000000000000000', zero32, '0x00'), '0xB928f69Bb1D91Cd65274e3c79d8986362984fDA3');
  assert.equal(create2Address('0x00000000000000000000000000000000deadbeef', '0x00000000000000000000000000000000000000000000000000000000cafebabe', '0xdeadbeef'), '0x60f3f640a8508fC6a86d45DF051962668E1e8AC7');
});

test('a deploy is one call to the factory: salt, then initcode', () => {
  const d = deployment(zero32, '0x6000');
  assert.equal(d.call.to, CREATE2_FACTORY);
  assert.equal(d.call.data, `0x${'00'.repeat(32)}6000`);
  assert.equal(d.address, create2Address(CREATE2_FACTORY, zero32, '0x6000'));
});

test('pasted bytecode is checked before anything is signed', () => {
  assert.equal(asHexBytes(' 0x60 80\n6040 ', 'bytecode', 10), '0x60806040');
  assert.equal(asHexBytes('6080', 'bytecode', 10), '0x6080');
  assert.throws(() => asHexBytes('', 'bytecode', 10), /paste the bytecode/);
  assert.throws(() => asHexBytes('0x608', 'bytecode', 10), /two digits per byte/);
  assert.throws(() => asHexBytes('0xzz', 'bytecode', 10), /hex/);
  assert.throws(() => asHexBytes(`0x${'00'.repeat(11)}`, 'bytecode', 10), /at most 10/);
});
