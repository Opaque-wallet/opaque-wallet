// T9 — durable intent state, idempotency and receipt reconciliation.
//
// The failures this file exists to prevent are all failures of *ambiguity*,
// not of cryptography:
//
//   * A lost acknowledgement is not a failure. Marking FAILED because a
//     response never came back can strand a payment that actually settled.
//   * A spent nullifier is not proof THIS intent settled. Someone else may
//     have spent that note directly — the pool is permissionless. SETTLED
//     requires a matching transaction, not a matching nullifier.
//   * Two workers must not mint two different releases for one intent. State
//     transitions are compare-and-set, and the outbox is created in the same
//     step as the transition that authorises it.
//
// And it is bounded (F-51), because anyone can submit: undecided intents are
// capped, by count and by ciphertext, and fail a day past a deadline no
// decision came for; an intent's ciphertext goes as soon as it is decided or
// ends; and an ended intent's status stays readable for a day, then goes.
// Nothing that may still settle is ever dropped.

import {
  ProtocolFailure,
  TERMINAL_INTENT_STATES,
  type ApprovedRelease,
  type EncryptedIntent,
  type IdempotencyKey,
  type IntentId,
  type IntentState,
  type IntentStatus,
  type ProtocolError,
  type TxHash,
  type UnixSeconds,
} from '@opaque/protocol-types';
import { spendHash } from '@opaque/protocol-types/codecs.js';

export interface IntentRecord {
  readonly intentId: IntentId;
  readonly intent: EncryptedIntent;
  readonly state: IntentState;
  readonly deadlineReached: boolean;
  readonly updatedAt: UnixSeconds;
  readonly attempts: number;
  /** Set once, when policy approves. Never replaced for the same intent. */
  readonly outbox?: ApprovedRelease;
  readonly broadcast?: TxHash;
  readonly txHash?: TxHash;
  readonly error?: ProtocolError;
  /** Where the outbox's attestation was signed: the registry index it is good for, and the key. */
  readonly attestation?: { readonly useCount: bigint; readonly generation?: number };
}

export interface IntentStoreOptions {
  /** Undecided intents held at once. More are refused, retryably, until some are decided. */
  readonly maxUndecided?: number;
  /** Their ciphertext held at once, in characters of hex. */
  readonly maxUndecidedBytes?: number;
  /** How long past its deadline an intent no decision came for is kept before it fails. */
  readonly undecidedGraceSeconds?: bigint;
  /** How long an ended intent's status stays readable. */
  readonly retainSeconds?: bigint;
  /** And how many ended intents at most: the oldest go first. */
  readonly maxRetained?: number;
}

const DAY = 86_400n;
const sizeOf = (intent: EncryptedIntent): number => intent.encryptedPayload.length + (intent.creEnvelope?.length ?? 0);
/** What is left of an intent once nothing will open it again: no ciphertext, nothing a caller added. */
const slim = (intent: EncryptedIntent): EncryptedIntent => ({
  version: intent.version, scope: intent.scope, encryptedPayload: '0x' as EncryptedIntent['encryptedPayload'],
  encryptionKeyId: intent.encryptionKeyId, spendHash: intent.spendHash, minPrivacyScore: intent.minPrivacyScore,
  deadline: intent.deadline, idempotencyKey: intent.idempotencyKey,
});

/** Evidence that a specific transaction settled a specific spend. */
export interface SettlementEvidence {
  readonly txHash: TxHash;
  readonly spendHash: string;
  readonly succeeded: boolean;
}

const isTerminal = (state: IntentState): boolean => TERMINAL_INTENT_STATES.includes(state);

export class IntentStore {
  #byId = new Map<IntentId, IntentRecord>();
  #byIdempotency = new Map<IdempotencyKey, IntentId>();
  /** Held attempt claims, so two workers cannot evaluate the same intent. */
  #leases = new Set<IntentId>();
  /** Not yet ended, in submission order: the queue, without walking what has ended. */
  #live = new Set<IntentId>();
  /** Live and not yet decided, with the size of the ciphertext each holds. */
  #undecided = new Map<IntentId, number>();
  #undecidedBytes = 0;
  /** Ended, in the order they ended, with when. */
  #ended = new Map<IntentId, UnixSeconds>();
  #forgotten: ((intentId: IntentId) => void)[] = [];
  readonly #limits: Required<IntentStoreOptions>;

  constructor(options: IntentStoreOptions = {}) {
    this.#limits = {
      maxUndecided: options.maxUndecided ?? 256,
      maxUndecidedBytes: options.maxUndecidedBytes ?? 256 * 1024 * 1024,
      undecidedGraceSeconds: options.undecidedGraceSeconds ?? DAY,
      retainSeconds: options.retainSeconds ?? DAY,
      maxRetained: options.maxRetained ?? 20_000,
    };
  }

  /** Told of each ended intent as it is forgotten, so what refers to it can go too. */
  onForget(listener: (intentId: IntentId) => void): void {
    this.#forgotten.push(listener);
  }

  /**
   * Idempotent submission. The same key with the same canonical request
   * returns the same intent; the same key with DIFFERENT content is a caller
   * bug and rejects rather than silently overwriting the first payment.
   */
  submit(input: {
    readonly intentId: IntentId;
    readonly intent: EncryptedIntent;
    readonly now: UnixSeconds;
  }): IntentRecord {
    const existing = this.#byIdempotency.get(input.intent.idempotencyKey);
    if (existing !== undefined) {
      const record = this.#byId.get(existing)!;
      if (record.intent.spendHash !== input.intent.spendHash) {
        throw new ProtocolFailure(
          'INVALID_INPUT',
          'idempotency key reused with different content',
        );
      }
      return record;
    }

    this.#forget(input.now);
    const size = sizeOf(input.intent);
    if (this.#undecided.size >= this.#limits.maxUndecided || this.#undecidedBytes + size > this.#limits.maxUndecidedBytes) {
      // Refused at the door, retryably, rather than held until memory runs
      // out: a crash loses every intent in flight, not just the newest.
      throw new ProtocolFailure('MESH_UNAVAILABLE', 'the executor is holding all the undecided payments it can: try again shortly', true);
    }

    const record: IntentRecord = {
      intentId: input.intentId,
      intent: input.intent,
      state: 'WAITING_FOR_PRIVACY',
      deadlineReached: false,
      updatedAt: input.now,
      attempts: 0,
    };
    this.#byId.set(input.intentId, record);
    this.#byIdempotency.set(input.intent.idempotencyKey, input.intentId);
    this.#live.add(input.intentId);
    this.#undecided.set(input.intentId, size);
    this.#undecidedBytes += size;
    return record;
  }

  get(intentId: IntentId): IntentRecord | undefined {
    return this.#byId.get(intentId);
  }

  /** Atomic claim. Returns false if another worker already holds this intent. */
  claimAttempt(intentId: IntentId): boolean {
    if (this.#leases.has(intentId)) return false;
    const record = this.#byId.get(intentId);
    if (record === undefined || isTerminal(record.state)) return false;
    this.#leases.add(intentId);
    this.#byId.set(intentId, { ...record, attempts: record.attempts + 1 });
    return true;
  }

  releaseClaim(intentId: IntentId): void {
    this.#leases.delete(intentId);
  }

  /** Compare-and-set. A stale expectation loses rather than clobbering. */
  transition(input: {
    readonly intentId: IntentId;
    readonly from: readonly IntentState[];
    readonly to: IntentState;
    readonly now: UnixSeconds;
    readonly patch?: Partial<IntentRecord>;
  }): IntentRecord {
    const record = this.#byId.get(input.intentId);
    if (record === undefined) throw new ProtocolFailure('INVALID_INPUT', 'unknown intent');
    if (isTerminal(record.state)) {
      throw new ProtocolFailure('INVALID_INPUT', `intent is already ${record.state}`);
    }
    if (!input.from.includes(record.state)) {
      throw new ProtocolFailure('INVALID_INPUT', `intent is ${record.state}, expected one of ${input.from.join('/')}`);
    }
    let next: IntentRecord = { ...record, ...input.patch, state: input.to, updatedAt: input.now };
    // Decided or ended, the ciphertext is never opened again: the outbox, or
    // the ending, is all that is left to act on.
    if (isTerminal(input.to) || next.outbox !== undefined) {
      next = { ...next, intent: slim(next.intent) };
      const size = this.#undecided.get(input.intentId);
      if (size !== undefined) {
        this.#undecided.delete(input.intentId);
        this.#undecidedBytes -= size;
      }
    }
    if (isTerminal(input.to)) {
      // Nothing acts on an ended intent's outbox: transitions refuse it.
      const { outbox, ...ended } = next;
      void outbox;
      next = ended;
      this.#live.delete(input.intentId);
      this.#ended.set(input.intentId, input.now);
    }
    this.#byId.set(input.intentId, next);
    if (isTerminal(input.to)) this.#forget(input.now);
    return next;
  }

  /** Ended intents past their retention, or past the most kept, oldest first. */
  #forget(now: UnixSeconds): void {
    for (const [intentId, endedAt] of this.#ended) {
      if (this.#ended.size <= this.#limits.maxRetained && now - endedAt < this.#limits.retainSeconds) break;
      this.#ended.delete(intentId);
      const record = this.#byId.get(intentId);
      this.#byId.delete(intentId);
      if (record !== undefined && this.#byIdempotency.get(record.intent.idempotencyKey) === intentId) {
        this.#byIdempotency.delete(record.intent.idempotencyKey);
      }
      for (const listener of this.#forgotten) listener(intentId);
    }
  }

  /**
   * Records the authorised release, in the SAME step as the transition that
   * authorises it. Once an outbox entry exists it is never replaced: a retry
   * re-delivers the identical release, so a second evaluation cannot produce
   * a second, different spend.
   */
  authorize(input: {
    readonly intentId: IntentId;
    readonly release: ApprovedRelease;
    readonly now: UnixSeconds;
    readonly attestation?: IntentRecord['attestation'];
  }): ApprovedRelease {
    const record = this.#byId.get(input.intentId);
    if (record === undefined) throw new ProtocolFailure('INVALID_INPUT', 'unknown intent');
    if (record.outbox !== undefined) return record.outbox;

    this.transition({
      intentId: input.intentId,
      from: ['WAITING_FOR_PRIVACY', 'POLICY_CHECKING', 'RETRYING'],
      to: 'READY_TO_RELEASE',
      now: input.now,
      patch: { outbox: input.release, ...(input.attestation === undefined ? {} : { attestation: input.attestation }) },
    });
    return input.release;
  }

  /** Persisted BEFORE a broadcast is declared successful, never after. */
  recordBroadcast(intentId: IntentId, txHash: TxHash, now: UnixSeconds): IntentRecord {
    return this.transition({
      intentId,
      from: ['READY_TO_RELEASE', 'RELEASING', 'RETRYING'],
      to: 'SETTLEMENT_PENDING',
      now,
      patch: { broadcast: txHash },
    });
  }

  /**
   * The only route to SETTLED. Requires a successful transaction whose spend
   * matches this intent's own outbox — a spent nullifier alone proves someone
   * spent that note, not that this intent is what did it.
   */
  reconcile(input: {
    readonly intentId: IntentId;
    readonly evidence: SettlementEvidence | null;
    readonly nullifierSpent: boolean;
    readonly now: UnixSeconds;
  }): IntentRecord {
    const record = this.#byId.get(input.intentId);
    if (record === undefined) throw new ProtocolFailure('INVALID_INPUT', 'unknown intent');
    if (isTerminal(record.state)) return record;

    const expected = record.outbox === undefined ? undefined : spendHash(record.outbox.spend);

    if (input.evidence?.succeeded === true && input.evidence.spendHash === expected) {
      return this.transition({
        intentId: input.intentId,
        from: ['READY_TO_RELEASE', 'RELEASING', 'SETTLEMENT_PENDING', 'RETRYING'],
        to: 'SETTLED',
        now: input.now,
        patch: { txHash: input.evidence.txHash },
      });
    }

    // Someone spent the note, but not through this intent's release. The
    // reservation must be released and the note re-checked; this is NOT a
    // settlement and it is NOT this intent's failure.
    if (input.nullifierSpent) {
      return this.transition({
        intentId: input.intentId,
        from: ['READY_TO_RELEASE', 'RELEASING', 'SETTLEMENT_PENDING', 'RETRYING', 'WAITING_FOR_PRIVACY'],
        to: 'RETRYING',
        now: input.now,
        patch: {
          error: {
            code: 'NULLIFIER_SPENT',
            retryable: false,
            publicMessage: 'this note was spent by a transaction that is not this payment',
          },
        },
      });
    }

    // No conclusive evidence either way. Stay resumable — never invent a
    // terminal state from silence.
    return this.transition({
      intentId: input.intentId,
      from: ['READY_TO_RELEASE', 'RELEASING', 'SETTLEMENT_PENDING', 'RETRYING'],
      to: 'RETRYING',
      now: input.now,
    });
  }

  /** Terminal failure needs conclusive evidence, which the caller supplies. */
  fail(intentId: IntentId, error: ProtocolError, now: UnixSeconds): IntentRecord {
    if (error.retryable) {
      throw new ProtocolFailure('INVALID_INPUT', 'a retryable condition is not a terminal failure');
    }
    return this.transition({
      intentId,
      from: ['WAITING_FOR_PRIVACY', 'POLICY_CHECKING', 'READY_TO_RELEASE', 'RELEASING', 'SETTLEMENT_PENDING', 'RETRYING'],
      to: 'FAILED',
      now,
      patch: { error },
    });
  }

  /**
   * The queue the confidential workflow reads: every intent not yet in a
   * terminal state, in submission order.
   *
   * Insertion order, not sorted by score or deadline. Two workflow nodes must
   * see the same list in the same order for their results to agree, and any
   * ordering derived from a value that changes between reads (a score, a
   * lease) would silently break that.
   *
   * These records carry EncryptedIntent, so the caller holds ciphertext. The
   * decision to decrypt is evaluate-intent.ts's alone, and only for an
   * eligible attempt.
   */
  pending(now: UnixSeconds): readonly IntentRecord[] {
    // An intent whose deadline has passed is still pending: the deadline
    // branch is what fires it, so dropping it here would strand exactly the
    // payments that most need to go. One a whole day past it, that no decision
    // ever came for and nobody is acting on, will not get one: it ends, its
    // note unspent, so the wallet can use the note again.
    for (const [intentId] of this.#undecided) {
      const record = this.#byId.get(intentId)!;
      if (!this.#leases.has(intentId) && now > record.intent.deadline + this.#limits.undecidedGraceSeconds) {
        this.fail(intentId, { code: 'EXPIRED', retryable: false, publicMessage: 'no decision came for this payment; its note was not spent' }, now);
      }
    }
    return [...this.#live].map((intentId) => this.#byId.get(intentId)!);
  }

  /** The safe projection. Never exposes the outbox, the payload or a broadcast id. */
  status(intentId: IntentId): IntentStatus {
    const record = this.#byId.get(intentId);
    if (record === undefined) throw new ProtocolFailure('INVALID_INPUT', 'unknown intent');
    return {
      state: record.state,
      deadlineReached: record.deadlineReached,
      updatedAt: record.updatedAt,
      ...(record.txHash === undefined ? {} : { txHash: record.txHash }),
      ...(record.error === undefined ? {} : { error: record.error }),
    };
  }
}
