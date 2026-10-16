#!/usr/bin/env node
// X3's ledger mechanics on TESTNET, before any UI depends on them: a per-site
// account (site.ts) set up by one master-key Batch, then a DEX trade, an AMM
// deposit and an NFT purchase, each signed by a regular key that is retired
// in the same breath.
//
//   cd backend && npm run xrpl:spike:sites
//
// The account is faucet-funded here; e2e-sites.ts funds one from a pool.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AMMDepositFlags, Client, NFTokenCreateOfferFlags, NFTokenMintFlags, OfferCreateFlags, Wallet, type SubmittableTransaction } from 'xrpl';
import { deriveAddress, verify } from 'ripple-keypairs';

import { xrplDeployment, xrplPool } from '../../deployments/xrpl.ts';
import { nodeLedger, XRPL_STATE } from './node.ts';
import { newSite, regularKey, setupSite, signAndSubmit, signMessage, signOnly, rotate, signTx, type Site } from './site.ts';

const log = (s: string) => process.stdout.write(`${s}\n`);
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
};

const rlusdPool = xrplPool('RLUSD');
if (rlusdPool.asset.kind !== 'IOU') throw new Error('the RLUSD pool must be a token pool');
const { currency, issuer: ISSUER } = rlusdPool.asset;
const rlusd = (value: string) => ({ currency, issuer: ISSUER, value });
const client = new Client(xrplDeployment.network.wss);
await client.connect();
const ledger = nodeLedger(client);
const send = async (tx: SubmittableTransaction, wallet: Wallet) => {
  const r = await client.submitAndWait(tx, { autofill: true, wallet });
  const result = typeof r.result.meta === 'object' ? r.result.meta.TransactionResult : '?';
  if (result !== 'tesSUCCESS') throw new Error(`${tx.TransactionType}: ${result}`);
  return r.result;
};
const lineOf = async (account: string, cur: string, peer: string) =>
  Number((await client.request({ command: 'account_lines', account, peer, ledger_index: 'validated' })).result.lines.find((l) => l.currency === cur)?.balance ?? '0');
/** A transaction signed by a key the account no longer lists: refused before the ledger. */
const refusedFor = async (site: Site, key: { address: string; publicKey: string; privateKey: string }) => {
  const seq = (await client.request({ command: 'account_info', account: site.address, ledger_index: 'current' })).result.account_data.Sequence;
  const signed = signTx({ TransactionType: 'AccountSet', Account: site.address, Sequence: seq, Fee: '12', LastLedgerSequence: await client.getLedgerIndex() + 20 }, key);
  return (await ledger.submit(signed.blob)).engine_result;
};

try {
  // ── a market: an offer, an AMM, an NFT for sale ─────────────────────────
  const issuer = Wallet.fromSeed((JSON.parse(readFileSync(join(XRPL_STATE, 'issuer.json'), 'utf8')) as { seed: string }).seed);
  const { wallet: maker } = await client.fundWallet();
  await client.fundWallet(maker);
  await send({ TransactionType: 'TrustSet', Account: maker.address, LimitAmount: rlusd('1000000') }, maker);
  await send({ TransactionType: 'Payment', Account: issuer.address, Destination: maker.address, Amount: rlusd('1000') }, issuer);
  await send({ TransactionType: 'OfferCreate', Account: maker.address, TakerGets: rlusd('100'), TakerPays: '100000000' }, maker);
  const amm = await client.request({ command: 'amm_info', asset: { currency: 'XRP' }, asset2: { currency, issuer: ISSUER } }).catch(() => null);
  if (amm === null) await send({ TransactionType: 'AMMCreate', Account: maker.address, Amount: '50000000', Amount2: rlusd('50'), TradingFee: 500 }, maker);
  const { wallet: minter } = await client.fundWallet();
  const minted = await send({ TransactionType: 'NFTokenMint', Account: minter.address, NFTokenTaxon: 0, Flags: NFTokenMintFlags.tfTransferable }, minter);
  const nftId = (minted.meta as { nftoken_id?: string }).nftoken_id!;
  const listed = await send({ TransactionType: 'NFTokenCreateOffer', Account: minter.address, NFTokenID: nftId, Amount: '1000000', Flags: NFTokenCreateOfferFlags.tfSellNFToken }, minter);
  const offerId = (listed.meta as { offer_id?: string }).offer_id!;
  log(`market: offer 1 RLUSD/XRP, AMM XRP/RLUSD, NFT ${nftId.slice(0, 12)}… for 1 XRP`);

  // ── the per-site account ─────────────────────────────────────────────────
  const site = newSite('https://dex.example');
  const masterKey = (await import('ripple-keypairs')).deriveKeypair(site.masterSeed);
  await client.fundWallet(new Wallet(masterKey.publicKey, masterKey.privateKey));
  await setupSite(ledger, site, [{ currency, issuer: ISSUER }]);
  const info = (await client.request({ command: 'account_info', account: site.address, ledger_index: 'validated' })).result.account_data;
  check('the master key sets regular key 0 and a trust line, then turns itself off', site.index === 0 && info.RegularKey === regularKey(site, 0).address, `${site.address}`);

  const trade = await signAndSubmit(ledger, site, {
    TransactionType: 'OfferCreate', Account: site.address, TakerGets: '2000000', TakerPays: rlusd('1.5'), Flags: OfferCreateFlags.tfImmediateOrCancel,
  });
  check('a DEX trade, with the key rotated in the same Batch', trade.result === 'tesSUCCESS' && site.index === 1, `${trade.result}, ${await lineOf(site.address, currency, ISSUER)} RLUSD, key ${site.index}`);

  const deposit = await signAndSubmit(ledger, site, {
    TransactionType: 'AMMDeposit', Account: site.address, Asset: { currency: 'XRP' }, Asset2: { currency, issuer: ISSUER }, Amount: '1000000', Flags: AMMDepositFlags.tfSingleAsset,
  });
  const ammInfo = (await client.request({ command: 'amm_info', asset: { currency: 'XRP' }, asset2: { currency, issuer: ISSUER } })).result.amm;
  const lp = await lineOf(site.address, ammInfo.lp_token.currency, ammInfo.account);
  check('an AMM deposit, key rotated', deposit.result === 'tesSUCCESS' && lp > 0 && site.index === 2, `${deposit.result}, ${lp} LP tokens, key ${site.index}`);

  // Sign-only: the dapp submits; the rotation waits for it.
  const signed = await signOnly(ledger, site, { TransactionType: 'NFTokenAcceptOffer', Account: site.address, NFTokenSellOffer: offerId });
  const bought = await client.submitAndWait(signed.tx_blob);
  await rotate(ledger, site);
  const nfts = (await client.request({ command: 'account_nfts', account: site.address, ledger_index: 'validated' })).result.account_nfts;
  check('an NFT bought by a dapp that submits itself, then the key rotated',
    typeof bought.result.meta === 'object' && bought.result.meta.TransactionResult === 'tesSUCCESS' && nfts.some((n) => n.NFTokenID === nftId) && site.index === 3,
    `owns ${nfts.length} NFT, key ${site.index}`);

  const old = await Promise.all([0, 1, 2].map((i) => refusedFor(site, regularKey(site, i))));
  check('every retired regular key is refused', old.every((r) => r.startsWith('tef')), old.join(' '));
  const viaMaster = await refusedFor(site, { address: site.address, ...masterKey });
  check('the master key cannot move funds', viaMaster === 'tefMASTER_DISABLED', viaMaster);
  const message = signMessage(site, 'sign in to dex.example');
  check('signMessage proves the account', verify(Buffer.from(message.message).toString('hex').toUpperCase(), message.signature, message.publicKey) && deriveAddress(message.publicKey) === site.address, 'master key signature');
} finally {
  await client.disconnect();
}

log(failures === 0 ? '\nper-site accounts passed on testnet' : `\nper-site accounts FAILED: ${failures} check(s)`);
process.exitCode = failures === 0 ? 0 : 1;
