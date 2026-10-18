#!/usr/bin/env node
// One wallet, an account per app, on XRPL TESTNET, from the outside.
//
//   cd backend && npm run xrpl:e2e:accounts
//
//   1. the wallet: 95 private XRP from the faucet
//   2. app A (the hosted demo) and app B (the same demo on another origin)
//      connect: two accounts, two addresses
//   3. app A again, by WalletConnect: A's account, never a third
//      (the browser extension is a wallet of its own: e2e-xrpl-extension.ts)
//   4. the ledger: each account was funded by the pool in a payout of its own,
//      neither ever touched the other, and both master keys are off
//   5. the wallet's Apps tab lists A and B, and nothing else
//
// Runs Playwright's Chrome for Testing. Outside backend's typecheck, like the
// other browser scripts.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'xrpl';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { openWallet } from './xrpl-wallet-page.ts';
import { xrplDeployment, xrplPool } from '../../deployments/xrpl.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WALLET = 'https://www.opaque.credit';
const APP_A = 'https://opaque-xrpl-demo.vercel.app';
const APP_B = 'http://localhost:5298';
const STACK = 'https://opaque-xrpl-testnet-production.up.railway.app';
const LSF_DISABLE_MASTER = 0x0010_0000;
const log = (s: string) => process.stdout.write(`${s}\n`);
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
};

const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
const build = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().pop() : undefined;
const executablePath = process.env['CHROMIUM']
  ?? (build && join(cache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'));

// App B: the same demo, served from a second origin.
const appB: ChildProcess = await new Promise((resolve, reject) => {
  const child = spawn('npx', ['vite', '--port', '5298', '--strictPort', '--host', 'localhost'], { cwd: join(ROOT, 'demo', 'xrpl-dapp'), stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => reject(new Error('the demo did not start')), 60_000);
  child.stdout!.on('data', (b: Buffer) => { if (/ready in|Local:/.test(b.toString())) { clearTimeout(timer); resolve(child); } });
  child.on('exit', (code) => reject(new Error(`vite exited ${code}`)));
});
const profile = mkdtempSync(join(tmpdir(), 'opaque-accounts-'));
const context = await chromium.launchPersistentContext(profile, {
  ...(executablePath ? { executablePath } : { channel: 'chromium' }), headless: true,
});
const client = new Client(xrplDeployment.network.wss);
try {
  await client.connect();
  const ours = [new URL(WALLET).origin, new URL(STACK).origin];
  const outside: string[] = [];
  const police = (p: any) => {
    const isOurs = (u: string) => ours.some((o) => u.startsWith(`${o}/`) || u.startsWith(`${o.replace(/^http/, 'ws')}/`));
    p.on('request', (r: any) => { const u = r.url(); if (!isOurs(u) && !u.startsWith('blob:') && !u.startsWith('data:')) outside.push(u); });
    p.on('websocket', (ws: any) => { if (!isOurs(ws.url())) outside.push(ws.url()); });
  };

  // ── 1. the wallet ─────────────────────────────────────────────────────────
  const wallet = await context.newPage();
  police(wallet);
  await wallet.goto(`${WALLET}/testnet/xrpl.html`); // the site's home page is the one-pager
  await openWallet(wallet);
  await wallet.click('#tab-receive');
  await wallet.click('#receive-button');
  await wallet.waitForFunction(() => (document.getElementById('receive-tag')?.textContent ?? '') !== '', null, { timeout: 120_000 });
  await wallet.click('#faucet-button');
  await wallet.waitForFunction(() => /^The faucet paid|^Faucet unavailable/.test(document.getElementById('receive-status')?.textContent ?? ''), null, { timeout: 150_000 });
  await wallet.click('#tab-home');
  for (let i = 0; i < 30 && (await wallet.textContent('#balance-main')) !== '95'; i++) {
    await wallet.click('#refresh');
    await new Promise((r) => setTimeout(r, 4_000));
  }
  check('one wallet: 95 private XRP in this browser', (await wallet.textContent('#balance-main')) === '95', String(await wallet.textContent('#note-count')));

  // A card on a page (the popup, or the wallet's connect page) approved once it shows `title`.
  const approve = async (page: any, title: RegExp) => {
    await page.waitForFunction((t: string) => !document.getElementById('request')!.hidden && new RegExp(t).test(document.getElementById('request-title')?.textContent ?? '')
      && !(document.getElementById('approve') as HTMLButtonElement).disabled, title.source, { timeout: 120_000 });
    await page.click('#approve');
  };
  const lineOf = async (dapp: any, id: string, before: number) => {
    await dapp.waitForFunction(([n, prefix]: [number, string]) => (document.getElementById('log')?.textContent ?? '').split('\n').filter(Boolean)
      .slice(n).some((l) => l.startsWith(prefix)), [before, id], { timeout: 300_000, polling: 1_000 });
    return String(await dapp.textContent('#log')).split('\n').filter(Boolean).slice(before).find((l) => l.startsWith(id))!;
  };
  const count = async (dapp: any) => String(await dapp.textContent('#log')).split('\n').filter(Boolean).length;
  /** Connects through a popup and returns the address the app was given. */
  async function viaPopup(dapp: any, button: string, title: RegExp): Promise<string> {
    const before = await count(dapp);
    const opened = context.waitForEvent('page');
    await dapp.click(`#${button}`);
    const popup = await opened;
    police(popup);
    await approve(popup, title);
    const line = await lineOf(dapp, button, before);
    await popup.close();
    return /connected (r\w+)/.exec(line)?.[1] ?? line;
  }

  // ── 2. two apps ────────────────────────────────────────────────────────────
  const dappA = await context.newPage();
  await dappA.goto(`${APP_A}/`);
  const a = await viaPopup(dappA, 'connect', /Connect privately/);
  const dappB = await context.newPage();
  await dappB.goto(`${APP_B}/`);
  const b = await viaPopup(dappB, 'connect', /Connect privately/);
  check('app A and app B each get an account of their own', /^r/.test(a) && /^r/.test(b) && a !== b, `A ${a}, B ${b}`);

  // ── 3. app A by another road ───────────────────────────────────────────────
  const hub = await context.newPage();
  police(hub);
  await hub.goto(`${WALLET}/testnet/xrpl-connect.html`);
  await hub.waitForFunction(() => !document.getElementById('wc-form')!.hidden, null, { timeout: 90_000 });
  const before = await count(dappA);
  await dappA.click('#connect-wc');
  await dappA.waitForFunction(() => /^wc:/.test(document.getElementById('wc-uri')?.textContent ?? ''), null, { timeout: 60_000 });
  await hub.fill('#wc-uri', String(await dappA.textContent('#wc-uri')));
  await hub.click('#wc-connect');
  await approve(hub, /^Connect$/);
  const viaWc = /connected (r\w+)/.exec(await lineOf(dappA, 'connect-wc', before))?.[1];
  check('app A through WalletConnect, verified by Reown: A\'s account again', viaWc === a, String(viaWc));

  // ── 4. the ledger ──────────────────────────────────────────────────────────
  const pool = xrplPool('XRP').account;
  const history = async (account: string) => (await client.request({ command: 'account_tx', account, forward: true, limit: 200 })).result.transactions;
  const [historyA, historyB] = await Promise.all([history(a), history(b)]);
  const fundingOf = (txs: typeof historyA, account: string) => txs.map((t) => ({ tx: (t.tx_json ?? (t as any).tx) as Record<string, unknown>, hash: t.hash, ledger: t.ledger_index }))
    .find(({ tx }) => tx['TransactionType'] === 'Payment' && tx['Destination'] === account);
  const fundA = fundingOf(historyA, a);
  const fundB = fundingOf(historyB, b);
  check('each account was funded by the pool, never by the user or the other app', fundA?.tx['Account'] === pool && fundB?.tx['Account'] === pool,
    `A from ${fundA?.tx['Account']} at ledger ${fundA?.ledger}, B from ${fundB?.tx['Account']} at ledger ${fundB?.ledger}`);
  check('in two separate payouts', fundA !== undefined && fundB !== undefined && fundA.hash !== fundB.hash, `${fundA?.hash?.slice(0, 12)}… and ${fundB?.hash?.slice(0, 12)}…`);
  const touches = (txs: typeof historyA, other: string) => txs.filter((t) => JSON.stringify(t).includes(other)).length;
  check('neither account\'s history ever names the other', touches(historyA, b) === 0 && touches(historyB, a) === 0, `${historyA.length} and ${historyB.length} transactions`);
  const flags = async (account: string) => (await client.request({ command: 'account_info', account, ledger_index: 'validated' })).result.account_data.Flags;
  const [flagsA, flagsB] = await Promise.all([flags(a), flags(b)]);
  check('both master keys are off: only single-use keys sign', (flagsA & LSF_DISABLE_MASTER) !== 0 && (flagsB & LSF_DISABLE_MASTER) !== 0, `flags ${flagsA}, ${flagsB}`);

  // ── 5. the one wallet's view ───────────────────────────────────────────────
  await wallet.reload();
  await wallet.waitForFunction(() => document.getElementById('account-short')?.textContent === 'Notes in this browser', null, { timeout: 90_000 });
  await wallet.click('#tab-apps');
  await wallet.waitForFunction((x: string) => (document.getElementById('site-list')?.textContent ?? '').includes(x), a, { timeout: 30_000 });
  const listed = String(await wallet.textContent('#site-list'));
  check('the wallet\'s Apps tab lists exactly A and B', listed.includes(a) && listed.includes(b) && listed.includes(new URL(APP_A).host) && listed.includes(new URL(APP_B).host)
    && (await wallet.$$('#site-list .intent')).length === 2, `${(await wallet.$$('#site-list .intent')).length} apps`);

  check('the wallet, its popup and its connect page talked to their origin and the service only', outside.length === 0, outside.length === 0 ? 'none' : outside.slice(0, 3).join(', '));
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).stack ?? error}`);
} finally {
  await client.disconnect().catch(() => undefined);
  await context.close().catch(() => undefined);
  appB.kill();
  rmSync(profile, { recursive: true, force: true });
}

log(failures === 0 ? '\none wallet, an account per app: passed on testnet' : `\none wallet, an account per app: FAILED ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
