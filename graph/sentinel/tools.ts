import type { CompanionContext } from '../src/companion-context.ts';

export const SENTINEL_TOOL_NAMES = [
  'get_privacy_context',
  'explain_privacy_readiness',
  'list_public_privacy_signals',
] as const;

export type SentinelToolName = typeof SENTINEL_TOOL_NAMES[number];

function requireEmptyArguments(args: Record<string, unknown>) {
  if (Object.keys(args).length !== 0) throw new Error('Sentinel does not accept arguments');
}

function explanation(context: CompanionContext): string {
  const suffix = ` ${context.privacyBoundary}`;
  if (context.privacy.status === 'STALE') return `The Opaque privacy snapshot is stale, so this companion cannot describe current conditions.${suffix}`;
  if (context.privacy.status === 'WEAK') return `The public privacy score is below the display threshold; ring or mesh conditions need more strength.${suffix}`;
  if (context.settlement.status !== 'CURRENT') return `Public privacy conditions are strong, but the independent settlement context is ${context.settlement.status.toLowerCase()}.${suffix}`;
  return `Public ring and mesh conditions are strong in the latest indexed context.${suffix}`;
}

export function invokeSentinelTool(
  name: string,
  args: Record<string, unknown>,
  context: CompanionContext,
): Record<string, unknown> {
  if (!(SENTINEL_TOOL_NAMES as readonly string[]).includes(name)) throw new Error(`unknown Sentinel tool: ${name}`);
  requireEmptyArguments(args);

  switch (name as SentinelToolName) {
    case 'get_privacy_context':
      return {
        contextStatus: context.status,
        privacyStatus: context.privacy.status,
        privacyScore: context.privacy.score,
        ringFreshness: context.privacy.ringFreshness,
        meshHealth: context.privacy.meshHealth,
        settlementStatus: context.settlement.status,
        privacyBoundary: context.privacyBoundary,
      };
    case 'explain_privacy_readiness':
      return { explanation: explanation(context), privacyBoundary: context.privacyBoundary };
    case 'list_public_privacy_signals':
      return {
        signals: ['ring cohort population', 'ring reuse pressure', 'ring concentration', 'relay reliability', 'relay occupancy', 'relay operator diversity'],
        privacyBoundary: context.privacyBoundary,
      };
  }
}
