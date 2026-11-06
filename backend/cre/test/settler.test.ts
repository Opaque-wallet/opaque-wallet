import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProtocolFailure,
  type ApprovedRelease,
  type CredentialHandle,
  type IdempotencyKey,
  type IntentId,
  type NoteId,
  type PoolScope,
  type PrivacyScore,
  type PrivateSpend,
  type TxHash,
  type UnixSeconds,
} from '@opaque/protocol-types';
import { asAddress, asChainId, spendHash } from '@opaque/protocol-types/codecs.js';
import { utf8 } from '@opaque/pq-wallet';

import { assertSpendable, setRereadMs } from '../../chain/pool.ts';

setRereadMs(0);
import type { AttesterIdentity } from '../attest.ts';
import { attesterCommitment, createAttesterKeys } from '../attester-keys.ts';
import { issueCredential } from '../credential.ts';
import { createExecutor, type OpaqueExecutor } from '../executor.ts';
import { issueRelease } from '../release.ts';
import { createIntentSealer, generateIntentKeypair } from '../seal-client.ts';
import { openEnvelope, releaseTag } from '../sealed-intent.ts';
import { createSettler, type SettlerOptions } from '../settler.ts';
import { buildRingSpend, deriveCommitment } from '../../zk/spend.ts';

// The settler between a CRE decision and the chain, where the attester's
// few-time key is spent (F-45) and where a payment that cannot land must end
// (F-56). The chain is the only thing stood in for; the decisions are sealed
// and tagged exactly as CRE makes them.

const NOW = 1_800_000_000n as UnixSeconds;
const scope: PoolScope = { chainId: asChainId(5042002n), pool: asAddress('0x8b54cc1b008eafa270740d847e45954f10dbf150'), denomination: 1_000_000 };
const identity: AttesterIdentity = {
  chainId: 5042002n,
  registry: asAddress('0x7fc11e0f5d224439b2d710bb1c141913f454ef17'),
  attester: asAddress('0x8d47981ac51628fa19bf8b32afdda09f2d72d257'),
  pool: scope.pool,
  denomination: scope.denomination,
};
const RECIPIENT = asAddress('0x000000000000000000000000000000000000b0b0');
const FORS_SEED = new Uint8Array(32).fill(7);
const MASTER = new Uint8Array(32).fill(0x24);
const credentialMac = utf8('test-credential-and-release-mac');
const intentKeys = generateIntentKeypair(new Uint8Array(64).fill(9));
const KEY_ID = 'opaque-intent-key-v1';
const POLICY = 'opaque-policy-v1';

const secrets = Array.from({ length: 8 }, (_, i) => new Uint8Array(16).fill(i + 41));
const commitments = secrets.map((s) => deriveCommitment(s, scope));
const spendOf = (mine: number, reps?: number): PrivateSpend => buildRingSpend({
  scope, recipient: RECIPIENT, noteSecret: secrets[mine]!, decoys: commitments.filter((_, i) => i !== mine), ...(reps === undefined ? {} : { reps }),
});
// Full strength, built once: the attester verifies them before it signs.
const NOTE_A = spendOf(1);
const NOTE_B = spendOf(2);
// Two repetitions: with no attester the settler only carries the proof.
const cheap = (mine: number) => spendOf(mine, 2);

const credential = issueCredential({ recipient: RECIPIENT, policyVersion: POLICY, expiresAt: (NOW + 86_400n) as UnixSeconds }, credentialMac);
const seal = createIntentSealer({
  crePublicKey: intentKeys.publicKey, encryptionKeyId: KEY_ID,
  resolveCredential: async () => JSON.stringify(credential, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)),
});

async function submit(executor: OpaqueExecutor, spend: PrivateSpend, key: string): Promise<IntentId> {
  const intent = await seal({
    scope, spendHash: spendHash(spend), spend,
    request: {
      noteId: key as NoteId, recipient: RECIPIENT, minPrivacyScore: 0 as PrivacyScore, deadline: (NOW + 60n) as UnixSeconds,
      credentialHandle: 'c' as CredentialHandle, idempotencyKey: key as IdempotencyKey,
    },
  });
  return (await executor.submit(intent)).intentId;
}

/** CRE's RELEASE for an intent, tagged as CRE tags it. */
function released(executor: OpaqueExecutor, intentId: IntentId) {
  const record = executor.store.get(intentId)!;
  const k = openEnvelope(intentKeys.secretKey, KEY_ID, record.intent.creEnvelope!).k;
  const recipient = RECIPIENT.toLowerCase();
  return { intentId, verdict: 'RELEASE' as const, recipient, k, tag: releaseTag(credentialMac, { intentId, spendHash: record.intent.spendHash, verdict: 'RELEASE', recipient, k }) };
}

const options = (executor: OpaqueExecutor, over: Partial<SettlerOptions>): SettlerOptions => ({
  executor, credentialMac, policyVersion: POLICY, releaseTtlSeconds: 900n, now: () => NOW,
  sleep: async () => undefined,
  deliver: async () => `0x${'aa'.repeat(32)}` as TxHash,
  evidence: async (txHash, release) => ({ txHash, spendHash: spendHash(release.spend), succeeded: true }),
  nullifierSpent: async () => false,
  ...over,
});

/** The pool's two reads, as chain/pool.ts assertSpendable makes them. */
const pool = (spent: boolean, unknownMember?: string) => ({
  readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) =>
    functionName === 'isNullifierSpent' ? spent : String(args[0]).toLowerCase() !== unknownMember?.toLowerCase(),
});

/** `n` turns of the event loop: long enough for anything not waiting on something else. */
const turns = (n: number) => new Promise<void>((resolve) => {
  const step = (left: number): void => { if (left === 0) resolve(); else setImmediate(() => step(left - 1)); };
  step(n);
});

// ── F-45: the attester's key ──────────────────────────────────────────────

test('a_deposit_a_lagging_node_has_not_seen_yet_is_asked_again_not_refused', async () => {
  // Sepolia's public RPC is load-balanced: the payer's own note, deposited a
  // block ago, reads unknown on a node behind it, then known.
  let asked = 0;
  const lagging = { readContract: async ({ functionName }: { functionName: string }) => functionName === 'isNullifierSpent' ? false : ++asked > 2 };
  const spend = { scope: { pool: '0x00000000000000000000000000000000000000aa' }, nullifier: `0x${'11'.repeat(32)}`, recipient: `0x${'22'.repeat(20)}`, ring: commitments, proof: '0x' };
  await assertSpendable(lagging as never, spend as never);
  assert.ok(asked > 2, 'the unknown member was read again');
});

test('F45_a_spend_the_pool_would_revert_is_refused_before_anything_is_signed', async () => {
  // The PoC: intents for an already-spent note, or a ring of commitments never
  // deposited, each got a FORS signature at the registry's index. The pool
  // refused each, the index never moved, and the next signed it again.
  for (const [chain, code] of [[pool(true), 'NULLIFIER_SPENT'], [pool(false, commitments[4]), 'PROOF_REJECTED']] as const) {
    const executor = createExecutor({ now: () => NOW });
    const ids = [await submit(executor, NOTE_A, `${code}-1`), await submit(executor, NOTE_A, `${code}-2`)];
    const signed: ApprovedRelease[] = [];
    const settler = createSettler(options(executor, {
      attester: { identity, current: async () => ({ forsSeed: FORS_SEED, useCount: 0n, generation: 0 }) },
      spendable: (spend) => assertSpendable(chain as never, spend),
      deliver: async (release) => { signed.push(release); throw new ProtocolFailure('SETTLEMENT_REVERTED', 'the pool refuses this transaction', false); },
    }));
    for (const id of ids) await settler.settle(released(executor, id));
    assert.equal(signed.length, 0, `${code}: no attestation was signed`);
    for (const id of ids) assert.equal(executor.store.get(id)?.error?.code, code);
  }
});

test('F45_a_note_is_attested_once_while_its_attestation_is_in_flight', async () => {
  // Two intents for one note, back to back: the first's transaction has not
  // landed, so the chain still says unspent, and the second was signed too.
  const executor = createExecutor({ now: () => NOW });
  const first = await submit(executor, NOTE_A, 'b1');
  const second = await submit(executor, NOTE_A, 'b2');
  const signed: ApprovedRelease[] = [];
  const settler = createSettler(options(executor, {
    attester: { identity, current: async () => ({ forsSeed: FORS_SEED, useCount: 0n, generation: 0 }), observe: async () => ({ useCount: 0n, generation: 0 }) },
    spendable: (spend) => assertSpendable(pool(false) as never, spend),
    deliver: async (release) => { signed.push(release); return `0x${'ab'.repeat(32)}` as TxHash; },
    evidence: async () => { throw new Error('no receipt yet'); },
  }));
  await settler.settle(released(executor, first));
  await settler.settle(released(executor, second));
  assert.equal(signed.length, 1, 'one attestation for one note');
  assert.equal(executor.store.get(second)?.error?.code, 'NOTE_RESERVED');
  assert.notEqual(executor.store.get(first)?.state, 'FAILED', 'the first may yet land');
});

test('F45_a_delivery_that_failed_after_broadcast_holds_the_turn_until_its_index_is_consumed', async () => {
  // The PoC: the egress broadcast note A at index 0, then gave up waiting for
  // its receipt. The turn was released with A in flight, and note B, decided
  // in the same tick, was signed at index 0 too.
  const executor = createExecutor({ now: () => NOW });
  const a = await submit(executor, NOTE_A, 'c1');
  const b = await submit(executor, NOTE_B, 'c2');
  const chain = { index: 0n, inFlight: false };
  const signedAt: bigint[] = [];
  let waited = 0;
  const settler = createSettler(options(executor, {
    attester: {
      identity,
      current: async () => { signedAt.push(chain.index); return { forsSeed: FORS_SEED, useCount: chain.index, generation: 0 }; },
      observe: async () => ({ useCount: chain.index, generation: 0 }),
    },
    // A lands three seconds after the egress gave up on it.
    sleep: async () => { if (chain.inFlight && ++waited === 3) [chain.index, chain.inFlight] = [chain.index + 1n, false]; },
    deliver: async (release) => {
      if (release.intentId === a) {
        chain.inFlight = true;
        throw new Error('egress: broadcast, then the receipt wait timed out');
      }
      return `0x${'bb'.repeat(32)}` as TxHash;
    },
    evidence: async (txHash, release) => { chain.index++; return { txHash, spendHash: spendHash(release.spend), succeeded: true }; },
  }));
  await Promise.all([settler.settle(released(executor, a)), settler.settle(released(executor, b))]);
  assert.deepEqual(signedAt, [0n, 1n], 'B was signed only once A\'s index was consumed');
});

test('F45_a_resent_attestation_that_lands_holds_the_turn_until_a_fresh_read_shows_it', async () => {
  // The PoC: retry() re-sent A's stored attestation for index 0. It landed,
  // and the turn passed straight to B, whose read came from a node a block
  // behind that still said 0.
  const executor = createExecutor({ now: () => NOW });
  const a = await submit(executor, NOTE_A, 'd1');
  const b = await submit(executor, NOTE_B, 'd2');
  const node = { landed: 0n, behind: 0 };
  const read = (): bigint => (node.behind > 0 ? (node.behind--, node.landed - 1n) : node.landed);
  const signedAt: bigint[] = [];
  let egressUp = false;
  const settler = createSettler(options(executor, {
    attester: {
      identity,
      current: async () => { const index = read(); signedAt.push(index); return { forsSeed: FORS_SEED, useCount: index, generation: 0 }; },
      observe: async () => ({ useCount: read(), generation: 0 }),
    },
    // Refused before anything was sent, the first time: the egress was restarting.
    deliver: async () => {
      if (!egressUp) throw new ProtocolFailure('MESH_UNAVAILABLE', 'the egress is restarting', true);
      return `0x${'cc'.repeat(32)}` as TxHash;
    },
    evidence: async (txHash, release) => { [node.landed, node.behind] = [node.landed + 1n, 2]; return { txHash, spendHash: spendHash(release.spend), succeeded: true }; },
  }));
  await settler.settle(released(executor, a));
  assert.equal(executor.store.get(a)?.state, 'READY_TO_RELEASE');
  egressUp = true;
  const resent = settler.retry();
  await turns(1);
  await Promise.all([resent, settler.settle(released(executor, b))]);
  assert.deepEqual(signedAt, [0n, 1n], 'B read the index after A\'s landing showed');
});

test('F45_waiting_for_an_index_never_rotates_on_a_stale_read', async () => {
  // Counted as they are made, the key's signatures run ahead of the registry's
  // count. Asked through current(), a node a block behind put the key in its
  // rotation band, and the rotation was signed at the index the attestation
  // had just used: two messages at one index.
  const executor = createExecutor({ now: () => NOW });
  const a = await submit(executor, NOTE_A, 'e1');
  const registry = { useCount: 1n, behind: 0 };
  const rotations: bigint[] = [];
  let lastRead = 0n;
  const keys = createAttesterKeys({
    master: MASTER, attester: identity.attester, chainId: identity.chainId, maxUses: 3n, rotateWhenLeft: 1n, now: () => NOW,
    readState: async () => {
      lastRead = registry.behind > 0 ? (registry.behind--, registry.useCount - 1n) : registry.useCount;
      return { pkCommitment: attesterCommitment(MASTER, 0), useCount: lastRead, maxUses: 3n };
    },
    rotate: async () => { rotations.push(lastRead); throw new Error('rotation sent'); },
    takeover: async () => assert.fail('nothing here is exhausted'),
  });
  const settler = createSettler(options(executor, {
    attester: { identity, ...keys },
    evidence: async (txHash, release) => { [registry.useCount, registry.behind] = [registry.useCount + 1n, 2]; return { txHash, spendHash: spendHash(release.spend), succeeded: true }; },
  }));
  await settler.settle(released(executor, a));
  assert.equal(executor.store.get(a)?.state, 'SETTLED');
  assert.deepEqual(rotations, [], 'nothing signed while waiting for the index');
  // The next turn rotates, at the index the registry is really at.
  await assert.rejects(keys.current(), /rotation sent/);
  assert.deepEqual(rotations, [2n]);
});

// ── F-56: a payment that cannot land ends ─────────────────────────────────

test('F56_a_release_that_expired_unsent_ends_instead_of_retrying_forever', async () => {
  let at = NOW;
  const executor = createExecutor({ now: () => at });
  const id = await submit(executor, cheap(3), 'f1');
  const settler = createSettler(options(executor, {
    now: () => at,
    deliver: async () => {
      throw at >= NOW + 900n
        ? new ProtocolFailure('EXPIRED', 'release delivery window has closed', false)
        : new ProtocolFailure('MESH_UNAVAILABLE', 'the egress is restarting', true);
    },
  }));
  await settler.settle(released(executor, id));
  for (const after of [600n, 1_200n, 1_800n]) {
    at = (NOW + after) as UnixSeconds;
    await settler.retry();
  }
  assert.equal(executor.store.get(id)?.state, 'FAILED');
  assert.equal(executor.store.get(id)?.error?.code, 'EXPIRED');
});

test('F56_a_settlement_mined_and_reverted_ends_and_frees_the_note', async () => {
  // The egress answers a release it already sent with that same hash, so a
  // reverted settlement was looked at, and "re-sent", for ever.
  let at = NOW;
  const executor = createExecutor({ now: () => at });
  const id = await submit(executor, cheap(4), 'g1');
  const settler = createSettler(options(executor, {
    now: () => at, receiptEvidence: true,
    deliver: async () => `0x${'dd'.repeat(32)}` as TxHash,
    evidence: async (txHash, release) => ({ txHash, spendHash: spendHash(release.spend), succeeded: false }),
  }));
  await settler.settle(released(executor, id));
  for (const after of [60n, 600n, 6_000n]) {
    at = (NOW + after) as UnixSeconds;
    await settler.retry();
  }
  assert.equal(executor.store.get(id)?.state, 'FAILED');
  assert.equal(executor.store.get(id)?.error?.code, 'SETTLEMENT_REVERTED');
});

test('F56_a_broadcast_that_never_lands_does_not_hold_up_the_next_payment', async () => {
  // The PoC: retry() looked for a dropped transaction's receipt inside the
  // attester's turn, and every settlement behind it waited out the wait.
  let at = NOW;
  const executor = createExecutor({ now: () => at });
  const a = await submit(executor, cheap(5), 'h1');
  const b = await submit(executor, cheap(6), 'h2');
  const DROPPED = `0x${'a1'.repeat(32)}` as TxHash;
  let looked = false;
  const settler = createSettler(options(executor, {
    now: () => at, receiptEvidence: true,
    deliver: async (release) => (release.intentId === a ? DROPPED : `0x${'b2'.repeat(32)}` as TxHash),
    // A's receipt never comes: the first look gives up, every later one waits on.
    evidence: (txHash, release) => (txHash !== DROPPED
      ? Promise.resolve({ txHash, spendHash: spendHash(release.spend), succeeded: true })
      : looked ? new Promise(() => undefined) : ((looked = true), Promise.reject(new Error('no receipt yet')))),
  }));
  await settler.settle(released(executor, a));
  assert.equal(executor.store.get(a)?.state, 'SETTLEMENT_PENDING');
  at = (NOW + 60n) as UnixSeconds;
  void settler.retry();
  await turns(5);
  const settled = settler.settle(released(executor, b)).then(() => 'settled');
  assert.equal(await Promise.race([settled, turns(50).then(() => 'held up')]), 'settled');
  assert.equal(executor.store.get(b)?.state, 'SETTLED');
});

test('F56_a_broadcast_dropped_for_good_ends_once_its_index_has_gone_to_another', async () => {
  let at = NOW;
  const executor = createExecutor({ now: () => at });
  const spend = cheap(7);
  const id = await submit(executor, spend, 'i1');
  // Where the PoC left it: attested at index 0, broadcast, never mined, and
  // index 0 since consumed by another attestation.
  const release = issueRelease({ intentId: id, spend, policyVersion: POLICY, issuedAt: NOW, ttlSeconds: 900n, secret: credentialMac });
  executor.store.authorize({ intentId: id, release, now: NOW, attestation: { useCount: 0n, generation: 0 } });
  executor.store.recordBroadcast(id, `0x${'e1'.repeat(32)}` as TxHash, NOW);
  const settler = createSettler(options(executor, {
    now: () => at, receiptEvidence: true,
    attester: { identity, current: async () => assert.fail('nothing is signed here'), observe: async () => ({ useCount: 1n, generation: 0 }) },
    evidence: async () => { throw new Error('no receipt'); },
  }));
  at = (NOW + 60n) as UnixSeconds;
  await settler.retry();
  assert.notEqual(executor.store.get(id)?.state, 'FAILED', 'one look is not enough: a node may be behind');
  for (const after of [200n, 400n]) {
    at = (NOW + after) as UnixSeconds;
    await settler.retry();
  }
  assert.equal(executor.store.get(id)?.state, 'FAILED');
  assert.equal(executor.store.get(id)?.error?.code, 'SETTLEMENT_REVERTED');
});

// ── F-68: signatures an anonymous payer could burn ────────────────────────

test('F68_a_spend_to_the_zero_address_is_refused_before_anything_is_signed', async () => {
  // The PoC: a credential for 0x0 is free, the proof verifies, the attester
  // signs, and the pool reverts ZeroRecipient, with the note still unspent.
  const zero = buildRingSpend({ scope, recipient: asAddress(`0x${'00'.repeat(20)}`), noteSecret: secrets[1]!, decoys: commitments.filter((_, i) => i !== 1), reps: 2 });
  await assert.rejects(assertSpendable(pool(false) as never, zero), (e: unknown) => e instanceof ProtocolFailure && !e.retryable && /recipient/.test(e.message));
});

test('F68_one_note_is_attested_at_most_twice_a_day_whatever_becomes_of_it', async () => {
  // Any revert the pool makes after the signature check (a recipient the token
  // refuses, say) ends the intent with the note unspent, and the next intent
  // for it was signed again: one deposit, unlimited signatures.
  const executor = createExecutor({ now: () => NOW });
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await submit(executor, NOTE_A, `burn-${i}`));
  const signed: ApprovedRelease[] = [];
  const settler = createSettler(options(executor, {
    attester: { identity, current: async () => ({ forsSeed: FORS_SEED, useCount: 0n, generation: 0, reserve: () => undefined }) },
    spendable: (spend) => assertSpendable(pool(false) as never, spend),
    deliver: async (release) => { signed.push(release); throw new ProtocolFailure('SETTLEMENT_REVERTED', 'TransferFailed', false); },
  }));
  for (const id of ids) await settler.settle(released(executor, id));
  assert.equal(signed.length, 2, 'two attestations for the note, then refusals');
  assert.equal(executor.store.get(ids[3]!)?.error?.code, 'NOTE_RESERVED');
});
