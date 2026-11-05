// The wallet's "Fully post-quantum" page (frontend/devnet.html) against the
// live EIP-8141 devnet, in a real browser: a wallet made the way a person makes
// one, then the account's whole life on the page. The faucet funds its
// address, the factory creates it, and it sends ETH signed by FORS+C alone.
//
//   (cd ../frontend && npm run build:site && npx vite preview --outDir dist --port 5174)
//   node --use-system-ca scripts/e2e-devnet-page.ts            SITE=http://localhost:5174 by default
//   SHOT=/some/dir node --use-system-ca scripts/e2e-devnet-page.ts   also saves a screenshot there

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
/** Waits for status `id` to start with `prefix`; fails on "Didn't go through". */
async function statusIs(id: string, prefix: string, timeout = 240_000): Promise<string> {
  await page.waitForFunction(([i, p]: string[]) => {
    const s = document.getElementById(i!)?.textContent ?? '';
    return s.startsWith(p!) || s.startsWith('Didn\'t go through');
  }, [id, prefix], { timeout }).catch(async (e: Error) => {
    throw new Error(`${e.message}; #${id} still says: ${await page.textContent(`#${id}`)}`);
  });
  const s = (await page.textContent(`#${id}`)) ?? '';
  if (!s.startsWith(prefix)) throw new Error(s);
  return s;
}
const ready = () => page.waitForFunction(() => (document.getElementById('account-short')?.textContent ?? '').startsWith('0x'), undefined, { timeout: 120_000 });

try {
  await page.goto(`${SITE}/testnet/xrpl`);
  // The phrase is saved when onboarding ends; this page needs nothing else from the XRPL wallet, not even its server.
  await createWallet(page, 90_000, () => true);
  check(true, 'a wallet, made on the XRPL page with a recovery phrase');

  await page.goto(`${SITE}/testnet/devnet`);
  await ready();
  check((await page.textContent('#network-switch'))?.includes('Fully post-quantum'), 'the network picker says Fully post-quantum');
  check(await page.isVisible('#promo-create'), 'the account is not created yet, and its address is already known');

  await page.click('#promo-fund-go');
  const funded = await statusIs('home-status', 'Funded').catch((e: Error) => e.message);
  if (!funded.startsWith('Funded')) {
    // Both faucets dry: our own account funds the address, with a FORS-signed transfer.
    const address = (await page.textContent('#address-x'))!.trim();
    execFileSync('node', ['--use-system-ca', 'ethereum/frame-tx.ts', 'send', address, '0.05'], { stdio: 'inherit' });
    await page.reload();
    await ready();
  }
  check(Number(await page.textContent('#balance-main')) > 0, `the address was funded before the account exists (${funded})`);

  await page.click('#promo-create-go');
  await statusIs('home-status', 'Created');
  check(!(await page.isVisible('#promo-create')), 'the factory created the account: no ECDSA key signed anything');

  await page.click('#tab-send');
  await page.fill('#recipient', '0x000000000000000000000000000000000000dEaD');
  await page.fill('#send-amount', '0.001');
  await page.click('#send-button');
  await statusIs('send-status', 'Sent.');
  const link = await page.getAttribute('#sent-list a', 'href');
  check(link?.includes('/tx/0x'), `sent with a FORS+C signature only: ${link}`);
  check((await page.textContent('#facts'))?.includes('7 of 8'), 'the key has 7 signatures left');

  await page.click('#tab-swap');
  await page.fill('#swap-amount', '0.001');
  await page.waitForFunction(() => Number(document.getElementById('swap-out')?.textContent) > 0, undefined, { timeout: 60_000 });
  const quoted = Number(await page.textContent('#swap-out'));
  check(quoted > 0, `a quote from the pool's own state: ${quoted} pqUSD for 0.001 ETH (${await page.textContent('#swap-rate')})`);
  await page.click('#swap-go');
  const swapped = await statusIs('swap-status', 'Swapped on Uniswap v4');
  // The price moves with every swap, so the check is against the quote: the swap takes no less than 99% of it.
  check(Number(/: ([0-9.]+) pqUSD/.exec(swapped)?.[1]) >= quoted * 0.99 - 0.0001, `swapped on Uniswap v4 with a FORS+C signature only: ${swapped}`);
  check((await page.textContent('#facts'))?.includes('6 of 8'), 'the key has 6 signatures left');

  if (process.env['SHOT']) {
    await page.click('#tab-home');
    await page.screenshot({ path: join(process.env['SHOT'], 'devnet-phone.jpg'), type: 'jpeg', quality: 80, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(process.env['SHOT'], 'devnet-desktop.jpg'), type: 'jpeg', quality: 80 });
    await page.click('#tab-swap');
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(process.env['SHOT'], 'devnet-swap.jpg'), type: 'jpeg', quality: 80 });
  }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  await browser.close();
}
