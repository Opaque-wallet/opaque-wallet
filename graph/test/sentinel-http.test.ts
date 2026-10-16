import assert from 'node:assert/strict';
import test from 'node:test';

import { createSentinelHttpHandler } from '../sentinel/http.ts';

const context = {
  status: 'CURRENT' as const,
  privacy: { status: 'STRONG' as const, score: 8_200, ringFreshness: 9_000, meshHealth: 8_200 },
  settlement: { status: 'CURRENT' as const, source: 'Graph Network: Arbitrum USDC', recentTransfers: 2 },
  privacyBoundary: 'No real note, recipient, selected decoys, or final relay route was queried.' as const,
};

const handler = createSentinelHttpHandler({ contextProvider: () => context, graphNetworkConfigured: () => true });

test('healthz reveals only service and source configuration state', async () => {
  const response = await handler(new Request('https://sentinel.example/healthz'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    service: 'opaque-privacy-sentinel',
    status: 'ok',
    opaqueStudio: 'public',
    graphNetwork: 'configured',
    mcp: '/mcp',
  });
});

test('rejects non-MCP routes and oversized bodies', async () => {
  const missing = await handler(new Request('https://sentinel.example/not-a-route'));
  assert.equal(missing.status, 404);
  const large = await handler(new Request('https://sentinel.example/mcp', {
    method: 'POST', body: 'x'.repeat(256 * 1024 + 1), headers: { 'content-type': 'application/json' },
  }));
  assert.equal(large.status, 413);
});

test('serves an MCP initialize request over HTTP', async () => {
  const response = await handler(new Request('https://sentinel.example/mcp', {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await response.json() as { result?: { serverInfo?: { name?: string } } };
  assert.equal(payload.result?.serverInfo?.name, 'opaque-privacy-sentinel');
});
