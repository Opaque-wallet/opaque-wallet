import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProtocolFailure,
  type EncryptedIntent,
  type IdempotencyKey,
  type IntentId,
  type StatusHandle,
  type UnixSeconds,
} from '@opaque/protocol-types';

import { createExecutor } from '../executor.ts';
import { IntentStore } from '../intent-store.ts';

const NOW = 1_760_000_000n as UnixSeconds;
const failure = (code: string) => (error: unknown) =>
  error instanceof ProtocolFailure && error.code === code;

const intentFor = (key: string, deadlineOffset = 3600n): EncryptedIntent =>
  ({
    version: '1-review',
    scope: { chainId: 5042002n, pool: `0x${'11'.repeat(20)}`, denomination: 1_000_000 },
    encryptedPayload: `0x${'ab'.repeat(64)}`,
    encryptionKeyId: 'opaque-intent-key-v1',
    spendHash: `0x${key.padEnd(64, '0')}`,
    minPrivacyScore: 5_000,
    deadline: (NOW + deadlineOffset) as UnixSeconds,
    idempotencyKey: key as IdempotencyKey,
  }) as unknown as EncryptedIntent;

const executor = (seq = 0) => {
  let n = seq;
  return createExecutor({
    now: () => NOW,
    newIntentId: () => `intent-${++n}` as IntentId,
    newStatusHandle: () => `handle-${n}`.padEnd(64, 'x') as StatusHandle,
  });
};

// ── submission ────────────────────────────────────────────────────────────

test('a submitted intent gets an id and a handle, and starts waiting', async () => {
  const ex = executor();
  const ref = await ex.submit(intentFor('aa'));
  assert.equal(ref.intentId, 'intent-1');
  assert.equal((await ex.getStatus(ref.statusHandle)).state, 'WAITING_FOR_PRIVACY');
});

test('the handle is not the intent id, and is not derived from the payment', async () => {
  // If the handle were the id, anyone who read an id from a log or a queue
  // could watch that payment settle.
  const ref = await createExecutor({ now: () => NOW }).submit(intentFor('bb'));
  assert.notEqual(ref.statusHandle as string, ref.intentId as string);
  assert.equal((ref.statusHandle as string).length, 64, '32 bytes of hex');

  // The property is UNPREDICTABILITY GIVEN THE PAYMENT, so the test has to be
  // the same payment twice: byte-identical intents, two executors, and the
  // handles still differ. Any derivation from the payment — a hash, a prefix,
  // an encoding of it — makes these two equal.
  //
  // Searching the handle for a substring of the payload is what this used to
  // do, and it was a coin flip rather than a test: 64 hex characters contain a
  // given two-character pair about one run in five, so it failed at random and
  // would have passed a handle that WAS the payment hash.
  const twin = await createExecutor({ now: () => NOW }).submit(intentFor('bb'));
  assert.notEqual(ref.statusHandle, twin.statusHandle, 'the handle tracks the payment');
});

test('two submissions share no handle and no id', async () => {
  const ex = createExecutor({ now: () => NOW });
  const a = await ex.submit(intentFor('cc'));
  const b = await ex.submit(intentFor('dd'));
  assert.notEqual(a.statusHandle, b.statusHandle);
  assert.notEqual(a.intentId, b.intentId);
});

test('resubmitting one payment returns the SAME handle, not a second one', async () => {
  // Two live capabilities for one intent is two things that can leak.
  const ex = executor();
  const first = await ex.submit(intentFor('ee'));
  const again = await ex.submit(intentFor('ee'));
  assert.deepEqual(again, first);
});

test('an idempotency key reused with different content is refused', async () => {
  const ex = executor();
  await ex.submit(intentFor('ff'));
  const different = { ...intentFor('ff'), spendHash: `0x${'99'.repeat(32)}` } as EncryptedIntent;
  await assert.rejects(ex.submit(different), failure('INVALID_INPUT'));
});

test('an intent whose deadline has already passed is refused, not accepted', async () => {
  // Returning a handle would promise a payment that can never be made.
  const ex = executor();
  await assert.rejects(ex.submit(intentFor('gg', 0n)), failure('EXPIRED'));
  await assert.rejects(ex.submit(intentFor('hh', -60n)), failure('EXPIRED'));
});

// ── the handle is a capability ────────────────────────────────────────────

test('an unknown handle is refused exactly like a wrong one', async () => {
  const ex = executor();
  await ex.submit(intentFor('ii'));
  const unknown = ex.getStatus('z'.repeat(64) as StatusHandle);
  const malformed = ex.getStatus('nope' as StatusHandle);
  await assert.rejects(unknown, failure('INVALID_INPUT'));
  await assert.rejects(malformed, failure('INVALID_INPUT'));
  // Same message: distinguishing them is an oracle for which handles exist.
  const [a, b] = await Promise.all([
    unknown.catch((e: ProtocolFailure) => e.publicMessage),
    malformed.catch((e: ProtocolFailure) => e.publicMessage),
  ]);
  assert.equal(a, b);
});

test('one payment’s handle does not read another payment’s status', async () => {
  const ex = executor();
  const a = await ex.submit(intentFor('jj'));
  const b = await ex.submit(intentFor('kk'));
  ex.store.transition({
    intentId: b.intentId,
    from: ['WAITING_FOR_PRIVACY'],
    to: 'POLICY_CHECKING',
    now: NOW,
  });
  assert.equal((await ex.getStatus(a.statusHandle)).state, 'WAITING_FOR_PRIVACY');
  assert.equal((await ex.getStatus(b.statusHandle)).state, 'POLICY_CHECKING');
});

test('status is the safe projection: no payload, no outbox, no broadcast id', async () => {
  const ex = executor();
  const ref = await ex.submit(intentFor('ll'));
  const status = await ex.getStatus(ref.statusHandle);
  for (const leaked of ['encryptedPayload', 'outbox', 'broadcast', 'intent', 'idempotencyKey']) {
    assert.equal(leaked in status, false, `status exposes ${leaked}`);
  }
});

// ── the queue the workflow reads ──────────────────────────────────────────

test('pending lists intents in submission order and holds ciphertext only', async () => {
  const ex = executor();
  await ex.submit(intentFor('m1'));
  await ex.submit(intentFor('m2'));
  const pending = ex.pending(NOW);
  assert.deepEqual(pending.map((r) => r.intent.idempotencyKey), ['m1', 'm2']);
  // Insertion order, so two workflow nodes see the same list and can agree.
  assert.match(pending[0]!.intent.encryptedPayload, /^0x(ab)+$/);
});

test('a settled intent leaves the queue; a past-deadline one does NOT', async () => {
  const ex = executor();
  const a = await ex.submit(intentFor('n1'));
  await ex.submit(intentFor('n2'));

  ex.store.fail(a.intentId, { code: 'POLICY_DENIED', retryable: false, publicMessage: 'no' }, NOW);
  assert.deepEqual(ex.pending(NOW).map((r) => r.intent.idempotencyKey), ['n2']);

  // Past its deadline and still pending: the deadline branch is what fires it,
  // so dropping it here would strand exactly the payments that most need to go.
  const late = (NOW + 7200n) as UnixSeconds;
  assert.equal(ex.pending(late).length, 1);
});

// ── F-51: bounded, because anyone can submit ─────────────────────────────

const bounded = (limits: ConstructorParameters<typeof IntentStore>[0], now: () => UnixSeconds = () => NOW) => {
  let n = 0;
  return createExecutor({
    store: new IntentStore(limits), now,
    newIntentId: () => `intent-${++n}` as IntentId,
    newStatusHandle: () => `handle-${n}`.padEnd(64, 'x') as StatusHandle,
  });
};

test('F51_undecided_intents_are_capped_and_the_next_is_refused_retryably', async () => {
  // The PoC: /v1/mesh/payment is public, and every intent posted there was held
  // for good, ciphertext and all, until the process ran out of memory and lost
  // every payment in flight with it.
  const ex = bounded({ maxUndecided: 2 });
  const first = await ex.submit(intentFor('cap-1'));
  await ex.submit(intentFor('cap-2'));
  await assert.rejects(ex.submit(intentFor('cap-3')), (e: unknown) => e instanceof ProtocolFailure && e.code === 'MESH_UNAVAILABLE' && e.retryable);
  // Asking again for one it holds is still answered.
  assert.deepEqual(await ex.submit(intentFor('cap-1')), first);
  // And a decided one makes room.
  ex.store.fail(first.intentId, { code: 'POLICY_DENIED', retryable: false, publicMessage: 'no' }, NOW);
  await ex.submit(intentFor('cap-3'));
});

test('F51_an_ended_intent_lets_go_of_its_ciphertext_at_once', async () => {
  const ex = executor();
  const ref = await ex.submit({ ...intentFor('drop-1'), creEnvelope: `0x${'ee'.repeat(2_000)}` } as EncryptedIntent);
  ex.store.fail(ref.intentId, { code: 'POLICY_DENIED', retryable: false, publicMessage: 'no' }, NOW);
  const held = ex.store.get(ref.intentId)!;
  assert.equal(held.intent.encryptedPayload, '0x', 'the ciphertext is gone');
  assert.equal(held.intent.creEnvelope, undefined, 'and so is the envelope');
  assert.equal((await ex.getStatus(ref.statusHandle)).state, 'FAILED', 'the status is still there to read');
});

test('F51_an_ended_intent_is_forgotten_after_its_retention_and_its_handle_with_it', async () => {
  let at = NOW;
  const ex = bounded({ retainSeconds: 3_600n }, () => at);
  const old = await ex.submit(intentFor('old-1'));
  ex.store.fail(old.intentId, { code: 'POLICY_DENIED', retryable: false, publicMessage: 'no' }, NOW);
  at = (NOW + 3_601n) as UnixSeconds;
  await ex.submit(intentFor('new-1', 7_200n));
  assert.equal(ex.store.get(old.intentId), undefined, 'forgotten');
  // Refused exactly like a handle that never existed: no oracle for what was.
  const [gone, never] = await Promise.all([
    ex.getStatus(old.statusHandle).catch((e: ProtocolFailure) => e.publicMessage),
    ex.getStatus('z'.repeat(64) as StatusHandle).catch((e: ProtocolFailure) => e.publicMessage),
  ]);
  assert.equal(gone, never);
});

test('F51_an_intent_no_decision_came_for_ends_a_day_past_its_deadline', async () => {
  const ex = executor();
  const ref = await ex.submit(intentFor('late-1'));
  const deadline = NOW + 3600n;
  assert.equal(ex.pending((deadline + 86_400n) as UnixSeconds).length, 1, 'a day past it, still waiting');
  assert.equal(ex.pending((deadline + 86_401n) as UnixSeconds).length, 0);
  const status = await ex.getStatus(ref.statusHandle);
  assert.equal(status.state, 'FAILED');
  assert.equal(status.error?.code, 'EXPIRED');
});

test('F51_an_intent_being_acted_on_is_never_expired_under_it', async () => {
  const ex = executor();
  const ref = await ex.submit(intentFor('held-1'));
  assert.ok(ex.store.claimAttempt(ref.intentId));
  assert.equal(ex.pending((NOW + 3600n + 86_401n) as UnixSeconds).length, 1);
});
