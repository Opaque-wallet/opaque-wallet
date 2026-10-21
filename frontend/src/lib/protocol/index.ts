// The application adapter barrel. Pages import THIS FILE and nothing else.
//
// No raw GraphQL, RPC, ABI or relay calls in pages. If something a page needs
// is missing here, it is reported to the adapter's owner and added — never
// worked around by reaching past the barrel, because every bypass is a
// direct request from the browser that the mesh was supposed to carry.
//
// ConfidentialPolicyAdapter is deliberately absent: it is server/internal only,
// so a page cannot obtain an authorization on its own or skip the executor.

import {
  ProtocolFailure,
  splitAmount,
  type Address,
  type EncryptedIntent,
  type GraphSelectionClient,
  type IntentRef,
  type IntentStatus,
  type MeshQuery,
  type MeshQueryResult,
  type NoteSummary,
  type PathSelectionPolicy,
  type PaymentApplication,
  type PaymentRequest,
  type PoolScope,
  type PqWallet,
  type PqWalletState,
  type PrivacyTimedExecutor,
  type PrivacyTransport,
  type PrivatePoolContract,
  type ProtocolCapabilities,
  type RelayPath,
  type RingClient,
  type StatusHandle,
  type TxHash,
} from '@opaque/protocol-types';
import { asPrivateSpend, assertRelayPath, spendHash } from '@opaque/protocol-types/codecs.js';

import type { DepositMany } from '../../../../backend/chain/wallet-chain.ts';

export type { ProtocolCapabilities, IntentStatus, NoteSummary, PaymentRequest, PoolScope };

/**
 * Verifies the result's discriminant matches the request before anything is
 * read off it. The alternative — `query<T>()` with a caller-supplied type
 * parameter — is an unchecked cast wearing a type annotation, and a relay that
 * returns a RELAY_SNAPSHOT where a PRIVACY_CONDITIONS was asked for would be
 * read as whatever the caller hoped for.
 */
export function decodeQueryResult<K extends MeshQuery['kind']>(
  request: Extract<MeshQuery, { kind: K }>,
  result: MeshQueryResult,
): Extract<MeshQueryResult, { kind: K }> {
  if (result.kind !== request.kind) {
    throw new ProtocolFailure(
      'INVALID_INPUT',
      `asked for ${request.kind} and received ${result.kind}`,
    );
  }
  return result as Extract<MeshQueryResult, { kind: K }>;
}

/**
 * The protocol ceiling is 27 notes. With the approved seven buckets a greedy
 * amount up to 999 USDC needs no more than 17, leaving room under the Arc
 * account-operation budget for future policy changes.
 */
export const MAX_NOTES_PER_DEPOSIT = 27;

/** Past this many units, the table below would take too much memory: largeAmount instead. */
const TABLE_LIMIT = 100_000;

/**
 * An exact amount from the notes held, largest notes first, backing off one
 * at a time when what is left cannot be made. Not always the fewest notes, but
 * near it with sizes of 1, 2 and 5 a decade, and no memory the size of the amount.
 * ponytail: gives up after 200,000 steps; a smarter search if that is ever hit.
 */
function largeAmount(amount: number, sizes: readonly number[], have: ReadonlyMap<number, number>): Map<number, number> | undefined {
  const cap: number[] = [];
  for (let i = sizes.length - 1, sum = 0; i >= 0; i--) cap[i] = sum += (have.get(sizes[i]!) ?? 0) * sizes[i]!;
  const pick = new Map<number, number>();
  let steps = 0;
  const go = (i: number, rest: number): boolean => {
    if (rest === 0) return true;
    if (i === sizes.length || rest > cap[i]! || ++steps > 200_000) return false;
    const d = sizes[i]!;
    for (let k = Math.min(have.get(d) ?? 0, Math.floor(rest / d)); k >= 0; k--) {
      if (k > 0) pick.set(d, k); else pick.delete(d);
      if (go(i + 1, rest - k * d)) return true;
    }
    return false;
  };
  return go(0, amount) ? pick : undefined;
}

/**
 * Notes that make `amount` exactly: denomination → count, all in whole units.
 * undefined when nothing makes it — a note is spent whole, with no change (§6.6).
 *
 * Without `have` (a deposit, any number of each): the payable split
 * (protocol-types splitAmount), so every amount up to it can be paid after.
 * With `have` (a send, from what is held): the fewest notes, solved outright,
 * since greedy is not even exact there (a 50 and three 20s make 60 only as
 * 3×20): dynamic programming over the amount, or largeAmount past TABLE_LIMIT.
 */
export function makeAmount(amount: number, denominations: readonly number[], have?: ReadonlyMap<number, number>): Map<number, number> | undefined {
  const sizes = [...denominations].sort((a, b) => b - a);
  // Without notes to choose from, how a deposit should split: so every amount up to it is payable.
  if (have === undefined) {
    const out = new Map<number, number>();
    const rest = splitAmount(BigInt(amount), sizes, true, (d) => { out.set(d, (out.get(d) ?? 0) + 1); return true; });
    return rest === 0n ? out : undefined;
  }
  if (amount > TABLE_LIMIT) return largeAmount(amount, sizes, have);
  // best[x]: fewest notes making x from the sizes so far; take[i][x]: how many
  // of sizes[i] that used. ponytail: O(amount × notes held), fine to thousands.
  let best = Array<number>(amount + 1).fill(Infinity);
  best[0] = 0;
  const take: number[][] = [];
  for (const d of sizes) {
    const next = Array<number>(amount + 1).fill(Infinity);
    const used = Array<number>(amount + 1).fill(0);
    for (let x = 0; x <= amount; x++) {
      for (let k = 0; k <= (have.get(d) ?? 0) && k * d <= x; k++) {
        if (best[x - k * d]! + k < next[x]!) [next[x], used[x]] = [best[x - k * d]! + k, k];
      }
    }
    best = next;
    take.push(used);
  }
  if (best[amount] === Infinity) return undefined;
  const counts: [number, number][] = [];
  for (let i = sizes.length - 1, x = amount; i >= 0; i--) {
    if (take[i]![x]! > 0) counts.unshift([sizes[i]!, take[i]![x]!]);
    x -= take[i]![x]! * sizes[i]!;
  }
  return new Map(counts);
}

export interface AdapterPorts {
  readonly wallet: PqWallet;
  readonly ring: RingClient;
  readonly pool: PrivatePoolContract & { readonly depositMany: DepositMany };
  /**
   * getRelaySnapshot() MUST return relay keys from the VERIFIED, PINNED
   * directory — createMeshBootstrap(...).snapshot() — and never from a network
   * Graph client. meshPath() below encrypts every onion layer to the keys this
   * returns, so a snapshot fetched from the Graph would let whoever answers
   * that request choose the keys every payment is sealed to. Health may come
   * from the Graph (see backend/mesh/graph-health.ts); keys may not.
   */
  readonly graph: GraphSelectionClient;
  readonly transport: PrivacyTransport;
  readonly executor: PrivacyTimedExecutor;
  readonly pathPolicy: PathSelectionPolicy;
  /** Seals the complete spend and the policy credential to the CRE key. */
  readonly sealIntent: (input: {
    readonly scope: PoolScope;
    readonly spendHash: ReturnType<typeof spendHash>;
    readonly spend: unknown;
    readonly request: PaymentRequest;
  }) => Promise<EncryptedIntent>;
  /**
   * Which pool a note belongs to. Not part of the frozen §2 contract — the
   * ring module owns notes and NoteSummary already carries its scope, so this
   * is a local lookup the adapter owner supplies rather than a new export
   * consumers would have to absorb.
   */
  readonly resolveNoteScope: (noteId: PaymentRequest['noteId']) => Promise<PoolScope>;
}

/**
 * Every sensitive read goes through the mesh. A path is drawn per request, so
 * two reads by one wallet do not share a route and cannot be joined by a relay
 * that happens to sit on both.
 */
async function meshPath(ports: AdapterPorts): Promise<RelayPath> {
  const snapshot = await ports.graph.getRelaySnapshot();
  const { nodes } = ports.pathPolicy.selectPath(snapshot);
  assertRelayPath(nodes);
  return nodes;
}

export function createPaymentApplication(ports: AdapterPorts): PaymentApplication & {
  /** `count` notes in each pool, all deposited in one transaction. */
  depositNotes(parts: readonly { readonly scope: PoolScope; readonly count: number }[]): Promise<readonly NoteSummary[]>;
} {
  const query = async <K extends MeshQuery['kind']>(
    request: Extract<MeshQuery, { kind: K }>,
  ): Promise<Extract<MeshQueryResult, { kind: K }>> =>
    decodeQueryResult(request, await ports.transport.query(request, await meshPath(ports)));

  const app = {
    async capabilities(scope: PoolScope): Promise<ProtocolCapabilities> {
      // Read from the pool, never assumed (T12). A SINGLE_NOTE_PQ deployment
      // must never be rendered with eight-member anonymity copy, and an
      // ATTESTED_OFFCHAIN one must be presented as trust in a named attester
      // rather than as a number — the chain cannot check its anonymity set at
      // all. docs/settlement-paths.md has the comparison.
      return ports.pool.capabilities(scope.pool);
    },

    createWallet: (): Promise<PqWalletState> => ports.wallet.create(),
    registerWallet: (): Promise<TxHash> => ports.wallet.register(),
    walletState: (): Promise<PqWalletState> => ports.wallet.getState(),
    rotateWallet: (): Promise<TxHash> => ports.wallet.rotate(),
    disableWallet: (): Promise<TxHash> => ports.wallet.disable(),

    async deposit(scope: PoolScope): Promise<NoteSummary> {
      return (await app.depositNotes([{ scope, count: 1 }]))[0]!;
    },

    async depositNotes(parts: readonly { readonly scope: PoolScope; readonly count: number }[]): Promise<readonly NoteSummary[]> {
      const count = parts.reduce((n, p) => n + p.count, 0);
      if (parts.some((p) => !Number.isInteger(p.count) || p.count < 1) || count < 1 || count > MAX_NOTES_PER_DEPOSIT) {
        throw new ProtocolFailure('INVALID_INPUT', `deposit 1 to ${MAX_NOTES_PER_DEPOSIT} notes at a time`);
      }
      // Every note and its commitment are persisted BEFORE the deposit is
      // submitted. A crash between the two leaves a recoverable local record,
      // where the reverse order would lose the secret for funded money.
      const notes: NoteSummary[] = [];
      const groups: { scope: PoolScope; commitments: NoteSummary['commitment'][] }[] = [];
      for (const { scope, count: n } of parts) {
        const group = { scope, commitments: [] as NoteSummary['commitment'][] };
        for (let i = 0; i < n; i++) {
          const note = await ports.ring.createNote(scope);
          notes.push(note);
          group.commitments.push(note.commitment);
        }
        groups.push(group);
      }
      const hash = await ports.pool.depositMany(groups);
      // Recorded as pending first: a tx hash is a claim, not evidence.
      for (const note of notes) await ports.ring.recordDeposit(note.id, hash);
      // Then reconciled against the chain. Without this a deposit stopped at
      // DEPOSIT_PENDING forever — and reserve() requires AVAILABLE, so a note
      // the user had paid for could never be spent. The pool port returns once
      // the deposit is mined — but Arc's public RPC is load-balanced, and the
      // node that answers the next read can be a block behind the one that
      // returned the receipt. So the evidence is looked for a few times before
      // a note is left pending (listNotes keeps looking after that).
      const summaries: NoteSummary[] = [];
      for (const note of notes) summaries.push(await ports.ring.reconcileNote(note.id));
      for (let attempt = 0; attempt < 10 && summaries.some((n) => n.state === 'DEPOSIT_PENDING'); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        for (const [i, n] of summaries.entries()) if (n.state === 'DEPOSIT_PENDING') summaries[i] = await ports.ring.reconcileNote(n.id);
      }
      return summaries;
    },

    async listNotes(scope: PoolScope): Promise<readonly NoteSummary[]> {
      // A note not yet known funded is re-checked against the chain every time
      // the wallet looks: one missed read must not leave paid-for money
      // unspendable. CREATED too: a deposit that landed without being recorded
      // (a wallet popup rejected halfway through a multi-note deposit, an
      // operation whose receipt never arrived) is still found and funded here.
      const notes = await ports.ring.listNotes(scope);
      const pending = notes.filter((n) => n.state === 'DEPOSIT_PENDING' || n.state === 'CREATED');
      if (pending.length === 0) return notes;
      await Promise.all(pending.map((n) => ports.ring.reconcileNote(n.id).catch(() => undefined)));
      return ports.ring.listNotes(scope);
    },

    /**
     * The one path a payment takes. Immediate mode is not a second path: the
     * page sets `deadline = now` and this same sequence runs, so there is no
     * bypass to keep in sync or to forget to gate.
     */
    async submitPayment(request: PaymentRequest): Promise<IntentRef> {
      const scope = await ports.resolveNoteScope(request.noteId);
      return createPaymentFlow(ports, request, scope, request.recipient);
    },

    async getStatus(handle: StatusHandle): Promise<IntentStatus> {
      // Status is fetched through the mesh, not by a direct call to CRE. A
      // per-intent connection to the executor would associate this browser
      // with this payment at exactly the moment it is being watched.
      return (await query({ kind: 'INTENT_STATUS', handle })).value;
    },
  };
  return app;
}

/**
 * The payment sequence, kept separate from the facade until the ring and
 * wallet modules land so that the shape is reviewable now and the wiring is a
 * substitution later. Order is load-bearing:
 *
 *   snapshot → local ring selection → local verify → seal → executor
 *
 * Selection runs LOCALLY (T6). The real note never appears in a query
 * parameter, and no remote selector is ever asked to exclude or locate it.
 */
export async function createPaymentFlow(
  ports: AdapterPorts,
  request: PaymentRequest,
  scope: PoolScope,
  recipient: Address = request.recipient,
): Promise<IntentRef> {
  const path = await meshPath(ports);
  const snapshot = decodeQueryResult(
    { kind: 'RING_SNAPSHOT', scope },
    await ports.transport.query({ kind: 'RING_SNAPSHOT', scope }, path),
  ).value;

  const spend = asPrivateSpend(
    await ports.ring.buildSpend({
      noteId: request.noteId,
      recipient,
      reservation: request.idempotencyKey,
      candidates: snapshot,
    }),
  );

  // Verify before sealing. A spend that cannot satisfy its own verifier must
  // fail here, where the note reservation can still be released cleanly.
  if (!(await ports.ring.verifyLocally(spend))) {
    throw new ProtocolFailure('PROOF_REJECTED', 'the locally built spend does not verify');
  }

  const sealed = await ports.sealIntent({
    scope,
    spendHash: spendHash(spend),
    spend,
    request,
  });
  return ports.executor.submit(sealed);
}

/**
 * Whether the swap about to be signed is the one the user was shown: its
 * least within `previewBps` of the preview's least, and no more than
 * `slippageBps` under its own estimate (the exit sets the slippage, so a
 * floor near nothing is refused). Otherwise the user sees the new quote first.
 */
export function swapHoldsPreview(preview: { readonly toAmountMin: string }, signed: { readonly toAmount: string; readonly toAmountMin: string }, previewBps = 50n, slippageBps = 200n): boolean {
  const least = BigInt(signed.toAmountMin);
  return least * 10_000n >= BigInt(preview.toAmountMin) * (10_000n - previewBps)
    && least * 10_000n >= BigInt(signed.toAmount) * (10_000n - slippageBps);
}

/**
 * Smallest units as a decimal, grouped with commas whatever the browser's
 * language: the result goes into amount fields, which read `.` as the
 * decimal point and drop `,`. Grouped by the locale, German's 1.234 (one
 * thousand two hundred thirty-four) would swap 1.234.
 */
export function fromUnits(units: bigint, decimals: number, places = 6): string {
  const digits = units.toString().padStart(decimals + 1, '0');
  const fraction = digits.slice(digits.length - decimals).slice(0, places).replace(/0+$/, '');
  return `${BigInt(digits.slice(0, digits.length - decimals)).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
}
