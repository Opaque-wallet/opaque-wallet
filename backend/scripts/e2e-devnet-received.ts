// Activity on the devnet page lists what reached the account from anyone, read from the chain:
// a fresh account shows nothing, then another FramePQAccount pays it ETH in a FORS-signed frame
// transaction, and the page lists that payment under "Received" once reopened.
//
//   (cd ../frontend && npm run build:site && npx vite preview --outDir dist --port 5174)
//   node --use-system-ca scripts/e2e-devnet-received.ts            SITE=http://localhost:5174 by default

import { execFileSync } from 'node:child_process';
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
const ready = () => page.waitForFunction(() => (document.getElementById('account-short')?.textContent ?? '').startsWith('0x'), undefined, { timeout: 120_000 });
/** Opens Activity and waits until the Received list has been read from the chain. */
async function received(): Promise<string> {
  await page.click('#tab-activity');
  await page.waitForFunction(() => !/^Looking/.test(document.getElementById('received-list')?.textContent ?? 'Looking'), undefined, { timeout: 60_000 });
  return (await page.textContent('#received-list')) ?? '';
}

try {
  await page.goto(`${SITE}/testnet/xrpl`);
  await createWallet(page, 90_000, () => true);
  await page.goto(`${SITE}/testnet/devnet`);
  await ready();
  const address = (await page.textContent('#address-x'))!.trim();
  check((await received()).includes('Nothing received yet.'), `a new account has received nothing: ${address}`);

  // Another post-quantum account pays it, as Account 2 would pay Account 1.
  execFileSync('node', ['--use-system-ca', 'ethereum/frame-tx.ts', 'send', address, '0.001'], { stdio: 'inherit' });
  await page.reload();
  await ready();
  const list = await received();
  check(/Received 0\.0010+ ETH/.test(list) && /from 0x/.test(list), `Activity lists it under Received: ${list.replace(/\s+/g, ' ').trim()}`);
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  await browser.close();
}
