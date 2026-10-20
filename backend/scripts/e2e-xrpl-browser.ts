#!/usr/bin/env node
// Drives the REAL XRPL wallet page in headless Chromium, through a real XRPL
// stack, to a private payment settled on XRPL TESTNET.
//
//   cd backend && npm run xrpl:e2e:browser
//
// Starts backend/xrpl/stack.ts (with MoonPay TEST keys, so Buy shows) and a
// Vite dev server, then, in the page:
//   1. Receive: a fresh tag; Node pays it 3 XRP from a faucet account; the page
//      shows 3 XRP of notes.
//   2. Buy: the click opens a NEW tab on MoonPay's sandbox for that tag. The
//      tab's own requests are aborted: test keys, nothing to buy.
//   3. Send 1 XRP privately; Activity shows it settled; the ledger shows the
//      recipient got 0.7999 XRP.
// Fails if the page sent a single request to anyone but its own origin and the
// stack: no XRPL node, no MoonPay, no CDN.
//
// Outside backend's typecheck on purpose, like e2e-wallet-browser.ts: the
// waitForFunction callbacks run IN THE BROWSER.

import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'xrpl';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { openWallet } from './xrpl-wallet-page.ts';
import { xrplDeployment, xrplPool } from '../../deployments/xrpl.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 5199;
const APP = `http://127.0.0.1:${PORT}/xrpl.html`;
const log = (s: string) => process.stdout.write(`${s}\n`);
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
};

/** Starts a process and resolves once a line of its output matches `ready`. */
function start(cmd: string, args: string[], cwd: string, ready: RegExp, env: Record<string, string> = {}): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => reject(new Error(`${cmd} ${args.join(' ')} did not start`)), 120_000);
    const watch = (b: Buffer) => { if (ready.test(b.toString())) { clearTimeout(timer); resolve(child); } };
    child.stdout!.on('data', watch);
    child.stderr!.on('data', (b: Buffer) => { watch(b); if (/Error/.test(b.toString())) process.stderr.write(b); });
    child.on('exit', (code) => reject(new Error(`${cmd} exited ${code}`)));
  });
}

const children: ChildProcess[] = [];
const client = new Client(xrplDeployment.network.wss);
const pool = xrplPool('XRP');
let browser: any;

try {
  children.push(await start('node', ['--use-system-ca', 'xrpl/stack.ts'], join(HERE, '..'), /wallet cfg/,
    { MOONPAY_API_KEY: 'pk_test_opaque', MOONPAY_SECRET_KEY: 'sk_test_opaque' }));
  children.push(await start('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], join(HERE, '..', '..', 'frontend'), /ready in|Local:/));
  await client.connect();
  const [{ wallet: payer }, { wallet: recipient }] = [await client.fundWallet(), await client.fundWallet()];

  // The machine's own Chrome, as e2e-wallet-browser.ts uses, not a downloaded build.
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  // The Buy tab: allowed to open, never allowed to load MoonPay with test keys.
  const opened: string[] = [];
  context.on('page', async (p: any) => {
    await p.route('**/*', (r: any) => r.abort());
    opened.push(p.url() === 'about:blank' ? await p.waitForEvent('framenavigated').then((f: any) => f.url()).catch(() => p.url()) : p.url());
  });
  const outside: string[] = [];
  page.on('request', (r: any) => { if (!r.url().startsWith('http://127.0.0.1:') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) outside.push(r.url()); });
  page.on('pageerror', (e: Error) => log(`  page error: ${e.message}`));

  await page.goto(APP);
  await openWallet(page);
  log('  wallet started: relay directory verified, mesh up');

  // ── 1. receive ───────────────────────────────────────────────────────────
  await page.click('#tab-receive');
  await page.selectOption('#receive-asset', 'XRP');
  await page.fill('#receive-expected', '3');
  await page.click('#receive-button');
  await page.waitForFunction(() => (document.getElementById('receive-tag')?.textContent ?? '') !== '', null, { timeout: 90_000 });
  const tag = Number(await page.textContent('#receive-tag'));
  const shownPool = await page.textContent('#receive-address');
  check('the page made a receive tag on the pool', shownPool === pool.account && tag > 0, `${shownPool} tag ${tag}`);

  const paid = await client.submitAndWait({ TransactionType: 'Payment', Account: payer.address, Destination: pool.account, Amount: '3000000', DestinationTag: tag }, { autofill: true, wallet: payer });
  log(`  Node paid 3 XRP to the tag: ${paid.result.hash}`);
  await page.click('#tab-home');
  await page.click('#refresh');
  await page.waitForFunction(() => document.getElementById('balance-xrp')?.textContent === '3', null, { timeout: 120_000, polling: 2_000 }).catch(async () => {
    await page.click('#refresh');
    await page.waitForFunction(() => document.getElementById('balance-xrp')?.textContent === '3', null, { timeout: 60_000, polling: 2_000 });
  });
  check('the payment became 3 private XRP notes in the page', true, `${await page.textContent('#note-count')}`);

  // ── 2. buy ───────────────────────────────────────────────────────────────
  await page.click('#tab-receive');
  check('Buy is offered for XRP', await page.isVisible('#buy-box'), 'MoonPay sandbox');
  await page.click('#buy-button');
  for (let i = 0; i < 20 && opened.length === 0; i++) await new Promise((r) => setTimeout(r, 250));
  const buy = opened[0] === undefined ? undefined : new URL(opened[0]);
  check('Buy opens MoonPay in a new tab, for the pool and this tag',
    buy?.origin === 'https://buy-sandbox.moonpay.com' && buy.searchParams.get('walletAddress') === pool.account && buy.searchParams.get('walletAddressTag') === String(tag) && buy.searchParams.has('signature'),
    buy === undefined ? 'no tab' : `${buy.origin} tag ${buy.searchParams.get('walletAddressTag')}`);

  // ── 3. send ──────────────────────────────────────────────────────────────
  const before = BigInt((await client.request({ command: 'account_info', account: recipient.address, ledger_index: 'validated' })).result.account_data.Balance);
  await page.click('#tab-send');
  await page.selectOption('#send-asset', 'XRP');
  await page.fill('#send-amount', '1');
  await page.fill('#recipient', recipient.address);
  const t0 = Date.now();
  await page.click('#send-button');
  await page.click('#send-confirm');
  await page.waitForFunction(() => /^Sent:/.test(document.getElementById('send-status')?.textContent ?? ''), null, { timeout: 300_000 });
  log(`  proof built in the page and sent through the mesh in ${Math.round((Date.now() - t0) / 1000)} s`);
  await page.click('#tab-activity');
  await page.waitForFunction(() => document.querySelector('#sent-list .intent-state')?.textContent === 'settled', null, { timeout: 300_000, polling: 3_000 });
  const settledIn = Math.round((Date.now() - t0) / 1000);
  const after = BigInt((await client.request({ command: 'account_info', account: recipient.address, ledger_index: 'validated' })).result.account_data.Balance);
  check('the page\'s payment SETTLED on testnet', after - before === 1_000_000n - BigInt(pool.spendFee), `recipient +${after - before} drops, ${settledIn} s from click`);

  check('the page made no request outside its origin and the stack', outside.length === 0, outside.length === 0 ? 'none' : outside.slice(0, 3).join(', '));
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).message}`);
} finally {
  await browser?.close();
  await client.disconnect().catch(() => undefined);
  for (const c of children) c.kill('SIGTERM');
}

log(failures === 0 ? '\nXRPL wallet page passed on testnet' : `\nXRPL wallet page FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
