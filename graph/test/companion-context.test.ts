import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveCompanionContext, formatCompanionReport } from '../src/companion-context.ts';

test('reports current context when both public Graph sources are fresh', () => {
  const context = deriveCompanionContext({
    now: 10_000n,
    maxAgeSeconds: 300n,
    opaque: { observedAt: 9_800n, privacyScore: 8_200, ringFreshness: 9_000, meshHealth: 8_200 },
    settlement: { observedAt: 9_850n, source: 'Arbitrum USDC', recentTransfers: 42 },
  });

  assert.deepEqual(context, {
    status: 'CURRENT',
    privacy: { status: 'STRONG', score: 8_200, ringFreshness: 9_000, meshHealth: 8_200 },
    settlement: { status: 'CURRENT', source: 'Arbitrum USDC', recentTransfers: 42 },
    privacyBoundary: 'No real note, recipient, selected decoys, or final relay route was queried.',
  });
});

test('marks only the sidecar context unknown when its external Graph source is unavailable', () => {
  const context = deriveCompanionContext({
    now: 10_000n,
    maxAgeSeconds: 300n,
    opaque: { observedAt: 9_800n, privacyScore: 8_200, ringFreshness: 9_000, meshHealth: 8_200 },
    settlement: null,
  });

  assert.equal(context.status, 'UNKNOWN');
  assert.equal(context.privacy.status, 'STRONG');
  assert.equal(context.settlement.status, 'UNKNOWN');
});

test('marks a stale external source degraded without changing the privacy assessment', () => {
  const context = deriveCompanionContext({
    now: 10_000n,
    maxAgeSeconds: 300n,
    opaque: { observedAt: 9_800n, privacyScore: 8_200, ringFreshness: 9_000, meshHealth: 8_200 },
    settlement: { observedAt: 9_600n, source: 'Arbitrum USDC', recentTransfers: 0 },
  });

  assert.equal(context.status, 'DEGRADED');
  assert.equal(context.privacy.status, 'STRONG');
  assert.equal(context.settlement.status, 'STALE');
});

test('formats a report that makes its read-only privacy boundary explicit', () => {
  const report = formatCompanionReport(deriveCompanionContext({
    now: 10_000n,
    maxAgeSeconds: 300n,
    opaque: { observedAt: 9_800n, privacyScore: 8_200, ringFreshness: 9_000, meshHealth: 8_200 },
    settlement: { observedAt: 9_850n, source: 'Arbitrum USDC', recentTransfers: 42 },
  }));

  assert.match(report, /PRIVACY CONTEXT — READ ONLY/);
  assert.match(report, /Opaque privacy: STRONG/);
  assert.match(report, /Settlement context: CURRENT — Arbitrum USDC/);
  assert.match(report, /No real note, recipient, selected decoys, or final relay route was queried\./);
});
