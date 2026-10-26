// The attester's FORS key, kept alive across its budget.
//
// FORS+C is few-time: each key signs at most maxUses attestations, and the
// attester's ADDRESS is immutable in AttestedRingVerifier. A key that simply
// runs out would lock every note in the pool. So before each signature this
// looks at the registry and, near the end of the budget, rotates to the
// pre-committed next key; if the key is already exhausted (a crash at the
// wrong moment, a second process), the next key takes over instead —
// PQKeyRegistry.takeover allows that once the current key has nothing left.
//
// Every generation derives from ONE master secret:
//
//   seed(g) = keccak256(canonical(["opaque/v1/attester/fors-seed", master, g]))
//
// g=0 is registered with seed(1) committed as next; rotating to g+1 commits
// seed(g+2). Nothing new has to be stored after a rotation, and a restart
// finds its generation by matching the registry's pkCommitment.
//
// ── The budget counts signatures MADE, not signatures that landed (F-45) ─
//
// The registry's useCount moves only when a signature lands. A signature that
// never does — an attestation the pool refused, a transaction dropped or still
// in flight, a rotation that reverted — leaves the count where it was, and the
// next one is signed at the same index over a different message. Every one of
// those is a signature the key has made, and a few-time key's security is in
// how many it has made. So each signature is counted here, in a file, BEFORE
// it is made, and never uncounted: `reserve` is the only way to the secret.
// A key's uses are the larger of the registry's count and this one, and that
// is what rotation and exhaustion are decided on. Re-signing an index after a
// revert is then just another counted signature.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

import { keccak_256 } from '@noble/hashes/sha3.js';

import { ProtocolFailure, type Address, type Bytes32, type Hex } from '@opaque/protocol-types';
import { asChainId } from '@opaque/protocol-types/codecs.js';
import { canonical, encodeSignature, forsSchemeId, keyGen, pkCommitment, pqDigest, sign, utf8 } from '@opaque/pq-wallet';
// Not in pq-wallet's pinned public API; imported from source, as
// chain/test/registry-digest.test.ts does.
import { rotationPayload, takeoverPayload } from '../../packages/pq-wallet/src/registry.ts';

const SEED_DOMAIN = 'opaque/v1/attester/fors-seed';
const DAY = 86_400n;

export function attesterSeed(master: Uint8Array, generation: number): Uint8Array {
  return keccak_256(canonical([utf8(SEED_DOMAIN), master, utf8(String(generation))]));
}

export const attesterCommitment = (master: Uint8Array, generation: number): Bytes32 =>
  pkCommitment(keyGen(attesterSeed(master, generation)).publicKey) as Bytes32;

export interface AttesterKeyState {
  readonly pkCommitment: Bytes32;
  readonly useCount: bigint;
  readonly maxUses: bigint;
}

export interface AttesterKeysOptions {
  readonly master: Uint8Array;
  readonly attester: Address;
  readonly chainId: bigint;
  readonly readState: () => Promise<AttesterKeyState>;
  /** Submit PQKeyRegistry.rotate(attester, …) and wait for it. Anyone may send it. */
  readonly rotate: (next: Bytes32, maxUses: bigint, deadline: bigint, signature: Hex) => Promise<void>;
  /** Submit PQKeyRegistry.takeover(attester, …) and wait for it. */
  readonly takeover: (next: Bytes32, maxUses: bigint, signature: Hex) => Promise<void>;
  /** Budget of every new key. */
  readonly maxUses?: bigint;
  /** Rotate once this few signatures are left. Must be at least 1: rotation spends one. */
  readonly rotateWhenLeft?: bigint;
  readonly now?: () => bigint;
  /** How far past the last known generation a restart will look. */
  readonly searchGenerations?: number;
  /**
   * The file that counts every signature each generation has made. Absent: the
   * count lives in memory, and a restart falls back to the registry's, which
   * forgets every signature that never landed.
   */
  readonly log?: string;
}

/** The key to sign the next attestation with. */
export interface AttesterKey {
  readonly forsSeed: Uint8Array;
  /** The registry's index: what the signature's digest commits to. */
  readonly useCount: bigint;
  readonly generation: number;
  /** Counts the one signature about to be made, durably, or throws if the key has none left. */
  readonly reserve: () => void;
}

export interface AttesterKeys {
  /** The key to sign the NEXT attestation with, and the index it will use. May rotate first. */
  current(): Promise<AttesterKey>;
  /** The registry's index and generation, read and nothing else: never rotates, never signs. */
  observe(): Promise<{ readonly useCount: bigint; readonly generation: number }>;
  /** Lets go of the log, for the next process. Nothing signs after it. */
  close(): void;
}

interface UsesFile {
  readonly attester: string;
  readonly chainId: string;
  /** Generation → signatures made, as decimal strings. */
  readonly uses: Readonly<Record<string, string>>;
  /** Generation → the highest registry index ever read for it. The chain only counts up. */
  readonly landed?: Readonly<Record<string, string>>;
  /** A rotation or takeover signed and not yet seen to land: sent again, never signed again. */
  readonly pending?: PendingMove;
}

interface PendingMove {
  readonly at: string;
  readonly kind: 'rotate' | 'takeover';
  readonly next: Bytes32;
  readonly maxUses: string;
  readonly deadline?: string;
  readonly signature: Hex;
}

/**
 * Logs held by this process (F-72), let go of on exit. One count per log: two
 * signers keeping a count each in one file each made the budget between them.
 */
const held = new Set<string>();
let releasing = false;
const releaseAll = () => { for (const lock of held) try { unlinkSync(lock); } catch { /* gone already */ } held.clear(); };

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * Takes `${log}.lock` for this process, or refuses. A lock left by a process
 * that is gone (this host, a dead pid) or by another host (the container a
 * volume was attached to before this deploy: Railway stops it first) is taken over.
 */
function lockLog(log: string): () => void {
  const lock = `${log}.lock`;
  const me = { host: hostname(), pid: process.pid };
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify(me)); fsyncSync(fd); } finally { closeSync(fd); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw error;
      let holder: { host?: string; pid?: number } = {};
      try { holder = JSON.parse(readFileSync(lock, 'utf8')) as typeof holder; } catch { /* half-written: its writer died */ }
      if (holder.host === me.host && typeof holder.pid === 'number' && alive(holder.pid)) {
        throw new ProtocolFailure('SIGNER_STATE_UNSAFE', `another signer holds the attester log (pid ${holder.pid})`);
      }
      unlinkSync(lock);
    }
  }
  held.add(lock);
  if (!releasing) { releasing = true; process.once('exit', releaseAll); }
  return () => { if (held.delete(lock)) try { unlinkSync(lock); } catch { /* gone already */ } };
}

export function createAttesterKeys(options: AttesterKeysOptions): AttesterKeys {
  const maxUses = options.maxUses ?? 32n;
  const rotateWhenLeft = options.rotateWhenLeft ?? 4n;
  if (rotateWhenLeft < 1n) throw new ProtocolFailure('INVALID_INPUT', 'rotation needs a signature left to spend');
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  const search = options.searchGenerations ?? 256;

  const commitments = new Map<number, Bytes32>();
  const commitment = (g: number): Bytes32 => {
    let c = commitments.get(g);
    if (c === undefined) commitments.set(g, (c = attesterCommitment(options.master, g)));
    return c;
  };
  let known = 0;
  const generationOf = (pk: Bytes32): number => {
    for (let g = known; g < known + search; g++) {
      if (commitment(g) === pk.toLowerCase()) return (known = g);
    }
    // Not ours. Signing anyway would burn an index on a signature the
    // registry rejects, so refuse instead.
    throw new ProtocolFailure('SIGNER_STATE_UNSAFE', 'the registered attester key is not derived from this master');
  };

  // ── the count ────────────────────────────────────────────────────────
  const uses = new Map<number, bigint>();
  /** The highest registry index read per generation. The chain only counts up, so a lower read is stale (F-69). */
  const landed = new Map<number, bigint>();
  let pending: { readonly move: PendingMove & { readonly from: number }; readonly send: () => Promise<void> } | undefined;
  const sendOf = (m: PendingMove): (() => Promise<void>) => (m.kind === 'rotate'
    ? () => options.rotate(m.next, BigInt(m.maxUses), BigInt(m.deadline!), m.signature)
    : () => options.takeover(m.next, BigInt(m.maxUses), m.signature));
  const fromOf = (m: PendingMove): number => Number(m.at.split(':')[1]) - (m.kind === 'takeover' ? 1 : 0);

  const log = options.log;
  // Its own directory is made, nothing above it: a log meant for a volume that
  // is not mounted must stop the stack, not count on a disk a redeploy wipes.
  if (log !== undefined && !existsSync(dirname(log))) mkdirSync(dirname(log), { mode: 0o700 });
  const unlock = log === undefined ? () => undefined : lockLog(log);
  try {
    if (log !== undefined && existsSync(log)) {
      // Unreadable or someone else's is a refusal to start, never a fresh count:
      // a count that restarts at the registry's is the forgetting this prevents.
      const saved = JSON.parse(readFileSync(log, 'utf8')) as UsesFile;
      if (saved.attester?.toLowerCase() !== options.attester.toLowerCase() || saved.chainId !== options.chainId.toString(10)) {
        throw new ProtocolFailure('SIGNER_STATE_UNSAFE', 'the attester log belongs to another attester');
      }
      for (const [g, n] of Object.entries(saved.uses)) uses.set(Number(g), BigInt(n));
      for (const [g, n] of Object.entries(saved.landed ?? {})) landed.set(Number(g), BigInt(n));
      // A move signed before the restart goes again as it was: signed afresh, its
      // deadline (read from the clock) would make it a second message (F-69).
      if (saved.pending !== undefined) pending = { move: { ...saved.pending, from: fromOf(saved.pending) }, send: sendOf(saved.pending) };
    }
  } catch (error) {
    unlock();
    throw error;
  }
  // The search starts where the log left off (F-71): the registry is on the
  // newest generation counted, or the one before while a move it signed is in flight.
  known = Math.max(0, ...[...uses.keys()].map((g) => g - 1));
  let closed = false;

  const asText = (m: Map<number, bigint>) => Object.fromEntries([...m].map(([g, n]) => [String(g), n.toString(10)]));
  /** Written whole, flushed, then moved into place: a crash leaves the old count or the new one, never half. */
  const persist = (): void => {
    if (log === undefined) return;
    const { from: _from, ...move } = pending?.move ?? {} as PendingMove & { from?: number };
    const file: UsesFile = {
      attester: options.attester.toLowerCase(), chainId: options.chainId.toString(10), uses: asText(uses), landed: asText(landed),
      ...(pending === undefined ? {} : { pending: move as PendingMove }),
    };
    const tmp = `${log}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(file));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, log);
    // And the rename itself, so a power cut cannot bring back the count before it.
    try {
      const dir = openSync(dirname(log), 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch { /* not every platform can flush a directory */ }
  };
  /** A registry index read for key g, never below one read before. */
  const landedOf = (g: number, read: bigint): bigint => {
    const was = landed.get(g) ?? 0n;
    if (read <= was) return was;
    landed.set(g, read);
    return read;
  };
  /** What key g has signed, as far as anything knows: what landed, or what this count saw made. */
  const usedBy = (g: number, at: bigint): bigint => {
    const made = uses.get(g) ?? 0n;
    return made > at ? made : at;
  };
  /** Counts one signature by key g, before it exists. Synchronous, so no two can interleave. */
  const reserve = (g: number, at: bigint, budget: bigint): void => {
    if (closed) throw new ProtocolFailure('SIGNER_STATE_UNSAFE', 'the attester log was let go of');
    const next = usedBy(g, at) + 1n;
    if (next > budget) throw new ProtocolFailure('KEY_EXHAUSTED', 'the attester key has made every signature it may', true);
    uses.set(g, next);
    persist();
  };

  const signAt = (generation: number, useCount: bigint, payload: Hex): Hex => {
    const key = keyGen(attesterSeed(options.master, generation));
    const digest = pqDigest({
      chainId: asChainId(options.chainId),
      walletAddress: options.attester,
      schemeId: forsSchemeId(key.publicKey.params),
      useCount,
      payload,
    });
    return encodeSignature(key.publicKey, sign(key.secretKey, digest));
  };

  /**
   * A rotation or takeover: signed once for a registry state, kept in the log,
   * and sent again as it is until the registry moves on. Its deadline is read
   * from the clock, so signing it afresh would be a second message at one index.
   */
  const move = async (at: string, make: () => PendingMove): Promise<void> => {
    if (pending?.move.at !== at) {
      const m = make();
      pending = { move: { ...m, from: fromOf(m) }, send: sendOf(m) };
      persist();
    }
    await pending.send();
  };

  return {
    async current() {
      // Looked at again after each hand-over, a few times at most: the new key
      // may itself be due to rotate (a takeover spends its first signature).
      for (let round = 0; ; round++) {
        const state = await options.readState();
        const g = generationOf(state.pkCommitment);
        const at = landedOf(g, state.useCount);
        // Never more than this attester was set up with, whatever a read claims (F-70).
        const limit = state.maxUses < maxUses ? state.maxUses : maxUses;
        if (pending !== undefined && g > pending.move.from) { pending = undefined; persist(); }
        const used = usedBy(g, at);
        const rotation = `rotate:${g}:${at}`;
        // A rotation already signed for this state goes again first: its
        // signature is counted, so it may be the one that used up the budget.
        const rotate = pending?.move.at === rotation || (used < limit && limit - used <= rotateWhenLeft);
        const takeover = !rotate && used >= limit;

        if (rotate) {
          const next = commitment(g + 2);
          await move(rotation, () => {
            const deadline = now() + 30n * DAY;
            reserve(g, at, limit);
            return { at: rotation, kind: 'rotate', next, maxUses: maxUses.toString(10), deadline: deadline.toString(10), signature: signAt(g, at, rotationPayload(next, maxUses, deadline)) };
          });
        } else if (takeover) {
          // Every signature this key may make is made, but the registry has not
          // counted them all: it would refuse a takeover, and a rotation needs
          // one more signature than the key has. Signing anyway breaks the budget.
          if (at < state.maxUses) {
            throw new ProtocolFailure('KEY_EXHAUSTED', 'the attester key has made every signature it may, more than the registry has counted', true);
          }
          // rotate() would spend a signature this key no longer has.
          const next = commitment(g + 2);
          // Signed by the NEXT key, so counted against it.
          const takeoverAt = `takeover:${g + 1}`;
          await move(takeoverAt, () => {
            reserve(g + 1, 0n, maxUses);
            return { at: takeoverAt, kind: 'takeover', next, maxUses: maxUses.toString(10), signature: signAt(g + 1, 0n, takeoverPayload(next, maxUses)) };
          });
        }
        if (rotate || takeover) {
          // Sent, not yet mined. Nothing else is signed with the old key until it
          // is: an attestation now would spend a signature kept for rotating, and
          // if an earlier one then landed, the rotation would need signing afresh
          // with none left, and the key could never move on.
          if (generationOf((await options.readState()).pkCommitment) === g || round >= 2) {
            throw new ProtocolFailure('KEY_EXHAUSTED', 'the attester key is rotating; nothing is signed with it until that lands', true);
          }
          continue;
        }
        // Attestations stop short of the signatures kept for rotating (rotateWhenLeft).
        const budget = limit - rotateWhenLeft;
        if (used >= budget) {
          throw new ProtocolFailure('KEY_EXHAUSTED', 'the attester key has no signature left', true);
        }
        return { forsSeed: attesterSeed(options.master, g), useCount: at, generation: g, reserve: () => reserve(g, at, budget) };
      }
    },

    async observe() {
      const state = await options.readState();
      const g = generationOf(state.pkCommitment);
      return { useCount: landedOf(g, state.useCount), generation: g };
    },

    close() {
      closed = true;
      unlock();
    },
  };
}
