import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { CompanionContext } from '../src/companion-context.ts';
import { SENTINEL_TOOL_NAMES, invokeSentinelTool } from './tools.ts';

export type SentinelContextProvider = () => Promise<CompanionContext> | CompanionContext;

function toolResponse(value: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * Public-only MCP surface. The caller owns the context provider; this server
 * has no imports from wallet, mesh, CRE, contracts, or settlement code.
 */
export function createSentinelServer(contextProvider: SentinelContextProvider): McpServer {
  const server = new McpServer({ name: 'opaque-privacy-sentinel', version: '0.1.0' });
  for (const name of SENTINEL_TOOL_NAMES) {
    server.registerTool(name, {
      description: name === 'get_privacy_context'
        ? 'Return the latest public Opaque privacy context.'
        : name === 'explain_privacy_readiness'
          ? 'Explain the current public privacy readiness without inferring a payment.'
          : 'List the public aggregate signals visible to the Sentinel.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async () => toolResponse(invokeSentinelTool(name, {}, await contextProvider())));
  }
  return server;
}

/** Connect an explicitly supplied public-only context provider over stdio. */
export async function serveSentinel(contextProvider: SentinelContextProvider): Promise<void> {
  await createSentinelServer(contextProvider).connect(new StdioServerTransport());
}

