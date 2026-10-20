// A query too large for one mesh message — a UserOperation carrying a
// contract's bytecode — crosses as chunks and is answered like any query.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import type { GraphSelectionClient, Hex, PrivacyScore, RelayPath, UnixSeconds } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { createExecutorServer } from '../../cre/executor-server.ts';
import { createMeshTransport } from '../client.ts';
import { buildLocalMesh, serveLocalMesh } from '../local-mesh.ts';
import type { MeshMessageKind } from '../transport.ts';

const nowS = (): UnixSeconds => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds;
const noGraph: GraphSelectionClient = {
  getRingSnapshot: async () => { throw new Error('unused'); },
  getRelaySnapshot: async () => ({ nodes: [], directoryVersion: 'unused', observedAt: nowS() }),
  getPrivacyConditions: async () => { throw new Error('unused'); },
};
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('a 50 KB query crosses six relays in chunks, and a small one still goes whole', { timeout: 120_000 }, async () => {
  // The exit's answer names the bytes it got: their size and hash.
  const exit = createExecutorServer({
    graph: noGraph,
    walletRpc: async (_operation, encodedRequest) => toHex(new TextEncoder().encode(`${fromHex(encodedRequest).length}:${digest(fromHex(encodedRequest))}`)),
  });
  const port = ((await exit.listen(0)).address() as AddressInfo).port;
  const mesh = buildLocalMesh(19_601);
  const relays = await serveLocalMesh(mesh, new Map<MeshMessageKind, string>([
    ['PAYMENT', `http://127.0.0.1:${port}/v1/mesh/payment`],
    ['QUERY', `http://127.0.0.1:${port}/v1/mesh/query`],
  ]));
  try {
    const nodes = mesh.signed.directory.entries.map((e) => ({
      id: e.id, endpoint: e.endpoint, kemPublicKey: e.kemPublicKey, keyEpoch: e.keyEpoch,
      operatorId: e.operatorId, reliabilityScore: 5_000 as PrivacyScore, batchOccupancy: 1,
      recentSelectionCount: 0, lastSeenAt: nowS(),
    }));
    const pathFor = async (): Promise<RelayPath> => [...nodes].sort(() => Math.random() - 0.5).slice(0, 3) as unknown as RelayPath;
    const transport = createMeshTransport({ pollIntervalMs: 100, pollTimeoutMs: 60_000, pathFor });
    const ask = async (bytes: Uint8Array) => {
      const r = await transport.query({ kind: 'WALLET_RPC', operation: 'ESTIMATE', encodedRequest: toHex(bytes) as Hex }, await pathFor());
      return new TextDecoder().decode(fromHex((r as { value: Hex }).value));
    };

    const large = crypto.getRandomValues(new Uint8Array(50_000));
    assert.equal(await ask(large), `50000:${digest(large)}`, 'every byte, in order');
    const small = new Uint8Array([0x7b, 0x7d]);
    assert.equal(await ask(small), `2:${digest(small)}`);
  } finally {
    await Promise.all(relays.map((r) => r.close()));
    await exit.close();
  }
});
