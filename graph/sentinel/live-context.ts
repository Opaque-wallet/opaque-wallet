import { deriveCompanionContext, type CompanionContext } from '../src/companion-context.ts';
import { readinessScores } from '../src/privacy-score.ts';

type Meta = { readonly hasIndexingErrors: boolean; readonly block: { readonly timestamp: number | string } };
type OpaquePool = { readonly poolSize: number | string; readonly observedAt: number | string };
type OpaqueRelay = {
  readonly operatorId?: string | null;
  readonly reliabilityScore?: number | string | null;
  readonly batchOccupancy?: number | string | null;
};

export interface PublicOpaqueGraphData {
  readonly meta: Meta;
  readonly ringPools: readonly OpaquePool[];
  readonly relayNodes: readonly OpaqueRelay[];
}

export interface PublicSettlementGraphData {
  readonly meta: Meta;
  readonly transfers: readonly { readonly id: string }[];
}

export interface LiveContextInput {
  readonly now: number;
  readonly maxAgeSeconds: number;
  readonly opaque: PublicOpaqueGraphData;
  readonly settlement: PublicSettlementGraphData | null;
}

function integer(value: number | string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a safe non-negative integer`);
  return parsed;
}

/**
 * Turns Graph Client's two public source responses into a display-only
 * companion context. This accepts no wallet or payment fields by design.
 */
export function buildCompanionContextFromGraph(input: LiveContextInput): CompanionContext {
  if (input.opaque.meta.hasIndexingErrors) throw new Error('Opaque subgraph reports indexing errors');

  const poolSize = Math.max(0, ...input.opaque.ringPools.map((pool) => integer(pool.poolSize, 'poolSize')));
  const completeRelays = input.opaque.relayNodes.flatMap((relay) => {
    if (relay.operatorId == null || relay.reliabilityScore == null || relay.batchOccupancy == null) return [];
    return [{
      operatorId: relay.operatorId,
      reliabilityScore: integer(relay.reliabilityScore, 'reliabilityScore'),
      batchOccupancy: integer(relay.batchOccupancy, 'batchOccupancy'),
    }];
  });
  const scores = readinessScores(poolSize, completeRelays);
  const opaqueObservedAt = integer(input.opaque.meta.block.timestamp, 'opaque block timestamp');

  const settlement = input.settlement === null || input.settlement.meta.hasIndexingErrors
    ? null
    : {
      observedAt: BigInt(integer(input.settlement.meta.block.timestamp, 'settlement block timestamp')),
      source: 'Graph Network: Arbitrum USDC',
      recentTransfers: input.settlement.transfers.length,
    };

  return deriveCompanionContext({
    now: BigInt(input.now),
    maxAgeSeconds: BigInt(input.maxAgeSeconds),
    opaque: {
      observedAt: BigInt(opaqueObservedAt),
      privacyScore: scores.privacyScore,
      ringFreshness: scores.ringFreshness,
      meshHealth: scores.meshHealth,
    },
    settlement,
  });
}

/**
 * Loads generated Graph Client artifacts at runtime. Run `bun run
 * companion:build` first. The composed source is read-only and failures in the
 * external sidecar intentionally leave it UNKNOWN rather than changing Opaque.
 */
export async function loadLiveCompanionContext(
  now = Math.floor(Date.now() / 1000),
  maxAgeSeconds = 300,
): Promise<CompanionContext> {
  const client = await import('../companion/.graphclient/index.ts');
  const sdk = client.getBuiltGraphSDK();
  const opaque = await sdk.OpaquePublicContext();

  let settlement: PublicSettlementGraphData | null = null;
  try {
    const result = await sdk.SettlementPublicContext();
    settlement = {
      meta: result.settlement._meta!,
      transfers: result.settlement.transfers,
    };
  } catch {
    // Sidecar absence remains visible in the companion result but is not a
    // reason to make any operational Opaque path unavailable.
  }

  return buildCompanionContextFromGraph({
    now,
    maxAgeSeconds,
    opaque: {
      meta: opaque.opaque._meta!,
      ringPools: opaque.opaque.ringPools,
      relayNodes: opaque.opaque.relayNodes,
    },
    settlement,
  });
}
