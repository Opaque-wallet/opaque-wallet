// "Connect with Opaque" for Ethereum dapps, in a real browser with the built extension:
// a wallet made in the extension's Sepolia page, given a little ETH; a dapp at its own
// https origin that finds "Opaque" by EIP-6963 (it is never window.ethereum), connects,
// and asks for a transaction; the extension's window shows the site and the call, and on
// Approve the account's FORS+C key signs it as an ERC-4337 operation. Then a rejection,
// which the dapp sees as EIP-1193's 4001.
//
//   (cd ../frontend && npm run ext)
//   node --use-system-ca scripts/e2e-eth-connect.ts

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { ARC_READY, createWallet, unlockIfAsked } from './wallet-page.ts';

const d = JSON.parse(readFileSync(new URL('../../deployments/eth-sepolia.json', import.meta.url), 'utf8'));
const pub = createPublicClient({ chain: sepolia, transport: http(d.network.rpcUrl, { retryCount: 4, retryDelay: 1_500 }) });
const funder = createWalletClient({ account: privateKeyToAccount(readFileSync(new URL('../.stack/eth-sepolia/deployer.key', import.meta.url), 'utf8').trim() as Hex), chain: sepolia, transport: http(d.network.rpcUrl) });
const EXTENSION = new URL('../../extension/dist', import.meta.url).pathname;
const DAPP = 'https://dapp.example';
const check = (ok: unknown, what: string) => { if (!ok) throw new Error(what); console.log(`ok  ${what}`); };
const until = async (what: string, test: () => Promise<boolean>, ms = 180_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 3_000))) if (await test().catch(() => false)) return;
  throw new Error(`timed out: ${what}`);
};

// A dapp as wagmi's EIP-6963 store finds wallets: ask, collect the announcements, pick by rdns.
const DAPP_PAGE = `<!doctype html><meta charset="utf-8"><title>dapp</title>
<button id="connect">Connect</button><button id="send">Send</button><pre id="out"></pre>
<script>
  const wallets = [];
  addEventListener('eip6963:announceProvider', (e) => wallets.push(e.detail));
  dispatchEvent(new Event('eip6963:requestProvider'));
  const opaque = () => wallets.find((w) => w.info.rdns === 'credit.opaque').provider;
  window.result = undefined;
  const run = (f) => { window.result = undefined; f().then((r) => { window.result = { ok: r }; }, (e) => { window.result = { code: e.code, message: e.message }; }); };
  document.getElementById('connect').onclick = () => run(() => opaque().request({ method: 'eth_requestAccounts' }));
  document.getElementById('send').onclick = () => run(() => opaque().request({ method: 'eth_sendTransaction', params: [window.tx] }));
</script>`;

const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
const build = readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort().pop()!;
const context = await chromium.launchPersistentContext('', {
  executablePath: process.env['CHROMIUM'] ?? join(cache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  headless: true, args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
const errors: string[] = [];
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const app = await context.newPage();
  await app.goto(`chrome-extension://${id}/sepolia/app.html`);
  await createWallet(app, 180_000, ARC_READY);
  await app.waitForFunction(() => /^0x[0-9a-f]{40}$/i.test(document.getElementById('receive-address')?.textContent?.trim() ?? ''), undefined, { timeout: 120_000 });
  const account = (await app.textContent('#receive-address'))!.trim().toLowerCase() as Address;
  check(true, `a wallet made in the extension; its post-quantum Sepolia account: ${account}`);
  const fund = await funder.sendTransaction({ to: account, value: parseEther('0.004') });
  await pub.waitForTransactionReceipt({ hash: fund });
  await until('the account\'s ETH', async () => (await pub.getBalance({ address: account })) > 0n);
  check(true, 'the account was given 0.004 Sepolia ETH');
  await app.close();

  const dapp = await context.newPage();
  dapp.on('pageerror', (e: Error) => errors.push(e.message));
  await dapp.route(`${DAPP}/**`, (route: { fulfill(o: object): Promise<void> }) => route.fulfill({ contentType: 'text/html', body: DAPP_PAGE }));
  await dapp.goto(`${DAPP}/`);
  const found = await dapp.evaluate(() => {
    const seen: { info: { name: string; rdns: string; icon: string } }[] = [];
    addEventListener('eip6963:announceProvider', (e) => seen.push((e as CustomEvent).detail));
    dispatchEvent(new Event('eip6963:requestProvider'));
    return { seen: seen.map((w) => [w.info.name, w.info.rdns, w.info.icon.startsWith('data:image/svg+xml')]), ethereum: 'ethereum' in window };
  });
  check(found.seen.some(([name, rdns, icon]) => name === 'Opaque' && rdns === 'credit.opaque' && icon === true), `the dapp found Opaque by EIP-6963: ${JSON.stringify(found.seen)}`);
  check(!found.ethereum, 'and Opaque did not take window.ethereum');

  const result = async () => { await dapp.waitForFunction(() => (window as unknown as { result?: unknown }).result !== undefined, undefined, { timeout: 300_000 }); return dapp.evaluate(() => (window as unknown as { result: { ok?: unknown; code?: number; message?: string } }).result); };
  const [popup] = await Promise.all([context.waitForEvent('page'), dapp.click('#connect')]);
  popup.on('pageerror', (e: Error) => errors.push(`popup: ${e.message}`));
  check(popup.url() === `chrome-extension://${id}/sepolia/eth-connect.html`, `the extension's own window opened: ${popup.url()}`);
  await unlockIfAsked(popup);
  await popup.waitForFunction(() => !(document.getElementById('approve') as HTMLButtonElement | null)?.disabled && !document.getElementById('request')!.hidden, undefined, { timeout: 180_000 });
  check((await popup.textContent('#request-origin')) === DAPP, `it names the site that asked: ${await popup.textContent('#request-origin')}`);
  check((await popup.textContent('#request-facts'))?.includes(account), 'and the account it would share');
  await popup.click('#approve');
  const connected = await result();
  check(Array.isArray(connected.ok) && (connected.ok as string[])[0] === account, `the dapp is connected: ${JSON.stringify(connected)}`);
  const again = await dapp.evaluate(async () => {
    const w: { info: { rdns: string }; provider: { request(a: object): Promise<unknown> } }[] = [];
    addEventListener('eip6963:announceProvider', (e) => w.push((e as CustomEvent).detail));
    dispatchEvent(new Event('eip6963:requestProvider'));
    const p = w.find((x) => x.info.rdns === 'credit.opaque')!.provider;
    return [await p.request({ method: 'eth_accounts' }), await p.request({ method: 'eth_chainId' })];
  });
  check(JSON.stringify(again) === JSON.stringify([[account], '0xaa36a7']), `eth_accounts and eth_chainId answer without a window: ${JSON.stringify(again)}`);

  const to = `0x${randomBytes(20).toString('hex')}` as Address;
  await dapp.evaluate(([from, to]) => { (window as unknown as { tx: object }).tx = { from, to, value: '0x38d7ea4c68000' }; }, [account, to]);
  await dapp.click('#send');
  await popup.waitForFunction(() => document.getElementById('request-title')?.textContent === 'Send a transaction' && !(document.getElementById('approve') as HTMLButtonElement).disabled, undefined, { timeout: 120_000 });
  check((await popup.textContent('#request-facts'))?.includes(to), `the window shows the transaction: ${await popup.textContent('#request-summary')}`);
  await popup.click('#approve');
  const sent = await result();
  check(typeof sent.ok === 'string' && /^0x[0-9a-f]{64}$/.test(sent.ok), `eth_sendTransaction answered with a transaction hash: ${JSON.stringify(sent)}`);
  const receipt = await pub.waitForTransactionReceipt({ hash: sent.ok as Hex });
  check(receipt.status === 'success', `mined: https://sepolia.etherscan.io/tx/${sent.ok}`);
  await until('the recipient\'s ETH', async () => (await pub.getBalance({ address: to })) === parseEther('0.001'));
  check(true, `${to} received exactly 0.001 ETH from the post-quantum account, signed by its FORS+C key`);

  await dapp.click('#send');
  await popup.waitForFunction(() => document.getElementById('request-title')?.textContent === 'Send a transaction' && !(document.getElementById('approve') as HTMLButtonElement).disabled, undefined, { timeout: 120_000 });
  await popup.click('#reject');
  const refused = await result();
  check(refused.code === 4001, `rejected in the window: the dapp gets EIP-1193's 4001 (${refused.message})`);
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  await context.close();
}
