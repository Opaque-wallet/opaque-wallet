import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import type { SentinelContextProvider } from './server.ts';
import { createSentinelServer } from './server.ts';

const MAX_BODY_BYTES = 256 * 1024;

export interface SentinelHttpOptions {
  readonly contextProvider: SentinelContextProvider;
  readonly graphNetworkConfigured?: () => boolean;
}

type BunServer = { stop(closeActiveConnections?: boolean): void };
type BunRuntime = { serve(options: { port: number; hostname?: string; fetch(request: Request): Response | Promise<Response> }): BunServer };

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
  });
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function boundedRequest(request: Request): Promise<Request | Response> {
  if (request.method !== 'POST') return request;
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json(413, { error: 'payload_too_large' });
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) return json(413, { error: 'payload_too_large' });
  return new Request(request.url, { method: request.method, headers: request.headers, body: bytes });
}

/**
 * Stateless public MCP handler. A new MCP server is created per request so no
 * client session, user input, or payment state is retained by this service.
 */
export function createSentinelHttpHandler(options: SentinelHttpOptions): (request: Request) => Promise<Response> {
  const graphNetworkConfigured = options.graphNetworkConfigured ?? (() => Boolean(process.env.GRAPH_GATEWAY_API_KEY));
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') {
      return json(200, {
        service: 'opaque-privacy-sentinel',
        status: 'ok',
        opaqueStudio: 'public',
        graphNetwork: graphNetworkConfigured() ? 'configured' : 'not-configured',
        mcp: '/mcp',
      });
    }
    if (url.pathname !== '/mcp') return json(404, { error: 'not_found' });
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) return json(405, { error: 'method_not_allowed' });

    const safeRequest = await boundedRequest(request);
    if (safeRequest instanceof Response) return safeRequest;

    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = createSentinelServer(options.contextProvider);
    try {
      await server.connect(transport);
      return noStore(await transport.handleRequest(safeRequest));
    } catch {
      return json(502, { error: 'sentinel_unavailable' });
    } finally {
      await server.close();
      await transport.close();
    }
  };
}

export function listenSentinelHttp(options: SentinelHttpOptions): BunServer {
  const runtime = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
  if (runtime === undefined) throw new Error('Opaque Privacy Sentinel HTTP service requires Bun');
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a valid TCP port');
  return runtime.serve({ port, hostname: '0.0.0.0', fetch: createSentinelHttpHandler(options) });
}
