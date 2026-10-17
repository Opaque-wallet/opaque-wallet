#!/usr/bin/env node
// The Opaque extension (extension-xrpl/) on XRPL TESTNET, from the outside.
// The hosted demo dapp's stock xrpl-connect GemWallet and Crossmark adapters,
// with no Opaque code of their own, reach the hosted wallet's approval popup.
//
//   cd frontend && npm run ext:xrpl
//   cd backend && npm run xrpl:e2e:extension [-- https://<wallet> https://<dapp>]
//
//   1. the wallet: a faucet deposit, 95 private XRP
//   2. as GemWallet: connect (a fresh account, funded privately), a DEX trade
//      (submitTransaction), an NFT minted and submitted by the dapp
//      (signTransaction), signMessage
//   3. Reject in the popup reaches the dapp as a refusal
//   4. as Crossmark, on the same page: connects without a popup, then a trade
//   5. after a reload, GemWallet reconnects without a popup
//
// Fails if the wallet or its popup sent a request anywhere but their origin
// and the service's. Runs Playwright's own Chromium: branded Chrome no longer
// loads an unpacked extension from the command line. Outside backend's
// typecheck, like the other browser scripts.

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXTENSION = join(ROOT, 'extension-xrpl', 'dist');
const WALLET = (process.argv[2] ?? 'https://opaque-xrpl.vercel.app').replace(/\/+$/, '');
const DAPP = (process.argv[3] ?? 'https://opaque-xrpl-demo.vercel.app').replace(/\/+$/, '');
const STACK = 'https://opaque-xrpl-testnet-production.up.railway.app';
const log = (s: string) => process.stdout.write(`${s}\n`);
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
};

if (!existsSync(join(EXTENSION, 'inject.js'))) throw new Error('extension-xrpl/dist is missing: cd frontend && npm run ext:xrpl');
const profile = mkdtempSync(join(tmpdir(), 'opaque-ext-'));
// ponytail: whichever Chrome for Testing Playwright last downloaded (macOS path); CHROMIUM overrides.
const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
const build = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().pop() : undefined;
const executablePath = process.env['CHROMIUM']
  ?? (build && join(cache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'));
const context = await chromium.launchPersistentContext(profile, {
  ...(executablePath ? { executablePath } : { channel: 'chromium' }), headless: true,
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
try {
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
  await wallet.goto(`${WALLET}/`);
  await wallet.waitForFunction(() => document.getElementById('account-short')?.textContent === 'Notes in this browser', null, { timeout: 90_000 });
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
  check('the wallet holds 95 private XRP', (await wallet.textContent('#balance-main')) === '95', String(await wallet.textContent('#note-count')));

  // ── the dapp, and the extension in it ─────────────────────────────────────
  const dapp = await context.newPage();
  await dapp.goto(`${DAPP}/`);
  const injected = await dapp.evaluate(() => (window as any).gemWallet === true && (window as any).xrpl?.isCrossmark === true);
  check('the extension answers as GemWallet and Crossmark', injected, `on ${DAPP}`);

  let popup: any;
  let popups = 0;
  context.on('page', (p: any) => { if (p !== wallet && p !== dapp) { popups++; popup = p; police(p); } });
  const lines = async () => String(await dapp.textContent('#log')).split('\n').filter(Boolean);
  /** Clicks in the dapp and returns its next log line for that button. */
  async function click(id: string, popupDecision?: { title: RegExp; button: 'approve' | 'reject' }): Promise<string> {
    const before = (await lines()).length;
    await dapp.click(`#${id}`);
    if (popupDecision !== undefined) {
      for (let i = 0; popup === undefined && i < 100; i++) await new Promise((r) => setTimeout(r, 100));
      await popup.waitForFunction((t: string) => new RegExp(t).test(document.getElementById('request-title')?.textContent ?? '')
        && !(document.getElementById(`approve`) as HTMLButtonElement).disabled, popupDecision.title.source, { timeout: 120_000 });
      await popup.click(`#${popupDecision.button}`);
    }
    await dapp.waitForFunction(([n, prefix]: [number, string]) => (document.getElementById('log')?.textContent ?? '').split('\n').filter(Boolean)
      .slice(n).some((l) => l.startsWith(prefix)), [before, id], { timeout: 300_000, polling: 1_000 });
    return (await lines()).slice(before).find((l) => l.startsWith(id))!;
  }

  // ── 2. as GemWallet ────────────────────────────────────────────────────────
  const t0 = Date.now();
  const connected = await click('connect-gem', { title: /Connect privately/, button: 'approve' });
  const site = /connected (r\w+)/.exec(connected)?.[1] ?? '';
  check('GemWallet connect opens Opaque: a fresh account, funded privately', site !== '', `${connected} in ${Math.round((Date.now() - t0) / 1000)} s`);
  const trade = await click('trade', { title: /Sign and submit/, button: 'approve' });
  check('a DEX trade through GemWallet\'s submitTransaction', /tesSUCCESS/.test(trade), trade);
  const nft = await click('nft', { title: /Sign \(the site submits it\)/, button: 'approve' });
  check('an NFT minted, signed through GemWallet\'s signTransaction and submitted by the dapp', /tesSUCCESS/.test(nft), nft);
  const message = await click('message', { title: /Sign a message/, button: 'approve' });
  check('GemWallet\'s signMessage', /signature/.test(message), message);

  // ── 3. a refusal ──────────────────────────────────────────────────────────
  const refused = await click('trade', { title: /Sign and submit/, button: 'reject' });
  check('Reject in Opaque reaches the dapp as a refusal', /failed/.test(refused) && /reject/i.test(refused), refused);

  // ── 4. as Crossmark ────────────────────────────────────────────────────────
  const opened = popups;
  const viaCrossmark = await click('connect-crossmark');
  check('Crossmark connect on the same page: the same account, no popup', viaCrossmark.includes(site) && popups === opened, viaCrossmark);
  const crossTrade = await click('trade', { title: /Sign and submit/, button: 'approve' });
  check('a DEX trade through Crossmark\'s sign-and-submit', /tesSUCCESS/.test(crossTrade), crossTrade);

  // ── 5. a reload ────────────────────────────────────────────────────────────
  await dapp.reload();
  const beforeReload = popups;
  const again = await click('connect-gem');
  check('after a reload, GemWallet reconnects without a popup', again.includes(site) && popups === beforeReload, again);

  check('the wallet and its popup talked to their origin and the service only', outside.length === 0, outside.length === 0 ? 'none' : outside.slice(0, 3).join(', '));
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).stack ?? error}`);
} finally {
  await context.close().catch(() => undefined);
  rmSync(profile, { recursive: true, force: true });
}

log(failures === 0 ? `\nthe Opaque extension passed (${WALLET}, ${DAPP})` : `\nthe Opaque extension FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
