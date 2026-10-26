import { createServer as createHttpServer } from 'node:http';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { relayTunnel } from '../tunnel.ts';

const listening = async <T extends { listen(port: number, host: string, cb: () => void): unknown; address(): unknown }>(server: T) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

// F-66: every WalletConnect upgrade opened a socket to Reown's relay, with no cap on how
// many and no idle timeout, so one visitor could hold thousands open from this server's address.
test('WalletConnect tunnels are capped, in all and per visitor, and an idle one is closed (F-66)', async () => {
  // Reown's relay, played by a local socket server: what reaches it is what the tunnel opened.
  const upstream: Socket[] = [];
  const relay = createServer((s) => { upstream.push(s); s.on('error', () => undefined); });
  const relayPort = await listening(relay);
  const tunnel = relayTunnel({
    host: 'relay.walletconnect.org', maxOpen: 3, maxPerSource: 2, idleMs: 60_000,
    connect: (onOpen) => connect(relayPort, '127.0.0.1', onOpen),
  });
  const accepted: Socket[] = [];
  const front = createHttpServer().on('upgrade', (req, socket: Socket, head) => { accepted.push(socket); tunnel.handle(req, socket, head); });
  const port = await listening(front);
  const pages: Socket[] = [];
  /** One page's relay socket, from `from` as the host's proxy names it: opened through to the relay, or refused. */
  const open = (from: string) => new Promise<{ ok: boolean; socket: Socket }>((resolve) => {
    const s = connect(port, '127.0.0.1', () => s.write(`GET /v1/walletconnect?auth=x HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: k\r\nX-Forwarded-For: 10.0.0.9, ${from}\r\n\r\n`));
    pages.push(s);
    const reached = () => { s.off('close', refused); resolve({ ok: true, socket: s }); };
    const refused = () => { relay.off('connection', reached); resolve({ ok: false, socket: s }); };
    relay.once('connection', reached);
    s.on('error', () => undefined).once('close', refused);
  });
  try {
    // OMEGA's PoC: one visitor opens tunnel after tunnel.
    const a1 = await open('203.0.113.7');
    const a2 = await open('203.0.113.7');
    const a3 = await open('203.0.113.7');
    assert.deepEqual([a1.ok, a2.ok, a3.ok], [true, true, false], 'two per visitor');
    const b1 = await open('198.51.100.1');
    const c1 = await open('192.0.2.5');
    assert.deepEqual([b1.ok, c1.ok], [true, false], 'three in all');
    assert.equal(tunnel.open, 3);

    // Idle: the socket is given a timeout, and on it both ends close and the slot is free again.
    const idle = accepted[0]!;
    assert.equal(idle.timeout, 60_000);
    const closed = new Promise((resolve) => a1.socket.once('close', resolve));
    idle.emit('timeout');
    await closed;
    assert.equal(tunnel.open, 2);
    assert.equal((await open('203.0.113.7')).ok, true, 'the visitor may open one again');
  } finally {
    for (const s of [...upstream, ...pages]) s.destroy();
    await new Promise((resolve) => front.close(resolve));
    await new Promise((resolve) => relay.close(resolve));
  }
});
