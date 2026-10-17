#!/usr/bin/env node
// X3's exit check, on XRPL TESTNET, in a real browser: an ordinary dapp on
// xrpl-connect (demo/xrpl-dapp) uses Opaque through its adapter.
//
//   cd backend && npm run xrpl:e2e:dapp [-- --close]
//
// Three origins, as in life: the wallet (127.0.0.1:5199), its connect popup
// (the same origin), and the dapp (localhost:5299). Node sets up a market —
// a DEX offer, an AMM, an NFT for sale — and gives the wallet 20 XRP of notes.
// Then, clicking in the dapp and approving in the popup:
//   connect   a fresh account for the dapp, funded privately by the XRP pool
//   trade     DEX OfferCreate, signAndSubmit
//   amm       AMMDeposit, signAndSubmit
//   nft       NFTokenAcceptOffer, sign only: the dapp submits it itself
//   message   signMessage, by the disabled master key
// Checks, from the ledger: the dapp's account was funded by the pool, holds
// the RLUSD, the LP tokens and the NFT, its master key is off, and each of its
// regular keys signed once. With --close it then waits out the 256 ledgers the
// ledger keeps an account, closes it from the wallet's Apps view, and checks
// the account is gone and its XRP came back to the pool under the wallet's tag.
// Fails if the wallet or the popup sent a request anywhere but their origin
// and the stack.
//
// With --walletconnect (WALLETCONNECT_PROJECT_ID set), the dapp connects with
// xrpl-connect's OWN WalletConnect adapter instead, as a dapp that has never
// heard of Opaque would: its link is pasted into Opaque's connect page, whose
// relay socket goes through the stack (sockets are policed too). Message
// signing is not a WalletConnect method, so that one step is skipped.

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BatchFlags, Client, GlobalFlags, NFTokenCreateOfferFlags, NFTokenMintFlags, Wallet, type Batch, type SubmittableTransaction } from 'xrpl';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { xrplDeployment, xrplPool } from '../../deployments/xrpl.ts';
import { createNoteSecret, deriveCommitment } from '../zk/index.ts';
import { startXrpl, XRPL_STATE } from '../xrpl/node.ts';
import { invoiceIdOf, scopeOf } from '../xrpl/protocol.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const WALLET = 'http://127.0.0.1:5199';
const DAPP = 'http://localhost:5299';
const CLOSE = process.argv.includes('--close');
const WC = process.argv.includes('--walletconnect') ? process.env['WALLETCONNECT_PROJECT_ID'] ?? '' : undefined;
if (WC === '') throw new Error('--walletconnect needs WALLETCONNECT_PROJECT_ID (a Reown project id)');
if (WC !== undefined && CLOSE) throw new Error('--close runs without --walletconnect');
const log = (s: string) => process.stdout.write(`${s}\n`);
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
};

function start(cmd: string, args: string[], cwd: string, ready: RegExp, env: Record<string, string> = {}): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => reject(new Error(`${cmd} ${args.join(' ')} did not start`)), 120_000);
    const watch = (b: Buffer) => { if (ready.test(b.toString())) { clearTimeout(timer); resolve(child); } };
    child.stdout!.on('data', watch);
    child.stderr!.on('data', watch);
    child.on('exit', (code) => reject(new Error(`${cmd} exited ${code}`)));
  });
}

const xrpPool = xrplPool('XRP');
const rlusdPool = xrplPool('RLUSD');
if (rlusdPool.asset.kind !== 'IOU') throw new Error('the RLUSD pool must be a token pool');
const { currency, issuer: ISSUER } = rlusdPool.asset;
const rlusd = (value: string) => ({ currency, issuer: ISSUER, value });
const client = new Client(xrplDeployment.network.wss);
const children: ChildProcess[] = [];
let browser: any;

const send = async (tx: SubmittableTransaction, wallet: Wallet) => {
  const r = await client.submitAndWait(tx, { autofill: true, wallet });
  const result = typeof r.result.meta === 'object' ? r.result.meta.TransactionResult : '?';
  if (result !== 'tesSUCCESS') throw new Error(`${tx.TransactionType}: ${result}`);
  return r.result;
};

try {
  await client.connect();
  // ── the market, and a 10 XRP ring big enough to fund an account from ────
  const node = await startXrpl();
  const tens = scopeOf(xrplDeployment.network.networkId, xrpPool.account, 10_000_000);
  const have = (await node.ringSnapshot(tens)).candidates.length;
  await node.close();
  if (have < 8) {
    const { wallet: seeder } = await client.fundWallet();
    await send({
      TransactionType: 'Batch', Account: seeder.address, Flags: BatchFlags.tfAllOrNothing,
      RawTransactions: Array.from({ length: Math.max(2, 8 - have) }, () => ({ RawTransaction: {
        TransactionType: 'Payment', Account: seeder.address, Destination: xrpPool.account, Amount: '10000000',
        DestinationTag: 0, InvoiceID: invoiceIdOf(deriveCommitment(createNoteSecret(), tens)), Flags: GlobalFlags.tfInnerBatchTxn,
      } })),
    } as Batch, seeder);
    log(`  seeded the 10 XRP ring: ${have} → ${have + Math.max(2, 8 - have)} deposits (one operator's: no anonymity set)`);
  }
  const issuer = Wallet.fromSeed((JSON.parse(readFileSync(join(XRPL_STATE, 'issuer.json'), 'utf8')) as { seed: string }).seed);
  const { wallet: maker } = await client.fundWallet();
  await send({ TransactionType: 'TrustSet', Account: maker.address, LimitAmount: rlusd('1000000') }, maker);
  await send({ TransactionType: 'Payment', Account: issuer.address, Destination: maker.address, Amount: rlusd('500') }, issuer);
  await send({ TransactionType: 'OfferCreate', Account: maker.address, TakerGets: rlusd('50'), TakerPays: '50000000' }, maker);
  const ammExists = await client.request({ command: 'amm_info', asset: { currency: 'XRP' }, asset2: { currency, issuer: ISSUER } }).then(() => true, () => false);
  if (!ammExists) await send({ TransactionType: 'AMMCreate', Account: maker.address, Amount: '20000000', Amount2: rlusd('20'), TradingFee: 500 }, maker);
  const { wallet: minter } = await client.fundWallet();
  const minted = await send({ TransactionType: 'NFTokenMint', Account: minter.address, NFTokenTaxon: 0, Flags: NFTokenMintFlags.tfTransferable }, minter);
  const nftId = (minted.meta as { nftoken_id?: string }).nftoken_id!;
  const offer = (await send({ TransactionType: 'NFTokenCreateOffer', Account: minter.address, NFTokenID: nftId, Amount: '1000000', Flags: NFTokenCreateOfferFlags.tfSellNFToken }, minter)).meta as { offer_id?: string };
  log('  market ready: a DEX offer, the XRP/RLUSD AMM, an NFT for sale at 1 XRP');

  // WalletConnect's relay and Verify are reached through the stack's one port.
  children.push(await start('node', ['--use-system-ca', 'xrpl/stack.ts'], join(ROOT, 'backend'), /wallet cfg/,
    WC === undefined ? {} : { PORT: '18990', WALLETCONNECT_PROJECT_ID: WC }));
  children.push(await start('npx', ['vite', '--port', '5199', '--strictPort', '--host', '127.0.0.1'], join(ROOT, 'frontend'), /ready in|Local:/));
  children.push(await start('npx', ['vite', '--port', '5299', '--strictPort', '--host', 'localhost'], join(ROOT, 'demo', 'xrpl-dapp'), /ready in|Local:/));

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  const outside: string[] = [];
  const police = (p: any) => {
    p.on('request', (r: any) => {
      const u = r.url();
      if (!u.startsWith('http://127.0.0.1:') && !u.startsWith('blob:') && !u.startsWith('data:')) outside.push(u);
    });
    p.on('websocket', (ws: any) => { if (!ws.url().startsWith('ws://127.0.0.1:')) outside.push(ws.url()); });
  };

  // ── the wallet: 20 XRP of notes, received by tag ─────────────────────────
  const wallet = await context.newPage();
  police(wallet);
  await wallet.goto(`${WALLET}/xrpl.html`);
  await wallet.waitForFunction(() => document.getElementById('account-short')?.textContent === 'Notes in this browser', null, { timeout: 60_000 });
  await wallet.click('#tab-receive');
  await wallet.fill('#receive-expected', '20');
  await wallet.click('#receive-button');
  await wallet.waitForFunction(() => (document.getElementById('receive-tag')?.textContent ?? '') !== '', null, { timeout: 90_000 });
  const { wallet: payer } = await client.fundWallet();
  await send({ TransactionType: 'Payment', Account: payer.address, Destination: xrpPool.account, Amount: '20000000', DestinationTag: Number(await wallet.textContent('#receive-tag')) }, payer);
  await wallet.click('#tab-home');
  for (let i = 0; i < 20 && (await wallet.textContent('#balance-main')) !== '20'; i++) {
    await wallet.click('#refresh');
    await new Promise((r) => setTimeout(r, 4_000));
  }
  check('the wallet holds 20 private XRP', (await wallet.textContent('#balance-main')) === '20', String(await wallet.textContent('#note-count')));

  // ── the dapp ─────────────────────────────────────────────────────────────
  const dapp = await context.newPage();
  await dapp.goto(`${DAPP}/?wallet=${encodeURIComponent(`${WALLET}/xrpl-connect.html`)}&currency=${currency}&issuer=${ISSUER}&nftOffer=${offer.offer_id}${WC === undefined ? '' : `&wc=${WC}`}`);
  let popup: any;
  if (WC !== undefined) {
    // The user opens Opaque's connect page themselves; nothing opens it for them.
    popup = await context.newPage();
    police(popup);
    await popup.goto(`${WALLET}/xrpl-connect.html`);
    await popup.waitForFunction(() => !(document.getElementById('wc-form') as HTMLElement).hidden, null, { timeout: 90_000 });
  }
  const logged = (id: string) => dapp.waitForFunction((k: string) => new RegExp(`^${k}( failed)?:`, 'm').test(document.getElementById('log')?.textContent ?? ''), id, { timeout: 300_000, polling: 1_000 });
  const lineOf = async (id: string) => ((await dapp.textContent('#log')) ?? '').split('\n').find((l: string) => l.startsWith(`${id}:`) || l.startsWith(`${id} failed:`)) ?? '';
  /** Clicks in the dapp, approves in the popup, returns the dapp's log line. */
  async function act(id: string, title: RegExp): Promise<string> {
    const opened = popup === undefined ? context.waitForEvent('page') : undefined;
    await dapp.click(`#${id}`);
    if (opened !== undefined) {
      popup = await opened;
      police(popup);
    }
    if (id === 'connect-wc') {
      // The link the dapp shows, pasted into Opaque, as a person would.
      await dapp.waitForFunction(() => /^wc:/.test(document.getElementById('wc-uri')?.textContent ?? ''), null, { timeout: 60_000 });
      await popup.fill('#wc-uri', String(await dapp.textContent('#wc-uri')));
      await popup.click('#wc-connect');
    }
    await popup.waitForFunction((t: string) => new RegExp(t).test(document.getElementById('request-title')?.textContent ?? '')
      && !(document.getElementById('approve') as HTMLButtonElement).disabled, title.source, { timeout: 120_000 });
    await popup.click('#approve');
    await logged(id);
    return lineOf(id);
  }

  const t0 = Date.now();
  const connected = await act(WC === undefined ? 'connect' : 'connect-wc', /Connect privately/);
  const site = /connected (r\w+)/.exec(connected)?.[1] ?? '';
  check(`connect${WC === undefined ? '' : ' over WalletConnect'}: a fresh account for the dapp, funded privately`, site !== '', `${connected} in ${Math.round((Date.now() - t0) / 1000)} s`);
  const trade = await act('trade', /Sign and submit/);
  check('a DEX trade from the dapp', /tesSUCCESS/.test(trade), trade);
  const amm = await act('amm', /Sign and submit/);
  check('an AMM deposit from the dapp', /tesSUCCESS/.test(amm), amm);
  const nft = await act('nft', /Sign \(the site submits it\)/);
  check('an NFT bought by a dapp that submits itself', /tesSUCCESS/.test(nft), nft);
  if (WC === undefined) {
    const message = await act('message', /Sign a message/);
    check('signMessage', /signature/.test(message), message);
  }

  // ── what the ledger says about the dapp's account ───────────────────────
  const history = (await client.request({ command: 'account_tx', account: site, forward: true, limit: 50 })).result.transactions;
  const funder = history.map((t) => t.tx_json as { TransactionType: string; Account: string; Destination?: string }).find((t) => t.TransactionType === 'Payment' && t.Destination === site);
  check('the ledger names the pool as its funder, never the user', funder?.Account === xrpPool.account, `funded by ${funder?.Account}`);
  const info = (await client.request({ command: 'account_info', account: site, ledger_index: 'validated' })).result.account_data;
  check('its master key is off', (info.Flags & 0x0010_0000) !== 0, `RegularKey ${info.RegularKey}`);
  const lines = (await client.request({ command: 'account_lines', account: site, ledger_index: 'validated' })).result.lines;
  const nfts = (await client.request({ command: 'account_nfts', account: site, ledger_index: 'validated' })).result.account_nfts;
  check('it holds the RLUSD, the LP tokens and the NFT', lines.some((l) => l.currency === currency && Number(l.balance) > 0) && lines.length >= 2 && nfts.some((n) => n.NFTokenID === nftId),
    `${lines.map((l) => `${Number(l.balance).toFixed(3)} ${l.currency.slice(0, 6)}`).join(', ')}, ${nfts.length} NFT`);
  const keys = history.map((t) => t.tx_json as Record<string, unknown>)
    .flatMap((t) => (t['TransactionType'] === 'Batch' ? [t] : [t]))
    .filter((t) => t['Account'] === site && typeof t['SigningPubKey'] === 'string' && t['SigningPubKey'] !== '')
    .map((t) => String(t['SigningPubKey']));
  const rotations = history.filter((t) => (t.tx_json as { TransactionType: string }).TransactionType === 'SetRegularKey').length;
  // The master key signs twice (set key, master off); a sign-only use signs the dapp's tx and its rotation.
  const regular = keys.slice(2);
  const repeats = regular.filter((k, i) => regular.indexOf(k) !== i).length;
  check('every regular key signed one ledger\'s worth and was replaced', repeats <= 1 && rotations >= 3, `${new Set(regular).size} regular keys for ${regular.length} signatures, ${rotations} SetRegularKey`);

  if (CLOSE) {
    const closeIn = async (origin: string) => {
      await wallet.click('#tab-home');
      await wallet.click('#tab-apps');
      await wallet.evaluate(() => { document.getElementById('apps-status')!.textContent = ''; });
      await wallet.click(`#site-list button[data-origin="${origin}"]`);
      await wallet.waitForFunction(() => /^(Closed|Not closed)/.test(document.getElementById('apps-status')?.textContent ?? ''), null, { timeout: 600_000, polling: 2_000 });
      return String(await wallet.textContent('#apps-status'));
    };
    // The first account holds an NFT and LP tokens: no pool takes those.
    const refused = await closeIn(DAPP);
    check('close refuses while the account holds what no pool takes', /Not closed/.test(refused), refused);

    // A second app on another origin: funded from the other 10 XRP, one trade, then closed.
    const second = 'http://localhost:5298';
    children.push(await start('npx', ['vite', '--port', '5298', '--strictPort', '--host', 'localhost'], join(ROOT, 'demo', 'xrpl-dapp'), /ready in|Local:/));
    // The adapter names its popup window, so an open one would be reused, not reopened.
    await popup.close();
    popup = undefined;
    await dapp.goto(`${second}/?wallet=${encodeURIComponent(`${WALLET}/xrpl-connect.html`)}&currency=${currency}&issuer=${ISSUER}`);
    const site2 = /connected (r\w+)/.exec(await act('connect', /Connect privately/))?.[1] ?? '';
    check('a second app gets a second, unrelated account', site2 !== '' && site2 !== site, site2);
    check('which trades on the DEX', /tesSUCCESS/.test(await act('trade', /Sign and submit/)), site2);

    // AccountDelete wants the account's sequence 256 ledgers behind; the close's
    // own token return and trust-line removal add six more.
    const sequence = (await client.request({ command: 'account_info', account: site2, ledger_index: 'validated' })).result.account_data.Sequence;
    log(`  waiting for ledger ${sequence + 270} before closing (now ${await client.getLedgerIndex()}, ~${Math.round((sequence + 270 - await client.getLedgerIndex()) * 3.8 / 60)} min)…`);
    while (await client.getLedgerIndex() < sequence + 270) await new Promise((r) => setTimeout(r, 15_000));
    const before = Number(await wallet.textContent('#balance-main'));
    const closed = await closeIn(second);
    check('the app\'s account closes into the pools', /^Closed/.test(closed), closed);
    const gone = await client.request({ command: 'account_info', account: site2, ledger_index: 'validated' }).then(() => false, (e: { data?: { error?: string } }) => e.data?.error === 'actNotFound');
    check('the account is gone from the ledger', gone, site2);
    let after = before;
    for (let i = 0; i < 20 && after <= before; i++) {
      await wallet.click('#tab-home');
      await wallet.click('#refresh');
      await new Promise((r) => setTimeout(r, 5_000));
      after = Number(await wallet.textContent('#balance-main'));
    }
    check('its reserve and the rest came back as notes', after > before, `${before} → ${after} private XRP`);
  }

  check('the wallet and its popup made no request outside their origin and the stack', outside.length === 0, outside.length === 0 ? 'none' : outside.slice(0, 3).join(', '));
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).stack ?? (error as Error).message}`);
} finally {
  await browser?.close();
  await client.disconnect().catch(() => undefined);
  for (const c of children) c.kill('SIGTERM');
}

log(failures === 0 ? '\nX3 passed on testnet' : `\nX3 FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
