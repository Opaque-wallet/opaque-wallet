// The site's demo autopilot (frontend/src/demo/autopilot.ts) in a real browser against the live
// stacks: a build made with VITE_DEMO=1, opened at /sepolia/app?demo, Play pressed as the person
// recording would, and the run followed across the Sepolia wallet, the devnet and the Q-Day page
// to its end. Every caption and wait it logs is printed with its time; the test fails where the
// autopilot stops, with its words.
//
//   (cd ../frontend && VITE_DEMO=1 npm run build:site && npx vite preview --outDir dist --port 5174)
//   node --use-system-ca scripts/e2e-demo.ts                       SITE=http://localhost:5174 by default
//   SITE=https://www.opaque.credit node --use-system-ca scripts/e2e-demo.ts   after npm run demo:on
//   PHASE=protocol   start at that step (the run's place, seeded in sessionStorage);
//   FROM=/ethglobal-mumbai   start where the recording does;  UNTIL='A wallet'   stop at that caption

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createPublicClient, createWalletClient, fallback, http, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';

const SITE = process.env['SITE'] ?? 'http://localhost:5174';
const UNTIL = process.env['UNTIL'];
const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
const build = readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort().pop()!;
const browser = await chromium.launch({ executablePath: process.env['CHROMIUM'] ?? join(cache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing') });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors: string[] = [];
page.on('pageerror', (e: Error) => errors.push(`${page.url()}: ${e.message}`));

// The stand-in for MetaMask, for the "Any protocol" step (as in e2e-admin.ts): a fresh secp256k1
// key, funded from the deployer, signing real Sepolia transactions behind an EIP-1193 provider.
const d = JSON.parse(readFileSync(new URL('../../deployments/eth-sepolia.json', import.meta.url), 'utf8'));
const transport = fallback([d.network.rpcUrl as string, 'https://sepolia.gateway.tenderly.co'].map((u) => http(u, { retryCount: 4, retryDelay: 1_500 })));
const pub = createPublicClient({ chain: sepolia, transport });
const FEES = { maxPriorityFeePerGas: 10_000_000n, maxFeePerGas: 50_000_000n };
const eoa = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({ account: eoa, chain: sepolia, transport });
const funder = privateKeyToAccount(readFileSync(new URL('../.stack/eth-sepolia/deployer.key', import.meta.url), 'utf8').trim() as Hex);
await pub.waitForTransactionReceipt({ hash: await createWalletClient({ account: funder, chain: sepolia, transport }).sendTransaction({ to: eoa.address, value: parseEther('0.0004'), ...FEES }), timeout: 600_000 });
console.log(`ok  a stand-in for MetaMask: ${eoa.address}, with 0.0004 Sepolia ETH`);
await page.exposeFunction('__wallet', async (method: string, params: unknown[]) => {
  if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [eoa.address];
  if (method === 'eth_chainId') return `0x${sepolia.id.toString(16)}`;
  if (method === 'wallet_switchEthereumChain') return null;
  if (method === 'eth_sendTransaction') {
    const tx = params[0] as { to: Address; data: Hex; value?: Hex };
    for (let i = 0; ; i++) {
      try { return await wallet.sendTransaction({ to: tx.to, data: tx.data, ...(tx.value ? { value: BigInt(tx.value) } : {}), ...FEES }); }
      catch (e) { if (i >= 6 || !/insufficient funds|exceeds allowance|reverted/i.test((e as Error).message)) throw e; await new Promise((r) => setTimeout(r, 4_000)); }
    }
  }
  const r = await (await fetch('https://sepolia.gateway.tenderly.co', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json() as { result?: unknown; error?: { message: string } };
  return r.error !== undefined ? { __error: r.error } : r.result;
});
await page.addInitScript(() => {
  (window as unknown as { ethereum: unknown }).ethereum = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      const out = await (window as unknown as { __wallet: (m: string, p: unknown[]) => Promise<unknown> }).__wallet(method, params ?? []);
      if (out && typeof out === 'object' && '__error' in (out as object)) throw Object.assign(new Error((out as { __error: { message: string } }).__error.message), (out as { __error: object }).__error);
      return out;
    },
  };
});

try {
  const ended = new Promise<string>((resolve, reject) => page.on('console', (m: any) => {
    const line: string = m.text();
    if (!line.startsWith('[opaque demo')) return;
    console.log(line);
    if (line.endsWith('the demo is done') || (UNTIL !== undefined && line.includes(UNTIL))) resolve(line);
    else if (/\] (stopped at|stopped$)/.test(line)) reject(new Error(line));
  }));
  if (process.env['PHASE'] !== undefined) {
    // Straight to a step: the run's place, as the autopilot keeps it in this tab.
    await page.goto(`${SITE}/sepolia/app`);
    await page.evaluate((phase: string) => sessionStorage.setItem('opaque-demo', JSON.stringify({ phase, label: `e2e-${Date.now().toString(36)}`, started: Date.now() })), process.env['PHASE']);
    await page.reload();
  } else {
    await page.goto(`${SITE}${process.env['FROM'] ?? '/sepolia/app'}?demo`);
    await page.click('#demo-start button', { timeout: 60_000 });
  }
  await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('the demo ran for an hour')), 3_600_000))]);
  console.log(`ok  the demo played ${UNTIL === undefined ? 'to its end' : `to "${UNTIL}"`}: ${await page.textContent('#demo-caption')}`);
  if (errors.length > 0) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log('ok  no page errors');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  // Closing a browser in the middle of a navigation can hang: the run is over either way.
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 10_000))]);
}
process.exit(process.exitCode ?? 0);
