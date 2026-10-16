import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createSentinelServer } from '../sentinel/server.ts';

const context = {
  status: 'CURRENT' as const,
  privacy: { status: 'STRONG' as const, score: 8_200, ringFreshness: 9_000, meshHealth: 8_200 },
  settlement: { status: 'CURRENT' as const, source: 'Arbitrum USDC', recentTransfers: 42 },
  privacyBoundary: 'No real note, recipient, selected decoys, or final relay route was queried.' as const,
};

test('the MCP server exposes only the three read-only Sentinel tools', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createSentinelServer(() => context);
  await server.connect(serverTransport);
  const client = new Client({ name: 'sentinel-test-client', version: '0.1.0' });
  await client.connect(clientTransport);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    'explain_privacy_readiness',
    'get_privacy_context',
    'list_public_privacy_signals',
  ]);
  assert.equal(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true), true);

  const result = await client.callTool({ name: 'get_privacy_context', arguments: {} });
  const content = (result as { content: Array<{ type: string; text: string }> }).content[0];
  assert.equal(content?.type, 'text');
  const payload = JSON.parse(content!.text) as Record<string, unknown>;
  assert.equal(payload.privacyScore, 8_200);
  assert.match(String(payload.privacyBoundary), /No real note/);
  await client.close();
  await server.close();
});
