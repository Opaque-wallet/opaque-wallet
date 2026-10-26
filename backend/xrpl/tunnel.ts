// The wallet's WalletConnect relay socket, tunnelled byte for byte to Reown's
// relay (stack.ts), so the page talks to Opaque's servers only and Reown sees
// this server, never the user.
//
// Each tunnel is a socket to Reown from this server's one address, and an
// upgraded socket escapes the HTTP server's timeouts: without a cap and an
// idle limit, one visitor could hold thousands open (F-66). A page holds one,
// and the relay pings it, so neither limit touches a page in use; a page whose
// tunnel was closed for idling reconnects on its own.

import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as connectTls } from 'node:tls';

export interface RelayTunnel {
  handle(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Tunnels open now. */
  readonly open: number;
}

/**
 * Who opened a tunnel, for the per-visitor cap: the last address in
 * X-Forwarded-For, the one the host's own proxy appended (a visitor can only
 * add addresses before it), else the socket's peer. Counted in memory, never logged.
 */
const sourceOf = (req: IncomingMessage): string =>
  String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1)?.trim() || req.socket.remoteAddress || '';

export function relayTunnel(options: {
  readonly host: string;
  /** Opens the upstream socket; TLS to `host`:443 unless a test points it elsewhere. */
  readonly connect?: (onOpen: () => void) => Socket;
  readonly maxOpen?: number;
  readonly maxPerSource?: number;
  /** Closed after this long with nothing either way. */
  readonly idleMs?: number;
}): RelayTunnel {
  const { host } = options;
  const connect = options.connect ?? ((onOpen: () => void) => connectTls({ host, port: 443, servername: host }, onOpen));
  const maxOpen = options.maxOpen ?? 512;
  const maxPerSource = options.maxPerSource ?? 16;
  const idleMs = options.idleMs ?? 5 * 60_000;
  let open = 0;
  const bySource = new Map<string, number>();
  return {
    get open() { return open; },
    handle(req, duplex, head) {
      const socket = duplex as Socket;
      const query = (req.url ?? '').slice('/v1/walletconnect'.length);
      const key = req.headers['sec-websocket-key'];
      if (typeof key !== 'string' || !/^(\?\S*)?$/.test(query)) { socket.destroy(); return; }
      const source = sourceOf(req);
      if (open >= maxOpen || (bySource.get(source) ?? 0) >= maxPerSource) { socket.destroy(); return; }
      open += 1;
      bySource.set(source, (bySource.get(source) ?? 0) + 1);
      const upstream = connect(() => {
        // Only what the handshake needs: none of the user's origin, cookies, agent or address.
        upstream.write(`GET /${query} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
        if (head.length > 0) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      let closed = false;
      const close = () => {
        socket.destroy();
        upstream.destroy();
        if (closed) return;
        closed = true;
        open -= 1;
        const left = (bySource.get(source) ?? 1) - 1;
        if (left === 0) bySource.delete(source); else bySource.set(source, left);
      };
      // Both ends: the visitor's, and Reown's (a connect that never completes is idle too).
      socket.setTimeout(idleMs, close);
      upstream.setTimeout(idleMs, close);
      upstream.on('error', close).on('close', close);
      socket.on('error', close).on('close', close);
    },
  };
}
