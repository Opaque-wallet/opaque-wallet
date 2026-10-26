// The exit's ring: MEMBERSHIP from the pool's own Deposited events, and the
// §8.1 weights — use counts, funding buckets — from the subgraph.
//
// Membership never comes from the Graph. A ring has to be real deposits (a
// decoy the pool has never seen makes spend() revert with UnknownCommitment),
// and an index that could add members could hand a wallet seven decoys it
// owns, or leave honest ones out. So the Graph only annotates members the
// chain already named; one it names that the chain does not is dropped.
//
// Without a (fresh) Graph the annotations are unknown, never zero:
// timesUsedInRing 0, fundingCluster and hasOtherActivity null.
//
// Arc serves getLogs windows of 20,000 blocks and refuses 50,000, so the scan
// pages in 10,000-block windows and only ever re-reads what is new.
//
// A pool's history can be millions of blocks (testnet: 5.7M, ~570 windows),
// more than one wallet request can wait for or a public RPC serves in a
// burst. So seed() asks the subgraph only WHERE deposits are and reads those
// windows from the chain, which answers in seconds; backfill() then reads the
// whole history in the background, so a deposit the index left out is
// still found. Until it finishes, a request is served the seeded ring and
// never waits on the history.

import type { PublicClient } from 'viem';
import { parseAbiItem } from 'viem';

import {
  ProtocolFailure,
  type GraphSelectionClient,
  type NoteCommitment,
  type PoolScope,
  type RelaySnapshot,
  type RingCandidate,
  type RingSnapshot,
  type UnixSeconds,
} from '@opaque/protocol-types';

import { evaluatePublicReadiness } from '../../graph/src/privacy-score.ts';

const DEPOSITED = parseAbiItem('event Deposited(bytes32 indexed commitment, uint256 index)');
const WINDOW = 10_000n;

export interface ChainRingSourceOptions {
  readonly publicClient: PublicClient;
  readonly scope: PoolScope;
  readonly deployedAtBlock: bigint;
  /** Relay health for privacy conditions. Keys never come from here. */
  readonly relaySnapshot: () => RelaySnapshot | Promise<RelaySnapshot>;
  /** The subgraph's view of the same pool. Weights only; see the header. */
  readonly indexed?: (scope: PoolScope) => Promise<RingSnapshot>;
  readonly now?: () => UnixSeconds;
  /** First backoff after a refused log read; doubles per retry. */
  readonly retryMs?: number;
}

export interface ChainRingSource extends GraphSelectionClient {
  /** Reads the windows the subgraph names deposits in. Throws if the index or chain refuses. */
  seed(): Promise<void>;
  /** Reads the whole history, retrying refusals, until caught up to the head. */
  backfill(retryMs?: number): Promise<void>;
}

export function createChainRingSource(options: ChainRingSourceOptions): ChainRingSource {
  const { publicClient, scope } = options;
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds);
  const candidates: RingCandidate[] = [];
  const known = new Set<string>();
  let scannedThrough = options.deployedAtBlock - 1n;
  // What the served ring is complete through, and when it was read. A seeded
  // ring is dated by its seed until the history is read.
  let servedThrough: bigint | undefined;
  let servedAt: UnixSeconds | undefined;
  let caughtUp = false;
  let scanning: Promise<bigint> | undefined;
  let seeding: Promise<void> | undefined;
  let tailing: Promise<bigint> | undefined;

  const sameScope = (s: PoolScope): boolean =>
    s.pool.toLowerCase() === scope.pool.toLowerCase() && BigInt(s.chainId) === BigInt(scope.chainId)
    && s.denomination === scope.denomination;

  async function read(fromBlock: bigint, toBlock: bigint): Promise<void> {
    // Arc's public RPCs refuse bursts, harder from a shared cloud IP: a refused
    // window is retried after 0.5, 1 and 2 s before the scan gives up.
    let logs;
    for (let attempt = 0; ; attempt++) {
      try {
        logs = await publicClient.getLogs({ address: scope.pool, event: DEPOSITED, fromBlock, toBlock });
        break;
      } catch (error) {
        if (attempt === 3) throw error;
        await new Promise((r) => setTimeout(r, (options.retryMs ?? 500) * 2 ** attempt));
      }
    }
    for (const log of logs) {
      const commitment = log.args.commitment!.toLowerCase() as NoteCommitment;
      if (known.has(commitment)) continue;
      known.add(commitment);
      candidates.push({ commitment, enrolledAtBlock: log.blockNumber!, timesUsedInRing: 0, fundingCluster: null, hasOtherActivity: null });
    }
  }

  async function refresh(): Promise<bigint> {
    const head = await publicClient.getBlockNumber();
    for (let from = scannedThrough + 1n; from <= head; from += WINDOW) {
      const to = from + WINDOW - 1n > head ? head : from + WINDOW - 1n;
      await read(from, to);
      scannedThrough = to;
    }
    return head;
  }

  // One scan at a time: two at once read the same blocks and added their
  // deposits twice. And a scan the RPC refuses (Arc rate-limits a burst of
  // reads) leaves the last good one standing, dated when it ran: membership
  // only grows, so it is still a true ring, missing at most the newest
  // deposits. A wallet waited out its whole poll for a refused one.
  const scan = (): Promise<bigint> => (scanning ??= refresh().then(
    (head) => { [servedThrough, servedAt, caughtUp] = [head, now(), true]; return head; },
    (error: unknown) => { if (servedAt === undefined) throw error; return servedThrough!; },
  ).finally(() => { scanning = undefined; }));

  async function seed(): Promise<void> {
    const indexed = await options.indexed?.(scope);
    if (indexed === undefined || caughtUp) return;
    // Windows starting at each indexed deposit, merged. The index picks
    // where to look; what is there is the chain's, so a member it invents
    // is never added.
    // No window past the head: the RPC refuses one, and a deposit in the
    // last WINDOW blocks would fail every seed of its pool.
    const head = await publicClient.getBlockNumber();
    const through = BigInt(indexed.indexedThroughBlock) < head ? BigInt(indexed.indexedThroughBlock) : head;
    const blocks = [...new Set(indexed.candidates.map((c) => BigInt(c.enrolledAtBlock)))]
      .filter((b) => b >= options.deployedAtBlock && b <= through).sort((a, b) => (a < b ? -1 : 1));
    for (let i = 0; i < blocks.length;) {
      const from = blocks[i]!;
      while (i < blocks.length && blocks[i]! < from + WINDOW) i++;
      await read(from, from + WINDOW - 1n > through ? through : from + WINDOW - 1n);
    }
    if (!caughtUp) [servedThrough, servedAt] = [through, now()];
  }

  // Seeded, not caught up: the blocks since, read on request, so a deposit
  // made after boot is in the ring before backfill() reaches it (hours on a
  // long chain; a wallet that can't see its deposit draws its number again).
  // One at a time; a refused read serves what was read.
  const tail = (): Promise<bigint> => (tailing ??= (async () => {
    const head = await publicClient.getBlockNumber();
    for (let from = servedThrough! + 1n; from <= head && !caughtUp; from += WINDOW) {
      const to = from + WINDOW - 1n > head ? head : from + WINDOW - 1n;
      await read(from, to);
      if (!caughtUp) [servedThrough, servedAt] = [to, now()];
    }
    return servedThrough!;
  })().catch(() => servedThrough!).finally(() => { tailing = undefined; }));

  async function backfill(retryMs = 5_000): Promise<void> {
    while (!caughtUp) {
      await scan().catch(() => undefined);
      if (!caughtUp) await new Promise((r) => setTimeout(r, retryMs));
    }
  }

  async function getRingSnapshot(requested: PoolScope): Promise<RingSnapshot> {
    // One pool per source. Answering for another would hand a wallet decoys
    // from the wrong pool — deposits this pool has never seen.
    if (!sameScope(requested)) {
      throw new ProtocolFailure('INVALID_INPUT', 'this ring source serves a different pool');
    }
    // A seed the RPC refused at boot is tried again here, once for all asking:
    // its windows answer in seconds, the whole history (backfill's, queued
    // behind the other pools) in hours, and a wallet can't wait that long.
    if (servedAt === undefined) await (seeding ??= seed().catch(() => undefined).finally(() => { seeding = undefined; }));
    const [head, indexed] = await Promise.all([
      // Seeded but not caught up: the seed and what came since; the history is backfill()'s.
      servedAt !== undefined && !caughtUp ? tail() : scan(),
      // Down or stale is not fatal: the ring is still the chain's.
      options.indexed?.(requested).catch(() => undefined),
    ]);
    const weights = new Map(indexed?.candidates.map((c) => [c.commitment.toLowerCase(), c]));
    return {
      scope,
      candidates: [...candidates].sort((a, b) => (a.enrolledAtBlock < b.enrolledAtBlock ? -1 : a.enrolledAtBlock > b.enrolledAtBlock ? 1 : 0)).map((c) => {
        const w = weights.get(c.commitment);
        return w === undefined ? c : { ...c, timesUsedInRing: w.timesUsedInRing, fundingCluster: w.fundingCluster, hasOtherActivity: w.hasOtherActivity };
      }),
      indexedThroughBlock: head,
      observedAt: servedAt!,
      policyVersion: indexed === undefined ? 'chain-deposited-v1' : 'chain-deposited+graph-v1',
    };
  }

  return {
    seed,
    backfill,
    getRingSnapshot,
    getRelaySnapshot: async () => options.relaySnapshot(),
    async getPrivacyConditions(requested) {
      return evaluatePublicReadiness(await getRingSnapshot(requested), await options.relaySnapshot());
    },
  };
}
