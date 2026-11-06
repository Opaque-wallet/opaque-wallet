// Opaque on Sepolia in a real browser, against the hosted stack: a wallet made on
// the Sepolia page (Arc's code, VITE_NETWORK=sepolia), test funds from the stack's
// faucet, a deposit its FORS key signs (an ERC-4337 operation, made into notes by
// itself), a private payment through the mesh, and the recipient's tUSDC on chain;
// then opaque.eth claimed from the page with the stack's claim code, pointed at the
// wallet by a FORS+C signature, and paid by name. The name goes back to the stack's
// key at the end (two rotations the test wallet's name keys sign), so the claim
// code still works for a real wallet.
//
//   (cd ../frontend && npm run build:site && npx vite preview --outDir dist --port 5174)
//   node --use-system-ca scripts/e2e-sepolia.ts                    SITE=http://localhost:5174 by default
//   SITE=https://www.opaque.credit node --use-system-ca scripts/e2e-sepolia.ts

import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { ARC_READY, createWallet } from './wallet-page.ts';
import { commitmentOf, masterKey, REGISTRY_ABI, CONTROLLER_ABI, signExecute, signRotation } from '../ethereum/ens.ts';
import { accountKeys, stream } from '../../frontend/src/lib/wallet-keys.ts';
import { dnsEncode, ETHEREUM_COIN, resolveName } from '../../frontend/src/ethereum/ens-name.ts';

const SITE = process.env['SITE'] ?? 'http://localhost:5174';
const d = JSON.parse(readFileSync(new URL('../../deployments/eth-sepolia.json', import.meta.url), 'utf8'));
const pub = createPublicClient({ chain: sepolia, transport: http(d.network.rpcUrl) });
const STACK = new URL('../.stack/eth-sepolia/', import.meta.url);
/** The test wallet's phrase and the stack generation to hand opaque.eth back to, kept until the hand-back is done. */
const NAME_FILE = new URL('e2e-name.json', STACK);
const RES = parseAbi(['function setAddress(bytes name, uint256 coinType, bytes addressBytes)', 'function setText(bytes name, string key, string value)', 'function multicall(bytes[] calls) returns (bytes[])']);
const nameKeys = (phrase: string) => (g: number) => masterKey(stream(accountKeys(phrase, 0).key, 'opaque/v1/ens/names')(32), 'opaque/v1/ens/wallet', g);
const stackKey = (g: number) => masterKey(Buffer.from(readFileSync(new URL('ens.master', STACK), 'utf8').trim().replace(/^0x/, ''), 'hex'), 'opaque/v1/ens/controller', g);
const nameState = () => pub.readContract({ address: d.ens.pqKeyRegistry, abi: REGISTRY_ABI, functionName: 'stateOf', args: [d.ens.controller] });
type NameState = Awaited<ReturnType<typeof nameState>>;
/** The registry's state once `test` holds: Sepolia's public RPC is load-balanced, and a node a block behind answers too. */
async function settled(test: (s: NameState) => boolean, what: string): Promise<NameState> {
  for (const end = Date.now() + 120_000; Date.now() < end; await new Promise((r) => setTimeout(r, 3_000))) {
    const s = await nameState().catch(() => undefined);
    if (s !== undefined && test(s)) return s;
  }
  throw new Error(`opaque.eth's key never showed ${what}`);
}

/**
 * opaque.eth back to the stack: the test wallet's name key puts back the records the
 * stack set, then the wallet's two keys rotate the stack's generations `to`, `to + 1` in.
 * Resumable: each step reads where the registry is first.
 */
async function handBack({ phrase, to }: { phrase: string; to: number }): Promise<void> {
  const chainId = BigInt(d.network.chainId);
  const { controller, pqKeyRegistry, resolver } = d.ens as Record<string, `0x${string}`>;
  const mine = nameKeys(phrase);
  const wallet = createWalletClient({ account: privateKeyToAccount(readFileSync(new URL('deployer.key', STACK), 'utf8').trim() as Hex), chain: sepolia, transport: http(d.network.rpcUrl) });
  const mined = async (hash: Hex) => { if ((await pub.waitForTransactionReceipt({ hash })).status !== 'success') throw new Error(`reverted: ${hash}`); };
  const deadline = (await pub.getBlock()).timestamp + 30n * 86_400n;
  const [home, after] = [commitmentOf(stackKey(to)), commitmentOf(stackKey(to + 1))];
  const isMine = (c: string) => [0, 1].some((g) => commitmentOf(mine(g)) === c.toLowerCase());
  let s = await settled((x) => isMine(x.pkCommitment) || x.pkCommitment.toLowerCase() === home, 'the test wallet\'s key or the stack\'s');
  let restored = false;
  while (isMine(s.pkCommitment)) {
    const key = [0, 1].map(mine).find((k) => commitmentOf(k) === s.pkCommitment.toLowerCase())!;
    const was = s;
    if (!restored) {
      const name = dnsEncode('opaque.eth');
      const data = encodeFunctionData({ abi: RES, functionName: 'multicall', args: [[
        encodeFunctionData({ abi: RES, functionName: 'setAddress', args: [name, ETHEREUM_COIN, controller] }),
        encodeFunctionData({ abi: RES, functionName: 'setText', args: [name, 'pq-key', home] }),
      ]] });
      await mined(await wallet.writeContract({ address: controller, abi: CONTROLLER_ABI, functionName: 'execute', args: [resolver, data, deadline, signExecute(key, chainId, controller, s.useCount, resolver, data, deadline)] }));
      restored = true;
      s = await settled((x) => x.useCount > was.useCount || x.pkCommitment !== was.pkCommitment, 'the records call');
      continue;
    }
    const next = s.nextCommitment.toLowerCase() === home ? after : home;
    await mined(await wallet.writeContract({ address: pqKeyRegistry, abi: REGISTRY_ABI, functionName: 'rotate', args: [controller, next, 32n, deadline, signRotation(key, chainId, controller, s.useCount, next, 32n, deadline)] }));
    s = await settled((x) => x.pkCommitment !== was.pkCommitment, 'the rotation');
  }
  await settled((x) => x.pkCommitment.toLowerCase() === home && x.nextCommitment.toLowerCase() === after, `the stack's generation ${to}`);
  console.log(`ok  opaque.eth handed back to the stack's key (generation ${to}): the claim code works again`);
}

if (process.env['HAND_BACK'] === '1') {
  await handBack(JSON.parse(readFileSync(NAME_FILE, 'utf8')));
  rmSync(NAME_FILE);
  process.exit(0);
}
const tusdc = (who: `0x${string}`) => pub.readContract({ address: d.tokens.usdc.address, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [who] });
const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
const build = readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort().pop()!;
const browser = await chromium.launch({ executablePath: process.env['CHROMIUM'] ?? join(cache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing') });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e: Error) => errors.push(e.message));
const check = (ok: unknown, what: string) => { if (!ok) throw new Error(what); console.log(`ok  ${what}`); };
const until = async (what: string, test: () => Promise<boolean>, ms = 300_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 5_000))) if (await test().catch(() => false)) return;
  throw new Error(`timed out: ${what}`);
};

try {
  await page.goto(`${SITE}/sepolia/app`);
  const phrase = await createWallet(page, 180_000, ARC_READY);
  check((await page.textContent('#network-switch'))?.includes('Sepolia'), 'a wallet made on the Sepolia page');
  check((await page.textContent('.hero .shield')) === 'Shielded on Sepolia', 'the page names its chain, not Arc');
  await page.waitForFunction(() => /^0x[0-9a-f]{40}$/i.test(document.getElementById('receive-address')?.textContent?.trim() ?? ''), undefined, { timeout: 120_000 });
  const account = (await page.textContent('#receive-address'))!.trim() as `0x${string}`;
  check(true, `its PQ account's address, known before the account exists: ${account}`);

  await page.click('#test-faucet');
  await page.waitForFunction(() => /^(On its way|The faucet said no)/.test(document.getElementById('deposit-status')?.textContent ?? ''), undefined, { timeout: 180_000 });
  const asked = (await page.textContent('#deposit-status')) ?? '';
  check(asked.startsWith('On its way'), `the stack's faucet: ${asked}`);
  await until('the faucet\'s tUSDC', async () => (await tusdc(account)) >= 100_000_000n || Number(await page.textContent('#balance')) > 0);
  check(true, 'the stack\'s faucet paid gas and 100 tUSDC');

  // Auto-deposit, on by default on a test network: the account's first operation deploys it and deposits.
  await page.waitForFunction(() => Number(document.getElementById('balance')?.textContent) >= 100, undefined, { timeout: 600_000 })
    .catch(async (e: Error) => { throw new Error(`${e.message}; deposit says: ${await page.textContent('#deposit-status')}; notes: ${await page.textContent('#note-count')}`); });
  check(true, `the tUSDC became private notes, deposited by a UserOperation its FORS key signed: ${await page.textContent('#note-count')}`);

  const recipient = `0x${randomBytes(20).toString('hex')}` as `0x${string}`;
  await page.click('#tab-send');
  await page.fill('#recipient', recipient);
  await page.fill('#send-amount', '3');
  await page.click('#arm');
  await until('the pool to pay the recipient', async () => (await tusdc(recipient)) === 3_000_000n, 600_000);
  check(true, `paid privately: ${recipient} holds exactly 3 tUSDC, from the pool`);

  // opaque.eth, claimed on the page with the stack's claim code.
  const held = await nameState();
  const k = Array.from({ length: 62 }, (_, i) => i).find((g) => commitmentOf(stackKey(g)) === held.pkCommitment.toLowerCase());
  if (k === undefined) throw new Error('opaque.eth is not the stack\'s to give: a wallet claimed it already');
  writeFileSync(NAME_FILE, JSON.stringify({ phrase, to: k + 2 }), { mode: 0o600 });
  // Only this wallet's own first name key may be sent: one the test could not hand back never leaves the page.
  const ours = commitmentOf(nameKeys(phrase)(0));
  await page.route('**/v1/ens/claim', (route: any) => (JSON.parse(route.request().postData()).pk === ours ? route.continue() : route.abort()));
  await page.click('#tab-home');
  await page.waitForSelector('#name-claim', { state: 'visible', timeout: 60_000 });
  await page.fill('#name-code', readFileSync(new URL('ens-claim-code', STACK), 'utf8').trim());
  await page.click('#name-claim');
  await page.waitForFunction(() => /^(Claimed|Not claimed)/.test(document.getElementById('name-status')?.textContent ?? ''), undefined, { timeout: 300_000 });
  const claimed = (await page.textContent('#name-status')) ?? '';
  check(claimed.startsWith('Claimed'), `opaque.eth claimed from the page: ${claimed}`);
  await settled((x) => x.pkCommitment.toLowerCase() === ours, 'the wallet\'s key');
  check(true, 'PQKeyRegistry: opaque.eth\'s controller answers to the wallet\'s first name key');
  await page.waitForSelector('#name-point', { state: 'visible', timeout: 120_000 });
  await page.click('#name-point');
  await page.waitForFunction(() => /now resolves to this wallet|^Not changed/.test(document.getElementById('name-status')?.textContent ?? ''), undefined, { timeout: 300_000 });
  check((await page.textContent('#name-status'))?.includes('now resolves'), `the wallet's FORS+C key set its records: ${await page.textContent('#name-status')}`);
  // Public RPCs are load-balanced: one a block behind still reads the old record for a few seconds.
  await until('ENS to name the wallet', async () => { const r = await resolveName('opaque.eth', ETHEREUM_COIN); return r.address.toLowerCase() === account.toLowerCase() && r.pq; }, 120_000);
  check(true, `ENSv2's UniversalResolver: opaque.eth → ${account}, a name a FORS+C key holds`);

  // Paid by name: the wallet looks opaque.eth up and pays the address it names, privately.
  const from = await pub.getBlockNumber();
  const TRANSFER = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])[0];
  await page.click('#tab-send');
  await page.fill('#recipient', 'opaque.eth');
  await page.fill('#send-amount', '2');
  await page.click('#arm');
  await until('opaque.eth to be paid', async () => (await pub.getLogs({ address: d.tokens.usdc.address, event: TRANSFER, args: { to: account }, fromBlock: from })).some((l) => l.args.value === 2_000_000n), 600_000);
  check(true, 'paid opaque.eth by name: 2 tUSDC from the pool to the address ENS names');
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  await browser.close();
  // A failed hand-back must not hide why the test failed; HAND_BACK=1 finishes it.
  if (existsSync(NAME_FILE)) await handBack(JSON.parse(readFileSync(NAME_FILE, 'utf8'))).then(() => rmSync(NAME_FILE), (e: Error) => { process.exitCode = 1; console.log(`FAIL the hand-back: ${e.message}. Finish it: HAND_BACK=1 node --use-system-ca scripts/e2e-sepolia.ts`); });
}
