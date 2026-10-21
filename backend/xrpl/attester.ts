// One XRPL attester. The ledger cannot check a ring proof, so a quorum of these
// checks it off ledger and co-signs the payout from the pool account, whose
// master key is disabled and whose signer list is the attesters' current keys.
//
// Before signing, each attester checks, on its own:
//   1. the proof, at the pinned verifier (verifyRingSpend, 128-bit soundness);
//   2. that every ring member is a deposit of THAT note size in the pool's log
//      (a 1 XRP deposit must never stand in a 100 XRP ring);
//   3. that the ledger holds no credential for the nullifier yet;
//   4. that the spend's recipient binds exactly the account and tag being paid;
//   5. that the proposed Batch is exactly that payout, at the pool's next
//      sequence, under a fee cap, with a short validity window;
//   6. that the next signer list is each current attester's NEXT key, so a
//      coordinator cannot rotate attesters out and its own keys in.
//
// Then it signs with whichever of its keys the ledger lists now. It keeps no
// "used" state. A Batch that showed its keys without rotating them (refused,
// expired, or validated with its inner transactions failed) is followed by the
// rotation alone, which `retire` signs: a key that has been seen is never left
// on the list.

import { Wallet, type Batch, type Client, type SignerListSet } from 'xrpl';

import { ProtocolFailure, type Bytes32, type PrivateSpend, type PoolScope } from '@opaque/protocol-types';
import { asPrivateSpend } from '@opaque/protocol-types/codecs.js';

import { verifyRingSpend } from '../zk/index.ts';
import { checkProposal, payoutBatch, rotationOf } from './batch.ts';
import { ATTESTER_FLOOR_BPS, quoteSwap, swapInto } from './swap.ts';
import { keyChain, type KeyChain } from './keys.ts';
import type { PoolSource } from './pool.ts';
import { accountOf, asDestination, recipientFor, xrplChainId, type XrplDestination } from './protocol.ts';

export interface XrplPool {
  readonly source: PoolSource;
  /** Kept per note, in units: the nullifier credential's reserve plus the batch fee. */
  readonly spendFee: bigint;
}

/** A spend as it reaches XRPL: the proven spend, and the destination its recipient binds. */
export type XrplSpend = PrivateSpend & {
  readonly destination: XrplDestination;
  /** A swap into another pool: the least it delivers there, in that pool's units. */
  readonly deliverMin?: string;
};

export interface SignRequest {
  readonly spends: readonly XrplSpend[];
  readonly proposed: Batch;
}

export interface Attester {
  readonly id: string;
  /** The address after `address` in this attester's chain for `pool`, or undefined if it is not one of its keys. */
  nextAfter(pool: string, address: string): string | undefined;
  /** Its address on the pool's signer list now, if any, searching on from where it last saw one if it must. */
  currentOn(pool: string, signers: readonly string[]): string | undefined;
  sign(request: SignRequest): Promise<string>;
  /** Signs the rotation alone: every listed key to its owner's next one, and nothing else. */
  retire(pool: string, proposed: SignerListSet): Promise<string>;
}

export interface SignerList { readonly quorum: number; readonly signers: readonly string[] }

export async function signerListOf(client: Client, pool: string): Promise<SignerList> {
  const response = await client.request({ command: 'account_objects', account: pool, type: 'signer_list', ledger_index: 'validated' });
  const list = response.result.account_objects[0] as { SignerQuorum: number; SignerEntries: { SignerEntry: { Account: string } }[] } | undefined;
  if (list === undefined) throw new ProtocolFailure('SETTLEMENT_REVERTED', `${pool} has no signer list`);
  return { quorum: list.SignerQuorum, signers: list.SignerEntries.map((e) => e.SignerEntry.Account) };
}

/** Each current signer's next key, from the attester that owns it. */
export function nextSignersOf(pool: string, signers: readonly string[], peers: readonly Pick<Attester, 'nextAfter' | 'currentOn'>[]): string[] {
  for (const p of peers) p.currentOn(pool, signers);
  return signers.map((s) => {
    const next = peers.map((p) => p.nextAfter(pool, s)).find((n) => n !== undefined);
    if (next === undefined) throw new ProtocolFailure('SETTLEMENT_REVERTED', `no attester owns signer ${s}`);
    return next;
  });
}

/** The key chain an attester signs `pool`'s payouts with. One per pool: a key listed on two pools could sign twice. */
export const attesterChain = (seed: Uint8Array, pool: string): KeyChain => keyChain(seed, `attester/${pool}`);

/** How far past its last position an attester looks for its listed key: about 13 s of key derivation, once. */
const CATCH_UP = 10_000;

export function createAttester(options: {
  readonly id: string;
  readonly seed: Uint8Array;
  readonly client: Client;
  readonly networkId: number;
  /** By pool account. */
  readonly pools: ReadonlyMap<string, XrplPool>;
  readonly verifierId: Bytes32;
  /** Every attester, this one included: whose next keys the rotation must name. */
  readonly peers: () => readonly Pick<Attester, 'nextAfter' | 'currentOn'>[];
  readonly maxFeeDrops?: bigint;
  /** Ledgers a signed Batch may stay valid for. */
  readonly ledgerWindow?: number;
  /** Per pool, where to start looking for its listed key; the stack saves it across restarts. */
  readonly startIndex?: ReadonlyMap<string, number>;
  readonly onIndex?: (pool: string, index: number) => void;
}): Attester {
  const { client } = options;
  const chainId = xrplChainId(options.networkId);
  const chains = new Map([...options.pools.keys()].map((pool) => [pool, attesterChain(options.seed, pool)]));
  // Per pool, the last index seen on the ledger: where the next search starts.
  const hints = new Map(options.startIndex ?? []);
  const refuse = (code: 'INVALID_INPUT' | 'PROOF_REJECTED' | 'NULLIFIER_SPENT', why: string): never => {
    throw new ProtocolFailure(code, `attester ${options.id}: ${why}`);
  };

  const ownIndex = (pool: string, address: string): number | undefined => {
    const hint = hints.get(pool) ?? 0;
    const i = chains.get(pool)?.indexOf(address, hint);
    if (i !== undefined && i !== hint) {
      hints.set(pool, i);
      options.onIndex?.(pool, i);
    }
    return i;
  };
  /**
   * The listed key, when none of this chain's next 64 is listed: another
   * operator with the same seeds (a laptop's e2e and the hosted service) has
   * rotated past where this one last looked. The search costs the gap, once.
   */
  const catchUp = (pool: string, signers: readonly string[]): string | undefined => {
    const chain = chains.get(pool);
    if (chain === undefined) return undefined;
    const listed = new Set(signers);
    const from = (hints.get(pool) ?? 0) + 64;
    for (let i = from; i < from + CATCH_UP; i++) {
      const address = chain.addressAt(i);
      if (!listed.has(address)) continue;
      hints.set(pool, i);
      options.onIndex?.(pool, i);
      return address;
    }
    return undefined;
  };

  /** Checks `proposed` is `expected` at the pool's next sequence, then signs it with this attester's listed key. */
  async function signAs(account: string, signers: readonly string[], expected: Batch | SignerListSet, proposed: Batch | SignerListSet): Promise<string> {
    const mine = signers.find((s) => ownIndex(account, s) !== undefined) ?? refuse('INVALID_INPUT', 'not on the pool\'s signer list');
    const [info, ledger] = await Promise.all([
      client.request({ command: 'account_info', account, ledger_index: 'current' }),
      client.getLedgerIndex(),
    ]);
    checkProposal({
      expected, proposed, poolSequence: info.result.account_data.Sequence,
      maxFeeDrops: options.maxFeeDrops ?? 2_000n, maxLastLedger: ledger + (options.ledgerWindow ?? 30), networkId: options.networkId,
    });
    const key = chains.get(account)!.keyAt(ownIndex(account, mine)!);
    return new Wallet(key.publicKey, key.privateKey).sign(proposed, true).tx_blob;
  }

  return {
    id: options.id,
    nextAfter(pool, address) {
      const i = ownIndex(pool, address);
      return i === undefined ? undefined : chains.get(pool)!.addressAt(i + 1);
    },
    currentOn: (pool, signers) => signers.find((s) => ownIndex(pool, s) !== undefined) ?? catchUp(pool, signers),

    async sign(request) {
      const first = request.spends[0];
      if (first === undefined) return refuse('INVALID_INPUT', 'nothing to sign');
      const destination = asDestination(first.destination);
      const poolAddress = first.scope.pool;
      const account = accountOf(poolAddress);
      const pool = options.pools.get(account) ?? refuse('INVALID_INPUT', `does not serve pool ${account}`);
      await pool.source.sync();
      const log = pool.source.log();

      const spends: PrivateSpend[] = [];
      for (const raw of request.spends) {
        const spend = asPrivateSpend(raw, 'RING_8');
        if (spend.mode !== 'RING_8') return refuse('INVALID_INPUT', 'only ring spends');
        const scope: PoolScope = spend.scope;
        if (scope.chainId !== chainId || scope.pool !== poolAddress) refuse('INVALID_INPUT', 'one payout, one pool');
        if (!pool.source.config.sizes.includes(scope.denomination)) refuse('INVALID_INPUT', `no ${scope.denomination} note in this pool`);
        const d = asDestination(raw.destination);
        if (d.account !== destination.account || d.tag !== destination.tag) refuse('INVALID_INPUT', 'one payout, one destination');
        if (spend.recipient !== recipientFor(destination)) refuse('INVALID_INPUT', 'the proof binds a different recipient');
        const members = new Set(log.deposits.filter((x) => x.denomination === scope.denomination).map((x) => x.commitment as string));
        if (spend.ring.some((m) => !members.has(m))) refuse('INVALID_INPUT', 'a ring member is not a deposit of this size');
        if (!verifyRingSpend(spend, options.verifierId)) refuse('PROOF_REJECTED', 'the ring proof does not verify');
        if (spends.some((s) => s.nullifier === spend.nullifier)) refuse('INVALID_INPUT', 'a nullifier repeats');
        if (await pool.source.isSpent(spend.nullifier)) refuse('NULLIFIER_SPENT', 'that note is already spent');
        spends.push(spend);
      }

      const list = await signerListOf(client, account);
      const gross = spends.reduce((n, s) => n + BigInt(s.scope.denomination), 0n);
      const fees = pool.spendFee * BigInt(spends.length);
      if (gross <= fees) refuse('INVALID_INPUT', 'the notes do not cover the fee');
      // A swap: held to the market, by this attester's own quote from the ledger's AMMs.
      const deliver = swapInto(options.pools, pool.source.config.asset, destination.account, first as XrplSpend);
      if (deliver !== undefined) {
        const read = <T>(command: string, params: Record<string, unknown>) => client.request({ command, ...params } as never).then((r) => (r as { result: T }).result);
        const fair = await quoteSwap(read, pool.source.config.asset, deliver.asset, gross - fees);
        if (deliver.min * 10_000n < fair * (10_000n - ATTESTER_FLOOR_BPS)) refuse('INVALID_INPUT', 'the swap would settle below the market');
      }
      const expected = payoutBatch({
        pool: account, asset: pool.source.config.asset, nullifiers: spends.map((s) => s.nullifier),
        destination, units: gross - fees, ...(deliver === undefined ? {} : { deliver }),
        nextSigners: nextSignersOf(account, list.signers, options.peers()), quorum: list.quorum,
      });
      return signAs(account, list.signers, expected, request.proposed);
    },

    async retire(pool, proposed) {
      if (!options.pools.has(pool)) refuse('INVALID_INPUT', `does not serve pool ${pool}`);
      // Safe to sign whenever asked: it can only move each listed key to its owner's next one.
      const list = await signerListOf(client, pool);
      return signAs(pool, list.signers, rotationOf(pool, nextSignersOf(pool, list.signers, options.peers()), list.quorum), proposed);
    },
  };
}
