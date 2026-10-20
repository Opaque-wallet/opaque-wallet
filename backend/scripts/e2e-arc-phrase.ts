#!/usr/bin/env node
// Arc accounts from the recovery phrase, from the outside, on ARC TESTNET.
//
//   cd backend && npm run arc:e2e:phrase [-- <site origin>] [--fund]
//
//   1. browser A: a new wallet on the Arc page; its address is the one the
//      phrase makes (worked out here, in Node, from the words alone)
//   2. the account list shows it under Account 1, and its chip copies it
//   3. Add account: Account 2, another address; then back to Account 1
//   4. the same phrase opens the XRPL page and Arc mainnet with no onboarding,
//      mainnet at an address of its own
//   5. browser B, with only the phrase: Account 1 and the same address
//
// --fund also waits for USDC (send ~3 testnet USDC to the printed address from
// any wallet), then checks it became notes by itself, and that a third browser
// with only the phrase finds the account's key on chain and every note.
// Spends nothing else. The origin defaults to https://www.opaque.credit.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { arcAddressOf } from '../../frontend/src/lib/arc-keys.ts';
import { accountKeys } from '../../frontend/src/lib/xrpl-keys.ts';
import { ARC_READY, acceptTerms, createWallet, passkeyOffer } from './xrpl-wallet-page.ts';

const args = process.argv.slice(2);
const ORIGIN = args.find((a) => !a.startsWith('--')) ?? 'https://www.opaque.credit';
const FUND = args.includes('--fund');
const ARC = `${ORIGIN}/testnet/app${ORIGIN.includes('opaque.credit') ? '' : '.html'}`;
const XRPL = `${ORIGIN}/testnet/xrpl${ORIGIN.includes('opaque.credit') ? '' : '.html'}`;
const MAINNET = `${ORIGIN}/app${ORIGIN.includes('opaque.credit') ? '' : '.html'}`;
const log = (s: string) => process.stdout.write(`${s}\n`);
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
};

// whichever Chrome for Testing Playwright last downloaded (macOS path); CHROMIUM overrides.
const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
const build = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().pop() : undefined;
const executablePath = process.env['CHROMIUM']
  ?? (build && join(cache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'));
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chromium' }), headless: true });

/** Waits for the Arc runtime and the account's address on Receive. */
async function addressOf(page: any): Promise<string> {
  await page.waitForFunction(ARC_READY, null, { timeout: 180_000 });
  await page.waitForFunction(() => /^0x[0-9a-f]{40}$/i.test(document.getElementById('receive-address')?.textContent ?? ''), null, { timeout: 180_000 });
  return String(await page.textContent('#receive-address')).toLowerCase();
}
const nameOf = async (page: any) => String(await page.textContent('#account-name'));
/** The private balance, once the runtime has read the notes. */
const balanceOf = async (page: any) => Number(await page.textContent('#balance'));

try {
  // ── 1. browser A: a new wallet ─────────────────────────────────────────────
  const a = await browser.newContext();
  await a.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(ORIGIN).origin });
  const walletA = await a.newPage();
  await walletA.goto(ARC);
  const phrase = await createWallet(walletA, 180_000, ARC_READY);
  const one = accountKeys(phrase, 0);
  const address = await addressOf(walletA);
  check('the Arc address is the one the phrase makes', address === arcAddressOf(one), address);
  check('it opens as Account 1', (await nameOf(walletA)) === 'Account 1', await nameOf(walletA));

  // ── 2. the account list ────────────────────────────────────────────────────
  await walletA.click('#account-button');
  await walletA.waitForSelector('.account-item .addr-chip:not(.pending)', { timeout: 60_000 });
  const chip = String(await walletA.textContent('.account-item .addr-chip:not(.pending) code'));
  check('the account list shows the address under Account 1', address.startsWith(chip.split('…')[0]!) && address.endsWith(chip.split('…')[1]!), chip);
  await walletA.click('.account-item .addr-chip:not(.pending)');
  const copied = await walletA.evaluate(() => navigator.clipboard.readText());
  check('its chip copies exactly that address', copied.toLowerCase() === address, copied);
  check('a phrase account offers no backup file to download', await walletA.isHidden('#backup-export'), 'hidden');

  // ── 3. a second account, and back ──────────────────────────────────────────
  await walletA.click('#account-add');
  await walletA.waitForLoadState('domcontentloaded');
  const second = await addressOf(walletA);
  check('Add account opens Account 2 at its own address', (await nameOf(walletA)) === 'Account 2' && second === arcAddressOf(accountKeys(phrase, 1)) && second !== address, second);
  await walletA.click('#account-button');
  await walletA.waitForSelector('.account-item:nth-child(2) .addr-chip:not(.pending)', { timeout: 60_000 });
  await walletA.click('.account-item:first-child .account-row');
  await walletA.waitForLoadState('domcontentloaded');
  check('and Account 1 opens again from the list', (await addressOf(walletA)) === address && (await nameOf(walletA)) === 'Account 1', await nameOf(walletA));

  // ── 4. one phrase for every chain ──────────────────────────────────────────
  await walletA.goto(XRPL);
  await walletA.waitForFunction(() => document.getElementById('account-short')?.textContent === 'Notes in this browser', null, { timeout: 180_000 });
  check('the XRPL page opens the same wallet, no onboarding', (await nameOf(walletA)) === 'Account 1', await nameOf(walletA));
  await walletA.goto(MAINNET);
  await walletA.waitForSelector('#mainnet-continue', { state: 'visible', timeout: 60_000 });
  await walletA.click('#mainnet-continue');
  const onMainnet = await addressOf(walletA);
  check('Arc mainnet opens it too, at an address of its own', (await nameOf(walletA)) === 'Account 1' && onMainnet !== address && await walletA.isHidden('#onboard'), onMainnet);

  // ── 5. browser B, with only the phrase ─────────────────────────────────────
  const b = await browser.newContext();
  const walletB = await b.newPage();
  await walletB.goto(ARC);
  await acceptTerms(walletB);
  await walletB.click('#ob-import');
  await walletB.fill('#ob-phrase', phrase);
  await walletB.click('#ob-restore-go');
  await passkeyOffer(walletB);
  check('the phrase alone brings Account 1 back at the same address', (await addressOf(walletB)) === address, address);
  await walletB.waitForFunction(() => /^Found \d+ note/.test(document.getElementById('home-status')?.textContent ?? ''), null, { timeout: 180_000 });
  check('and looks for its notes on Arc', true, String(await walletB.textContent('#home-status')));

  if (FUND) {
    // ── 6. USDC to the address becomes notes by itself ───────────────────────
    log(`\nSend about 3 testnet USDC to ${address} (Arc testnet) now. Waiting up to 15 minutes…`);
    await walletA.goto(ARC);
    await addressOf(walletA);
    const t0 = Date.now();
    await walletA.waitForFunction(() => Number(document.getElementById('balance')?.textContent) > 0, null, { timeout: 900_000, polling: 5_000 });
    const balance = await balanceOf(walletA);
    check('USDC sent to the address became private notes by itself', balance > 0, `${balance} USDC in ${Math.round((Date.now() - t0) / 1000)} s`);

    // ── 7. browser C, with only the phrase: the key on chain, and the notes ───
    const c = await browser.newContext();
    const walletC = await c.newPage();
    await walletC.goto(ARC);
    await acceptTerms(walletC);
    await walletC.click('#ob-import');
    await walletC.fill('#ob-phrase', phrase);
    await walletC.click('#ob-restore-go');
    await passkeyOffer(walletC);
    await addressOf(walletC);
    await walletC.waitForFunction(() => /^Found \d+ note/.test(document.getElementById('home-status')?.textContent ?? ''), null, { timeout: 300_000 });
    await walletC.waitForFunction((want: number) => Number(document.getElementById('balance')?.textContent) === want, balance, { timeout: 180_000, polling: 3_000 }).catch(() => undefined);
    check('the phrase brings back every note', (await balanceOf(walletC)) === balance, `${await balanceOf(walletC)} USDC`);
    const state = await walletC.evaluate(async () => {
      const s = await (globalThis as { opaque?: any }).opaque.app.walletState();
      return { active: s.active as boolean, uses: String(s.chainUseCount), local: String(s.localSigningReservations) };
    });
    check('and the account\'s key, adopted from the chain, ready to sign', state.active && BigInt(state.local) >= BigInt(state.uses), `chain uses ${state.uses}, counted here ${state.local}`);
  }
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).stack ?? error}`);
} finally {
  await browser.close().catch(() => undefined);
}

log(failures === 0 ? `\nArc accounts from the phrase passed (${ARC})` : `\nArc accounts from the phrase FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
