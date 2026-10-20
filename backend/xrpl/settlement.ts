// Settling a released XRPL spend: the coordinator between the executor's
// settler (cre/settler.ts) and the attester quorum.
//
//   deliver    builds the payout Batch, autofills it once, asks attesters to
//              sign until a quorum has, combines their signatures, submits.
//   evidence   reads the ledger: the Batch validated AND its inner Payment
//              succeeded. A failed ALLORNOTHING batch still reports tesSUCCESS
//              outside and records none of its inner transactions, so the
//              outer result proves nothing on its own.
//   spent      the ledger holds the pool's credential for the nullifier.
//
// One Batch at a time per pool: each one consumes the pool's sequence and
// rotates its signer list, so a second built in parallel would be refused. A
// Batch that showed its signers' public keys without rotating them is followed
// at once by the rotation alone (retireIfListed).

import { decode, GlobalFlags, hashes, multisign, type Batch, type Client } from 'xrpl';

import { ProtocolFailure, type ApprovedRelease, type PrivateSpend, type TxHash } from '@opaque/protocol-types';
import { spendHash } from '@opaque/protocol-types/codecs.js';

import type { SettlementEvidence } from '../cre/intent-store.ts';
import { payoutBatch, rotationOf } from './batch.ts';
import { nextSignersOf, signerListOf, type Attester, type SignerList, type XrplPool, type XrplSpend } from './attester.ts';
import { accountOf, asDestination, type XrplAsset } from './protocol.ts';
import { swapInto } from './swap.ts';

export const toTxHash = (hash: string): TxHash => `0x${hash.toLowerCase()}` as TxHash;

export const fromTxHash = (hash: TxHash): string => hash.slice(2).toUpperCase();

/** An attester's refusals that no retry can fix: the settler fails the intent on these. */
const FINAL = new Set(['PROOF_REJECTED', 'NULLIFIER_SPENT']);

export interface XrplSettlement {
  deliver(release: ApprovedRelease): Promise<TxHash>;
  evidence(txHash: TxHash, release: ApprovedRelease): Promise<SettlementEvidence>;
  nullifierSpent(spend: PrivateSpend): Promise<boolean>;
}

export function createXrplSettlement(options: {
  readonly client: Client;
  readonly pools: ReadonlyMap<string, XrplPool>;
  readonly attesters: readonly Attester[];
  readonly log?: (line: string) => void;
}): XrplSettlement {
  const { client } = options;
  const tails = new Map<string, Promise<unknown>>();
  const inTurn = <T>(pool: string, run: () => Promise<T>): Promise<T> => {
    const next = (tails.get(pool) ?? Promise.resolve()).then(run, run);
    tails.set(pool, next.catch(() => undefined));
    return next;
  };
  const poolOf = (spend: PrivateSpend): { account: string; pool: XrplPool } => {
    const account = accountOf(spend.scope.pool);
    const pool = options.pools.get(account);
    if (pool === undefined) throw new ProtocolFailure('INVALID_INPUT', `no XRPL pool ${account}`);
    return { account, pool };
  };

  /** A payment into another pool of another asset is a swap, and must name the least it delivers. */
  const swapOf = (asset: XrplAsset, destination: string, spend: XrplSpend) => swapInto(options.pools, asset, destination, spend);

  async function payout(spends: readonly XrplSpend[]): Promise<string> {
    const { account, pool } = poolOf(spends[0]!);
    const list = await signerListOf(client, account);
    const units = spends.reduce((n, s) => n + BigInt(s.scope.denomination), 0n) - pool.spendFee * BigInt(spends.length);
    const destination = asDestination(spends[0]!.destination);
    const deliver = swapOf(pool.source.config.asset, destination.account, spends[0]!);
    const batch = payoutBatch({
      pool: account, asset: pool.source.config.asset, nullifiers: spends.map((s) => s.nullifier),
      destination, units, ...(deliver === undefined ? {} : { deliver }),
      nextSigners: nextSignersOf(account, list.signers, options.attesters), quorum: list.quorum,
    });
    // A payment the destination can never take — no trust line, under the
    // reserve for a new account, a tag it requires — would fail the Batch on
    // every retry while the note sat reserved. Ask the ledger first, and fail
    // the intent for good if it says no; the wallet then frees the note.
    const payment = batch.RawTransactions.find((r) => r.RawTransaction.TransactionType === 'Payment')!.RawTransaction;
    // Simulated on its own, so without the inner-batch flag; a swap keeps its partial-payment one.
    const { Flags: flags, ...rest } = payment as unknown as Record<string, unknown>;
    const outer = Number(flags ?? 0) & ~GlobalFlags.tfInnerBatchTxn;
    const alone = outer === 0 ? rest : { ...rest, Flags: outer };
    const dry = await client.simulate(alone as never).then((r) => r.result.engine_result, () => 'unknown');
    if (dry.startsWith('tec')) {
      throw new ProtocolFailure('SETTLEMENT_REVERTED', `the destination cannot take this payment (${dry})`, false);
    }
    const proposed = await client.autofill(batch, list.quorum) as Batch;

    // Only attesters on the list now can sign; ask them in a random order, so
    // no one attester is always the one that sees every payout first.
    const listed = options.attesters.filter((a) => a.currentOn(account, list.signers) !== undefined).sort(() => Math.random() - 0.5);
    const blobs: string[] = [];
    const signedBy: Attester[] = [];
    const refusals: string[] = [];
    for (const attester of listed) {
      if (blobs.length === list.quorum) break;
      try {
        blobs.push(await attester.sign({ spends, proposed }));
        signedBy.push(attester);
      } catch (error) {
        if (error instanceof ProtocolFailure && FINAL.has(error.code)) throw error;
        refusals.push((error as Error).message);
      }
    }
    // Short of a quorum, the signatures never leave this process: nothing is shown.
    if (blobs.length < list.quorum) {
      throw new ProtocolFailure('SETTLEMENT_REVERTED', `quorum not reached (${blobs.length}/${list.quorum}): ${refusals.join('; ')}`, true);
    }
    const signed = multisign(blobs);
    const hash = hashes.hashSignedTx(signed);
    try {
      const submitted = await client.submit(signed);
      const preliminary = submitted.result.engine_result;
      // Thrown only when the ledger certainly never applied it. From here on the
      // hash is returned whatever happens, and evidence() reads the outcome: a
      // payout that landed must never be retried as if it had not.
      if (/^te[mfl]/.test(preliminary)) {
        throw new ProtocolFailure('SETTLEMENT_REVERTED', `payout refused before the ledger: ${preliminary}`, true);
      }
      options.log?.(`  xrpl payout ${hash} (${spends.length} note${spends.length === 1 ? '' : 's'}, preliminary ${preliminary})`);
      // Hold this pool's turn until the ledger decides: the next payout needs
      // the sequence and signer list this one leaves behind.
      await untilFinal(hash, proposed.LastLedgerSequence ?? 0).catch(() => undefined);
      return hash;
    } finally {
      // The signing keys' public keys are out now, whatever became of the Batch.
      await retireIfListed(account, list, signedBy);
    }
  }

  /**
   * If `before` is still the pool's signer list, the payout's own rotation did
   * not apply, and the keys that signed it stay listed with their public keys
   * known: rotate them now, with the rotation alone. The keys already shown sign
   * it, so the third stays unseen. Best effort: a failure here is logged, and
   * the next payout's rotation retires them instead.
   */
  async function retireIfListed(account: string, before: SignerList, shown: readonly Attester[]): Promise<void> {
    try {
      const now = await signerListOf(client, account);
      if (now.signers.join() !== before.signers.join()) return;
      const rotation = rotationOf(account, nextSignersOf(account, now.signers, options.attesters), now.quorum);
      const proposed = await client.autofill(rotation, now.quorum);
      const order = [...shown, ...options.attesters.filter((a) => !shown.includes(a) && a.currentOn(account, now.signers) !== undefined)];
      const blobs: string[] = [];
      const refusals: string[] = [];
      for (const attester of order) {
        if (blobs.length === now.quorum) break;
        try { blobs.push(await attester.retire(account, proposed)); } catch (error) { refusals.push((error as Error).message); }
      }
      if (blobs.length < now.quorum) throw new Error(`only ${blobs.length}/${now.quorum} signed the rotation: ${refusals.join('; ')}`);
      const signed = multisign(blobs);
      const hash = hashes.hashSignedTx(signed);
      await client.submit(signed);
      const final = await untilFinal(hash, proposed.LastLedgerSequence ?? 0);
      const result = typeof final?.result.meta === 'object' ? final.result.meta.TransactionResult : 'not validated';
      options.log?.(`  retired the keys a payout showed without rotating: ${hash} ${result}`);
    } catch (error) {
      options.log?.(`  could not retire the keys a payout showed: ${(error as Error).message}`);
    }
  }

  /** The validated tx, or null once its LastLedgerSequence has passed without it. */
  async function untilFinal(hash: string, lastLedger: number) {
    for (;;) {
      const tx = await client.request({ command: 'tx', transaction: hash }).catch(() => null);
      if (tx?.result.validated === true) return tx;
      if (lastLedger > 0 && await client.getLedgerIndex() > lastLedger) return null;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  const nullifierSpent = (spend: PrivateSpend) => poolOf(spend).pool.source.isSpent(spend.nullifier);

  return {
    nullifierSpent,
    async deliver(release) {
      const spend = release.spend as XrplSpend;
      const { account, pool } = poolOf(spend);
      const hash = await inTurn(account, () => payout([spend]));
      if (spend.mode === 'RING_8') pool.source.noteRing(spend.ring);
      return toTxHash(hash);
    },

    async evidence(txHash, release) {
      const spend = release.spend as XrplSpend;
      const failed = { txHash, spendHash: spendHash(release.spend), succeeded: false };
      // Not found is inconclusive: the settler retries, and its retry looks at
      // the nullifier before it sends anything again.
      const lookup = await client.request({ command: 'tx', transaction: fromTxHash(txHash) }).catch(() => null);
      if (lookup === null) return failed;
      const lastLedger = Number((lookup.result as { tx_json?: { LastLedgerSequence?: number } }).tx_json?.LastLedgerSequence ?? 0);
      const outer = lookup.result.validated === true ? lookup : lastLedger > 0 ? await untilFinal(fromTxHash(txHash), lastLedger) : null;
      if (outer === null || outer.result.validated !== true) return failed;
      const tx = (outer.result as { tx_json?: Batch }).tx_json ?? decode(String((outer.result as { tx_blob?: string }).tx_blob)) as unknown as Batch;
      const payment = tx.RawTransactions?.map((r) => r.RawTransaction).find((t) => t.TransactionType === 'Payment');
      if (payment === undefined) return failed;
      const destination = asDestination(spend.destination);
      const inner = await client.request({ command: 'tx', transaction: hashes.hashSignedTx(payment) }).catch(() => null);
      const meta = inner?.result.meta;
      const paid = inner?.result.validated === true && typeof meta === 'object' && meta.TransactionResult === 'tesSUCCESS'
        && (payment as { Destination?: string }).Destination === destination.account
        && ((payment as { DestinationTag?: number }).DestinationTag ?? null) === destination.tag;
      return { ...failed, succeeded: paid && await nullifierSpent(release.spend) };
    },
  };
}
