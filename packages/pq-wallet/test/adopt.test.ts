import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adoptWallet, createPqWallet } from '../src/wallet.ts';
import { MockWalletChain, mockWalletOptions } from '../src/mock.ts';
import { MemorySignerStore } from '../src/signer-state.ts';
import { MemoryWalletStateStore } from '../src/wallet-state.ts';

// A wallet whose keys are drawn from a phrase, one seed per epoch, comes back
// on another device from the phrase and the chain alone: the key in force
// after rotations, and a signing log at least as long as the chain's count.
const seedFor = (phrase: number) => (epoch: bigint) => new Uint8Array(32).fill(phrase).map((b, i) => (i === 0 ? Number(epoch) : b));

function device(chain: MockWalletChain, phrase = 7) {
  const options = { ...mockWalletOptions(chain), params: { k: 8, a: 4 }, signerStore: new MemorySignerStore(),
    walletStore: new MemoryWalletStateStore(), seedFor: seedFor(phrase) };
  return { options, wallet: createPqWallet(options) };
}

test('a phrase wallet is adopted from the chain: same account, the key in force, a long enough log', async () => {
  const chain = new MockWalletChain();
  const first = device(chain);
  const made = await first.wallet.create();
  await first.wallet.register();
  for (const op of ['0x01', '0x02', '0x03']) await chain.acceptUserOperation(await first.wallet.signUserOperation(op));
  await first.wallet.rotate();
  await chain.acceptUserOperation(await first.wallet.signUserOperation('0x04'));
  const before = await first.wallet.getState();
  assert.equal(before.keyEpoch, 1n);

  const second = device(chain);
  assert.equal(await adoptWallet(second.options), true);
  const after = await second.wallet.getState();
  assert.equal(after.accountAddress, made.accountAddress, 'the phrase gives the same account');
  assert.equal(after.pkCommitment, before.pkCommitment, 'and finds the key in force after a rotation');
  assert.equal(after.chainUseCount, 1n);
  assert.ok(after.localSigningReservations >= 1n + 2n, 'counting what another device may have signed and not landed');
  assert.equal(after.active, true);

  // It signs and rotates on from there, to the key the first device would have made.
  await chain.acceptUserOperation(await second.wallet.signUserOperation('0x05'));
  await second.wallet.rotate();
  assert.equal((await second.wallet.getState()).keyEpoch, 2n);
  assert.equal(await adoptWallet(second.options), false, 'a store that holds the wallet is left alone');
});

test('an unregistered phrase wallet is not adopted: create() makes the same keys and address', async () => {
  const chain = new MockWalletChain();
  const first = device(chain);
  const made = await first.wallet.create();
  const second = device(chain);
  assert.equal(await adoptWallet(second.options), false);
  assert.equal((await second.wallet.create()).accountAddress, made.accountAddress);
  assert.notEqual((await device(chain, 8).wallet.create()).accountAddress, made.accountAddress, 'another phrase, another account');
});

test('random keys cannot be adopted', async () => {
  const { seedFor: _, ...random } = device(new MockWalletChain()).options;
  await assert.rejects(adoptWallet(random as never), { code: 'INVALID_INPUT' });
});
