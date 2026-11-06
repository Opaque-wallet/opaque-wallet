// Opaque on Sepolia in a real browser, against the hosted stack: a wallet made on
// the Sepolia page (Arc's code, VITE_NETWORK=sepolia), test funds from the stack's
// faucet, a deposit its FORS key signs (an ERC-4337 operation, made into notes by
// itself), a private payment through the mesh, and the recipient's tUSDC on chain;
// the account's ETH listed and sent publicly from Send; a name.opaque.eth claimed
// by the wallet, resolved by ENS (through anon-rpc), paid by name and released; then
// every Opaque server refused, and a note leaving its pool anyway (announce, wait the
// pool's delay, withdraw) through anon-rpc and a public bundler;
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
import { ARC_READY, createWallet, unlockIfAsked } from './wallet-page.ts';
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
  const stacks = (c: string) => Array.from({ length: to + 2 }, (_, g) => g).some((g) => commitmentOf(stackKey(g)) === c.toLowerCase());
  let s = await settled((x) => isMine(x.pkCommitment) || stacks(x.pkCommitment), 'the test wallet\'s key or the stack\'s');
  if (!isMine(s.pkCommitment)) { console.log('    opaque.eth never left the stack\'s key: nothing to hand back'); return; }
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

  // ETH, public, from the same account: Home lists it, Send picks it, the account's PQ key signs the transfer.
  await page.click('#tab-home');
  await page.waitForFunction(() => [...document.querySelectorAll('#assets .asset b')].some((b) => /^[\d.,]+ ETH$/.test(b.textContent ?? '')), undefined, { timeout: 120_000 });
  check(true, `Your funds lists the account's ETH: ${await page.$$eval('#assets .asset b', (bs: Element[]) => bs.map((b) => b.textContent).filter((t) => / ETH$/.test(t ?? '')).join(''))}`);
  const ethTo = `0x${randomBytes(20).toString('hex')}` as `0x${string}`;
  await page.click('#tab-send');
  await page.click('#send-asset');
  await page.click('#asset-eth');
  await page.fill('#recipient', ethTo);
  await page.fill('#send-amount', '0.001');
  await page.click('#arm');
  // Any answer but "Signing…": a refusal must fail here, with its words, not as a timeout.
  await page.waitForFunction(() => { const s = document.getElementById('send-status')?.textContent ?? ''; return s !== '' && !s.startsWith('Signing'); }, undefined, { timeout: 300_000 });
  check((await page.textContent('#send-status'))?.startsWith('Sent'), `sent ETH from the page: ${await page.textContent('#send-status')}`);
  await until('the ETH to arrive', async () => (await pub.getBalance({ address: ethTo })) === 1_000_000_000_000_000n, 120_000);
  check(true, `${ethTo} holds exactly 0.001 ETH`);
  await page.click('#send-asset');
  await page.click('#asset-usdc');

  // name.opaque.eth: the wallet claims its own name; ENS resolves it to the wallet; a payment by that name arrives.
  const label = `e2e-${randomBytes(4).toString('hex')}`;
  await page.click('#tab-home');
  await page.fill('#sub-label', label);
  await page.click('#sub-claim');
  await page.waitForFunction(() => /is yours|^Not done/.test(document.getElementById('sub-status')?.textContent ?? ''), undefined, { timeout: 300_000 });
  check((await page.textContent('#sub-status'))?.includes('is yours'), `claimed from the page: ${await page.textContent('#sub-status')}`);
  await until('ENS to resolve the new name', async () => { const r = await resolveName(`${label}.opaque.eth`, ETHEREUM_COIN); return r.address.toLowerCase() === account.toLowerCase() && r.pq; }, 120_000);
  check(true, `ENSv2's UniversalResolver: ${label}.opaque.eth → ${account}, held by a PQ account`);
  const before = await pub.getBlockNumber();
  await page.click('#tab-send');
  // Notes are whole and spent whole: after 3 (2 + 1) the notes still make 2 and 5.
  await page.fill('#recipient', `${label}.opaque.eth`);
  await page.fill('#send-amount', '2');
  await page.click('#arm');
  await until(`${label}.opaque.eth to be paid`, async () => (await pub.getLogs({ address: d.tokens.usdc.address, event: parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])[0], args: { to: account }, fromBlock: before })).some((l) => l.args.value === 2_000_000n), 600_000)
    .catch(async (e: Error) => { throw new Error(`${e.message}; Send says: ${await page.textContent('#send-status')}`); });
  check(true, `paid ${label}.opaque.eth by name: 2 tUSDC from the pool to the wallet that holds it`);
  page.once('dialog', (dialog: any) => void dialog.accept());
  await page.click('#tab-home');
  await page.click('#sub-release');
  await page.waitForFunction(() => /free again|^Not done/.test(document.getElementById('sub-status')?.textContent ?? ''), undefined, { timeout: 300_000 });
  check((await page.textContent('#sub-status'))?.includes('free again'), `released: ${await page.textContent('#sub-status')}`);

  // opaque.eth, claimed on the page with the stack's claim code.
  const held = await nameState();
  const k = Array.from({ length: 62 }, (_, i) => i).find((g) => commitmentOf(stackKey(g)) === held.pkCommitment.toLowerCase());
  if (k === undefined) throw new Error('opaque.eth is not the stack\'s to give: a wallet claimed it already');
  writeFileSync(NAME_FILE, JSON.stringify({ phrase, to: k + 2 }), { mode: 0o600 });
  // Only this wallet's own first name key may be sent: one the test could not hand back never leaves the page.
  const ours = commitmentOf(nameKeys(phrase)(0));
  await page.route('**/v1/ens/claim', (route: any) => (JSON.parse(route.request().postData()).pk === ours ? route.continue() : route.abort()));
  await page.click('#tab-home');
  await page.click('#name-owner');
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
  await page.fill('#send-amount', '5');
  await page.click('#arm');
  await until('opaque.eth to be paid', async () => (await pub.getLogs({ address: d.tokens.usdc.address, event: TRANSFER, args: { to: account }, fromBlock: from })).some((l) => l.args.value === 5_000_000n), 600_000)
    .catch(async (e: Error) => { throw new Error(`${e.message}; Send says: ${await page.textContent('#send-status')}`); });
  check(true, 'paid opaque.eth by name: 5 tUSDC from the pool to the address ENS names');
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);

  // ── Without Opaque: every server of ours refuses; a note still leaves its pool ──
  const OURS = new URL(d.services.meshExitUrl).host;
  let refused = 0;
  const direct: string[] = [];
  await page.route(`**://${OURS}/**`, (route: any) => { refused++; return route.abort(); });
  page.on('request', (r: any) => { if (/publicnode|pimlico/.test(r.url())) direct.push(`${r.url()} ${(r.postData() ?? '').slice(0, 160)}`); });
  await page.reload();
  await unlockIfAsked(page);
  await page.waitForSelector('#exit-card', { state: 'visible', timeout: 120_000 });
  check(refused > 0, `Opaque's servers refuse the page (${refused} requests): it offers the way out instead of a dead end`);
  await page.click('#exit-find');
  await page.waitForFunction(() => document.querySelectorAll('#exit-notes .exit-row').length > 0 || /^(No notes|Could not)/.test(document.getElementById('exit-status')?.textContent ?? ''), undefined, { timeout: 300_000 });
  const rows = await page.$$eval('#exit-notes .exit-row b', (bs: Element[]) => bs.map((b) => b.textContent ?? ''));
  check(rows.length > 0, `the notes, read from the chain through anon-rpc alone: ${rows.join(', ')} (${await page.textContent('#exit-status')})`);
  const noteId = (await page.getAttribute('#exit-notes .exit-row button', 'data-note'))!;
  const exiting = await page.$eval(`#exit-notes button[data-note="${noteId}"]`, (b: Element) => b.closest('.exit-row')!.querySelector('b')!.textContent ?? '');
  const amount = BigInt(parseInt(exiting, 10)) * 1_000_000n;
  await page.click(`#exit-notes button[data-note="${noteId}"]`);
  await page.waitForFunction(() => /^(Exit announced|Not done)/.test(document.getElementById('exit-status')?.textContent ?? ''), undefined, { timeout: 300_000 });
  check((await page.textContent('#exit-status'))?.startsWith('Exit announced'), `${exiting}: ${await page.textContent('#exit-status')}`);
  const exitFrom = await pub.getBlockNumber();
  // The pool's delay (five minutes on Sepolia), then the withdrawal.
  await page.waitForSelector(`#exit-notes button.primary[data-note="${noteId}"]`, { timeout: 600_000 });
  await page.click(`#exit-notes button.primary[data-note="${noteId}"]`);
  await page.waitForFunction(() => /^(Withdrawn|Not done)/.test(document.getElementById('exit-status')?.textContent ?? ''), undefined, { timeout: 300_000 });
  check((await page.textContent('#exit-status'))?.startsWith('Withdrawn'), `${await page.textContent('#exit-status')}`);
  await until('the exit to pay', async () => (await pub.getLogs({ address: d.tokens.usdc.address, event: parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])[0], args: { to: account }, fromBlock: exitFrom })).some((l) => l.args.value === amount), 180_000);
  check(true, `${exiting} left its pool with no attester, relay or server of Opaque's: ${account} received it`);
  // Only the harness's bootstrap (reading the network's specifier, once) goes straight to an RPC; every account read and UserOperation went through the mixnet.
  const named = direct.filter((r) => r.toLowerCase().includes(account.slice(2).toLowerCase()));
  check(named.length === 0, `no RPC or bundler saw this account from this browser (${direct.length} direct requests, none naming it)${named.length ? `: ${named[0]}` : ''}`);
} finally {
  await browser.close();
  // A failed hand-back must not hide why the test failed; HAND_BACK=1 finishes it.
  if (existsSync(NAME_FILE)) await handBack(JSON.parse(readFileSync(NAME_FILE, 'utf8'))).then(() => rmSync(NAME_FILE), (e: Error) => { process.exitCode = 1; console.log(`FAIL the hand-back: ${e.message}. Finish it: HAND_BACK=1 node --use-system-ca scripts/e2e-sepolia.ts`); });
}
