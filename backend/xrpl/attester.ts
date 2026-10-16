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
// "used" state: if a Batch it signed never lands, the same key is still listed
// and signs the retry, which spends only time, never a second key's secrecy.

import { Wallet, type Batch, type Client } from 'xrpl';

import { ProtocolFailure, type Bytes32, type PrivateSpend, type PoolScope } from '@opaque/protocol-types';
import { asPrivateSpend } from '@opaque/protocol-types/codecs.js';

import { verifyRingSpend } from '../zk/index.ts';
import { checkProposal, payoutBatch } from './batch.ts';
import { keyChain, type KeyChain } from './keys.ts';
import type { PoolSource } from './pool.ts';
import { accountOf, asDestination, recipientFor, xrplChainId, type XrplDestination } from './protocol.ts';

export interface XrplPool {
  readonly source: PoolSource;
  /** Kept per note, in units: the nullifier credential's reserve plus the batch fee. */
  readonly spendFee: bigint;
}

/** A spend as it reaches XRPL: the proven spend, and the destination its recipient binds. */
export type XrplSpend = PrivateSpend & { readonly destination: XrplDestination };

export interface SignRequest {
  readonly spends: readonly XrplSpend[];
  readonly proposed: Batch;
}

export interface Attester {
  readonly id: string;
  /** The address after `address` in this attester's chain for `pool`, or undefined if it is not one of its keys. */
  nextAfter(pool: string, address: string): string | undefined;
  /** Its address on the pool's signer list now, if any. */
  currentOn(pool: string, signers: readonly string[]): string | undefined;
  sign(request: SignRequest): Promise<string>;
}

export interface SignerList { readonly quorum: number; readonly signers: readonly string[] }

export async function signerListOf(client: Client, pool: string): Promise<SignerList> {
  const response = await client.request({ command: 'account_objects', account: pool, type: 'signer_list', ledger_index: 'validated' });
  const list = response.result.account_objects[0] as { SignerQuorum: number; SignerEntries: { SignerEntry: { Account: string } }[] } | undefined;
  if (list === undefined) throw new ProtocolFailure('SETTLEMENT_REVERTED', `${pool} has no signer list`);
  return { quorum: list.SignerQuorum, signers: list.SignerEntries.map((e) => e.SignerEntry.Account) };
}

/** Each current signer's next key, from the attester that owns it. */
export function nextSignersOf(pool: string, signers: readonly string[], peers: readonly Pick<Attester, 'nextAfter'>[]): string[] {
  return signers.map((s) => {
    const next = peers.map((p) => p.nextAfter(pool, s)).find((n) => n !== undefined);
    if (next === undefined) throw new ProtocolFailure('SETTLEMENT_REVERTED', `no attester owns signer ${s}`);
    return next;
  });
}

/** The key chain an attester signs `pool`'s payouts with. One per pool: a key listed on two pools could sign twice. */
export const attesterChain = (seed: Uint8Array, pool: string): KeyChain => keyChain(seed, `attester/${pool}`);

export function createAttester(options: {
  readonly id: string;
  readonly seed: Uint8Array;
  readonly client: Client;
  readonly networkId: number;
  /** By pool account. */
  readonly pools: ReadonlyMap<string, XrplPool>;
  readonly verifierId: Bytes32;
  /** Every attester, this one included: whose next keys the rotation must name. */
  readonly peers: () => readonly Pick<Attester, 'nextAfter'>[];
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

  return {
    id: options.id,
    nextAfter(pool, address) {
      const i = ownIndex(pool, address);
      return i === undefined ? undefined : chains.get(pool)!.addressAt(i + 1);
    },
    currentOn: (pool, signers) => signers.find((s) => ownIndex(pool, s) !== undefined),

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
      const mine = list.signers.find((s) => ownIndex(account, s) !== undefined) ?? refuse('INVALID_INPUT', 'not on the pool\'s signer list');
      const gross = spends.reduce((n, s) => n + BigInt(s.scope.denomination), 0n);
      const fees = pool.spendFee * BigInt(spends.length);
      if (gross <= fees) refuse('INVALID_INPUT', 'the notes do not cover the fee');
      const expected = payoutBatch({
        pool: account, asset: pool.source.config.asset, nullifiers: spends.map((s) => s.nullifier),
        destination, units: gross - fees, nextSigners: nextSignersOf(account, list.signers, options.peers()), quorum: list.quorum,
      });
      const [info, ledger] = await Promise.all([
        client.request({ command: 'account_info', account, ledger_index: 'current' }),
        client.getLedgerIndex(),
      ]);
      checkProposal({
        expected, proposed: request.proposed, poolSequence: info.result.account_data.Sequence,
        maxFeeDrops: options.maxFeeDrops ?? 2_000n, maxLastLedger: ledger + (options.ledgerWindow ?? 30), networkId: options.networkId,
      });
      const key = chains.get(account)!.keyAt(ownIndex(account, mine)!);
      return new Wallet(key.publicKey, key.privateKey).sign(request.proposed, true).tx_blob;
    },
  };
}
