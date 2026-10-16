/**
 * Read-only composition for the Graph-prize companion. This module is never
 * imported by wallet, relay, CRE, or settlement code.
 */

export const COMPANION_STRONG_PRIVACY_SCORE = 8_000;

export interface CompanionInput {
  readonly now: bigint;
  readonly maxAgeSeconds: bigint;
  readonly opaque: {
    readonly observedAt: bigint;
    readonly privacyScore: number;
    readonly ringFreshness: number;
    readonly meshHealth: number;
  };
  readonly settlement: {
    readonly observedAt: bigint;
    readonly source: string;
    readonly recentTransfers: number;
  } | null;
}

type PrivacyStatus = 'STRONG' | 'WEAK' | 'STALE';
type SettlementStatus = 'CURRENT' | 'STALE' | 'UNKNOWN';

export interface CompanionContext {
  readonly status: 'CURRENT' | 'DEGRADED' | 'UNKNOWN';
  readonly privacy: {
    readonly status: PrivacyStatus;
    readonly score: number;
    readonly ringFreshness: number;
    readonly meshHealth: number;
  };
  readonly settlement: {
    readonly status: SettlementStatus;
    readonly source?: string;
    readonly recentTransfers?: number;
  };
  readonly privacyBoundary: 'No real note, recipient, selected decoys, or final relay route was queried.';
}

function fresh(observedAt: bigint, now: bigint, maxAgeSeconds: bigint): boolean {
  return observedAt <= now && now - observedAt <= maxAgeSeconds;
}

export function deriveCompanionContext(input: CompanionInput): CompanionContext {
  const privacyFresh = fresh(input.opaque.observedAt, input.now, input.maxAgeSeconds);
  const privacyStatus: PrivacyStatus = !privacyFresh
    ? 'STALE'
    : input.opaque.privacyScore >= COMPANION_STRONG_PRIVACY_SCORE ? 'STRONG' : 'WEAK';
  const settlement = input.settlement === null
    ? { status: 'UNKNOWN' as const }
    : fresh(input.settlement.observedAt, input.now, input.maxAgeSeconds)
      ? { status: 'CURRENT' as const, source: input.settlement.source, recentTransfers: input.settlement.recentTransfers }
      : { status: 'STALE' as const, source: input.settlement.source, recentTransfers: input.settlement.recentTransfers };
  const status = settlement.status === 'UNKNOWN'
    ? 'UNKNOWN'
    : privacyStatus === 'STRONG' && settlement.status === 'CURRENT' ? 'CURRENT' : 'DEGRADED';

  return {
    status,
    privacy: {
      status: privacyStatus,
      score: input.opaque.privacyScore,
      ringFreshness: input.opaque.ringFreshness,
      meshHealth: input.opaque.meshHealth,
    },
    settlement,
    privacyBoundary: 'No real note, recipient, selected decoys, or final relay route was queried.',
  };
}

/** Human-readable output for the judge-facing companion only. */
export function formatCompanionReport(context: CompanionContext): string {
  const settlementSource = context.settlement.source === undefined ? '' : ` — ${context.settlement.source}`;
  const transferCount = context.settlement.recentTransfers === undefined ? '' : `\nRecent observed transfers: ${context.settlement.recentTransfers}`;
  return [
    'PRIVACY CONTEXT — READ ONLY',
    `Overall context: ${context.status}`,
    `Opaque privacy: ${context.privacy.status}`,
    `  score: ${context.privacy.score} · ring: ${context.privacy.ringFreshness} · mesh: ${context.privacy.meshHealth}`,
    `Settlement context: ${context.settlement.status}${settlementSource}${transferCount}`,
    `Privacy boundary: ${context.privacyBoundary}`,
  ].join('\n');
}
