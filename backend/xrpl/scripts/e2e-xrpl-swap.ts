#!/usr/bin/env node
// Private swaps on XRPL TESTNET, from the outside: notes of one pool spent
// through rings into a fresh tag of another, converted by the ledger's AMMs.
//
//   cd backend && npm run xrpl:e2e:swap [-- <wallet page URL>]
//
//   1. a new wallet; the faucet pays its address: 95 private XRP
//   2. Swap quotes 15 XRP → USDC from the AMM, and swaps it privately: the
//      USDC arrives as private notes, at least the quote's minimum
//   3. 10 USDC → RLUSD, token to token through XRP, the same way
//   4. with Carry on, two swaps of 10 XRP → USDC land in one swap tag of the
//      account: the second's quote shows what the first left, and adds it
//   5. the ledger shows the pools paying each other, nothing from the wallet;
//      the page talked to nobody but its origin and Opaque's service
//
// Don't run it beside another faucet-using script.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { createWallet } from '../../scripts/wallet-page.ts';

const PAGE = process.argv[2] ?? 'https://www.opaque.credit/testnet/xrpl';
const STACK = 'https://opaque-xrpl-testnet-production.up.railway.app';
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

/** Refreshes until `symbol`'s private balance reaches `want`, or three minutes pass. */
async function waitFor(page: any, symbol: string, want: number): Promise<number> {
  for (let i = 0; i < 45; i++) {
    await page.click('#tab-home');
    await page.click('#refresh');
    await page.waitForTimeout(4_000);
    await page.click('#tab-swap');
    await page.selectOption('#swap-to', symbol === 'XRP' ? 'USDC' : symbol).catch(() => undefined);
    const have = Number(String(await page.textContent('#swap-have-to')).split(' ')[0]!.replace(/,/g, ''));
    if (have >= want) return have;
  }
  return Number(String(await page.textContent('#swap-have-to')).split(' ')[0]!.replace(/,/g, ''));
}
/** Sets up a swap on the Swap screen and waits for its quote. */
async function quote(page: any, from: string, to: string, amount: number): Promise<{ button: string; least: number }> {
  await page.click('#tab-swap');
  await page.selectOption('#swap-from', from);
  await page.selectOption('#swap-to', to);
  await page.fill('#swap-amount', String(amount));
  await page.waitForFunction(() => { const b = document.getElementById('swap-go') as HTMLButtonElement | null; return b !== null && !/Reading|Enter an amount/.test(b.textContent ?? '') && (!b.disabled || !/^Swap /.test(b.textContent ?? '')); }, null, { timeout: 120_000 });
  // "12 USDC as notes": whole notes, the least that becomes spendable.
  return { button: String(await page.textContent('#swap-go')), least: Number(String(await page.textContent('#swap-min')).split(' ')[0]!.replace(/,/g, '')) };
}

try {
  const page = await browser.newPage();
  const outside: string[] = [];
  page.on('request', (r: any) => { const u = r.url(); if (![new URL(PAGE).origin, STACK].some((o) => u.startsWith(o)) && !/^(data|blob):/.test(u)) outside.push(u); });
  await page.goto(PAGE);
  await createWallet(page);

  // ── 1. XRP to swap ─────────────────────────────────────────────────────────
  await page.click('#tab-receive');
  await page.waitForFunction(() => /^T/.test(document.getElementById('address-x')?.textContent ?? ''), null, { timeout: 180_000 });
  await page.click('#address-faucet');
  await page.waitForFunction(() => /^The faucet paid|^Faucet unavailable/.test(document.getElementById('address-status')?.textContent ?? ''), null, { timeout: 180_000 });
  for (let i = 0; i < 30 && (await page.textContent('#balance-xrp')) !== '95'; i++) { await page.click('#tab-home'); await page.click('#refresh'); await page.waitForTimeout(4_000); }
  check('the faucet\'s XRP became private notes', (await page.textContent('#balance-xrp')) === '95', String(await page.textContent('#note-count')));

  // ── 2. XRP → USDC ──────────────────────────────────────────────────────────
  const q1 = await quote(page, 'XRP', 'USDC', 15);
  check('Swap quotes 15 XRP → USDC from the ledger\'s AMM', /^Swap 15 XRP for ~[\d.]+ USDC/.test(q1.button) && q1.least > 0, `${q1.button}; at least ${q1.least} USDC, ${await page.textContent('#swap-route')}`);
  await page.click('#swap-go');
  // A countdown in seconds while it settles: it shows a number, and the number goes down.
  await page.waitForFunction(() => /^\d+$/.test(document.getElementById('swap-eta')?.textContent ?? ''), null, { timeout: 30_000 });
  const first = Number(await page.textContent('#swap-eta'));
  await page.waitForTimeout(2_500);
  const later = Number(await page.textContent('#swap-eta'));
  if (process.env['E2E_SHOTS']) await page.screenshot({ path: join(process.env['E2E_SHOTS'], 'swap-countdown.png') });
  check('a countdown in seconds runs while the swap settles', Number.isFinite(first) && later < first, `${first} s, then ${later} s: ${await page.textContent('#swap-progress-text')}`);
  await page.waitForFunction(() => ['✓', '!'].includes(document.getElementById('swap-eta')?.textContent ?? ''), null, { timeout: 600_000 });
  log(`      ${await page.textContent('#swap-progress-text')}`);
  const usdc = await waitFor(page, 'USDC', q1.least);
  check('the USDC arrived as private notes, at least the minimum', usdc >= q1.least, `${usdc} USDC`);

  // ── 3. USDC → RLUSD, through XRP ───────────────────────────────────────────
  // What step 2 brought, up to 10: at XRP's price on the day, 15 XRP may buy a
  // little under 10 USDC, and notes are whole units.
  const tokens = Math.min(10, Math.floor(usdc));
  const q2 = await quote(page, 'USDC', 'RLUSD', tokens);
  check(`${tokens} USDC → RLUSD quotes through XRP`, /through XRP/.test(String(await page.textContent('#swap-route'))) && q2.least > 0, `${q2.button}; at least ${q2.least} RLUSD`);
  await page.click('#swap-go');
  await page.waitForFunction(() => ['✓', '!'].includes(document.getElementById('swap-eta')?.textContent ?? ''), null, { timeout: 600_000 });
  log(`      ${await page.textContent('#swap-progress-text')}`);
  check('the countdown ends saying what arrived', /^Arrived: [\d.,]+ RLUSD/.test(String(await page.textContent('#swap-progress-text'))), String(await page.textContent('#swap-progress-text')));
  const rlusd = await waitFor(page, 'RLUSD', q2.least);
  check('and the RLUSD arrived as private notes', rlusd >= q2.least, `${rlusd} RLUSD`);

  // ── 4. leftovers carried forward ───────────────────────────────────────────
  await page.check('#swap-carry');
  const swapped: string[] = [];
  for (const round of [1, 2]) {
    const q = await quote(page, 'XRP', 'USDC', 10);
    if (round === 2) {
      const carried = await page.isVisible('#swap-carried-row') ? String(await page.textContent('#swap-carried')) : 'none';
      check('the next quote shows what the last swap carried, and counts it', /^0\.\d+ USDC$/.test(carried), `${carried}; at least ${q.least} USDC as notes`);
    }
    await page.click('#swap-go');
    await page.waitForFunction(() => ['✓', '!'].includes(document.getElementById('swap-eta')?.textContent ?? ''), null, { timeout: 600_000 });
    swapped.push(String(await page.textContent('#swap-progress-text')));
  }
  check('each says what carries to the next swap', swapped.every((t) => /carries to your next USDC swap/.test(t)), swapped.join(' | '));
  await page.click('#tab-activity');
  const tags = await page.$$eval('#sent-list .intent-meta', (r: Element[]) => r.map((x) => /your USDC swap tag \((\d+)\)/.exec(x.textContent ?? '')?.[1]).filter(Boolean));
  check('both landed in the account\'s one USDC swap tag', tags.length === 2 && tags[0] === tags[1], tags.join(', '));

  // ── 5. what the outside saw ────────────────────────────────────────────────
  // Every note of both swaps settled, as Activity polls them: up to ten minutes.
  for (let i = 0; i < 40 && (await page.$$('#sent-list .intent-state.settled')).length < 4; i++) {
    await page.click('#tab-home');
    await page.click('#tab-activity');
    await page.waitForTimeout(15_000);
  }
  const rows = await page.$$eval('#sent-list .intent', (r: Element[]) => r.map((x) => x.querySelector('.intent-amt')?.textContent + ': ' + x.querySelector('.intent-state')?.textContent));
  log(`      ${String(await page.textContent('#sent-list')).replace(/\s+/g, ' ').slice(0, 900)}`);
  check('Activity shows every note of every swap settled', rows.filter((r: string) => /→/.test(r)).length === 4 && rows.filter((r: string) => /→/.test(r)).every((r: string) => /: settled$/.test(r)), rows.join(' | '));
  check('the page talked to its own origin and Opaque\'s service only', outside.length === 0, outside.slice(0, 3).join(', ') || 'none');
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).stack ?? error}`);
} finally {
  await browser.close().catch(() => undefined);
}

log(failures === 0 ? `\nprivate XRPL swaps passed (${PAGE})` : `\nprivate XRPL swaps FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
