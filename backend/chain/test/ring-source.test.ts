import assert from 'node:assert/strict';
import test from 'node:test';

import type { PoolScope, RelaySnapshot, UnixSeconds } from '@opaque/protocol-types';

import { createChainRingSource } from '../ring-source.ts';

// Offline: a fake RPC with one deposit per 10,000-block window.
const scope = { chainId: 5042002n, pool: `0x${'ab'.repeat(20)}`, denomination: 1_000_000 } as unknown as PoolScope;
function fakeRpc() {
  const rpc = { head: 20_000n, fail: false, calls: 0 };
  const client = {
    getBlockNumber: async () => { rpc.calls++; if (rpc.fail) throw new Error('Request exceeds defined limit'); return rpc.head; },
    getLogs: async ({ fromBlock }: { fromBlock: bigint }) => {
      await new Promise((r) => setTimeout(r, 5));
      if (rpc.fail) throw new Error('Request exceeds defined limit');
      return [{ args: { commitment: `0x${fromBlock.toString(16).padStart(32, '0')}${'0'.repeat(32)}` }, blockNumber: fromBlock }];
    },
  };
  return { rpc, client };
}
const relays = (): RelaySnapshot => ({ nodes: [], directoryVersion: '1', observedAt: 1n as UnixSeconds });

test('reads at once share one scan, so no deposit is listed twice', async () => {
  const { client } = fakeRpc();
  const source = createChainRingSource({ publicClient: client as never, scope, deployedAtBlock: 1n, relaySnapshot: relays });
  const snaps = await Promise.all(Array.from({ length: 7 }, () => source.getRingSnapshot(scope)));
  for (const snap of snaps) assert.equal(snap.candidates.length, 2);
});

test('a scan the RPC refuses serves the last good ring, dated when it ran', async () => {
  let clock = 100n;
  const { rpc, client } = fakeRpc();
  const source = createChainRingSource({ publicClient: client as never, scope, deployedAtBlock: 1n, relaySnapshot: relays, now: () => clock as UnixSeconds, retryMs: 1 });
  const first = await source.getRingSnapshot(scope);
  [rpc.fail, clock] = [true, 130n];
  const second = await source.getRingSnapshot(scope);
  assert.equal(second.candidates.length, first.candidates.length);
  assert.equal(second.observedAt, 100n);
  // With nothing to fall back on, the refusal is the answer.
  const fresh = createChainRingSource({ publicClient: client as never, scope, deployedAtBlock: 1n, relaySnapshot: relays, retryMs: 1 });
  await assert.rejects(fresh.getRingSnapshot(scope), /exceeds defined limit/);
});

test('a seed reads only where the index points, keeps only what the chain has, and backfill finds the rest', async () => {
  const deposits = [5n, 40_000n, 90_000n].map((b) => ({ args: { commitment: `0x${b.toString(16).padStart(64, '0')}` }, blockNumber: b }));
  const reads: bigint[] = [];
  const client = {
    getBlockNumber: async () => 100_000n,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      reads.push(fromBlock);
      return deposits.filter((d) => d.blockNumber >= fromBlock && d.blockNumber <= toBlock);
    },
  };
  // The index leaves out block 5 and invents a member at block 70,000.
  const indexed = async () => ({
    scope, indexedThroughBlock: 99_000n, observedAt: 1n as UnixSeconds, policyVersion: 'test',
    candidates: [40_000n, 70_000n, 90_000n].map((b) => ({ commitment: `0x${(b + 1n).toString(16).padStart(64, '0')}`, enrolledAtBlock: b, timesUsedInRing: 0, fundingCluster: null, hasOtherActivity: null })),
  }) as never;
  const source = createChainRingSource({ publicClient: client as never, scope, deployedAtBlock: 1n, relaySnapshot: relays, indexed });
  await source.seed();
  assert.deepEqual(reads, [40_000n, 70_000n, 90_000n]);
  const seeded = await source.getRingSnapshot(scope);
  assert.deepEqual(seeded.candidates.map((c) => c.enrolledAtBlock), [40_000n, 90_000n]);
  assert.equal(seeded.indexedThroughBlock, 100_000n);
  assert.deepEqual(reads, [40_000n, 70_000n, 90_000n, 99_001n], 'a seeded request reads the blocks since the index, not the history');
  await source.backfill(1);
  const full = await source.getRingSnapshot(scope);
  assert.deepEqual(full.candidates.map((c) => c.enrolledAtBlock), [5n, 40_000n, 90_000n]);
  assert.equal(full.indexedThroughBlock, 100_000n);
});

test('backfill retries a refused history until it is read', async () => {
  const { rpc, client } = fakeRpc();
  const source = createChainRingSource({ publicClient: client as never, scope, deployedAtBlock: 1n, relaySnapshot: relays, retryMs: 1 });
  rpc.fail = true;
  setTimeout(() => { rpc.fail = false; }, 20);
  await source.backfill(5);
  assert.equal((await source.getRingSnapshot(scope)).candidates.length, 2);
});

test('a refused log read is retried before the scan gives up', async () => {
  const { client } = fakeRpc();
  let refusals = 2;
  const flaky = { ...client, getLogs: async (a: { fromBlock: bigint }) => { if (refusals-- > 0) throw new Error('RPC Request failed.'); return client.getLogs(a); } };
  const source = createChainRingSource({ publicClient: flaky as never, scope, deployedAtBlock: 1n, relaySnapshot: relays, retryMs: 1 });
  assert.equal((await source.getRingSnapshot(scope)).candidates.length, 2);
});

test('a seed the RPC refused at boot is tried again on request, not the whole history', async () => {
  const deposits = [40_000n, 90_000n].map((b) => ({ args: { commitment: `0x${b.toString(16).padStart(64, '0')}` }, blockNumber: b }));
  const reads: bigint[] = [];
  let refuse = true;
  const client = {
    getBlockNumber: async () => 100_000n,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (refuse) throw new Error('RPC Request failed.');
      reads.push(fromBlock);
      return deposits.filter((d) => d.blockNumber >= fromBlock && d.blockNumber <= toBlock);
    },
  };
  const indexed = async () => ({
    scope, indexedThroughBlock: 99_000n, observedAt: 1n as UnixSeconds, policyVersion: 'test',
    candidates: deposits.map((d) => ({ commitment: d.args.commitment, enrolledAtBlock: d.blockNumber, timesUsedInRing: 0, fundingCluster: null, hasOtherActivity: null })),
  }) as never;
  const source = createChainRingSource({ publicClient: client as never, scope, deployedAtBlock: 1n, relaySnapshot: relays, indexed, retryMs: 1 });
  await assert.rejects(source.seed(), /RPC Request failed/);
  refuse = false;
  const snaps = await Promise.all([source.getRingSnapshot(scope), source.getRingSnapshot(scope)]);
  for (const snap of snaps) assert.deepEqual(snap.candidates.map((c) => c.enrolledAtBlock), [40_000n, 90_000n]);
  assert.deepEqual(reads, [40_000n, 90_000n, 99_001n], 'the indexed windows and the blocks since, once, not the history from block 1');
});

test('a seeded ring takes in a deposit made after boot, before backfill reaches the history', async () => {
  const deposits = [40_000n].map((b) => ({ args: { commitment: `0x${b.toString(16).padStart(64, '0')}` }, blockNumber: b }));
  let head = 100_000n;
  const client = {
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => deposits.filter((d) => d.blockNumber >= fromBlock && d.blockNumber <= toBlock),
  };
  const indexed = async () => ({
    scope, indexedThroughBlock: 100_000n, observedAt: 1n as UnixSeconds, policyVersion: 'test',
    candidates: [{ commitment: deposits[0]!.args.commitment, enrolledAtBlock: 40_000n, timesUsedInRing: 0, fundingCluster: null, hasOtherActivity: null }],
  }) as never;
  const source = createChainRingSource({ publicClient: client as never, scope, deployedAtBlock: 1n, relaySnapshot: relays, indexed });
  await source.seed();
  // A wallet's deposit lands after boot.
  deposits.push({ args: { commitment: `0x${(100_500n).toString(16).padStart(64, '0')}` }, blockNumber: 100_500n });
  head = 101_000n;
  const snap = await source.getRingSnapshot(scope);
  assert.deepEqual(snap.candidates.map((c) => c.enrolledAtBlock), [40_000n, 100_500n]);
  assert.equal(snap.indexedThroughBlock, 101_000n);
});

test('a seed never asks for blocks past the head, so a pool with a recent deposit still seeds', async () => {
  const deposits = [95_000n].map((b) => ({ args: { commitment: `0x${b.toString(16).padStart(64, '0')}` }, blockNumber: b }));
  const client = {
    getBlockNumber: async () => 100_000n,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock > 100_000n) throw new Error('Invalid parameters were provided to the RPC method.');
      return deposits.filter((d) => d.blockNumber >= fromBlock && d.blockNumber <= toBlock);
    },
  };
  const indexed = async () => ({
    scope, indexedThroughBlock: 100_000n, observedAt: 1n as UnixSeconds, policyVersion: 'test',
    candidates: [{ commitment: deposits[0]!.args.commitment, enrolledAtBlock: 95_000n, timesUsedInRing: 0, fundingCluster: null, hasOtherActivity: null }],
  }) as never;
  const source = createChainRingSource({ publicClient: client as never, scope, deployedAtBlock: 1n, relaySnapshot: relays, indexed, retryMs: 1 });
  await source.seed();
  assert.deepEqual((await source.getRingSnapshot(scope)).candidates.map((c) => c.enrolledAtBlock), [95_000n]);
});
