import assert from 'node:assert/strict';
import test from 'node:test';

import { invokeSentinelTool } from '../sentinel/tools.ts';

const context = {
  status: 'CURRENT' as const,
  privacy: { status: 'STRONG' as const, score: 8_200, ringFreshness: 9_000, meshHealth: 8_200 },
  settlement: { status: 'CURRENT' as const, source: 'Arbitrum USDC', recentTransfers: 42 },
  privacyBoundary: 'No real note, recipient, selected decoys, or final relay route was queried.' as const,
};

test('get_privacy_context returns public conditions and the privacy boundary only', () => {
  const result = invokeSentinelTool('get_privacy_context', {}, context);

  assert.equal(result.privacyScore, 8_200);
  assert.equal(result.settlementStatus, 'CURRENT');
  assert.equal(result.privacyBoundary, context.privacyBoundary);
  assert.equal(Object.hasOwn(result, 'recipient'), false);
  assert.equal(Object.hasOwn(result, 'decoys'), false);
});

test('explain_privacy_readiness explains a weak public condition without inferring a payment', () => {
  const result = invokeSentinelTool('explain_privacy_readiness', {}, {
    ...context,
    status: 'DEGRADED',
    privacy: { ...context.privacy, status: 'WEAK', score: 6_000 },
  });

  assert.match(String(result.explanation), /below the display threshold/);
  assert.match(String(result.explanation), /No real note/);
});

test('rejects unknown tools and arguments instead of accepting hidden payment data', () => {
  assert.throws(() => invokeSentinelTool('release_payment', {}, context), /unknown Sentinel tool/);
  assert.throws(() => invokeSentinelTool('get_privacy_context', { recipient: '0xabc' }, context), /does not accept arguments/);
});
