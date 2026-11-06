// The executor's side of a CRE decision.
//
// CRE decides in the enclave (cre-release.ts) and posts its decisions to the
// executor, tagged under the secret the two share. For a RELEASE the settler:
//
//   1. checks the tag — only CRE, holding the secret, could have made it;
//   2. opens the payment with the key CRE released, and requires that it is
//      exactly the spend the intent committed to (spendHash) and pays exactly
//      the recipient CRE approved;
//   3. attests it (the attester verifies the 1.1 MiB proof at full strength
//      first — too big for CRE), issues the release, hands it to the egress,
//      and reconciles against the chain.
//
// A DENY is checked the same way and ends the intent. Anything that fails
// after authorisation is retried from the one release in the outbox, never
// re-decided, so an intent can never produce two different spends.

import { timingSafeEqual } from 'node:crypto';

import {
  ProtocolFailure,
  TERMINAL_INTENT_STATES,
  type ApprovedRelease,
  type IntentId,
  type PoolScope,
  type PrivateSpend,
  type ProtocolError,
  type TxHash,
  type UnixSeconds,
} from '@opaque/protocol-types';
import { asPrivateSpend, fromHex, spendHash as hashOf } from '@opaque/protocol-types/codecs.js';

import { attestRingSpend, type AttesterIdentity } from './attest.ts';
import type { Decision, PendingBatch, PendingIntent } from './cre-release.ts';
import type { OpaqueExecutor } from './executor.ts';
import type { IntentRecord, SettlementEvidence } from './intent-store.ts';
import { issueRelease } from './release.ts';
import { decodeIntentPlaintext, openBulk, releaseTag } from './sealed-intent.ts';

export interface SettlerOptions {
  readonly executor: OpaqueExecutor;
  /**
   * One line per step a payment takes here, for an operator to watch: what the settler opened, that
   * the proof verified and the attester signed. Only what this box already sees; never a note secret.
   */
  readonly trace?: (line: string) => void;
  /** Shared with CRE: checks decision tags, and MACs the release the egress trusts. */
  readonly credentialMac: Uint8Array;
  readonly policyVersion: string;
  readonly releaseTtlSeconds: bigint;
  /**
   * Arc's FORS attester, which replaces the proof with its signature. Absent
   * (XRPL), the release carries the spend with its proof, because the chain's
   * own attester quorum verifies it before it co-signs anything.
   */
  readonly attester?: {
    /** One attester can serve several pools: then, the identity for the spend's pool. */
    readonly identity: AttesterIdentity | ((scope: PoolScope) => AttesterIdentity);
    /** The key and index to sign with; `reserve` counts the signature first (attester-keys.ts). */
    readonly current: () => Promise<{ readonly forsSeed: Uint8Array; readonly useCount: bigint; readonly generation?: number; readonly reserve?: () => void }>;
    /**
     * The registry's index, read and nothing else: what the settler watches for
     * a signature to be consumed. Absent, current() is asked, and current()
     * rotates near the end of a key's budget, on whatever a stale node says.
     */
    readonly observe?: () => Promise<{ readonly useCount: bigint; readonly generation?: number }>;
  };
  /**
   * Asked before the attester signs: throws a final refusal for a spend the
   * pool would revert, a ring member it never saw or a spent note
   * (chain/pool.ts assertSpendable). An attestation that can never land still
   * costs the few-time key a use.
   */
  readonly spendable?: (spend: PrivateSpend) => Promise<void>;
  /** Hands a release to the egress and returns the broadcast tx. */
  readonly deliver: (release: ApprovedRelease) => Promise<TxHash>;
  /** What the chain says that tx did — required before anything is SETTLED. */
  readonly evidence: (txHash: TxHash, release: ApprovedRelease) => Promise<SettlementEvidence>;
  /**
   * Arc's delivery: evidence() reads a receipt, so it answers only once the
   * chain has decided and throws until then; and the egress answers a release
   * it has sent before with that same transaction. A failed verdict then ends
   * the intent, and a broadcast is reconciled, never sent again (F-56). Unset
   * (XRPL), a failed verdict may only mean "not found yet", and a retry pays
   * afresh.
   */
  readonly receiptEvidence?: boolean;
  readonly nullifierSpent: (spend: PrivateSpend) => Promise<boolean>;
  /** Told when a settlement fails and will be retried. Never given a recipient. */
  readonly onError?: (intentId: IntentId, error: unknown) => void;
  readonly now?: () => UnixSeconds;
  /** Injected so tests do not wait on real time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface Settler {
  /** Checks each decision's tag and settles the valid ones in the background. Returns how many it accepted. */
  accept(decisions: readonly Decision[]): number;
  /** One decision, awaited: the local stand-in and tests. */
  settle(decision: Decision): Promise<void>;
  /** Re-delivers authorised releases that have not settled yet. */
  retry(): Promise<void>;
}

/** An intent awaiting CRE: a v2 envelope, no decision yet. */
const awaitingCre = (record: IntentRecord): boolean =>
  record.intent.creEnvelope !== undefined && record.outbox === undefined
  && (record.state === 'WAITING_FOR_PRIVACY' || record.state === 'POLICY_CHECKING');

/**
 * What the executor serves CRE: every intent awaiting a decision, oldest
 * first, until the response would pass `maxBytes` (CRE reads 100 KB). Ids and
 * ciphertext only: CRE reads the terms from inside the envelope.
 */
export function pendingForCre(executor: OpaqueExecutor, now: UnixSeconds, maxBytes = 90_000): PendingBatch {
  const intents: PendingIntent[] = [];
  let size = 32;
  for (const record of executor.pending(now)) {
    if (!awaitingCre(record)) continue;
    const view: PendingIntent = { intentId: record.intentId, spendHash: record.intent.spendHash, envelope: record.intent.creEnvelope! };
    size += JSON.stringify(view).length + 1;
    if (size > maxBytes) break;
    intents.push(view);
  }
  return { intents };
}

/**
 * Refusals no retry can change, raised before anything was broadcast: the
 * proof is bad, the note was already spent (an XRPL attester checks the
 * ledger's credential before it signs), the note is already being paid by
 * another intent, the release's window has closed, or the chain says the
 * payment can never land (a non-retryable SETTLEMENT_REVERTED, from a dry run).
 */
const isFinal = (error: unknown): error is ProtocolFailure & { code: 'PROOF_REJECTED' | 'NULLIFIER_SPENT' | 'NOTE_RESERVED' | 'EXPIRED' | 'SETTLEMENT_REVERTED' } =>
  error instanceof ProtocolFailure && (error.code === 'PROOF_REJECTED' || error.code === 'NULLIFIER_SPENT'
    || error.code === 'NOTE_RESERVED' || error.code === 'EXPIRED'
    || (error.code === 'SETTLEMENT_REVERTED' && !error.retryable));

/** Where an attestation was signed: the registry index it is good for, and the key. */
type Signed = { readonly useCount: bigint; readonly generation?: number };

/** How many times a held turn looks for a signature to be consumed, a second apart. */
const CONSUME_TRIES = 15;
/** A broadcast whose index another signature has since consumed is dropped once seen so this long apart. */
const DROPPED_AFTER_SECONDS = 60;

const tagMatches = (expected: string, actual: unknown): boolean => {
  if (typeof actual !== 'string' || !/^0x[0-9a-f]{64}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(fromHex(expected as never)), Buffer.from(fromHex(actual as never)));
};

export function createSettler(options: SettlerOptions): Settler {
  const { executor } = options;
  const store = executor.store;
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const identityFor = (scope: PoolScope): AttesterIdentity =>
    typeof options.attester!.identity === 'function' ? options.attester!.identity(scope) : options.attester!.identity;
  // Per intent, and gone with it (retry() prunes): when it was last tried, the
  // note each attestation in flight spends, and when a broadcast was first seen dropped.
  const lastTry = new Map<IntentId, number>();
  const attesting = new Map<string, IntentId>();
  const dropped = new Map<IntentId, number>();
  // Per note, the times it was attested in the last day (F-68). A note is paid
  // with one attestation; one whose spend the pool refuses after the signature
  // check (a recipient the token will not pay, say) ends with the note unspent,
  // and every new intent for it cost the key another signature for one deposit.
  const attestedAt = new Map<string, number[]>();
  const ATTESTATIONS_PER_NOTE = 2;
  const NOTE_WINDOW = 86_400;
  const live = (intentId: IntentId): boolean => {
    const record = store.get(intentId);
    return record !== undefined && !TERMINAL_INTENT_STATES.includes(record.state);
  };

  // ONE ATTESTATION AT A TIME, FROM SIGNING TO A LANDED TRANSACTION.
  //
  // The registry accepts the attester's signature only for its current use
  // count, and the count moves only when a spend carrying it succeeds. Two notes
  // of one payment are decided in the same CRE tick; settled in parallel, both
  // read count N, both sign for N, the first lands and the second reverts with
  // BadSignature. It is also a few-time key signing two messages at one index,
  // which spends more of its budget than the registry counts. Reserving counts
  // ahead does not work either: if N fails, everything signed for N+1 reverts.
  let tail: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };

  /**
   * A load-balanced RPC can answer from before the block that consumed an index,
   * and the next attestation would sign that index again. Hold the turn until
   * the registry shows it moved, or a rotation replaced the key. Read plainly,
   * never through current(), which rotates on what a stale node says. Giving up
   * is safe: the next signature is counted against the key (attester-keys.ts),
   * at worst it signs an index again and reverts.
   */
  async function untilConsumed(used: Signed): Promise<void> {
    const read = options.attester!.observe ?? options.attester!.current;
    for (let attempt = 0; attempt < CONSUME_TRIES; attempt++) {
      const seen = await read().catch(() => undefined);
      if (seen !== undefined && (seen.generation !== used.generation || seen.useCount > used.useCount)) return;
      await sleep(1_000);
    }
  }

  /** A decision this executor should act on: a known, undecided intent, and a tag only CRE could make. */
  function authentic(decision: Decision): IntentRecord | undefined {
    const record = store.get(decision.intentId as IntentId);
    if (record === undefined || !awaitingCre(record)) return undefined;
    const expected = releaseTag(options.credentialMac, decision.verdict === 'RELEASE'
      ? { intentId: record.intentId, spendHash: record.intent.spendHash, verdict: 'RELEASE', recipient: decision.recipient, k: decision.k }
      : { intentId: record.intentId, spendHash: record.intent.spendHash, verdict: 'DENY' });
    return tagMatches(expected, decision.tag) ? record : undefined;
  }

  const refuse = (intentId: IntentId, code: ProtocolError['code'], message: string): void => {
    try {
      store.fail(intentId, { code, retryable: false, publicMessage: message } as ProtocolError, now());
    } catch { /* already terminal */ }
  };

  /** From an authorised release to SETTLED: delivery, broadcast, evidence. */
  async function deliver(intentId: IntentId, release: ApprovedRelease): Promise<void> {
    const txHash = await options.deliver(release);
    store.recordBroadcast(intentId, txHash, now());
    // SETTLED only on evidence that THIS release's spend succeeded. A spent
    // nullifier alone is not proof — the pool is permissionless.
    const evidence = await options.evidence(txHash, release);
    const spent = await options.nullifierSpent(release.spend);
    const after = store.reconcile({ intentId, evidence, nullifierSpent: spent, now: now() });
    // Mined and failed, and the note unspent: that transaction is over, and the
    // egress answers this release with its hash rather than send it again, so
    // nothing more can come of this intent (F-56). It ends; the note is free.
    if (options.receiptEvidence === true && after.state !== 'SETTLED' && !spent) {
      refuse(intentId, 'SETTLEMENT_REVERTED', 'the settlement transaction failed on chain; the note was not spent');
    }
  }

  /**
   * One delivery, in the attester's turn, holding the turn while the signature
   * it carries may yet land: when it settled, and when delivery failed in a way
   * that may have left a transaction behind (F-45). A final refusal comes before
   * anything is broadcast.
   */
  async function deliverHolding(intentId: IntentId, release: ApprovedRelease, signed: Signed | undefined): Promise<void> {
    let outstanding = true;
    try {
      await deliver(intentId, release);
      outstanding = store.get(intentId)?.state === 'SETTLED';
    } catch (error) {
      outstanding = !isFinal(error);
      throw error;
    } finally {
      if (signed !== undefined && outstanding) await untilConsumed(signed);
    }
  }

  async function settle(decision: Decision): Promise<void> {
    const record = authentic(decision);
    if (record === undefined) return;
    const intentId = record.intentId;
    if (decision.verdict === 'DENY') {
      refuse(intentId, 'POLICY_DENIED', decision.reason);
      return;
    }
    if (!store.claimAttempt(intentId)) return;
    try {
      // Open with the released key, and hold CRE's approval to exactly this
      // spend: the committed hash, the approved recipient, the intent's pool.
      let spend: PrivateSpend;
      let beside: { readonly destination?: unknown; readonly deliverMin?: unknown } = {};
      try {
        const opened = decodeIntentPlaintext(openBulk(fromHex(decision.k as never), record.intent.spendHash, record.intent.encryptedPayload)).spend;
        spend = asPrivateSpend(opened);
        // An XRPL payment names its account and tag beside the spend. Not
        // trusted here: the spend's recipient binds both, and every XRPL
        // attester recomputes that binding before it signs.
        if (opened['destination'] !== undefined) beside = { destination: opened['destination'] };
        // A swap into another pool also names the least it must deliver there.
        // Checked by the attesters against the AMM before they sign.
        if (opened['deliverMin'] !== undefined) beside = { ...beside, deliverMin: opened['deliverMin'] };
      } catch {
        refuse(intentId, 'INVALID_INPUT', 'the released key does not open this payment');
        return;
      }
      if (hashOf(spend) !== record.intent.spendHash) {
        refuse(intentId, 'INVALID_INPUT', 'the payment is not the spend this intent committed to');
        return;
      }
      if (spend.recipient.toLowerCase() !== decision.recipient.toLowerCase()) {
        refuse(intentId, 'POLICY_DENIED', 'the payment pays a different recipient than CRE approved');
        return;
      }
      if (spend.scope.pool !== record.intent.scope.pool || spend.scope.denomination !== record.intent.scope.denomination) {
        refuse(intentId, 'INVALID_INPUT', 'the payment is scoped to a different pool');
        return;
      }
      const checked = spend;
      const units = BigInt(checked.scope.denomination);
      options.trace?.(`opened payment ${String(intentId).slice(0, 10)}…: one ${units >= 10n ** 12n ? `${Number(units) / 1e18} ETH` : `${Number(units) / 1e6} USDC`} note to ${String(checked.recipient).slice(0, 10)}…, ${checked.mode === 'RING_8' ? `hiding among a ring of ${checked.ring.length}` : 'one note, not in a ring'}`);
      await oneAtATime(async () => {
        const at = now();
        let attested = { ...checked, ...beside } as PrivateSpend;
        let signed: Signed | undefined;
        if (options.attester !== undefined) {
          // One note, one attestation in flight: a second intent for a note
          // this process has signed for, and not yet seen settle or fail, would
          // be a second signature for a spend only one of can land (F-45).
          const nullifier = String(checked.nullifier).toLowerCase();
          const holder = attesting.get(nullifier);
          if (holder !== undefined && holder !== intentId && live(holder)) {
            throw new ProtocolFailure('NOTE_RESERVED', 'another payment of this note is already under way');
          }
          const recent = (attestedAt.get(nullifier) ?? []).filter((t) => t > Number(at) - NOTE_WINDOW);
          if (recent.length >= ATTESTATIONS_PER_NOTE) {
            throw new ProtocolFailure('NOTE_RESERVED', 'this note was attested twice today and paid neither time; try again tomorrow');
          }
          // Read in this turn, right before signing: nothing can sign for this
          // note between the read and the signature.
          await options.spendable?.(checked);
          const key = await options.attester.current();
          const started = Date.now();
          attested = attestRingSpend({ spend: checked, identity: identityFor(checked.scope), ...key });
          options.trace?.(`ring proof verified in ${((Date.now() - started) / 1000).toFixed(1)} s; attested with the attester's FORS+C key${key.generation === undefined ? '' : ` (generation ${key.generation}`}, signature ${key.useCount + 1n}${key.generation === undefined ? '' : ')'}`);
          attesting.set(nullifier, intentId);
          attestedAt.set(nullifier, [...recent, Number(at)]);
          signed = { useCount: key.useCount, ...(key.generation === undefined ? {} : { generation: key.generation }) };
        }
        const release = issueRelease({
          intentId, spend: attested, policyVersion: options.policyVersion,
          issuedAt: at, ttlSeconds: options.releaseTtlSeconds, secret: options.credentialMac,
        });
        // Authorised BEFORE delivery: the outbox is created in the same step as
        // the transition that permits it, so a crash cannot mint a second one.
        store.authorize({ intentId, release, now: at, ...(signed === undefined ? {} : { attestation: signed }) });
        await deliverHolding(intentId, release, signed);
      });
    } catch (error) {
      options.onError?.(intentId, error);
      if (isFinal(error)) refuse(intentId, error.code, error.message);
      // Anything else after authorisation is retried from the outbox.
    } finally {
      store.releaseClaim(intentId);
    }
  }

  /**
   * A broadcast with no verdict yet, looked at again, outside the attester's
   * turn: nothing here signs, and a transaction that never lands must not hold
   * up the ones that will (F-56). It is never sent again (the egress would hand
   * back the same hash); it ends when the chain says: settled, mined and
   * failed, or dropped. Dropped means the index its attestation was signed for
   * has been consumed by another, so it can never verify, seen twice a minute
   * apart so that one node behind the others cannot end a payment that landed.
   */
  async function reconcileBroadcast(record: IntentRecord, broadcast: TxHash, outbox: ApprovedRelease): Promise<void> {
    const intentId = record.intentId;
    const evidence = await options.evidence(broadcast, outbox).catch(() => null);
    const spent = await options.nullifierSpent(outbox.spend);
    const after = store.reconcile({ intentId, evidence, nullifierSpent: spent, now: now() });
    if (after.state === 'SETTLED' || spent) return;
    if (evidence !== null) {
      refuse(intentId, 'SETTLEMENT_REVERTED', 'the settlement transaction failed on chain; the note was not spent');
      return;
    }
    if (record.attestation === undefined || options.attester === undefined) return;
    const seen = await (options.attester.observe ?? options.attester.current)();
    if (seen.generation === record.attestation.generation && seen.useCount <= record.attestation.useCount) {
      dropped.delete(intentId);
      return;
    }
    const first = dropped.get(intentId);
    if (first === undefined) dropped.set(intentId, Number(now()));
    else if (Number(now()) - first >= DROPPED_AFTER_SECONDS) {
      refuse(intentId, 'SETTLEMENT_REVERTED', 'the settlement transaction was dropped and can no longer land; the note was not spent');
    }
  }

  async function retry(): Promise<void> {
    const records = executor.pending(now());
    const ids = new Set(records.map((r) => r.intentId));
    for (const id of [...lastTry.keys()]) if (!ids.has(id)) lastTry.delete(id);
    for (const id of [...dropped.keys()]) if (!ids.has(id)) dropped.delete(id);
    for (const [nullifier, id] of [...attesting]) if (!ids.has(id)) attesting.delete(nullifier);
    const since = Number(now()) - NOTE_WINDOW;
    for (const [nullifier, times] of [...attestedAt]) if (times.every((t) => t <= since)) attestedAt.delete(nullifier);

    for (const record of records) {
      if (record.outbox === undefined) continue;
      // Ten seconds, doubling with each attempt, to ten minutes: a payment
      // waiting on the chain is looked at often, one that keeps failing less.
      const at = Number(now()) * 1000;
      const backoff = Math.min(10_000 * 2 ** Math.max(0, record.attempts - 1), 600_000);
      if (at - (lastTry.get(record.intentId) ?? 0) < backoff) continue;
      if (!store.claimAttempt(record.intentId)) continue;
      lastTry.set(record.intentId, at);
      const outbox = record.outbox;
      try {
        if (record.broadcast !== undefined && options.receiptEvidence === true) {
          await reconcileBroadcast(record, record.broadcast, outbox);
          continue;
        }
        if (record.broadcast !== undefined) {
          // A broadcast already made may have landed: look before paying again.
          // If the note is spent, the receipt says whether it was this release.
          const spent = await options.nullifierSpent(outbox.spend);
          const after = store.reconcile({
            intentId: record.intentId,
            evidence: spent ? await options.evidence(record.broadcast, outbox) : null,
            nullifierSpent: spent,
            now: now(),
          });
          if (spent || after.state !== 'RETRYING') continue;
        } else if (options.receiptEvidence === true && await options.nullifierSpent(outbox.spend)) {
          // Nothing on record as sent, and the note is spent anyway: sent again,
          // the pool would refuse it, and that refusal would end a payment that
          // may be this one. Wait for the chain to say whose spend it was.
          store.reconcile({ intentId: record.intentId, evidence: null, nullifierSpent: true, now: now() });
          continue;
        }
        // In turn with fresh attestations: this re-sends one already signed, and
        // must not race a new one for the same index. It deliberately does not
        // call current() first — that can rotate, consuming the very index this
        // stored attestation was signed for.
        await oneAtATime(() => deliverHolding(record.intentId, outbox, record.attestation));
      } catch (error) {
        options.onError?.(record.intentId, error);
        // Nothing of this intent's was ever broadcast, so a refusal now is not
        // about a transaction of its own that may yet land.
        if (store.get(record.intentId)?.broadcast === undefined && isFinal(error)) refuse(record.intentId, error.code, error.message);
      } finally {
        store.releaseClaim(record.intentId);
      }
    }
  }

  return {
    accept(decisions) {
      const valid = decisions.filter((d) => authentic(d) !== undefined);
      // In the background: CRE's request times out in 10 s, a settlement
      // takes several. The executor's own retry covers a crash mid-way.
      for (const decision of valid) void settle(decision);
      return valid.length;
    },
    settle,
    retry,
  };
}
