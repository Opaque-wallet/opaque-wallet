#!/usr/bin/env node
// X2's exit check, on XRPL TESTNET: receiving by tag, the way the wallet does
// it — every registration and read through the mesh.
//
//   XRP     a registered tag, paid 21.5 XRP by anyone  →  10 + 10 + 1 notes,
//           0.5 carried on the tag; TAG_STATUS says so.
//   Buy     ONRAMP_URL signs a MoonPay checkout to the pool under that tag,
//           and refuses a tag nothing would credit.
//   RLUSD   a PARTIAL payment that claims 100 and delivers 12.3  →  10 + 1 + 1
//           notes and 0.3 carried: credited by delivered_amount, never Amount.
//   none    a payment to an unregistered tag credits nothing.
//   payout  a 1 RLUSD note pays a trust-line recipient privately.
//   refused a payout the destination can't take fails before the ledger; one
//           that gets past the dry run fails ON the ledger, and the attester
//           keys it showed are retired at once by the rotation alone.
//
//   cd backend && npm run xrpl:e2e:receive

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BatchFlags, GlobalFlags, PaymentFlags, Wallet, type Batch } from 'xrpl';

import type { ApprovedRelease } from '@opaque/protocol-types';

import { xrplDeployment, xrplPool } from '../../deployments/xrpl/index.ts';
import { signQuery } from '../onramp/moonpay.ts';
import { createNoteSecret, deriveCommitment, deriveNullifier } from '../zk/index.ts';
import { signerListOf } from './attester.ts';
import { log, startHarness } from './harness.ts';
import { XRPL_STATE } from './node.ts';
import { invoiceIdOf, scopeOf } from './protocol.ts';
import { onrampUrl, registerTag, tagStatus } from './queries.ts';
import { createXrplSettlement, fromTxHash } from './settlement.ts';

const UNIT = 1_000_000;
const { networkId } = xrplDeployment.network;
const xrpPool = xrplPool('XRP');
const rlusdPool = xrplPool('RLUSD');
if (rlusdPool.asset.kind !== 'IOU') throw new Error('the RLUSD pool must be a token pool');
const { currency, issuer: ISSUER } = rlusdPool.asset;
const rlusd = (value: string) => ({ currency, issuer: ISSUER, value });
const randomTag = () => 1 + Math.floor(Math.random() * 0xfffffffe);
/** A wallet's registration: fresh notes, so many per size. */
const notesFor = (pool: string, counts: Record<number, number>) => {
  const secrets = new Map<number, Uint8Array[]>();
  const commitments: Record<string, ReturnType<typeof deriveCommitment>[]> = {};
  for (const [size, n] of Object.entries(counts)) {
    const list = Array.from({ length: n }, () => createNoteSecret());
    secrets.set(Number(size), list);
    commitments[size] = list.map((s) => deriveCommitment(s, scopeOf(networkId, pool, Number(size))));
  }
  return { secrets, commitments };
};

const h = await startHarness(19_801);
const { client, check } = h;

try {
  const { wallet: payer } = await client.fundWallet();
  const { wallet: recipient } = await client.fundWallet();

  // ── XRP, by tag, from anyone ────────────────────────────────────────────
  const tag = randomTag();
  const xrpNotes = notesFor(xrpPool.account, { [10 * UNIT]: 9, [UNIT]: 9 });
  await registerTag(h.xrpl, xrpPool.account, tag, xrpNotes.commitments);
  await h.send({ TransactionType: 'Payment', Account: payer.address, Destination: xrpPool.account, Amount: String(21_500_000), DestinationTag: tag }, payer);
  const status = await tagStatus(h.xrpl, xrpPool.account, tag);
  check('a tag payment becomes notes, read through the mesh', status.notes === 3 && status.carried === 500_000n, `${status.notes} notes, ${status.carried} drops carried`);
  const tens = new Set((await h.ring(scopeOf(networkId, xrpPool.account, 10 * UNIT))).candidates.map((c) => c.commitment as string));
  check('they are in the 10 XRP ring', xrpNotes.commitments[String(10 * UNIT)]!.slice(0, 2).every((c) => tens.has(c)), 'both 10 XRP notes');

  // ── Buy ──────────────────────────────────────────────────────────────────
  const url = new URL(await onrampUrl(h.xrpl, xrpPool.account, tag, 50));
  const signed = url.search.slice(0, url.search.lastIndexOf('&signature='));
  check('Buy is a signed checkout to the pool under the tag',
    url.searchParams.get('walletAddress') === xrpPool.account && url.searchParams.get('walletAddressTag') === String(tag)
      && url.searchParams.get('signature') === signQuery(signed, 'sk_test_opaque'),
    `${url.origin} currency ${url.searchParams.get('currencyCode')}`);
  const unregistered = randomTag();
  const noBuy = await onrampUrl(h.xrpl, xrpPool.account, unregistered, 50).then(() => 'signed', (e: Error) => e.message);
  check('Buy refuses a tag nothing would credit', /register the tag/.test(noBuy), noBuy);

  // ── nothing credits an unregistered tag ──────────────────────────────────
  await h.send({ TransactionType: 'Payment', Account: payer.address, Destination: xrpPool.account, Amount: String(2_000_000), DestinationTag: unregistered }, payer);
  const stray = await tagStatus(h.xrpl, xrpPool.account, unregistered);
  check('an unregistered tag credits nothing', !stray.registered && stray.notes === 0, 'held for the refund rule');
  const late = await registerTag(h.xrpl, xrpPool.account, unregistered, { [String(UNIT)]: [deriveCommitment(createNoteSecret(), scopeOf(networkId, xrpPool.account, UNIT))] }).then(() => 'accepted', (e: Error) => e.message);
  check('and it can never be registered after the fact', /already in use/.test(late), late);

  // ── RLUSD: a partial payment, credited by what it delivered ─────────────
  const issuer = Wallet.fromSeed((JSON.parse(readFileSync(join(XRPL_STATE, 'issuer.json'), 'utf8')) as { seed: string }).seed);
  for (const w of [payer, recipient]) await h.send({ TransactionType: 'TrustSet', Account: w.address, LimitAmount: rlusd('100000') }, w);
  await h.send({ TransactionType: 'Payment', Account: issuer.address, Destination: payer.address, Amount: rlusd('100') }, issuer);
  const rTag = randomTag();
  const rlusdNotes = notesFor(rlusdPool.account, { [10 * UNIT]: 9, [UNIT]: 9 });
  await registerTag(h.xrpl, rlusdPool.account, rTag, rlusdNotes.commitments);
  await h.send({
    TransactionType: 'Payment', Account: payer.address, Destination: rlusdPool.account, DestinationTag: rTag,
    Amount: rlusd('100'), SendMax: rlusd('12.3'), Flags: PaymentFlags.tfPartialPayment,
  }, payer);
  const partial = await tagStatus(h.xrpl, rlusdPool.account, rTag);
  check('a partial payment is credited what it delivered', partial.notes === 3 && partial.carried === 300_000n, `claimed 100, delivered 12.3: ${partial.notes} notes, ${partial.carried} carried`);

  // ── RLUSD: a private payout to a trust line ─────────────────────────────
  const one = scopeOf(networkId, rlusdPool.account, UNIT);
  const invoices = Array.from({ length: 6 }, () => createNoteSecret());
  await h.send({
    TransactionType: 'Batch', Account: payer.address, Flags: BatchFlags.tfAllOrNothing,
    RawTransactions: invoices.map((s) => ({ RawTransaction: {
      TransactionType: 'Payment', Account: payer.address, Destination: rlusdPool.account, Amount: rlusd('1'),
      DestinationTag: 0, InvoiceID: invoiceIdOf(deriveCommitment(s, one)), Flags: GlobalFlags.tfInnerBatchTxn,
    } })),
  } as Batch, payer);
  const lineOf = async (account: string) => {
    const lines = await client.request({ command: 'account_lines', account, peer: ISSUER, ledger_index: 'validated' });
    return lines.result.lines.find((l) => l.currency === currency)?.balance ?? '0';
  };
  const before = await lineOf(recipient.address);
  const paid = await h.pay(one, rlusdNotes.secrets.get(UNIT)![0]!, { account: recipient.address, tag: null });
  const after = await lineOf(recipient.address);
  check('a 1 RLUSD note pays privately', paid.state === 'SETTLED', `${paid.state} ${paid.txHash ?? ''}`);
  check('the recipient got it less the fee', Number(after) - Number(before) === 0.5, `${before} → ${after} RLUSD`);

  // ── a payout the destination can never take ─────────────────────────────
  const { wallet: noLine } = await client.fundWallet();
  const second = rlusdNotes.secrets.get(UNIT)![1]!;
  const refused = await h.pay(one, second, { account: noLine.address, tag: null });
  check('a payout to an account without the trust line fails at once', refused.state === 'FAILED' && /cannot take/.test(refused.error?.publicMessage ?? ''), `${refused.state}: ${refused.error?.publicMessage ?? ''}`);
  check('and the note is still unspent', !await h.node.pools.get(rlusdPool.account)!.source.isSpent(deriveNullifier(second, one)), 'no credential on the ledger');

  // ── a payout that fails ON the ledger ───────────────────────────────────
  // The dry run normally stops this one. A client that lies about it lets the
  // Batch through: its Payment fails on the ledger, so nothing in it applies,
  // the rotation included, while the Batch shows its signers' public keys.
  const lying = new Proxy(client, {
    get(target, key) {
      if (key === 'simulate') return async () => ({ result: { engine_result: 'tesSUCCESS' } });
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const blind = createXrplSettlement({ client: lying, pools: h.node.pools, attesters: h.node.attesters, log });
  const listed = (await signerListOf(client, rlusdPool.account)).signers;
  const release = { spend: await h.spend(one, second, { account: noLine.address, tag: null }) } as unknown as ApprovedRelease;
  const failedHash = await blind.deliver(release);
  const evidence = await blind.evidence(failedHash, release);
  const outer = await client.request({ command: 'tx', transaction: fromTxHash(failedHash) });
  const shown = ((outer.result as { tx_json?: { Signers?: { Signer: { Account: string } }[] } }).tx_json?.Signers ?? []).map((s) => s.Signer.Account);
  check('a payout that fails on the ledger is a validated Batch that paid nothing',
    outer.result.validated === true && !evidence.succeeded && shown.length === 2, `${fromTxHash(failedHash).slice(0, 12)}…, signed by ${shown.length} keys`);
  const relisted = (await signerListOf(client, rlusdPool.account)).signers;
  check('the keys it showed are retired at once', shown.every((s) => !relisted.includes(s)) && relisted.every((s) => !listed.includes(s)), `all ${listed.length} listed keys replaced`);
  check('and that note is still unspent', !await h.node.pools.get(rlusdPool.account)!.source.isSpent(deriveNullifier(second, one)), 'no credential on the ledger');
  const again = await h.pay(one, invoices[0]!, { account: recipient.address, tag: null });
  check('the pool pays again under the new keys', again.state === 'SETTLED', `${again.state} ${again.txHash ?? ''}`);
} finally {
  await h.finish('X2');
}
