#!/usr/bin/env node
// One account by its key, and an ordinary XRPL wallet swept in, on XRPL
// TESTNET, from the outside.
//
//   cd backend && npm run xrpl:e2e:import [-- https://<wallet page>]
//
//   1. browser A: a new wallet, 95 XRP from the faucet, and its account key
//   2. browser B: that key alone imported; the ledger gives back the 95 XRP
//   3. browser B: a fresh testnet wallet, known only by its family seed, swept
//      in: its XRP above the reserve becomes notes, and the ledger shows it
//      left with the reserve alone
//
// Runs Playwright's Chrome for Testing. Outside backend's typecheck, like the
// other browser scripts.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Client } from 'xrpl';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { xrplDeployment } from '../../deployments/xrpl.ts';
import { createWallet, importWallet, PASSWORD } from './xrpl-wallet-page.ts';

const PAGE = process.argv[2] ?? 'https://www.opaque.credit/testnet/xrpl.html';
const log = (s: string) => process.stdout.write(`${s}\n`);
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
};

// ponytail: whichever Chrome for Testing Playwright last downloaded (macOS path); CHROMIUM overrides.
const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
const build = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().pop() : undefined;
const executablePath = process.env['CHROMIUM']
  ?? (build && join(cache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'));
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chromium' }), headless: true });
const client = new Client(xrplDeployment.network.wss);

const balance = async (page: any) => Number(await page.textContent('#balance-xrp'));
/** Refreshes until the balance reaches `want`, or a minute and a half passes. */
async function settleTo(page: any, want: (n: number) => boolean): Promise<number> {
  for (let i = 0; i < 22 && !want(await balance(page)); i++) {
    await page.click('#refresh');
    await new Promise((r) => setTimeout(r, 4_000));
  }
  return balance(page);
}

try {
  await client.connect();
  // ── 1. browser A ───────────────────────────────────────────────────────────
  const a = await (await browser.newContext()).newPage();
  await a.goto(PAGE);
  await createWallet(a);
  await a.click('#tab-receive');
  await a.click('#receive-button');
  await a.waitForFunction(() => (document.getElementById('receive-tag')?.textContent ?? '') !== '', null, { timeout: 120_000 });
  await a.click('#faucet-button');
  await a.waitForFunction(() => /^The faucet paid|^Faucet unavailable/.test(document.getElementById('receive-status')?.textContent ?? ''), null, { timeout: 150_000 });
  await a.click('#tab-home');
  check('A: 95 private XRP from the faucet', (await settleTo(a, (n) => n === 95)) === 95, String(await a.textContent('#note-count')));
  await a.click('#account-button');
  await a.click('#key-show');
  // Shown only after the password, again.
  await a.fill('#confirm-password', PASSWORD);
  await a.click('#confirm-go');
  await a.waitForFunction(() => !(document.getElementById('key-text') as HTMLElement).hidden, null, { timeout: 60_000 });
  const key = String(await a.textContent('#key-text')).trim();
  check('A: Account 1\'s key, shown on request, after the password', /^opq1[0-9a-f]{72}$/.test(key), `${key.slice(0, 10)}…`);

  // ── 2. browser B: the key alone ────────────────────────────────────────────
  const b = await (await browser.newContext()).newPage();
  await b.goto(PAGE);
  const found = await importWallet(b, key);
  const imported = await settleTo(b, (n) => n === 95);
  check('B: the key imported, and the ledger gave back its 95 XRP', imported === 95 && (await b.textContent('#account-name')) === 'Imported 1', `${await b.textContent('#account-name')}: ${found} ${imported} XRP`);

  // ── 3. browser B: an ordinary wallet swept in ──────────────────────────────
  const { wallet: old } = await client.fundWallet();
  const xrpOf = async () => Number((await client.request({ command: 'account_info', account: old.classicAddress, ledger_index: 'validated' })).result.account_data.Balance) / 1e6;
  const funded = await xrpOf();
  await b.click('#tab-receive');
  await b.click('#sweep-open');
  await b.fill('#sweep-secret', old.seed!);
  await b.click('#sweep-check');
  await b.waitForFunction(() => !document.getElementById('sweep-plan')!.hidden || /no account|not/.test(document.getElementById('sweep-status')?.textContent ?? ''), null, { timeout: 90_000 });
  const moves = String(await b.textContent('#sweep-moves'));
  check('B: the swept wallet is read before anything is signed', String(await b.textContent('#sweep-address')) === old.classicAddress && /XRP/.test(moves), `${old.classicAddress}: moves ${moves}, keeps ${await b.textContent('#sweep-stays')}`);
  await b.click('#sweep-go');
  await b.waitForFunction(() => /^Swept|^Not swept/.test(document.getElementById('sweep-status')?.textContent ?? ''), null, { timeout: 240_000 });
  const status = String(await b.textContent('#sweep-status'));
  const left = await xrpOf();
  check('B: the sweep went through, and the old wallet keeps only its reserve', /^Swept/.test(status) && left <= 1.0001, `${status} ${funded} XRP before, ${left} after`);
  await b.keyboard.press('Escape');
  await b.click('#tab-home');
  const whole = Math.floor(funded - left - 0.001);
  const after = await settleTo(b, (n) => n >= 95 + whole - 1);
  check('B: the swept XRP became private notes', after >= 95 + whole - 1, `${after} XRP (95 + about ${whole})`);
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).stack ?? error}`);
} finally {
  await client.disconnect().catch(() => undefined);
  await browser.close().catch(() => undefined);
}

log(failures === 0 ? `\nimport by key and sweep passed (${PAGE})` : `\nimport by key and sweep FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
