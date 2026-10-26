import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Hex } from '@opaque/protocol-types';
import { asAddress, asChainId } from '@opaque/protocol-types/codecs.js';
import { encodeSignature, keyGen, pqDigest, sign, forsSchemeId } from '@opaque/pq-wallet';
import { PQKeyRegistry, userActionPayload } from '../../../packages/pq-wallet/src/registry.ts';

import { attesterCommitment, attesterSeed, createAttesterKeys, type AttesterKeyState } from '../attester-keys.ts';

// The pq-wallet in-memory registry mirrors PQKeyRegistry.sol byte for byte
// (both pinned by the same vectors), so rotation and takeover signatures that
// pass here are the ones the contract accepts.
const chainId = 31337n;
const attester = asAddress(`0x${'5a'.repeat(20)}`);
const master = new Uint8Array(32).fill(0x42);
const policy = { deadline: 'observe-only', allowLateRotation: true, pendingDisableOnRotation: 'preserve', repeatedDisable: 'restart' } as const;

function world(maxUses: bigint) {
  const registry = new PQKeyRegistry({ chainId: asChainId(chainId), now: () => 100n, policy });
  registry.register(attester, { pkCommitment: attesterCommitment(master, 0), nextCommitment: attesterCommitment(master, 1), maxUses, rotationDeadline: 1_000n });
  const calls: string[] = [];
  const keys = createAttesterKeys({
    master, attester, chainId, maxUses, rotateWhenLeft: 1n, now: () => 100n,
    readState: async () => {
      const s = registry.stateOf(attester)!;
      return { pkCommitment: s.pkCommitment, useCount: s.useCount, maxUses: s.maxUses };
    },
    rotate: async (next, m, deadline, sig) => { calls.push('rotate'); registry.rotate(attester, next, m, deadline, sig); },
    takeover: async (next, m, sig) => { calls.push('takeover'); registry.takeover(attester, next, m, sig); },
  });
  // Stand-in for an attestation: whatever key current() hands back signs.
  const attest = async () => {
    const { forsSeed, useCount } = await keys.current();
    const key = keyGen(forsSeed);
    const payload = userActionPayload('0x1234');
    const digest = pqDigest({ chainId: asChainId(chainId), walletAddress: attester, schemeId: forsSchemeId(key.publicKey.params), useCount, payload });
    registry.consume(attester, '0x1234' as Hex, encodeSignature(key.publicKey, sign(key.secretKey, digest)));
  };
  return { registry, keys, calls, attest };
}

test('rotates_before_the_budget_runs_out_and_keeps_signing', async () => {
  const { registry, calls, attest } = world(3n);
  await attest();
  await attest(); // one left: the next current() rotates first
  await attest();
  assert.deepEqual(calls, ['rotate']);
  const s = registry.stateOf(attester)!;
  assert.equal(s.pkCommitment, attesterCommitment(master, 1), 'generation 1 is active');
  assert.equal(s.nextCommitment, attesterCommitment(master, 2), 'and generation 2 is committed');
  assert.equal(s.useCount, 1n, 'the new key has signed once');
});

test('an_exhausted_key_hands_over_to_the_next_generation', async () => {
  // Three, not two: the new key's first signature goes on the takeover, and on a
  // budget of two its one left would be the one kept for rotating.
  const { registry, calls, attest } = world(3n);
  // Burn the budget behind the manager's back, as a second process might.
  for (const count of [0n, 1n, 2n]) {
    const key = keyGen(attesterSeed(master, 0));
    const digest = pqDigest({ chainId: asChainId(chainId), walletAddress: attester, schemeId: forsSchemeId(key.publicKey.params), useCount: count, payload: userActionPayload('0x99') });
    registry.consume(attester, '0x99' as Hex, encodeSignature(key.publicKey, sign(key.secretKey, digest)));
  }
  assert.equal(registry.stateOf(attester)!.useCount, 3n);
  await attest();
  assert.deepEqual(calls, ['takeover']);
  assert.equal(registry.stateOf(attester)!.pkCommitment, attesterCommitment(master, 1));
  assert.equal(registry.stateOf(attester)!.useCount, 2n, 'takeover spent index 0, the attestation index 1');
});

test('refuses_a_registered_key_it_did_not_derive', async () => {
  const registry = new PQKeyRegistry({ chainId: asChainId(chainId), now: () => 100n, policy });
  registry.register(attester, { pkCommitment: attesterCommitment(new Uint8Array(32).fill(1), 0), nextCommitment: attesterCommitment(master, 1), maxUses: 4n, rotationDeadline: 1_000n });
  const keys = createAttesterKeys({
    master, attester, chainId, searchGenerations: 4,
    readState: async () => { const s = registry.stateOf(attester)!; return { pkCommitment: s.pkCommitment, useCount: s.useCount, maxUses: s.maxUses }; },
    rotate: async () => assert.fail('must not rotate'), takeover: async () => assert.fail('must not take over'),
  });
  await assert.rejects(keys.current(), { code: 'SIGNER_STATE_UNSAFE' });
});

// ── F-45: the budget counts signatures made, not signatures that landed ──

/** A world whose registry never sees an attestation land: the case the count exists for. */
function unlanded(maxUses: bigint, log: string, rotate?: (sig: Hex, deadline: bigint) => void, now: () => bigint = () => 100n) {
  const registry = new PQKeyRegistry({ chainId: asChainId(chainId), now: () => 100n, policy });
  registry.register(attester, { pkCommitment: attesterCommitment(master, 0), nextCommitment: attesterCommitment(master, 1), maxUses, rotationDeadline: 1_000n });
  const made = new Map<number, number>();
  const generation = () => [0, 1, 2, 3, 4, 5].find((g) => attesterCommitment(master, g) === registry.stateOf(attester)!.pkCommitment)!;
  const count = (g: number) => made.set(g, (made.get(g) ?? 0) + 1);
  const keysAt = () => createAttesterKeys({
    master, attester, chainId, maxUses, rotateWhenLeft: 1n, now, log,
    readState: async () => { const s = registry.stateOf(attester)!; return { pkCommitment: s.pkCommitment, useCount: s.useCount, maxUses: s.maxUses }; },
    rotate: async (next, m, deadline, sig) => { count(generation()); rotate?.(sig, deadline); registry.rotate(attester, next, m, deadline, sig); },
    takeover: async (next, m, sig) => { count(generation() + 1); registry.takeover(attester, next, m, sig); },
  });
  // An attestation the pool refuses: signed, never consumed on chain.
  const attest = async (keys: ReturnType<typeof keysAt>) => {
    const key = await keys.current();
    (key as { reserve?: () => void }).reserve?.();
    count(key.generation);
  };
  return { registry, made, keysAt, attest };
}

test('F45_signatures_that_never_land_still_count_against_the_key_budget', async () => {
  // The PoC: attestations the pool refuses leave the registry's count at 0, so
  // without a count of its own the key signed index 0 again for every one.
  const { made, keysAt, attest } = unlanded(4n, join(mkdtempSync(join(tmpdir(), 'attester-')), 'uses.json'));
  const keys = keysAt();
  for (let i = 0; i < 10; i++) await attest(keys);
  for (const [g, n] of made) assert.ok(n <= 4, `generation ${g} made ${n} signatures on a budget of 4`);
  assert.equal(made.get(0), 4, 'three attestations and the rotation they forced');
});

test('F45_a_restart_remembers_signatures_the_registry_never_counted', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'attester-')), 'uses.json');
  const { made, keysAt, attest } = unlanded(4n, log);
  const before = keysAt();
  for (let i = 0; i < 3; i++) await attest(before);
  // A redeploy: a new process, the same file.
  before.close();
  const after = keysAt();
  for (let i = 0; i < 4; i++) await attest(after);
  assert.equal(made.get(0), 4, 'the restarted process rotated instead of signing a fourth and fifth time');
  assert.equal(existsSync(`${log}.tmp`), false, 'written whole and moved into place');
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')).uses, { 0: '4', 1: '4', 2: '1' }, 'each generation rotated at its budget');
});

test('F45_a_rotation_that_failed_is_sent_again_not_signed_again', async () => {
  // Its deadline comes from the clock: signed afresh, a retry is a second
  // message at the same index.
  const sent: string[] = [];
  let fail = true;
  let clock = 100n;
  const { keysAt, attest } = unlanded(4n, join(mkdtempSync(join(tmpdir(), 'attester-')), 'uses.json'), (sig, deadline) => {
    sent.push(`${deadline}:${sig.slice(0, 66)}`);
    if (fail) throw new Error('rotate reverted');
  }, () => clock++);
  const keys = keysAt();
  for (let i = 0; i < 3; i++) await attest(keys);
  await assert.rejects(keys.current(), /reverted/);
  fail = false;
  await keys.current();
  assert.equal(sent.length, 2);
  assert.equal(sent[1], sent[0], 'the same deadline and the same signature');
});

test('F45_observe_reads_the_index_without_rotating', async () => {
  const { registry, calls } = world(2n);
  const keys = createAttesterKeys({
    master, attester, chainId, maxUses: 2n, rotateWhenLeft: 1n, now: () => 100n,
    readState: async () => { const s = registry.stateOf(attester)!; return { pkCommitment: s.pkCommitment, useCount: s.useCount, maxUses: s.maxUses }; },
    rotate: async () => { calls.push('rotate'); }, takeover: async () => { calls.push('takeover'); },
  });
  assert.deepEqual(await (keys as unknown as { observe: () => Promise<unknown> }).observe(), { useCount: 0n, generation: 0 });
  assert.deepEqual(calls, [], 'one signature from the end, and still nothing signed');
});

test('F45_while_a_rotation_is_pending_nothing_signs_into_the_signatures_kept_for_it', async () => {
  // Six signatures, two kept for rotating. The PoC: the rotation was sent but
  // not yet mined, the key was handed out for attestations anyway, they spent
  // the kept signatures, and when an earlier attestation then landed the
  // rotation had to be signed afresh with nothing left to sign it: stuck for good.
  const registry = new PQKeyRegistry({ chainId: asChainId(chainId), now: () => 100n, policy });
  registry.register(attester, { pkCommitment: attesterCommitment(master, 0), nextCommitment: attesterCommitment(master, 1), maxUses: 6n, rotationDeadline: 1_000n });
  let mined = false;
  const keys = createAttesterKeys({
    master, attester, chainId, maxUses: 6n, rotateWhenLeft: 2n, now: () => 100n, log: join(mkdtempSync(join(tmpdir(), 'attester-')), 'uses.json'),
    readState: async () => { const s = registry.stateOf(attester)!; return { pkCommitment: s.pkCommitment, useCount: s.useCount, maxUses: s.maxUses }; },
    rotate: async (next, m, deadline, sig) => { if (mined) registry.rotate(attester, next, m, deadline, sig); },
    takeover: async () => assert.fail('a key that keeps its reserve never needs a takeover'),
  });
  const signed = async () => {
    const key = await keys.current();
    key.reserve();
    const fors = keyGen(key.forsSeed);
    const digest = pqDigest({ chainId: asChainId(chainId), walletAddress: attester, schemeId: forsSchemeId(fors.publicKey.params), useCount: key.useCount, payload: userActionPayload('0x1234') });
    return encodeSignature(fors.publicKey, sign(fors.secretKey, digest));
  };
  const inFlight = await signed(); // lands later
  for (let i = 0; i < 3; i++) await signed(); // the pool refuses these
  await assert.rejects(keys.current(), /rotat/, 'a rotation is under way: nothing else is signed with this key');
  registry.consume(attester, '0x1234' as Hex, inFlight);
  mined = true;
  const next = await keys.current();
  assert.equal(next.generation, 1, 'the rotation was signed again for the new index, and landed');
});

// ── F-69…F-72: the count itself, under restarts, bad reads and a second process ──

/** A registry the attester's rotations never reach (sent, not mined), with reads it may be lied to by. */
function pendingWorld(maxUses: bigint, rotateWhenLeft: bigint) {
  const registry = new PQKeyRegistry({ chainId: asChainId(chainId), now: () => 100n, policy });
  registry.register(attester, { pkCommitment: attesterCommitment(master, 0), nextCommitment: attesterCommitment(master, 1), maxUses, rotationDeadline: 1_000n });
  const sent: string[] = [];
  const log = join(mkdtempSync(join(tmpdir(), 'attester-')), 'uses.json');
  let read = (s: AttesterKeyState) => s;
  const keysAt = (now: () => bigint = () => 100n) => createAttesterKeys({
    master, attester, chainId, maxUses, rotateWhenLeft, now, log,
    readState: async () => { const s = registry.stateOf(attester)!; return read({ pkCommitment: s.pkCommitment, useCount: s.useCount, maxUses: s.maxUses }); },
    rotate: async (_next, _m, deadline, sig) => { sent.push(`${deadline}:${sig.slice(0, 66)}`); },
    takeover: async () => assert.fail('no takeover'),
  });
  const burn = (n: number) => {
    for (let i = 0; i < n; i++) {
      const key = keyGen(attesterSeed(master, 0));
      const useCount = registry.stateOf(attester)!.useCount;
      const digest = pqDigest({ chainId: asChainId(chainId), walletAddress: attester, schemeId: forsSchemeId(key.publicKey.params), useCount, payload: userActionPayload('0x99') });
      registry.consume(attester, '0x99' as Hex, encodeSignature(key.publicKey, sign(key.secretKey, digest)));
    }
  };
  return { registry, sent, log, keysAt, burn, lie: (f: typeof read) => { read = f; } };
}
const usesIn = (log: string) => JSON.parse(readFileSync(log, 'utf8')).uses as Record<string, string>;

test('F69_a_restart_resends_the_rotation_it_signed_instead_of_signing_another', async () => {
  // The PoC: the rotation was signed but never mined, and each restart signed a
  // new one (its deadline comes from the clock) at the same index, until the
  // count was spent with the registry short of it: wedged for good.
  const { sent, log, keysAt, burn } = pendingWorld(6n, 2n);
  burn(4);
  let clock = 100n;
  for (let restart = 0; restart < 4; restart++) {
    const keys = keysAt(() => clock++);
    await assert.rejects(keys.current(), /rotat/);
    (keys as unknown as { close?: () => void }).close?.();
  }
  assert.equal(new Set(sent).size, 1, 'one rotation, sent four times');
  assert.equal(usesIn(log)['0'], '5', 'four that landed and the one rotation, counted once');
});

test('F69_a_stale_read_cannot_trigger_a_second_rotation_or_an_attestation', async () => {
  // Reads from a pool of RPC endpoints flap between the current index and the
  // one before. Each flap named a different rotation, and the stale one handed
  // the key out for an attestation while the rotation was pending.
  const { sent, log, keysAt, burn, lie } = pendingWorld(6n, 2n);
  burn(4);
  const keys = keysAt();
  await assert.rejects(keys.current(), /rotat/);
  let flip = false;
  lie((s) => ((flip = !flip) ? { ...s, useCount: s.useCount - 1n } : s));
  for (let i = 0; i < 6; i++) await assert.rejects(keys.current(), /rotat/);
  assert.equal(new Set(sent).size, 1);
  assert.equal(usesIn(log)['0'], '5', 'four that landed and the one rotation');
});

test('F70_a_read_that_claims_a_bigger_budget_is_not_believed', async () => {
  // An RPC endpoint answering maxUses 1000 for a key registered with 6.
  const { log, keysAt, lie } = pendingWorld(6n, 2n);
  lie((s) => ({ ...s, maxUses: 1000n }));
  const keys = keysAt();
  let signed = 0;
  for (let i = 0; i < 20; i++) {
    try { (await keys.current()).reserve(); signed++; } catch { break; }
  }
  assert.ok(Number(usesIn(log)['0']) <= 6, `generation 0 made ${usesIn(log)['0']} signatures on a budget of 6`);
  assert.equal(signed, 4, 'four attestations, two kept for rotating');
});

test('F71_a_restart_finds_its_generation_from_the_log_however_far_on', async () => {
  // The search began at generation 0 on every boot: past `searchGenerations`
  // rotations a restart refused to start at all.
  const registry = new PQKeyRegistry({ chainId: asChainId(chainId), now: () => 100n, policy });
  registry.register(attester, { pkCommitment: attesterCommitment(master, 10), nextCommitment: attesterCommitment(master, 11), maxUses: 6n, rotationDeadline: 1_000n });
  const dir = mkdtempSync(join(tmpdir(), 'attester-'));
  const log = join(dir, 'uses.json');
  writeFileSync(log, JSON.stringify({ attester: attester.toLowerCase(), chainId: chainId.toString(10), uses: { 10: '1' } }));
  const keys = createAttesterKeys({
    master, attester, chainId, maxUses: 6n, rotateWhenLeft: 2n, now: () => 100n, log, searchGenerations: 4,
    readState: async () => { const s = registry.stateOf(attester)!; return { pkCommitment: s.pkCommitment, useCount: s.useCount, maxUses: s.maxUses }; },
    rotate: async () => assert.fail('no rotation'), takeover: async () => assert.fail('no takeover'),
  });
  assert.equal((await keys.current()).generation, 10);
});

test('F72_two_signers_cannot_count_against_one_log', async () => {
  // Each kept its own count and the last write won: two of them made twice the
  // budget between them while the file showed one budget.
  const { keysAt } = pendingWorld(6n, 2n);
  const first = keysAt();
  assert.throws(() => keysAt(), /another/);
  (first as unknown as { close: () => void }).close();
  keysAt();
});
