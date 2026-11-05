// Opaque's privacy on the EIP-8141 devnet, in a real browser: a wallet made
// the way a person makes one, its account created, test pqUSDC deposited into
// the pools with a FORS-signed transaction, then paid privately: a ring proof
// in the page, sealed, three relays, the stack's attester, and the pool pays.
// Checked on chain: the recipient holds exactly the amount, and the payment's
// transaction was sent by the stack's account, not the payer's.
//
//   node --use-system-ca ethereum/devnet-stack.ts                (another terminal)
//   (cd ../frontend && npx vite --port 5173)                     a dev server: it takes the stack's own mesh root
//   node --use-system-ca scripts/e2e-devnet-private.ts           SITE=http://localhost:5173 by default; SHOT=/dir saves a screenshot
//   SITE=https://www.opaque.credit node --use-system-ca scripts/e2e-devnet-private.ts    the hosted page and service

import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { call, devnet, mined } from '../ethereum/frame.ts';
import { tokenBalance } from '../ethereum/uniswap.ts';
import { createWallet } from './wallet-page.ts';

const SITE = process.env['SITE'] ?? 'http://localhost:5173';
// A dev server serves the pages by file; the built site by its clean URLs.
const [XRPL, DEVNET] = /:5173$/.test(SITE) ? ['xrpl.html', 'devnet.html'] : ['testnet/xrpl', 'testnet/devnet'];
const privacy = (devnet as unknown as { privacy: { token: { address: `0x${string}` }; attester: `0x${string}` } }).privacy;
const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
const build = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().pop()!;
const browser = await chromium.launch({ executablePath: process.env['CHROMIUM'] ?? join(cache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing') });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e: Error) => errors.push(e.message));
const check = (ok: unknown, what: string) => { if (!ok) throw new Error(what); console.log(`ok  ${what}`); };
async function statusIs(id: string, prefix: string, timeout = 300_000): Promise<string> {
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

try {
  await page.goto(`${SITE}/${XRPL}`);
  await createWallet(page, 90_000, () => true);
  await page.goto(`${SITE}/${DEVNET}`);
  await page.waitForFunction(() => (document.getElementById('account-short')?.textContent ?? '').startsWith('0x'), undefined, { timeout: 120_000 });
  const account = (await page.textContent('#address-x'))!.trim().toLowerCase();
  await page.click('#promo-fund-go');
  await statusIs('home-status', 'Funded');
  await page.click('#promo-create-go');
  await statusIs('home-status', 'Created');
  check(true, `an account, created by its factory: ${account}`);

  check((await page.textContent('.hero-label')) === 'Private balance', 'Home shows the private balance first, as Arc does');
  await page.click('#usdc-faucet');
  await statusIs('deposit-status', 'Got 100 test pqUSDC');
  check(true, 'the pqUSDC faucet paid for its own transaction');

  await page.fill('#deposit-amount', '10');
  await page.click('#deposit');
  await page.waitForSelector('#sign-dialog[open]');
  await page.click('#sign-confirm');
  const deposited = await statusIs('deposit-status', 'Deposited');
  check(true, `deposited with a FORS+C signature: ${deposited}`);
  await page.waitForFunction(() => (document.getElementById('balance-main')?.textContent ?? '').startsWith('10.00'), undefined, { timeout: 120_000 });
  check(true, 'the notes are in their rings: 10.00 pqUSDC private');

  const recipient = `0x${randomBytes(20).toString('hex')}` as `0x${string}`;
  await page.click('#tab-send');
  await page.fill('#recipient', recipient);
  await page.fill('#send-amount', '3');
  await page.click('#send-button');
  await page.waitForSelector('#sign-dialog[open]');
  check((await page.textContent('#sign-confirm')) === 'Send privately', 'the review says the account signs nothing: the proofs authorise the payment');
  await page.click('#sign-confirm');
  const paid = await statusIs('send-status', 'Paid privately', 420_000);
  check(true, paid);

  check(await tokenBalance(recipient, privacy.token.address) === 3_000_000n, `the recipient ${recipient} holds exactly 3 pqUSDC`);
  const link = await page.getAttribute('#private-list a', 'href');
  const hash = /0x[0-9a-f]{64}/i.exec(link ?? '')?.[0] as `0x${string}`;
  await mined(hash);
  const tx = await call('eth_getTransactionByHash', [hash]);
  const sender = String(tx.sender ?? tx.from).toLowerCase();
  check(sender === privacy.attester.toLowerCase() && sender !== account, `the pool paid in a transaction the stack's account sent, not the payer's: ${link}`);
  check((await page.textContent('#balance-main'))?.startsWith('7.00'), '7.00 pqUSDC left private');
  await page.click('#tab-ring');
  await page.waitForFunction(() => document.querySelectorAll('#hops .hop').length === 3, undefined, { timeout: 60_000 });
  check(true, `Privacy shows the ring, ${await page.textContent('#pool-size')} deposits, and a three-relay path`);
  if (process.env['SHOT']) await page.screenshot({ path: join(process.env['SHOT'], 'devnet-private.jpg'), type: 'jpeg', quality: 80, fullPage: true });
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  await browser.close();
}
