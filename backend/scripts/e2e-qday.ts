// The Q-Day simulator (frontend/q-day.html) in a real browser, against live Sepolia: set up a
// victim, run Q-Day, and check on chain what the attacker took and what it couldn't; then the
// owner moves the vault's funds and drives the PQAdmin protocol with the guard key alone.
//
//   (cd ../frontend && npm run build:site && npx vite preview --outDir dist --port 5174)
//   node --use-system-ca scripts/e2e-qday.ts            SITE=http://localhost:5174 by default

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createPublicClient, fallback, http, parseAbi, parseEther, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';

const SITE = process.env['SITE'] ?? 'http://localhost:5174';
const d = JSON.parse(readFileSync(new URL('../../deployments/eth-sepolia.json', import.meta.url), 'utf8'));
const pub = createPublicClient({ chain: sepolia, transport: fallback([d.network.rpcUrl, 'https://sepolia.gateway.tenderly.co'].map((u: string) => http(u, { retryCount: 4, retryDelay: 1_500 }))) });
const ABI = parseAbi(['function owner() view returns (address)', 'function balanceOf(address owner, address token) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function fee() view returns (uint256)']);
const ETH = '0x0000000000000000000000000000000000000000' as Address;
const USDC = d.tokens.usdc.address as Address;
const read = <T>(address: Address, functionName: string, args: readonly unknown[] = []) => pub.readContract({ address, abi: ABI, functionName, args } as never) as Promise<T>;
const check = (ok: unknown, what: string) => { if (!ok) throw new Error(what); console.log(`ok  ${what}`); };
const until = async (what: string, test: () => Promise<boolean>, ms = 180_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 3_000))) if (await test().catch(() => false)) return;
  throw new Error(`timed out: ${what}`);
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
const build = readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort().pop()!;
const browser = await chromium.launch({ executablePath: process.env['CHROMIUM'] ?? join(cache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing') });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e: Error) => errors.push(e.message));
const textOf = async (id: string) => ((await page.textContent(`#${id}`)) ?? '').replace(/\s+/g, ' ').trim();

try {
  await page.goto(`${SITE}/sepolia/q-day`);
  await page.click('#setup');
  await page.waitForFunction(() => document.getElementById('st-stealth')?.dataset['state'] === 'done' || /^Setup stopped/.test(document.getElementById('setup-status')?.textContent ?? ''), undefined, { timeout: 600_000 });
  check(!(await textOf('setup-status')).startsWith('Setup stopped'), `the victim, set up on Sepolia: ${await textOf('setup-status') || 'all six steps done'}`);
  const run = await page.evaluate(() => JSON.parse(localStorage.getItem('opaque-qday-run') ?? '{}')) as { victim: `0x${string}`; rescue: `0x${string}`; attacker: Address; plain: Address; safe: Address; pqAdmin: Address };
  const victim = privateKeyToAccount(run.victim).address;
  const rescue = privateKeyToAccount(run.rescue).address;
  check((await read<bigint>(d.vault.address, 'balanceOf', [victim, ETH])) >= parseEther('0.01'), `the vault holds 0.01 ETH for the victim ${victim}`);
  check(same(await read<Address>(run.safe, 'owner'), run.pqAdmin), `the second protocol is the PQAdmin's: ${run.pqAdmin}`);
  check(same(await read<Address>(run.plain, 'owner'), victim), 'the first protocol is the victim\'s ECDSA key\'s');

  await page.click('#qday');
  await page.waitForFunction(() => !document.getElementById('score')!.hidden || /^Stopped/.test(document.getElementById('qday-status')?.textContent ?? ''), undefined, { timeout: 600_000 });
  check(!(await textOf('qday-status')).startsWith('Stopped'), `Q-Day: ${await textOf('qday-status')}`);
  check((await page.textContent('#sk'))?.toLowerCase() === run.victim.toLowerCase(), 'the "cracked" private key shown is the victim\'s');
  const hits = await page.$$eval('#hits li', (ls: Element[]) => ls.map((l) => l.textContent?.replace(/\s+/g, ' ').trim()));
  for (const h of hits) console.log(`    ${h}`);
  check(hits.length === 7, `seven attacks logged`);
  check(same(await read<Address>(run.plain, 'owner'), run.attacker), 'on chain: the plain protocol now belongs to the attacker');
  check(same(await read<Address>(run.safe, 'owner'), run.pqAdmin), 'on chain: the protocol behind PQAdmin is still the PQAdmin\'s');
  check((await read<bigint>(d.vault.address, 'balanceOf', [victim, ETH])) >= parseEther('0.01'), 'on chain: the vault still holds the victim\'s 0.01 ETH');
  check((await read<bigint>(USDC, 'balanceOf', [run.attacker])) >= 50_000_000n, 'on chain: the attacker took the wallet\'s tUSDC');
  check(hits.filter((h) => h?.startsWith('REFUSED')).every((h) => /BadSignature|OwnableUnauthorizedAccount|lattice/.test(h ?? '')), 'every refusal names its reason');

  await page.click('#rescue');
  await page.waitForFunction(() => /^(Done|Stopped)/.test(document.getElementById('rescue-status')?.textContent ?? ''), undefined, { timeout: 600_000 });
  check((await textOf('rescue-status')).startsWith('Done'), `the owner, after Q-Day: ${await textOf('rescue-status')}`);
  await until('the rescue to land', async () => (await read<bigint>(USDC, 'balanceOf', [rescue])) >= 50_000_000n && (await read<bigint>(run.safe, 'fee')) === 1n);
  check(true, `on chain: the owner's new wallet ${rescue} holds the vault's 50 tUSDC (and its 0.01 ETH), and the PQAdmin protocol's fee is 1`);
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  await browser.close();
}
