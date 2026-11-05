#!/usr/bin/env node
// X1's exit check, on XRPL TESTNET, through every component:
//
//   deposits (InvoiceID, and a registered tag with a remainder carried)  →
//   the pool's deposit log  →  a ring of 8 from it  →  219-rep proof bound to
//   the recipient's account and tag  →  sealed to the CRE key  →  chunked
//   through six relays  →  the exit  →  CRE stand-in decides  →  2-of-3
//   attesters verify and multisign one Batch  →  testnet  →  evidence from the
//   ledger  →  SETTLED, read back through the mesh.  Then the same note again:
//   refused, and the ledger unchanged.
//
//   cd backend && npm run xrpl:e2e
//
// Testnet XRP from the faucet only. Prints a PASS/FAIL line per check and exits
// non-zero on any failure.

import { BatchFlags, GlobalFlags, type Batch } from 'xrpl';

import type { PoolScope } from '@opaque/protocol-types';

import { xrplDeployment, xrplPool } from '../../deployments/xrpl/index.ts';
import { createNoteSecret, deriveCommitment, deriveNullifier } from '../zk/index.ts';
import { attesterChain, signerListOf } from './attester.ts';
import { log, startHarness } from './harness.ts';
import { attesterFile } from './node.ts';
import { invoiceIdOf, scopeOf, type XrplDestination } from './protocol.ts';
import { registerTag } from './queries.ts';

const XRP = 1_000_000;
const pool = xrplPool('XRP');
const scope: PoolScope = scopeOf(xrplDeployment.network.networkId, pool.account, XRP);
const h = await startHarness(19_701);
const { client, check } = h;

try {
  log(`pool ${pool.account} on ${xrplDeployment.network.displayName}`);
  const { wallet: depositor } = await client.fundWallet();
  const { wallet: payer } = await client.fundWallet();
  const { wallet: recipient } = await client.fundWallet();

  // ── deposits: six by InvoiceID, in one Batch from one account ───────────
  const secrets = Array.from({ length: 9 }, () => createNoteSecret());
  const commitments = secrets.map((s) => deriveCommitment(s, scope));
  const before = await h.ring(scope);
  await h.send({
    TransactionType: 'Batch', Account: depositor.address, Flags: BatchFlags.tfAllOrNothing,
    RawTransactions: commitments.slice(0, 6).map((c) => ({ RawTransaction: {
      TransactionType: 'Payment', Account: depositor.address, Destination: pool.account, Amount: String(XRP),
      DestinationTag: 0, InvoiceID: invoiceIdOf(c), Flags: GlobalFlags.tfInnerBatchTxn,
    } })),
  } as Batch, depositor);

  // ── and three from anyone, by a tag the wallet registered first ─────────
  const tag = 1 + Math.floor(Math.random() * 0xfffffffe);
  await registerTag(h.xrpl, pool.account, tag, { [String(XRP)]: commitments.slice(6) });
  await h.send({ TransactionType: 'Payment', Account: payer.address, Destination: pool.account, Amount: String(3_400_000), DestinationTag: tag }, payer);

  const after = await h.ring(scope);
  const logged = new Set(after.candidates.map((c) => c.commitment as string));
  check('InvoiceID deposits become notes', commitments.slice(0, 6).every((c) => logged.has(c)), `${after.candidates.length - before.candidates.length} new 1 XRP notes`);
  check('a tag payment is split into its notes', commitments.slice(6).every((c) => logged.has(c)), `tag ${tag}: 3.4 XRP → 3 notes`);
  check('the remainder waits on the tag', h.node.pools.get(pool.account)!.source.log().carried.get(tag) === 400_000n, '0.4 XRP carried');
  const refused = await registerTag(h.xrpl, pool.account, tag, { [String(XRP)]: [deriveCommitment(createNoteSecret(), scope)] }).then(() => 'accepted', (e: Error) => e.message);
  check('a tag in use is refused', /already in use/.test(refused), refused);

  // ── a private payment ───────────────────────────────────────────────────
  const listBefore = await signerListOf(client, pool.account);
  const destination: XrplDestination = { account: recipient.address, tag: null };
  const r0 = await h.balance(recipient.address);
  const status = await h.pay(scope, secrets[0]!, destination);
  const r1 = await h.balance(recipient.address);
  const listAfter = await signerListOf(client, pool.account);
  const expectedNext = new Set(attesterFile().seeds.map((s) => {
    const chain = attesterChain(Uint8Array.from(Buffer.from(s.slice(2), 'hex')), pool.account);
    const i = listBefore.signers.map((a) => chain.indexOf(a)).find((x) => x !== undefined)!;
    return chain.addressAt(i + 1);
  }));
  check('the payment SETTLED, read through the mesh', status.state === 'SETTLED', `${status.state}${status.txHash ? ` ${status.txHash}` : ''}`);
  check('the recipient got the note less the fee', r1 - r0 === BigInt(XRP) - BigInt(pool.spendFee), `+${r1 - r0} drops`);
  check('the nullifier is on the ledger', await h.node.pools.get(pool.account)!.source.isSpent(deriveNullifier(secrets[0]!, scope)), 'credential present');
  check('every attester key rotated', listAfter.signers.every((s) => expectedNext.has(s)) && listAfter.signers.every((s) => !listBefore.signers.includes(s)), `${listBefore.signers.length} keys replaced`);

  // ── the same note again ──────────────────────────────────────────────────
  const again = await h.pay(scope, secrets[0]!, destination);
  const r2 = await h.balance(recipient.address);
  check('a reused note is refused', again.state === 'FAILED' && again.error?.code === 'NULLIFIER_SPENT', `${again.state} ${again.error?.code ?? ''}`);
  check('and nothing moved', r2 === r1, `recipient +${r2 - r1} drops`);
} finally {
  await h.finish('X1');
}
