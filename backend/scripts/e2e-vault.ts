// The Q-Day vault's page in a real browser, with a stand-in for MetaMask: a fresh
// secp256k1 key signing real Sepolia transactions, exposed to the page as an EIP-1193
// provider. Connect, make a guard key, register it, deposit ETH, the thief's try
// (refused: BadSignature), and a signed withdrawal to another address.
//
//   (cd ../frontend && npm run build:site && npx vite preview --outDir dist --port 5174)
//   node --use-system-ca scripts/e2e-vault.ts            SITE=http://localhost:5174 by default

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { createPublicClient, createWalletClient, http, parseAbi, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';

const SITE = process.env['SITE'] ?? 'http://localhost:5174';
const d = JSON.parse(readFileSync(new URL('../../deployments/eth-sepolia.json', import.meta.url), 'utf8'));
const rpcUrl = d.network.rpcUrl as string;
const pub = createPublicClient({ chain: sepolia, transport: http(rpcUrl, { retryCount: 4, retryDelay: 1_500 }) });
const funder = privateKeyToAccount(readFileSync(new URL('../.stack/eth-sepolia/deployer.key', import.meta.url), 'utf8').trim() as Hex);
const eoa = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({ account: eoa, chain: sepolia, transport: http(rpcUrl) });
const VAULT = d.vault.address as Address;
const ETH = '0x0000000000000000000000000000000000000000' as Address;
const balanceOf = (owner: Address) => pub.readContract({ address: VAULT, abi: parseAbi(['function balanceOf(address,address) view returns (uint256)']), functionName: 'balanceOf', args: [owner, ETH] });
const check = (ok: unknown, what: string) => { if (!ok) throw new Error(what); console.log(`ok  ${what}`); };
const until = async (what: string, test: () => Promise<boolean>, ms = 180_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 3_000))) if (await test().catch(() => false)) return;
  throw new Error(`timed out: ${what}`);
};

// A little Sepolia ETH for the stand-in MetaMask wallet: gas, and the deposit.
const fund = await createWalletClient({ account: funder, chain: sepolia, transport: http(rpcUrl) }).sendTransaction({ to: eoa.address, value: parseEther('0.0015') });
await pub.waitForTransactionReceipt({ hash: fund });
await until('the stand-in wallet\'s ETH', async () => (await pub.getBalance({ address: eoa.address })) > 0n);
check(true, `a fresh ECDSA wallet, like MetaMask's: ${eoa.address}, given 0.0015 Sepolia ETH`);

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
    // A load-balanced node behind the funding answers "insufficient funds": ask again.
    for (let i = 0; ; i++) {
      try { return await wallet.sendTransaction({ to: t.to, data: t.data, ...(t.value ? { value: BigInt(t.value) } : {}) }); }
      // So does one behind the last deposit or registration ("reverted"): a real refusal fails every time.
      catch (e) { if (i >= 6 || !/insufficient funds|reverted/i.test((e as Error).message)) throw e; await new Promise((r) => setTimeout(r, 4_000)); }
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

try {
  await page.goto(`${SITE}/sepolia/vault`);
  await page.click('#connect');
  await page.waitForFunction(() => (document.getElementById('connect-status')?.textContent ?? '').startsWith('Connected'), undefined, { timeout: 60_000 });
  check(true, `connected: ${await page.textContent('#connect-status')}`);
  await page.click('#key-new');
  check((await page.$$eval('#words li', (ls: Element[]) => ls.length)) === 12, 'a guard key from 12 new words');
  await page.waitForSelector('#key-register', { state: 'visible', timeout: 60_000 });
  await page.click('#key-register');
  await page.waitForFunction(() => /^(Registered|Not registered)/.test(document.getElementById('key-status')?.textContent ?? ''), undefined, { timeout: 180_000 });
  check((await page.textContent('#key-status'))?.startsWith('Registered'), `the guard key, registered by the ECDSA wallet's ordinary transaction: ${await page.textContent('#key-status')}`);
  await page.waitForFunction(() => !document.getElementById('s-vault')?.classList.contains('locked'), undefined, { timeout: 120_000 });

  await page.fill('#dep-amount', '0.001');
  await page.click('#dep-go');
  await page.waitForFunction(() => /^(In the vault|Not deposited)/.test(document.getElementById('dep-status')?.textContent ?? ''), undefined, { timeout: 180_000 });
  check((await page.textContent('#dep-status'))?.startsWith('In the vault'), `deposited 0.001 ETH from the page: ${await page.textContent('#dep-status')}`);
  await until('the vault to hold it', async () => (await balanceOf(eoa.address)) === parseEther('0.001'));
  check(true, 'PQVault holds exactly 0.001 ETH for the ECDSA wallet');

  await page.click('#attack-go');
  await page.waitForFunction(() => (document.getElementById('attack-status')?.textContent ?? '').startsWith('Refused') || (document.getElementById('attack-status')?.textContent ?? '').startsWith('The chain accepted'), undefined, { timeout: 120_000 });
  check((await page.textContent('#attack-status'))?.includes('BadSignature'), `the thief's try, with the cracked ECDSA key: ${await page.textContent('#attack-status')}`);

  const to = `0x${randomBytes(20).toString('hex')}` as Address;
  await page.fill('#out-amount', '0.0005');
  await page.fill('#out-to', to);
  await page.click('#out-go');
  await page.waitForFunction(() => /^(Out of the vault|Not withdrawn)/.test(document.getElementById('out-status')?.textContent ?? ''), undefined, { timeout: 180_000 });
  check((await page.textContent('#out-status'))?.startsWith('Out of the vault'), `withdrew 0.0005 ETH, signed by the guard key: ${await page.textContent('#out-status')}`);
  await until('the recipient\'s ETH', async () => (await pub.getBalance({ address: to })) === parseEther('0.0005'));
  check(true, `${to} received exactly 0.0005 ETH; the vault still holds 0.0005 for the wallet`);
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  await browser.close();
}
