#!/usr/bin/env node
// Swaps on ARC TESTNET, from the outside: tokens at the account's address,
// routed by LI.FI, asked through the mesh.
//
//   cd backend && npm run arc:e2e:swap [-- <site origin>] [--fund]
//
//   1. a new wallet's Swap screen quotes USDC → EURC: LI.FI's route, the least
//      it delivers and its fee, asked through Opaque's relays
//   2. the page talked to nobody but its own origin and Opaque's service
//
// --fund also switches auto-deposit off, waits for USDC (send about 3 testnet
// USDC to the printed address), swaps 1 USDC into EURC, and all that EURC back.
// The origin defaults to https://www.opaque.credit.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { requireService } from '../../deployments/index.ts';
import { ARC_READY, createWallet } from './wallet-page.ts';

const args = process.argv.slice(2);
const ORIGIN = args.find((a) => !a.startsWith('--')) ?? 'https://www.opaque.credit';
const FUND = args.includes('--fund');
// A vite dev server (frontend: npx vite) serves the testnet pages at its root.
const PAGE = `${/\/\/(127\.0\.0\.1|localhost):/.test(ORIGIN) ? ORIGIN : `${ORIGIN}/testnet`}/app${ORIGIN.includes('opaque.credit') ? '' : '.html'}`;
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
const ours = [new URL(ORIGIN).origin, new URL(requireService('meshExitUrl')).origin];

/** Types an amount on Swap and waits for LI.FI's route, or its refusal. */
async function quote(page: any, amount: string): Promise<string> {
  await page.fill('#swap-amount', amount);
  await page.waitForFunction(() => !/Finding|Enter an amount/.test(document.getElementById('swap-go')?.textContent ?? ''), null, { timeout: 120_000 });
  return String(await page.textContent('#swap-go'));
}
const held = async (page: any, id: string) => Number(String(await page.textContent(id)).split(' ')[0]!.replace(/,/g, ''));

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const outside: string[] = [];
  page.on('request', (r: any) => { const u = r.url(); if (!ours.some((o) => u.startsWith(o)) && !/^(data|blob):/.test(u)) outside.push(u); });
  await page.goto(PAGE);
  await createWallet(page, 180_000, ARC_READY);
  await page.waitForFunction(() => /^0x[0-9a-f]{40}$/i.test(document.getElementById('receive-address')?.textContent ?? ''), null, { timeout: 180_000 });
  const address = String(await page.textContent('#receive-address'));

  // ── 1. a quote ─────────────────────────────────────────────────────────────
  await page.click('#tab-swap');
  const said = await quote(page, '2');
  check('Swap quotes USDC → EURC through LI.FI', await page.isVisible('#swap-quote') && /EURC/.test(String(await page.textContent('#swap-min'))),
    `${await page.textContent('#swap-route')}: at least ${await page.textContent('#swap-min')}, fee ${await page.textContent('#swap-fee')}`);
  check('an empty address cannot swap', /Not enough USDC/.test(said), said);
  check('the page talked to its own origin and Opaque\'s service only', outside.length === 0, outside.slice(0, 3).join(', ') || 'none');

  if (FUND) {
    // ── 2. a real swap, and back ─────────────────────────────────────────────
    await page.click('#tab-home');
    await page.uncheck('#auto-deposit');
    log(`\nSend about 3 testnet USDC to ${address} (Arc testnet) now. Waiting up to 15 minutes…`);
    await page.click('#tab-swap');
    await page.waitForFunction(() => Number(String(document.getElementById('swap-have')?.textContent).split(' ')[0]) >= 1.3, null, { timeout: 900_000, polling: 5_000 });
    const said1 = await quote(page, '1');
    check('with USDC at the address, the swap is offered', /^Swap 1 USDC for/.test(said1), said1);
    await page.click('#swap-go');
    await page.waitForFunction(() => /^Swapped|^Swap failed/.test(document.getElementById('swap-progress-text')?.textContent ?? ''), null, { timeout: 300_000 });
    const done = String(await page.textContent('#swap-progress-text'));
    const eurc = await held(page, '#swap-have-to');
    check('1 USDC became EURC at the address, in one operation the PQ key signed', /^Swapped 1 USDC for/.test(done) && eurc > 0, done);

    await page.click('#swap-flip');
    await page.click('#swap-max');
    const said2 = await quote(page, String(await page.inputValue('#swap-amount')));
    await page.click('#swap-go');
    await page.waitForFunction(() => /^Swapped|^Swap failed/.test(document.getElementById('swap-progress-text')?.textContent ?? ''), null, { timeout: 300_000 });
    const back = String(await page.textContent('#swap-progress-text'));
    check('and all of that EURC back into USDC', /^Swapped [\d.]+ EURC for [\d.]+ USDC/.test(back) && (await held(page, '#swap-have')) === 0, `${said2} → ${back}`);
  }
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).stack ?? error}`);
} finally {
  await browser.close().catch(() => undefined);
}

log(failures === 0 ? `\nArc swaps passed (${PAGE})` : `\nArc swaps FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
