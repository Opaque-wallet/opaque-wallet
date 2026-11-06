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

import { createPublicClient, createWalletClient, fallback, http, keccak256, parseAbi, parseEther, toBytes, type Address, type Hex } from 'viem';
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
  'function hasRole(bytes32 role, address account) view returns (bool)',
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

const fund = await createWalletClient({ account: funder, chain: sepolia, transport }).sendTransaction({ to: eoa.address, value: parseEther('0.0004'), ...FEES });
await pub.waitForTransactionReceipt({ hash: fund, timeout: 600_000 });
await until('the stand-in wallet\'s ETH', async () => (await pub.getBalance({ address: eoa.address })) > 0n);
check(true, `a fresh ECDSA wallet, like MetaMask's: ${eoa.address}, given 0.0004 Sepolia ETH (its whole run costs well under 0.0001 at Sepolia's fees)`);

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
  // Reads as MetaMask's own RPC answers them, whole-chain log queries included (publicnode caps those at 50,000 blocks).
  const r = await (await fetch('https://sepolia.gateway.tenderly.co', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json() as { result?: unknown; error?: { code: number; message: string; data?: Hex } };
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

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: SITE });
  await page.click('#key-new');
  await page.waitForFunction(() => document.querySelectorAll('#words li').length === 12, undefined, { timeout: 60_000 });
  check(true, 'a guard key from 12 new words (offered only because this address has none registered)');
  await page.click('#key-copy');
  await status('key-status', /^(Copied|Couldn't copy)/, 10_000);
  const shown = (await page.$$eval('#words li', (ls: Element[]) => ls.map((l) => l.textContent))).join(' ');
  check((await page.evaluate(() => navigator.clipboard.readText())) === shown, 'Copy the 12 words: the clipboard holds exactly the words shown');
  await page.waitForSelector('#key-register', { state: 'visible', timeout: 60_000 });
  await page.click('#key-register');
  check((await status('key-status', /^(Registered|Not registered)/)).startsWith('Registered'), `the guard key, registered by the wallet's ordinary transaction: ${await page.textContent('#key-status')}`);
  await page.waitForFunction(() => !document.getElementById('s-contract')?.classList.contains('locked'), undefined, { timeout: 120_000 });
  check(await page.isHidden('#key-new') && await page.isVisible('#key-show'), 'once registered, no new guard key is offered over it: only "Show my 12 words"');

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

  // A second protocol, with the admin keys real ones spread around: a beacon, and three AccessControl roles.
  await page.click('#demo-roles');
  await page.waitForFunction(() => document.querySelectorAll('#c-keys li.yours').length === 4 || /^(No demo|There is no contract)/.test(document.getElementById('c-status')?.textContent ?? ''), undefined, { timeout: 300_000 })
    .catch(async (e: Error) => { throw new Error(`${e.message}; the page says: ${await page.textContent('#c-status')} | ${await page.textContent('#c-keys')}`); });
  const roles = (await page.inputValue('#c-address')) as Address;
  check((await page.$$eval('#c-keys li.yours', (ls: Element[]) => ls.length)) === 4, `a demo with roles ${roles}: the page found its beacon and all three roles: ${(await page.textContent('#c-keys'))?.replace(/\s+/g, ' ')}`);
  await page.click('#go');
  check((await status('go-status', new RegExp(`^(Quantum-safe: every admin key of ${roles.slice(0, 6)}|Not handed|Handed over all but)`, 'i'), 900_000)).startsWith('Quantum-safe'), `the button, for every key: ${await page.textContent('#go-status')}`);
  const beacon = `0x${(await pub.getStorageAt({ address: roles, slot: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50' }))!.slice(26)}` as Address;
  const ROLE = { admin: `0x${'0'.repeat(64)}`, fee: keccak256(toBytes('FEE_ROLE')), pauser: keccak256(toBytes('PAUSER_ROLE')) } as Record<string, Hex>;
  await until('every key at the PQAdmin', async () => {
    if (!same(await read<Address>(beacon, 'owner'), pqAdmin)) return false;
    for (const r of Object.values(ROLE)) if (!(await read<boolean>(roles, 'hasRole', [r, pqAdmin])) || await read<boolean>(roles, 'hasRole', [r, eoa.address])) return false;
    return true;
  });
  check(true, 'on chain: the beacon\'s owner is the PQAdmin, and it holds DEFAULT_ADMIN_ROLE, FEE_ROLE and PAUSER_ROLE while the ECDSA wallet holds none');
  await page.waitForFunction(() => !document.getElementById('s-attack')?.classList.contains('locked'), undefined, { timeout: 120_000 });
  await page.click('#attack-go');
  check((await status('attack-status', /^(Refused|The chain would)/, 120_000)).startsWith('Refused'), `the thief's try on all four: ${await page.textContent('#attack-status')}`);
  await page.fill('#fee', '7');
  await page.click('#fee-go');
  await page.waitForFunction(() => /^Done, as your PQAdmin: set the fee to 7|^Not done/.test(document.getElementById('act-status')?.textContent ?? ''), undefined, { timeout: 300_000 });
  await until('fee 7', async () => (await read<bigint>(roles, 'fee')) === 7n);
  check(true, 'a fee change through FEE_ROLE, signed by the guard key: the fee is 7 on chain');
  await page.click('#upgrade-go');
  await page.waitForFunction(() => /^Done, as your PQAdmin: upgrade|^Not done/.test(document.getElementById('act-status')?.textContent ?? ''), undefined, { timeout: 300_000 });
  await until('version 2 through the beacon', async () => (await read<bigint>(roles, 'version')) === 2n);
  check(true, 'an upgrade through the beacon, signed by the guard key: version 2 on chain');
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  await browser.close();
}
