import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProtocolFailure,
  type ApprovedRelease,
  type CredentialHandle,
  type IdempotencyKey,
  type NoteId,
  type PoolScope,
  type PrivacyScore,
  type TxHash,
  type UnixSeconds,
} from '@opaque/protocol-types';
import { asAddress, asChainId, spendHash } from '@opaque/protocol-types/codecs.js';

import { issueCredential } from '../credential.ts';
import { createExecutor } from '../executor.ts';
import { createIntentSealer, generateIntentKeypair } from '../seal-client.ts';
import { createCreSimulator } from '../simulator.ts';
import { buildRingSpend, deriveCommitment } from '../../zk/spend.ts';

// The settler on XRPL: no FORS attester (the chain's own attester quorum
// verifies the proof), the destination sealed beside the spend, and the
// refusals that must end an intent rather than retry it forever.

const NOW = 1_800_000_000n as UnixSeconds;
const scope: PoolScope = { chainId: asChainId((1n << 64n) + 1n), pool: asAddress(`0x${'11'.repeat(20)}`), denomination: 1_000_000 };
const RECIPIENT = asAddress(`0x${'22'.repeat(20)}`);
const DESTINATION = { account: 'rw5r7pX37iAtLEh1VZdciHaFpduftUtjYe', tag: 7 };
const credentialMac = new TextEncoder().encode('test-credential-and-release-mac');
const intentKeys = generateIntentKeypair(new Uint8Array(64).fill(5));
const secrets = Array.from({ length: 8 }, (_, i) => new Uint8Array(16).fill(i + 31));
const commitments = secrets.map((s) => deriveCommitment(s, scope));

async function run(deliver: (release: ApprovedRelease) => Promise<TxHash>) {
  const executor = createExecutor({ now: () => NOW });
  const credential = issueCredential({ recipient: RECIPIENT, policyVersion: 'p', expiresAt: (NOW + 3600n) as UnixSeconds }, credentialMac);
  const seal = createIntentSealer({
    crePublicKey: intentKeys.publicKey, encryptionKeyId: 'k',
    resolveCredential: async () => JSON.stringify(credential, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)),
  });
  // Two repetitions: nothing on this path verifies the proof, it only carries it.
  const spend = buildRingSpend({ scope, recipient: RECIPIENT, noteSecret: secrets[0]!, decoys: commitments.slice(1), reps: 2 });
  const ref = await executor.submit(await seal({
    scope, spendHash: spendHash(spend), spend: { ...spend, destination: DESTINATION },
    request: {
      noteId: 'n' as NoteId, recipient: RECIPIENT, minPrivacyScore: 0 as PrivacyScore, deadline: (NOW + 60n) as UnixSeconds,
      credentialHandle: 'c' as CredentialHandle, idempotencyKey: 'i' as IdempotencyKey,
    },
  }));
  const simulator = createCreSimulator({
    executor, credentialMac, policyVersion: 'p', releaseTtlSeconds: 900n, now: () => NOW,
    intentSecretKey: intentKeys.secretKey, encryptionKeyId: 'k',
    deliver,
    evidence: async (txHash, release) => ({ txHash, spendHash: spendHash(release.spend), succeeded: true }),
    nullifierSpent: async () => true,
  });
  await simulator.tick();
  return { status: await executor.getStatus(ref.statusHandle), spend };
}

test('with no attester, the release carries the proven spend and the destination sealed beside it', async () => {
  let delivered: ApprovedRelease | undefined;
  const { status, spend } = await run(async (release) => { delivered = release; return `0x${'ab'.repeat(32)}` as TxHash; });
  assert.equal(status.state, 'SETTLED');
  assert.equal(delivered!.spend.proof, spend.proof, 'the proof itself, not a signature in its place');
  assert.deepEqual((delivered!.spend as unknown as { destination: unknown }).destination, DESTINATION);
  assert.equal(delivered!.spendHash, spendHash(spend), 'the destination is not part of the spend hash');
});

test('a note already spent, refused before any broadcast, fails the intent instead of retrying it', async () => {
  const { status } = await run(async () => { throw new ProtocolFailure('NULLIFIER_SPENT', 'attester A1: that note is already spent'); });
  assert.equal(status.state, 'FAILED');
  assert.equal(status.error?.code, 'NULLIFIER_SPENT');
});

test('a payment the chain says can never land fails; a passing refusal is retried', async () => {
  const never = await run(async () => { throw new ProtocolFailure('SETTLEMENT_REVERTED', 'the destination cannot take this payment (tecPATH_DRY)', false); });
  assert.equal(never.status.state, 'FAILED');
  assert.match(never.status.error?.publicMessage ?? '', /tecPATH_DRY/);
  const later = await run(async () => { throw new ProtocolFailure('SETTLEMENT_REVERTED', 'quorum not reached (1/2)', true); });
  assert.notEqual(later.status.state, 'FAILED', 'a quorum short of a signature is worth another try');
});
