#!/usr/bin/env node
// A reusable address on XRPL TESTNET, from the outside: one account's address
// paid three times, and found again from the recovery phrase alone.
//
//   cd backend && npm run xrpl:e2e:address [-- <wallet page URL>]
//
//   1. browser A: a new wallet; Deposit shows its address, an X-address that
//      decodes to the pool and the account's tag; Copy gives exactly that
//   2. the faucet pays that address twice: both payments become notes (190 XRP)
//   3. a third payment needs the 10 XRP notes the wallet added by itself, with
//      the next link of the address's hash chain: 285 XRP only if it did
//   4. the account list shows the address under the account
//   5. browser B, with only the phrase: the same address, and all 285 XRP
//
// Don't run it beside another faucet-using script: they compete for the faucet.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { xAddressToClassicAddress } from 'ripple-address-codec';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { createWallet, importWallet } from './xrpl-wallet-page.ts';

const PAGE = process.argv[2] ?? 'https://www.opaque.credit/testnet/xrpl';
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
const origin = new URL(PAGE).origin;

const balance = async (page: any) => String(await page.textContent('#balance-main'));
/** Refreshes until the balance reads `want`, or two minutes pass. */
async function settleTo(page: any, want: string): Promise<string> {
  for (let i = 0; i < 30 && (await balance(page)) !== want; i++) {
    await page.click('#refresh');
    await new Promise((r) => setTimeout(r, 4_000));
  }
  return balance(page);
}
/** Opens Deposit and waits for the account's address. */
async function addressOf(page: any): Promise<string> {
  await page.click('#tab-receive');
  await page.waitForFunction(() => /^T/.test(document.getElementById('address-x')?.textContent ?? ''), null, { timeout: 180_000 });
  return String(await page.textContent('#address-x'));
}
/** The faucet pays the address on Deposit; then back to Home. */
async function faucet(page: any): Promise<void> {
  await page.click('#address-faucet');
  await page.waitForFunction(() => /^The faucet paid|^Faucet unavailable/.test(document.getElementById('address-status')?.textContent ?? ''), null, { timeout: 180_000 });
  const said = String(await page.textContent('#address-status'));
  if (!said.startsWith('The faucet paid')) throw new Error(said);
  await page.click('#tab-home');
}

try {
  // ── 1. browser A: the address ──────────────────────────────────────────────
  const a = await browser.newContext();
  await a.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const walletA = await a.newPage();
  await walletA.goto(PAGE);
  const phrase = await createWallet(walletA);
  const address = await addressOf(walletA);
  const decoded = xAddressToClassicAddress(address);
  const pool = String(await walletA.textContent('#address-pool'));
  const tag = Number(await walletA.textContent('#address-tag'));
  check('Deposit shows the account\'s address: an X-address of the pool and its tag', decoded.classicAddress === pool && decoded.tag === tag && decoded.test, `${address} = ${pool} tag ${tag}`);
  await walletA.click('#address-copy');
  const copied = await walletA.evaluate(() => navigator.clipboard.readText());
  check('Copy gives exactly that address', copied === address, copied);

  // ── 2. two payments to one address ─────────────────────────────────────────
  await faucet(walletA);
  check('the first payment to the address became notes', (await settleTo(walletA, '95')) === '95', await balance(walletA));
  await addressOf(walletA);
  check('the address is the same the second time', String(await walletA.textContent('#address-x')) === address, 'reused');
  await faucet(walletA);
  check('the second payment to the same address became notes too', (await settleTo(walletA, '190')) === '190', await balance(walletA));

  // ── 3. a top-up, by the wallet itself ──────────────────────────────────────
  // Each 95 takes nine 10 XRP notes of the twenty the address began with: a
  // third payment fits only if the wallet added more, revealing the next link.
  await addressOf(walletA);
  await faucet(walletA);
  check('a third payment fits because the wallet topped the address up', (await settleTo(walletA, '285')) === '285', `${await balance(walletA)} XRP`);

  // ── 4. the account list ────────────────────────────────────────────────────
  await walletA.click('#account-button');
  await walletA.waitForSelector('.addr-chip', { timeout: 30_000 });
  const chip = String(await walletA.textContent('.addr-chip code'));
  check('the account list shows the address under the account', address.startsWith(chip.split('…')[0]!) && address.endsWith(chip.split('…')[1]!), chip);

  // ── 5. browser B, with only the phrase ─────────────────────────────────────
  const b = await browser.newContext();
  const walletB = await b.newPage();
  await walletB.goto(PAGE);
  const t0 = Date.now();
  await importWallet(walletB, phrase);
  const restored = await settleTo(walletB, '285');
  check('the phrase brings back every note the address received', restored === '285', `${restored} XRP in ${Math.round((Date.now() - t0) / 1000)} s`);
  check('and the same address', (await addressOf(walletB)) === address, address);
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).stack ?? error}`);
} finally {
  await browser.close().catch(() => undefined);
}

log(failures === 0 ? `\nthe reusable address passed (${PAGE})` : `\nthe reusable address FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
