#!/usr/bin/env node
// Deployers on ARC TESTNET, from the outside: plain addresses an account funds
// privately, for contracts and scripts.
//
//   cd backend && npm run arc:e2e:deployer [-- <site origin>]
//
//   1. Accounts → New deployer lists a fresh address
//   2. its key is shown only after the password, as PRIVATE_KEY=… for a .env
//   3. that key is the address's own (viem works it out independently)
//   4. Fund privately opens Send with the deployer's address filled in
//   5. the policy credential a send to it needs comes across the mesh: the
//      page never asks the credential authority directly
//
// Funding it spends notes through the ordinary private send, which the other
// Arc tests cover; this one needs no USDC. The origin defaults to
// https://www.opaque.credit; http://127.0.0.1:<port> is a vite dev server.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { privateKeyToAddress } from 'viem/accounts';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { ARC_READY, createWallet, PASSWORD } from './xrpl-wallet-page.ts';

const ORIGIN = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'https://www.opaque.credit';
const clean = ORIGIN.includes('opaque.credit');
const base = /\/\/(127\.0\.0\.1|localhost):/.test(ORIGIN) ? ORIGIN : `${ORIGIN}/testnet`;
const ARC = `${base}/app${clean ? '' : '.html'}`;
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
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chromium' }), headless: true });

try {
  const page = await (await browser.newContext()).newPage();
  const asked: string[] = [];
  page.on('request', (r: any) => asked.push(r.url()));
  await page.goto(ARC);
  await createWallet(page, 180_000, ARC_READY);
  await page.waitForFunction(() => /^0x[0-9a-f]{40}$/i.test(document.getElementById('receive-address')?.textContent ?? ''), null, { timeout: 180_000 });

  // ── 1. a fresh address ─────────────────────────────────────────────────────
  await page.click('#account-button');
  await page.waitForSelector('#deployer-box', { state: 'visible', timeout: 30_000 });
  await page.click('#deployer-new');
  await page.waitForSelector('.deployer', { timeout: 120_000 });
  const address = String(await page.getAttribute('.deployer code', 'title'));
  const account = String(await page.textContent('#account-address'));
  check('New deployer lists a fresh address, not the account\'s own', /^0x[0-9a-fA-F]{40}$/.test(address) && address.toLowerCase() !== account.toLowerCase(), address);
  // F-25 (overlord): nothing is read for it until asked, so an exit can't tie it to the account by timing.
  check('its balance is not read until asked', String(await page.textContent('.deployer strong')).trim() === 'Check balance', String(await page.textContent('.deployer strong')));
  await page.click('.deployer [data-do="balance"]');
  await page.waitForFunction(() => /USDC$/.test(document.querySelector('.deployer strong')?.textContent ?? ''), null, { timeout: 60_000 });
  check('and asked, it is read through the mesh', true, String(await page.textContent('.deployer strong')));

  // ── 2. its key, after the password ─────────────────────────────────────────
  await page.click('.deployer [data-do="show"]');
  await page.waitForSelector('#confirm-password', { timeout: 30_000 });
  check('Show key asks for the password first', await page.evaluate(() => (document.querySelector('.deployer .key-text') as HTMLElement).hidden), 'hidden until then');
  await page.fill('#confirm-password', PASSWORD);
  await page.click('#confirm-go');
  await page.waitForFunction(() => !(document.querySelector('.deployer .key-text') as HTMLElement).hidden, null, { timeout: 60_000 });
  const line = String(await page.textContent('.deployer .key-text'));
  check('then shows it as a .env line', /^PRIVATE_KEY=0x[0-9a-f]{64}$/.test(line), `${line.slice(0, 18)}…`);

  // ── 3. the key is the address's ────────────────────────────────────────────
  const derived = privateKeyToAddress(line.slice('PRIVATE_KEY='.length) as `0x${string}`);
  check('the key is that address\'s own (viem agrees, checksum included)', derived === address, derived);

  // ── 4. funded by a private send ────────────────────────────────────────────
  await page.click('.deployer [data-do="fund"]');
  await page.waitForSelector('#view-send', { state: 'visible', timeout: 30_000 });
  check('Fund privately opens Send with the deployer\'s address', (await page.inputValue('#recipient')) === address, await page.inputValue('#recipient'));

  // ── 5. its credential, across the mesh ───────────────────────────────────
  const before = asked.length;
  const credential = await page.evaluate(async (a: string) => {
    try { return String(await (globalThis as any).opaque.obtainCredential(a)); } catch (e) { return `failed: ${(e as Error).message}`; }
  }, address);
  const direct = asked.slice(before).filter((u) => u.includes('/v1/credential'));
  check('a send to it gets its credential across the mesh, never directly', credential === address.toLowerCase() && direct.length === 0, `${credential}; ${direct.length} direct request(s)`);

  // Reopened, the list is still there: kept with the account (sealed under the password).
  await page.reload();
  await page.waitForFunction(ARC_READY, null, { timeout: 180_000 });
  await page.click('#account-button');
  await page.waitForSelector('.deployer', { timeout: 30_000 });
  check('a reload keeps it', (await page.getAttribute('.deployer code', 'title')) === address, `${await page.locator('.deployer').count()} deployer`);
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).stack ?? error}`);
} finally {
  await browser.close().catch(() => undefined);
}

log(failures === 0 ? `\nArc deployers passed (${ORIGIN})` : `\nArc deployers FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
