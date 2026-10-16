import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCompanionContextFromGraph } from '../sentinel/live-context.ts';

const opaque = {
  meta: { hasIndexingErrors: false, block: { timestamp: 10_000 } },
  ringPools: [{ id: 'pool-10', poolSize: 8, observedAt: 9_900 }],
  relayNodes: [
    { id: 'r1', operatorId: 'a', reliabilityScore: 9_300, batchOccupancy: 4, recentSelectionCount: 1, lastSeenAt: 9_900 },
    { id: 'r2', operatorId: 'b', reliabilityScore: 9_200, batchOccupancy: 4, recentSelectionCount: 1, lastSeenAt: 9_900 },
    { id: 'r3', operatorId: 'c', reliabilityScore: 9_100, batchOccupancy: 4, recentSelectionCount: 1, lastSeenAt: 9_900 },
    { id: 'r4', operatorId: 'd', reliabilityScore: 9_400, batchOccupancy: 4, recentSelectionCount: 1, lastSeenAt: 9_900 },
    { id: 'r5', operatorId: 'e', reliabilityScore: 9_500, batchOccupancy: 4, recentSelectionCount: 1, lastSeenAt: 9_900 },
    { id: 'r6', operatorId: 'f', reliabilityScore: 9_600, batchOccupancy: 4, recentSelectionCount: 1, lastSeenAt: 9_900 },
  ],
};

test('derives a public readiness report from Graph Client data without a payment input', () => {
  const context = buildCompanionContextFromGraph({
    now: 10_050,
    maxAgeSeconds: 300,
    opaque,
    settlement: { meta: { hasIndexingErrors: false, block: { timestamp: 10_020 } }, transfers: [{ id: 'x' }, { id: 'y' }] },
  });
  assert.equal(context.status, 'CURRENT');
  assert.equal(context.privacy.status, 'STRONG');
  assert.equal(context.settlement.recentTransfers, 2);
});

test('keeps payment controls impossible when the external Graph source is unavailable', () => {
  const context = buildCompanionContextFromGraph({ now: 10_050, maxAgeSeconds: 300, opaque, settlement: null });
  assert.equal(context.status, 'UNKNOWN');
  assert.equal(context.privacy.status, 'STRONG');
  assert.match(context.privacyBoundary, /No real note/);
});
