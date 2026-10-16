#!/usr/bin/env node
// X4's MPT pool, on XRPL TESTNET: a Multi-Purpose Token gets the same private
// notes as XRP and trust-line tokens, through the same mesh, attesters and Batch.
//
//   deposits  seven by InvoiceID in one Batch, and one by tag (1.5 → one note,
//             0.5 carried), all credited by delivered_amount in the token's scale
//   payout    a 1 tMPT note pays a holder privately: 1 less the 0.5 fee
//
//   cd backend && npm run xrpl:e2e:mpt

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BatchFlags, GlobalFlags, Wallet, type Batch } from 'xrpl';

import { xrplDeployment, xrplPool } from '../../deployments/xrpl.ts';
import { createNoteSecret, deriveCommitment } from '../zk/index.ts';
import { log, startHarness } from './harness.ts';
import { XRPL_STATE } from './node.ts';
import { amountOf, invoiceIdOf, scopeOf } from './protocol.ts';
import { registerTag, tagStatus } from './queries.ts';

const UNIT = 1_000_000n;
const pool = xrplPool('tMPT');
if (pool.asset.kind !== 'MPT') throw new Error('the tMPT pool must be an MPT pool');
const asset = pool.asset;
const mpt = (units: bigint) => amountOf(asset, units);
const scope = scopeOf(xrplDeployment.network.networkId, pool.account, Number(UNIT));
const h = await startHarness(19_901);
const { client, check } = h;
const held = async (account: string) => {
  const objects = (await client.request({ command: 'account_objects', account, type: 'mptoken', ledger_index: 'validated' })).result.account_objects as unknown as { MPTokenIssuanceID: string; MPTAmount?: string }[];
  return BigInt(objects.find((o) => o.MPTokenIssuanceID.toUpperCase() === asset.issuanceId)?.MPTAmount ?? '0');
};

try {
  const issuer = Wallet.fromSeed((JSON.parse(readFileSync(join(XRPL_STATE, 'issuer-mpt.json'), 'utf8')) as { seed: string }).seed);
  const { wallet: holder } = await client.fundWallet();
  const { wallet: recipient } = await client.fundWallet();
  for (const w of [holder, recipient]) await h.send({ TransactionType: 'MPTokenAuthorize', Account: w.address, MPTokenIssuanceID: asset.issuanceId }, w);
  await h.send({ TransactionType: 'Payment', Account: issuer.address, Destination: holder.address, Amount: mpt(100n * UNIT) as never }, issuer);
  log(`  ${asset.issuanceId.slice(0, 12)}… : holder has ${await held(holder.address)} base units (scale ${asset.scale})`);

  const secrets = Array.from({ length: 8 }, () => createNoteSecret());
  const commitments = secrets.map((s) => deriveCommitment(s, scope));
  await h.send({
    TransactionType: 'Batch', Account: holder.address, Flags: BatchFlags.tfAllOrNothing,
    RawTransactions: commitments.slice(0, 7).map((c) => ({ RawTransaction: {
      TransactionType: 'Payment', Account: holder.address, Destination: pool.account, Amount: mpt(UNIT),
      DestinationTag: 0, InvoiceID: invoiceIdOf(c), Flags: GlobalFlags.tfInnerBatchTxn,
    } })),
  } as Batch, holder);
  const tag = 1 + Math.floor(Math.random() * 0xfffffffe);
  await registerTag(h.xrpl, pool.account, tag, { [String(UNIT)]: commitments.slice(7) });
  await h.send({ TransactionType: 'Payment', Account: holder.address, Destination: pool.account, Amount: mpt(1_500_000n) as never, DestinationTag: tag }, holder);

  const ring = new Set((await h.ring(scope)).candidates.map((c) => c.commitment as string));
  check('MPT deposits become notes, by InvoiceID and by tag', commitments.every((c) => ring.has(c)), `${ring.size} notes of 1 tMPT`);
  const status = await tagStatus(h.xrpl, pool.account, tag);
  check('the remainder waits on the tag, in the token\'s scale', status.notes === 1 && status.carried === 500_000n, `${status.notes} note, ${status.carried} units carried`);

  const before = await held(recipient.address);
  const paid = await h.pay(scope, secrets[0]!, { account: recipient.address, tag: null });
  const after = await held(recipient.address);
  check('a 1 tMPT note pays a holder privately', paid.state === 'SETTLED', `${paid.state} ${paid.txHash ?? ''}`);
  check('the holder got it less the fee', after - before === (UNIT - BigInt(pool.spendFee)) / 10n ** BigInt(6 - asset.scale), `+${after - before} base units`);
} finally {
  await h.finish('MPT pool');
}
