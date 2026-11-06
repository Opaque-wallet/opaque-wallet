// "Make your protocol quantum-safe" (frontend/quantum-safe.html) in a real browser, with a
// stand-in for MetaMask: a fresh secp256k1 key signing real Sepolia transactions, exposed to the
// page as an EIP-1193 provider. Connect, make and register a guard key, make a demo protocol
// (two ECDSA admin keys), press the button, the thief's try (refused), then a signed fee change
// and a signed upgrade, each checked on chain.
//
//   (cd ../frontend && npm run build:site && npx vite preview --outDir dist --port 5174)
//   node --use-system-ca scripts/e2e-admin.ts            SITE=http://localhost:5174 by default

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createPublicClient, createWalletClient, fallback, http, parseAbi, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';

const SITE = process.env['SITE'] ?? 'http://localhost:5174';
const d = JSON.parse(readFileSync(new URL('../../deployments/eth-sepolia.json', import.meta.url), 'utf8'));
const rpcUrl = d.network.rpcUrl as string;
// This office's TLS proxy resets connections now and then (admin-sepolia.ts).
const transport = fallback([rpcUrl, 'https://sepolia.gateway.tenderly.co'].map((u) => http(u, { retryCount: 4, retryDelay: 1_500 })));
const pub = createPublicClient({ chain: sepolia, transport });
const funder = privateKeyToAccount(readFileSync(new URL('../.stack/eth-sepolia/deployer.key', import.meta.url), 'utf8').trim() as Hex);
const eoa = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({ account: eoa, chain: sepolia, transport });
// Sepolia's base fee is a few wei; a 2-wei tip can sit unmined for minutes.
const FEES = { maxPriorityFeePerGas: 10_000_000n, maxFeePerGas: 50_000_000n };
const ADMIN = d.admin as { factory: Address };
const ABI = parseAbi([
  'function owner() view returns (address)',
  'function fee() view returns (uint256)',
  'function version() view returns (uint256)',
  'function adminOf(address guardian) view returns (address)',
]);
const read = <T>(address: Address, functionName: string, args: readonly unknown[] = []) => pub.readContract({ address, abi: ABI, functionName, args } as never) as Promise<T>;
const check = (ok: unknown, what: string) => { if (!ok) throw new Error(what); console.log(`ok  ${what}`); };
const until = async (what: string, test: () => Promise<boolean>, ms = 180_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 3_000))) if (await test().catch(() => false)) return;
  throw new Error(`timed out: ${what}`);
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const fund = await createWalletClient({ account: funder, chain: sepolia, transport }).sendTransaction({ to: eoa.address, value: parseEther('0.003'), ...FEES });
await pub.waitForTransactionReceipt({ hash: fund, timeout: 600_000 });
await until('the stand-in wallet\'s ETH', async () => (await pub.getBalance({ address: eoa.address })) > 0n);
check(true, `a fresh ECDSA wallet, like MetaMask's: ${eoa.address}, given 0.003 Sepolia ETH`);

const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
const build = readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort().pop()!;
const browser = await chromium.launch({ executablePath: process.env['CHROMIUM'] ?? join(cache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing') });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e: Error) => errors.push(e.message));
// The stand-in for MetaMask: accounts and transactions from the key above; reads from the RPC.
await page.exposeFunction('__wallet', async (method: string, params: unknown[]) => {
  if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [eoa.address];
  if (method === 'eth_chainId') return `0x${sepolia.id.toString(16)}`;
  if (method === 'wallet_switchEthereumChain') return null;
  if (method === 'eth_sendTransaction') {
    const t = params[0] as { to: Address; data: Hex; value?: Hex };
    // A load-balanced node behind the last transaction sees too little ETH, or the call reverting: ask again.
    for (let i = 0; ; i++) {
      try { return await wallet.sendTransaction({ to: t.to, data: t.data, ...(t.value ? { value: BigInt(t.value) } : {}), ...FEES }); }
      catch (e) { if (i >= 6 || !/insufficient funds|exceeds allowance|reverted/i.test((e as Error).message)) throw e; await new Promise((r) => setTimeout(r, 4_000)); }
    }
  }
  const r = await (await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json() as { result?: unknown; error?: { code: number; message: string; data?: Hex } };
  if (r.error !== undefined) return { __error: r.error };
  return r.result;
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
const status = (id: string, pattern: RegExp, timeout = 300_000) =>
  page.waitForFunction(([i, p]: string[]) => new RegExp(p!).test(document.getElementById(i!)?.textContent ?? ''), [id, pattern.source], { timeout }).then(() => page.textContent(`#${id}`)) as Promise<string>;

try {
  await page.goto(`${SITE}/sepolia/quantum-safe`);
  await page.click('#connect');
  check((await status('connect-status', /^(Connected|Not connected)/)).startsWith('Connected'), `connected: ${await page.textContent('#connect-status')}`);
  const pqAdmin = await read<Address>(ADMIN.factory, 'adminOf', [eoa.address]);

  await page.click('#key-new');
  check((await page.$$eval('#words li', (ls: Element[]) => ls.length)) === 12, 'a guard key from 12 new words');
  await page.waitForSelector('#key-register', { state: 'visible', timeout: 60_000 });
  await page.click('#key-register');
  check((await status('key-status', /^(Registered|Not registered)/)).startsWith('Registered'), `the guard key, registered by the wallet's ordinary transaction: ${await page.textContent('#key-status')}`);
  await page.waitForFunction(() => !document.getElementById('s-contract')?.classList.contains('locked'), undefined, { timeout: 120_000 });

  await page.click('#demo-make');
  await page.waitForFunction(() => document.querySelectorAll('#c-keys li.yours').length === 2 || /^(No demo|There is no contract)/.test(document.getElementById('c-status')?.textContent ?? ''), undefined, { timeout: 300_000 })
    .catch(async (e: Error) => { throw new Error(`${e.message}; the page says: ${await page.textContent('#c-status')} | ${await page.textContent('#c-keys')}`); });
  const protocol = (await page.inputValue('#c-address')) as Address;
  check((await page.$$eval('#c-keys li.yours', (ls: Element[]) => ls.length)) === 2, `a demo protocol ${protocol}, and the page found its two ECDSA admin keys: ${(await page.textContent('#c-keys'))?.replace(/\s+/g, ' ')}`);

  await page.click('#go');
  check((await status('go-status', /^(Quantum-safe|Not handed)/, 600_000)).startsWith('Quantum-safe'), `the button: ${await page.textContent('#go-status')}`);
  const proxyAdmin = `0x${(await pub.getStorageAt({ address: protocol, slot: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103' }))!.slice(26)}` as Address;
  await until('both admin keys at the PQAdmin', async () => same(await read<Address>(protocol, 'owner'), pqAdmin) && same(await read<Address>(proxyAdmin, 'owner'), pqAdmin));
  check(true, `on chain: the protocol's owner and its ProxyAdmin's owner are both the PQAdmin ${pqAdmin}`);

  await page.click('#attack-go');
  check((await status('attack-status', /^(Refused|The chain would)/, 120_000)).startsWith('Refused'), `the thief's try, with the cracked ECDSA key: ${await page.textContent('#attack-status')}`);

  await page.fill('#fee', '42');
  await page.click('#fee-go');
  check((await status('act-status', /^(Done|Not done)/)).startsWith('Done'), `a fee change signed by the guard key: ${await page.textContent('#act-status')}`);
  await until('fee 42', async () => (await read<bigint>(protocol, 'fee')) === 42n);
  check(true, 'on chain: the fee is 42');

  await page.click('#upgrade-go');
  await page.waitForFunction(() => /^Done, as your PQAdmin: upgrade/.test(document.getElementById('act-status')?.textContent ?? '') || /^Not done/.test(document.getElementById('act-status')?.textContent ?? ''), undefined, { timeout: 300_000 });
  check((await page.textContent('#act-status'))?.startsWith('Done'), `an upgrade signed by the guard key: ${await page.textContent('#act-status')}`);
  await until('version 2', async () => (await read<bigint>(protocol, 'version')) === 2n);
  check(true, 'on chain: the protocol runs version 2');
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  await browser.close();
}
