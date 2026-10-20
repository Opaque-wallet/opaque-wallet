#!/usr/bin/env node
// A recovery phrase on XRPL TESTNET, from the outside: one wallet in two
// browsers that share nothing but the 12 words.
//
//   cd backend && npm run xrpl:e2e:phrase [-- https://<wallet> https://<dapp>]
//
//   1. browser A: a new wallet, its phrase confirmed; 95 XRP from the faucet;
//      the demo app connected, its account funded privately
//   2. browser A: Account 2 is a wallet of its own, empty; Account 1 still holds the rest
//   3. browser B: the phrase imported; the ledger gives back Account 1's notes,
//      spent and unspent as they are, so the balance matches A's; and finds
//      Account 2, which A only opened (its address, nothing in it)
//   4. browser B: the same app, connected again, gets the same address, and
//      nothing is paid to fund it a second time
//
// Runs Playwright's Chrome for Testing. Outside backend's typecheck, like the
// other browser scripts.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { createWallet, importWallet, unlockIfAsked } from './xrpl-wallet-page.ts';

const WALLET = (process.argv[2] ?? 'https://www.opaque.credit').replace(/\/+$/, '');
const DAPP = (process.argv[3] ?? 'https://opaque-xrpl-demo.vercel.app').replace(/\/+$/, '');
const PAGE = `${WALLET}/testnet/xrpl.html`;
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

const balance = async (page: any) => String(await page.textContent('#balance-xrp'));
/** Refreshes until the balance reads `want`, or a minute and a half passes. */
async function settleTo(page: any, want: string): Promise<string> {
  for (let i = 0; i < 22 && (await balance(page)) !== want; i++) {
    await page.click('#refresh');
    await new Promise((r) => setTimeout(r, 4_000));
  }
  return balance(page);
}
/** The demo's own Opaque button, approved in the popup; the address the app was given. */
async function connectDemo(context: any, dapp: any): Promise<string> {
  const before = String(await dapp.textContent('#log')).split('\n').filter(Boolean).length;
  const opened = context.waitForEvent('page');
  await dapp.click('#connect');
  const popup = await opened;
  await unlockIfAsked(popup);
  await popup.waitForFunction(() => !document.getElementById('request')!.hidden && /Connect privately/.test(document.getElementById('request-title')?.textContent ?? '')
    && !(document.getElementById('approve') as HTMLButtonElement).disabled, null, { timeout: 120_000 });
  await popup.click('#approve');
  await dapp.waitForFunction((n: number) => (document.getElementById('log')?.textContent ?? '').split('\n').filter(Boolean)
    .slice(n).some((l) => l.startsWith('connect')), before, { timeout: 300_000, polling: 1_000 });
  const line = String(await dapp.textContent('#log')).split('\n').filter(Boolean).slice(before).find((l) => l.startsWith('connect'))!;
  await popup.close().catch(() => undefined);
  return /connected (r\w+)/.exec(line)?.[1] ?? line;
}

try {
  // ── 1. browser A ───────────────────────────────────────────────────────────
  const a = await browser.newContext();
  const walletA = await a.newPage();
  await walletA.goto(PAGE);
  const phrase = await createWallet(walletA);
  check('a new wallet: 12 words, confirmed, and Account 1 open', phrase.split(' ').length === 12 && (await walletA.textContent('#account-name')) === 'Account 1', `${phrase.split(' ').slice(0, 2).join(' ')} …`);
  await walletA.click('#tab-receive');
  await walletA.click('#receive-button');
  await walletA.waitForFunction(() => (document.getElementById('receive-tag')?.textContent ?? '') !== '', null, { timeout: 120_000 });
  await walletA.click('#faucet-button');
  await walletA.waitForFunction(() => /^The faucet paid|^Faucet unavailable/.test(document.getElementById('receive-status')?.textContent ?? ''), null, { timeout: 150_000 });
  await walletA.click('#tab-home');
  check('A: 95 private XRP from the faucet', (await settleTo(walletA, '95')) === '95', String(await walletA.textContent('#note-count')));

  const dappA = await a.newPage();
  await dappA.goto(`${DAPP}/`);
  const site = await connectDemo(a, dappA);
  check('A: the demo app connected, its account funded privately', /^r\w{24,34}$/.test(site), site);
  await walletA.reload();
  await walletA.waitForFunction(() => document.getElementById('account-short')?.textContent === 'Notes in this browser', null, { timeout: 90_000 });
  const left = await settleTo(walletA, '85');
  check('A: Account 1 holds what funding the app left', left === '85', `${left} XRP`);

  // ── 2. a second account ────────────────────────────────────────────────────
  await walletA.click('#account-button');
  await walletA.click('#account-add');
  await walletA.waitForFunction(() => document.getElementById('account-short')?.textContent === 'Notes in this browser', null, { timeout: 90_000 });
  await walletA.waitForFunction(() => document.getElementById('balance-xrp') !== null, null, { timeout: 60_000 });
  check('A: Account 2 is a wallet of its own, empty', (await walletA.textContent('#account-name')) === 'Account 2' && (await balance(walletA)) === '0', `${await walletA.textContent('#account-name')}: ${await balance(walletA)} XRP`);
  // Its address is made as it opens: wait for it, as a person would see it under Deposit.
  await walletA.click('#tab-receive');
  await walletA.waitForFunction(() => /^T/.test(document.getElementById('address-x')?.textContent ?? ''), null, { timeout: 180_000 });
  await walletA.click('#tab-home');
  await walletA.click('#account-button');
  await walletA.click('.account-row:first-child');
  await walletA.waitForFunction(() => document.getElementById('account-short')?.textContent === 'Notes in this browser', null, { timeout: 90_000 });
  const back = await settleTo(walletA, left);
  check('A: back on Account 1, the same notes', (await walletA.textContent('#account-name')) === 'Account 1' && back === left, `${back} XRP`);

  // ── 3. browser B: nothing but the phrase ───────────────────────────────────
  const b = await browser.newContext();
  const walletB = await b.newPage();
  await walletB.goto(PAGE);
  const t0 = Date.now();
  const found = await importWallet(walletB, phrase);
  const restored = await settleTo(walletB, left);
  check('B: the phrase imported, and the ledger gave back Account 1\'s balance', restored === left, `${found} ${restored} XRP, ${Math.round((Date.now() - t0) / 1000)} s`);
  check('B: and found Account 2, which A only opened', /and 1 more account of this phrase/.test(found), found);

  // ── 4. the same app, from browser B ────────────────────────────────────────
  const dappB = await b.newPage();
  await dappB.goto(`${DAPP}/`);
  const again = await connectDemo(b, dappB);
  check('B: the same app gets the same address', again === site, `${again} (A had ${site})`);
  await walletB.reload();
  await walletB.waitForFunction(() => document.getElementById('account-short')?.textContent === 'Notes in this browser', null, { timeout: 90_000 });
  const after = await settleTo(walletB, left);
  check('B: and nothing was paid to fund it again', after === left, `${after} XRP`);
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).stack ?? error}`);
} finally {
  await browser.close().catch(() => undefined);
}

log(failures === 0 ? `\nthe recovery phrase passed (${WALLET}, ${DAPP})` : `\nthe recovery phrase FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
