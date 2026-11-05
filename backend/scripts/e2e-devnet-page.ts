// The wallet's "Fully post-quantum" page (frontend/devnet.html) against the
// live EIP-8141 devnet, in a real browser: a wallet made the way a person makes
// one, then the account's whole life on the page. The faucet funds its
// address, the factory creates it, and it sends ETH signed by FORS+C alone.
//
//   (cd ../frontend && npm run build:site && npx vite preview --outDir dist --port 5174)
//   node --use-system-ca scripts/e2e-devnet-page.ts            SITE=http://localhost:5174 by default
//   SHOT=/some/dir node --use-system-ca scripts/e2e-devnet-page.ts   also saves a screenshot there

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { createWallet } from './wallet-page.ts';

const SITE = process.env['SITE'] ?? 'http://localhost:5174';
const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
const build = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().pop()!;
const browser = await chromium.launch({ executablePath: process.env['CHROMIUM'] ?? join(cache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing') });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e: Error) => errors.push(e.message));
const check = (ok: unknown, what: string) => { if (!ok) throw new Error(what); console.log(`ok  ${what}`); };
/** Waits for the page's status line to start with `prefix`; fails on "Didn't go through". */
async function statusIs(prefix: string, timeout = 240_000): Promise<string> {
  await page.waitForFunction((p: string) => {
    const s = document.getElementById('status')?.textContent ?? '';
    return s.startsWith(p) || s.startsWith('Didn\'t go through');
  }, prefix, { timeout });
  const s = await page.textContent('#status');
  if (!s.startsWith(prefix)) throw new Error(s);
  return s;
}

try {
  await page.goto(`${SITE}/testnet/xrpl`);
  await createWallet(page);
  check(true, 'a wallet, made on the XRPL page with a recovery phrase');

  await page.goto(`${SITE}/testnet/devnet`);
  await page.waitForSelector('#home:not([hidden])', { timeout: 60_000 });
  await statusIs('Account 1, on the EIP-8141 devnet', 120_000);
  check((await page.textContent('#network-switch'))?.includes('Fully post-quantum'), 'the network picker says Fully post-quantum');
  check(await page.isVisible('#create'), 'the account is not created yet, and its address is already known');

  await page.click('#faucet');
  await statusIs('Funded');
  check(Number(await page.textContent('#balance')) > 0, 'the faucet funded the address before the account exists');

  await page.click('#create');
  await statusIs('Created');
  check(await page.isVisible('#send-form'), 'the factory created the account: no ECDSA key signed anything');

  await page.fill('#send-to', '0x000000000000000000000000000000000000dEaD');
  await page.fill('#send-amount', '0.001');
  await page.click('#send');
  await statusIs('Sent.');
  const link = await page.getAttribute('#activity a', 'href');
  check(link?.includes('/tx/0x'), `sent with a FORS+C signature only: ${link}`);
  check((await page.textContent('#facts'))?.includes('7 of 8'), 'the key has 7 signatures left');
  if (process.env['SHOT']) await page.screenshot({ path: join(process.env['SHOT'], 'devnet-page.jpg'), type: 'jpeg', quality: 80, fullPage: true });
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  await browser.close();
}
