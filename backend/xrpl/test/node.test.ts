import { createHash } from 'node:crypto';
import fs, { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { Client, NotConnectedError } from 'xrpl';

import { attesterFile, keepConnected, saveAttesterFile } from '../node.ts';

const POOL = 'rw5r7pX37iAtLEh1VZdciHaFpduftUtjYe';

/** One unmasked WebSocket frame, as a server sends it. */
const frame = (opcode: number, data: Buffer) =>
  Buffer.concat([Buffer.from(data.length < 126 ? [0x80 | opcode, data.length] : [0x80 | opcode, 126, data.length >> 8, data.length & 0xff]), data]);

/**
 * A ledger node on localhost, just enough WebSocket to answer every request with
 * success (no package for it: the client side is xrpl.js's own). `drop` is a
 * node restart: every connection cut, nothing listening until a new one.
 */
async function localNode(port = 0) {
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => { res.writeHead(426); res.end(); });
  server.on('upgrade', (req, socket: Socket) => {
    const accept = createHash('sha1').update(`${String(req.headers['sec-websocket-key'])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket)).on('error', () => undefined);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0]! & 0x0f;
        let len = buf[1]! & 0x7f;
        let at = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
        if (buf.length < at + 4 + len) return;
        const data = Buffer.alloc(len);
        for (let i = 0; i < len; i++) data[i] = buf[at + 4 + i]! ^ buf[at + (i % 4)]!;
        buf = buf.subarray(at + 4 + len);
        if (opcode === 1) {
          const { id } = JSON.parse(data.toString('utf8')) as { id: number };
          socket.write(frame(1, Buffer.from(JSON.stringify({ id, type: 'response', status: 'success', result: {} }))));
        }
        if (opcode === 8) socket.end(frame(8, Buffer.alloc(0)));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    async drop() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const once = (client: Client, event: 'disconnected' | 'connected') => new Promise((resolve) => client.once(event, resolve));
/** xrpl.js's own reconnect, ~100 ms after an unexpected close: it fails against a node that is down, and is never tried again. */
const ownRetryFails = (client: Client) => new Promise<void>((resolve) => {
  const seen = (code: string) => { if (code === 'reconnect') { client.off('error', seen); resolve(); } };
  client.on('error', seen);
});

// F-53: xrpl.js reconnects once after an unexpected close, and if that one attempt
// fails it never tries again: the stack's one ledger connection stayed dead for good
// while the process looked healthy, so its host never restarted it.
test('the ledger connection comes back after a reconnect that failed, and gives up only after minutes (F-53)', async () => {
  let node = await localNode();
  const client = new Client(`ws://127.0.0.1:${node.port}`);
  await client.connect();
  let clock = 0;
  const timers: { run: () => Promise<void>; ms: number }[] = [];
  let downs = 0;
  const watch = keepConnected(client, {
    now: () => clock, setTimer: (run, ms) => { timers.push({ run, ms }); }, maxDownMs: 300_000, onDown: () => { downs += 1; },
  });
  const fire = async () => { const t = timers.shift()!; clock += t.ms; await t.run(); return t.ms; };
  try {
    // OMEGA's PoC: the node restarts, and is still down when xrpl.js tries again.
    const dropped = once(client, 'disconnected');
    const retried = ownRetryFails(client);
    await node.drop();
    await dropped;
    await retried;
    assert.equal(client.isConnected(), false, 'xrpl.js has given up');
    await assert.rejects(client.request({ command: 'ping' }), NotConnectedError, 'meanwhile a request fails at once, and is retried by its caller');
    node = await localNode(node.port);
    assert.equal(timers.length, 1, 'a reconnect is scheduled');
    await fire();
    assert.equal(client.isConnected(), true, 'connected again once the node is back');
    await client.request({ command: 'ping' });

    // Down for good: tried again and again, at most 30 s apart, and after five minutes the host is told.
    const again = once(client, 'disconnected');
    const retriedAgain = ownRetryFails(client);
    await node.drop();
    await again;
    await retriedAgain;
    const waits: number[] = [];
    while (downs === 0 && waits.length < 50) waits.push(await fire());
    assert.equal(downs, 1, 'given up on, once');
    assert.deepEqual(waits.slice(0, 6), [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    assert.ok(waits.every((ms) => ms <= 30_000));
    assert.ok(clock >= 300_000 && clock < 340_000, `told after ${clock} ms`);
    assert.equal(timers.length, 1, 'and still trying');
  } finally {
    watch.close();
    await client.disconnect();
    await node.drop().catch(() => undefined);
  }
});

test('closing the node does not reconnect it (F-53)', async () => {
  const node = await localNode();
  const client = new Client(`ws://127.0.0.1:${node.port}`);
  await client.connect();
  const timers: unknown[] = [];
  const watch = keepConnected(client, { setTimer: (run) => { timers.push(run); } });
  watch.close();
  await client.disconnect();
  await node.drop();
  assert.equal(timers.length, 0);
});

// F-60: attesters.json holds the attesters' seeds and key positions, and was rewritten in
// place on every rotation: a kill mid-write left it cut short, and the next boot could not parse it.
test('attesters.json is replaced whole or not at all (F-60)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opaque-attesters-'));
  const realWriteFileSync = fs.writeFileSync;
  const realWriteSync = fs.writeSync;
  try {
    const state = attesterFile(dir, 3);
    // OMEGA's PoC: the process dies halfway through writing the file (OOM, or a SIGKILL).
    const killed = () => new Error('killed mid-write');
    mock.method(fs, 'writeFileSync', (file: fs.PathOrFileDescriptor, data: string, opts: fs.WriteFileOptions) => {
      realWriteFileSync(file, data.slice(0, data.length >> 1), opts);
      throw killed();
    });
    mock.method(fs, 'writeSync', (fd: number, data: string | Buffer) => {
      const bytes = Buffer.from(data);
      realWriteSync(fd, bytes.subarray(0, bytes.length >> 1));
      throw killed();
    });
    syncBuiltinESMExports();
    assert.throws(() => saveAttesterFile(dir, { ...state, index: { A1: { [POOL]: 7 } } }), /killed/);
    mock.restoreAll();
    syncBuiltinESMExports();
    assert.deepEqual(attesterFile(dir, 3), state, 'the next boot reads the file as it was');
    saveAttesterFile(dir, { ...state, index: { A1: { [POOL]: 7 } } });
    assert.equal(attesterFile(dir, 3).index['A1']?.[POOL], 7);
    assert.equal(statSync(join(dir, 'attesters.json')).mode & 0o777, 0o600, 'secrets: owner only');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'attesters.json'), 'utf8')).seeds, state.seeds);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});
