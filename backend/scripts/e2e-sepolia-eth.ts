// Private ETH on Sepolia in a real browser: a wallet made on the Sepolia page, given
// ETH; "Make private" wraps it to WETH and deposits seven notes (6×0.001 +
// 1×0.0005) in one operation its FORS+C key signs; then Send → "ETH, privately" pays
// 0.0015 ETH from two of them through the mesh, and the recipient holds WETH that
// no transaction from the wallet's address sent.
//
//   (cd ../frontend && npm run build:site && npx vite preview --outDir dist --port 5174)
//   node --use-system-ca scripts/e2e-sepolia-eth.ts           SITE=http://localhost:5174 by default

import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createPublicClient, createWalletClient, fallback, formatEther, http, parseAbi, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { ARC_READY, createWallet } from './wallet-page.ts';

const SITE = process.env['SITE'] ?? 'http://localhost:5174';
const d = JSON.parse(readFileSync(new URL('../../deployments/eth-sepolia.json', import.meta.url), 'utf8'));
const pub = createPublicClient({ chain: sepolia, transport: fallback([d.network.rpcUrl, ...d.network.rpcFallbacks].map((u: string) => http(u, { retryCount: 4, retryDelay: 2_000 }))) });
const funder = createWalletClient({ account: privateKeyToAccount(readFileSync(new URL('../.stack/eth-sepolia/deployer.key', import.meta.url), 'utf8').trim() as Hex), chain: sepolia, transport: http(d.network.rpcUrl) });
const WETH = d.tokens.weth.address as Address;
const weth = (owner: Address) => pub.readContract({ address: WETH, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [owner] });
const check = (ok: unknown, what: string) => { if (!ok) throw new Error(what); console.log(`ok  ${what}`); };
const until = async (what: string, test: () => Promise<boolean>, ms = 300_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 5_000))) if (await test().catch(() => false)) return;
  throw new Error(`timed out: ${what}`);
};

const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
const build = readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort().pop()!;
const browser = await chromium.launch({ executablePath: process.env['CHROMIUM'] ?? join(cache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing') });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e: Error) => errors.push(e.message));
try {
  await page.goto(`${SITE}/sepolia/app`);
  await createWallet(page, 180_000, ARC_READY);
  await page.waitForFunction(() => /^0x[0-9a-f]{40}$/i.test(document.getElementById('receive-address')?.textContent?.trim() ?? ''), undefined, { timeout: 120_000 });
  const account = (await page.textContent('#receive-address'))!.trim().toLowerCase() as Address;
  check(true, `a wallet made on the Sepolia page: ${account}`);
  const fund = await funder.sendTransaction({ to: account, value: parseEther('0.01') });
  await pub.waitForTransactionReceipt({ hash: fund });
  await until('the account\'s ETH', async () => (await pub.getBalance({ address: account })) > 0n);
  check(true, 'the account was given 0.01 Sepolia ETH, public at its address');

  // Make private, from Your funds.
  await page.click('#refresh-balance');
  await page.waitForSelector('#assets [data-do="private"]:not([hidden])', { timeout: 120_000 });
  await page.click('#assets [data-do="private"]');
  await page.fill('#eth-private-amount', '0.0065');
  // Split so any amount up to it can be paid after (makeAmount): 6×0.001 + 1×0.0005, not 0.005 + 0.001 + 0.0005.
  check((await page.textContent('#eth-private-split')) === 'As 6×0.001 + 1×0.0005 ETH notes.', `the split: ${await page.textContent('#eth-private-split')}`);
  await page.click('#eth-private-go');
  await page.waitForFunction(() => /^(Private:|Not made private)/.test(document.getElementById('eth-private-status')?.textContent ?? ''), undefined, { timeout: 300_000 });
  check((await page.textContent('#eth-private-status'))?.startsWith('Private:'), `made private in one operation: ${await page.textContent('#eth-private-status')}`);
  await page.click('#eth-private-dialog button[value="close"]');
  await page.waitForFunction(() => (document.getElementById('hero-peth-amount')?.textContent ?? '') === '0.0065 ETH · private', undefined, { timeout: 300_000 })
    .catch(async (e: Error) => { throw new Error(`${e.message}; hero says ${await page.textContent('#hero-peth-amount')}; funds: ${await page.textContent('#assets')}`); });
  check(true, `the balance shows it: ${await page.textContent('#hero-peth-amount')}, and ${await page.textContent('#hero-eth-amount')}`);

  // Send, ETH privately.
  const to = `0x${randomBytes(20).toString('hex')}` as Address;
  await page.click('#tab-send');
  await page.click('#send-asset');
  await page.click('#asset-peth');
  check((await page.textContent('#send-asset-mode')) === 'Private on Sepolia' && !(await page.isHidden('#send-weth-note')), 'Send → ETH, privately');
  await page.fill('#send-amount', '0.0015');
  await page.fill('#recipient', to);
  await page.click('#arm');
  await page.waitForFunction(() => /^(Sent across the mesh|Not sent|Sent \d+ of)/.test(document.getElementById('send-status')?.textContent ?? ''), undefined, { timeout: 600_000 });
  check((await page.textContent('#send-status'))?.startsWith('Sent across the mesh'), `sent: ${await page.textContent('#send-status')}`);
  check((await page.textContent('#intent-list .intent-amt')) === '0.0015 ETH', `Activity: ${await page.textContent('#intent-list .intent-amt')}`);
  await until('the recipient\'s WETH, both notes', async () => (await weth(to)) >= parseEther('0.0014'), 600_000);
  const got = await weth(to);
  check(got <= parseEther('0.0015') && got >= parseEther('0.0014'), `${to} holds ${formatEther(got)} WETH, paid by the pools (0.0015 less the fee)`);
  const fromWallet = await pub.getLogs({ address: WETH, event: parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])[0], args: { from: account, to }, fromBlock: (await pub.getBlockNumber()) - 500n });
  check(fromWallet.length === 0, 'and no transfer from the wallet\'s address to it');
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  await browser.close();
}
