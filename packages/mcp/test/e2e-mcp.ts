#!/usr/bin/env node
// opaque-mcp on ARC TESTNET, as an agent's client runs it: `init`, then `serve`
// started over stdio by a real MCP client.
//
//   cd packages/mcp && npm run e2e
//   OPAQUE_MCP_CLI=…/node_modules/@opaque/mcp/lib/cli.js npm run e2e     the installed package
//
//   1. init makes the agent's wallet from the funded contracts account's phrase
//      (backend/.stack/e2e-contracts.phrase), with the default limits
//   2. serve answers wallet_info and arc_balance, the notes already on chain found
//   3. over its limit, a payment is refused before anything is signed
//   4. without a client that can ask, a deployer's key is not written
//   5. `opaque-mcp deployer-key` reads the key in a terminal while serve holds the wallet
//   6. fund_deployer pays a deployer 1 USDC privately, and payment_status sees it settle
//
// Step 6 spends a 1-USDC note; with none, it deposits 1 first (1.2 USDC from the address).
//
// --all: every other tool, from a client that asks the person (MCP elicitation,
// answered here), then XRPL testnet (uses the faucet: don't run it beside
// another faucet-using script):
//   7. with approval, a deployer's key goes into a git-ignored .env, mode 600, never the reply
//   8. arc_send pays that deployer 1 USDC privately; it settles; arc_activity lists it
//   9. contract_risk reads an approval in words, a plain call as null
//  10. arc_deploy lands a contract where it said
//  11. a plain call to it signs without asking; an approval asks, and signs once approved
//  12. arc_swap_quote and arc_swap: 1 USDC into EURC without asking, the EURC back with asking
//  13. arc_withdraw declined sends nothing; approved, it sends everything to the deployer
//      (whose key, from step 7, sends it back)
//  14. the account, imported from its phrase, finds the XRP it already holds (from earlier
//      runs) before it is asked for anything; XRP paid to xrpl_deposit_address becomes notes
//  15. xrpl_send pays 10 of it privately (testnet's smaller sizes have no full rings yet), and
//      it arrives; xrpl_activity lists it
//
// --all needs ~3 USDC at the account's address (the withdrawal comes back) and spends ~1.1 of it.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { xrplDeployment } from '../../../deployments/xrpl.ts';

// OPAQUE_MCP_CLI: the built one (node_modules/@opaque/mcp/lib/cli.js), to test the package a company installs.
const CLI = process.env['OPAQUE_MCP_CLI'] ?? new URL('../src/cli.ts', import.meta.url).pathname;
const PHRASE = new URL('../../../backend/.stack/e2e-contracts.phrase', import.meta.url);
const log = (s: string) => process.stdout.write(`${s}\n`);
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => { if (!ok) failures++; log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`); };

if (!existsSync(PHRASE)) { log('no backend/.stack/e2e-contracts.phrase: run backend e2e-arc-contracts.ts --fund first'); process.exit(1); }
const dir = mkdtempSync(join(tmpdir(), 'opaque-mcp-e2e-'));
const password = `e2e-${Date.now()}`;
const env = { ...process.env, OPAQUE_PASSWORD: password } as Record<string, string>;

// ── 1 ─────────────────────────────────────────────────────────────────────
const init = spawnSync(process.execPath, [CLI, 'init', '--dir', dir, '--import-phrase', '--account', '0'],
  { input: `${password}\n${password}\n${readFileSync(PHRASE, 'utf8').trim()}\n`, encoding: 'utf8', env: process.env as Record<string, string> });
const arcAddress = /Its Arc address: (0x[0-9a-f]{40})/i.exec(init.stderr)?.[1];
check('init makes the agent\'s wallet and names its address', init.status === 0 && arcAddress !== undefined, arcAddress ?? init.stderr.slice(-300));

const serveIn = async (c: Client) => {
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'serve', '--dir', dir], env, stderr: 'ignore' }));
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 600_000 }) as { isError?: boolean; content: { text: string }[] };
    const text = r.content[0]!.text;
    return { error: r.isError === true, text, value: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; } })() };
  };
};
const poll = async (ready: () => Promise<boolean>, tries: number, ms: number) => { for (let i = 0; i < tries; i++) { if (await ready()) return true; await new Promise((r) => setTimeout(r, ms)); } return false; };
const client = new Client({ name: 'e2e', version: '1' });
let call = await serveIn(client);

try {
  // ── 2 ───────────────────────────────────────────────────────────────────
  const info = await call('wallet_info');
  check('wallet_info names the account and its limits', info.value['arcAddress'] === arcAddress && /arc:USDC/.test(info.text), String(info.value['arcAddress']));
  const first = await call('arc_balance');
  let balance = first.value as { private: number; public: number; notes: number };
  check('arc_balance reads through the mesh, notes on chain found', typeof balance.public === 'number', first.text.slice(0, 200));

  // ── 3 ───────────────────────────────────────────────────────────────────
  const over = await call('arc_send', { to: '0x1111111111111111111111111111111111111111', usdc: 11 });
  check('over its limit, a payment is refused before anything is signed', over.error && /over the 10/.test(over.text), over.text);

  // ── 4 ───────────────────────────────────────────────────────────────────
  const key = await call('get_deployer_key', { index: 2, path: join(dir, '.env') });
  check('without a client that can ask, no key is written', key.error && /approval/.test(key.text) && !existsSync(join(dir, '.env')) && !/PRIVATE_KEY|0x[0-9a-f]{64}/i.test(key.text), key.text.slice(0, 120));

  // ── 5 ───────────────────────────────────────────────────────────────────
  const deployer = (await call('get_deployer', { index: 2 })).value as { address: string; usdc: number };
  const terminal = spawnSync(process.execPath, [CLI, 'deployer-key', '2', '--dir', dir], { encoding: 'utf8', env });
  check('deployer-key reads the key in a terminal while serve holds the wallet',
    /^PRIVATE_KEY=0x[0-9a-f]{64}\n$/.test(terminal.stdout) && terminal.stderr.includes(deployer.address), `deployer 2 ${deployer.address}`);

  // ── 6 ───────────────────────────────────────────────────────────────────
  if (balance.private < 1) {
    const deposited = await call('arc_deposit', { usdc: 1 });
    if (deposited.error) throw new Error(`arc_deposit: ${deposited.text}`);
    for (let i = 0; i < 40 && balance.private < 1; i++) { await new Promise((r) => setTimeout(r, 3_000)); balance = (await call('arc_balance')).value as typeof balance; }
  }
  const before = deployer.usdc;
  const paid = await call('fund_deployer', { index: 2, usdc: 1 });
  if (paid.error) throw new Error(`fund_deployer: ${paid.text}; ${JSON.stringify(balance)}`);
  const handle = (JSON.parse(paid.text) as { handle: string }[])[0]?.handle;
  let state = '';
  for (let i = 0; i < 60 && handle !== undefined && state !== 'SETTLED' && state !== 'FAILED'; i++) {
    state = String((await call('payment_status', { handle })).value['state']);
    if (state !== 'SETTLED') await new Promise((r) => setTimeout(r, 5_000));
  }
  const after = ((await call('get_deployer', { index: 2 })).value as { usdc: number }).usdc;
  check('fund_deployer pays privately, and payment_status sees it settle', state === 'SETTLED' && after >= before + 1, `${state}; deployer 2 went ${before} → ${after} USDC`);
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).stack ?? error}`);
} finally {
  await client.close();
}

if (process.argv.includes('--all')) {
  // The person, as this client asks them: each question kept, each answered from `answers`.
  const asked: string[] = [];
  const answers: boolean[] = [];
  const approver = new Client({ name: 'e2e', version: '1' }, { capabilities: { elicitation: {} } });
  approver.setRequestHandler(ElicitRequestSchema, async (r) => { asked.push(String(r.params.message)); return { action: 'accept', content: { approve: answers.shift() ?? false } }; });
  const fromBackend = createRequire(new URL('../../../backend/package.json', import.meta.url));
  // The backend's viem and xrpl, as CommonJS: module.exports is the default.
  const load = async (name: string) => { const m = await import(fromBackend.resolve(name)); return m.default ?? m; };
  const viem = await load('viem');
  const { privateKeyToAccount } = await load('viem/accounts');
  const xrpl = await load('xrpl');
  const RPC = 'https://rpc.testnet.arc.io';
  const USDC = '0x3600000000000000000000000000000000000000';
  const EURC = '0x89b50855aa3be2f677cd6303cec089b5f319d72a';
  const arc = viem.createPublicClient({ transport: viem.http(RPC) });
  const tokenAt = (token: string, holder: string) => arc.readContract({ address: token, abi: viem.erc20Abi, functionName: 'balanceOf', args: [holder] }) as Promise<bigint>;
  const settles = async (handle: string) => { let state = ''; await poll(async () => (state = String((await call('payment_status', { handle })).value['state'])) === 'SETTLED' || state === 'FAILED', 60, 5_000); return state; };
  const ledger = new xrpl.Client(xrplDeployment.network.wss);
  try {
    call = await serveIn(approver);

    // ── 7 ─────────────────────────────────────────────────────────────────
    const repo = mkdtempSync(join(tmpdir(), 'opaque-mcp-repo-'));
    spawnSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, '.gitignore'), '.env\n');
    const deployer = (await call('get_deployer', { index: 3 })).value as { address: string };
    answers.push(true);
    const written = await call('get_deployer_key', { index: 3, path: join(repo, '.env') });
    const envFile = String(written.value['path']);
    const keyLine = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
    const terminal = spawnSync(process.execPath, [CLI, 'deployer-key', '3', '--dir', dir], { encoding: 'utf8', env }).stdout;
    check('approved, a deployer\'s key goes into the git-ignored .env, mode 600, and not into the reply',
      !written.error && keyLine === terminal && /^PRIVATE_KEY=0x[0-9a-f]{64}\n$/.test(keyLine) && (statSync(envFile).mode & 0o777) === 0o600
        && !/0x[0-9a-f]{64}/i.test(written.text) && asked.at(-1)!.includes(envFile) && asked.at(-1)!.includes(deployer.address), `${envFile}; asked "${asked.at(-1)?.slice(0, 60)}…"`);
    const deployerKey = /^PRIVATE_KEY=(0x[0-9a-f]{64})$/m.exec(keyLine)?.[1];

    // ── 8 ─────────────────────────────────────────────────────────────────
    let balance = (await call('arc_balance')).value as { private: number; public: number };
    if (balance.private < 1) {
      const deposited = await call('arc_deposit', { usdc: 1 });
      if (deposited.error) throw new Error(`arc_deposit: ${deposited.text}`);
      await poll(async () => (balance = (await call('arc_balance')).value as typeof balance).private >= 1, 40, 3_000);
    }
    const before = await tokenAt(USDC, deployer.address);
    const sent = await call('arc_send', { to: deployer.address, usdc: 1 });
    if (sent.error) throw new Error(`arc_send: ${sent.text}; ${JSON.stringify(balance)}`);
    const handle = (JSON.parse(sent.text) as { handle: string }[])[0]?.handle ?? '';
    const state = await settles(handle);
    const activity = (await call('arc_activity')).text;
    check('arc_send pays 1 USDC privately, it settles, and arc_activity lists it',
      state === 'SETTLED' && await tokenAt(USDC, deployer.address) === before + 1_000_000n && activity.includes(handle) && activity.toLowerCase().includes(deployer.address.toLowerCase()), `${state}; ${sent.text.slice(0, 80)}`);

    // ── 9 ─────────────────────────────────────────────────────────────────
    const approveZero = `0x095ea7b3${'00'.repeat(12)}${'ee'.repeat(20)}${'00'.repeat(32)}`;
    const risk = (await call('contract_risk', { to: USDC, data: approveZero })).value['risk'];
    const none = (await call('contract_risk', { to: USDC, data: '0x70a08231' + '00'.repeat(32) })).value;
    check('contract_risk reads an approval in words, a balance read as null', /spend 0 units of USDC/.test(String(risk)) && none['risk'] === null, String(risk));

    // ── 10 ────────────────────────────────────────────────────────────────
    const made = (await call('arc_deploy', { initcode: '0x600a600c600039600a6000f3602a60005260206000f3' })).value as { address: `0x${string}`; tx: string };
    check('arc_deploy lands the contract where it said', await arc.getCode({ address: made.address }) === '0x602a60005260206000f3', `${made.address} in ${made.tx}`);

    // ── 11 ────────────────────────────────────────────────────────────────
    let questions = asked.length;
    const plain = await call('arc_call', { to: made.address, data: '0x12345678' });
    check('a plain call to its own contract signs without asking', !plain.error && asked.length === questions && /^0x[0-9a-f]{64}$/.test(String(plain.value['tx'])), plain.text.slice(0, 100));
    answers.push(true);
    const approval = await call('arc_call', { to: USDC, data: approveZero });
    check('an approval asks first, and signs once approved', !approval.error && asked.length === questions + 1 && /spend 0 units of USDC/.test(asked.at(-1)!), `asked "${asked.at(-1)?.slice(0, 70)}…"; ${approval.text.slice(0, 80)}`);

    // ── 12 ────────────────────────────────────────────────────────────────
    const quote = (await call('arc_swap_quote', { from: 'USDC', to: 'EURC', amount: '1' })).value as { expected: number; atLeast: number };
    questions = asked.length;
    const there = await tokenAt(EURC, String(arcAddress));
    const swapped = await call('arc_swap', { from: 'USDC', to: 'EURC', amount: '1' });
    let eurc = there;
    await poll(async () => (eurc = await tokenAt(EURC, String(arcAddress))) > there, 20, 3_000);
    check('arc_swap_quote quotes, and 1 USDC swaps into EURC without asking', quote.expected > 0 && !swapped.error && asked.length === questions && eurc > there,
      `quoted ${quote.expected} EURC (at least ${quote.atLeast}); got ${Number(eurc - there) / 1e6}; ${swapped.text.slice(0, 60)}`);
    answers.push(true);
    const back = await call('arc_swap', { from: 'EURC', to: 'USDC', amount: `${eurc / 1_000_000n}.${String(eurc % 1_000_000n).padStart(6, '0')}` });
    await poll(async () => (eurc = await tokenAt(EURC, String(arcAddress))) === 0n, 20, 3_000);
    check('EURC, with no limit of its own, swaps back only once the person approves', !back.error && asked.length === questions + 1 && eurc === 0n, `asked "${asked.at(-1)?.slice(0, 60)}…"; ${back.text.slice(0, 60)}`);

    // ── 13 ────────────────────────────────────────────────────────────────
    const held = await tokenAt(USDC, String(arcAddress));
    answers.push(false);
    const declined = await call('arc_withdraw', { to: deployer.address });
    check('a declined withdrawal sends nothing', declined.error && /declined/.test(declined.text) && await tokenAt(USDC, String(arcAddress)) === held, declined.text.slice(0, 80));
    const deployerHad = await tokenAt(USDC, deployer.address);
    answers.push(true);
    const out = await call('arc_withdraw', { to: deployer.address });
    const moved = await tokenAt(USDC, deployer.address) - deployerHad;
    check('an approved withdrawal sends everything at the address to the deployer', !out.error && moved > held - 100_000n && await tokenAt(USDC, String(arcAddress)) === 0n,
      `${Number(moved) / 1e6} of ${Number(held) / 1e6} USDC moved; ${out.text.slice(0, 60)}`);
    // Back to the account, from the deployer's key in the .env: the account keeps its gas money.
    const chain = viem.defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
    const signer = viem.createWalletClient({ account: privateKeyToAccount(deployerKey), chain, transport: viem.http(RPC) });
    const fees = await arc.estimateFeesPerGas({ chain });
    const all = await tokenAt(USDC, deployer.address);
    const gas = await arc.estimateContractGas({ account: deployer.address, address: USDC, abi: viem.erc20Abi, functionName: 'transfer', args: [arcAddress, all / 2n] });
    const returned = all - (gas * 2n * fees.maxFeePerGas + 999_999_999_999n) / 1_000_000_000_000n; // the gas, in 6 decimals, rounded up
    await arc.waitForTransactionReceipt({ hash: await signer.writeContract({ address: USDC, abi: viem.erc20Abi, functionName: 'transfer', args: [arcAddress, returned], gas: gas * 2n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }) });
    log(`      ${Number(returned) / 1e6} USDC sent back to the account from the deployer`);

    // ── 14 ────────────────────────────────────────────────────────────────
    let first = { error: true, text: '', value: {} as Record<string, unknown> };
    await poll(async () => !(first = await call('xrpl_balance', { symbol: 'XRP' })).error, 3, 5_000);
    const found = first.value as { amount: number; notes: number };
    check('an imported account finds the XRP it already holds on XRPL', !first.error && found.amount > 0, first.error ? first.text : `${found.amount} XRP in ${found.notes} notes`);
    const deposit = await call('xrpl_deposit_address', { symbol: 'XRP' });
    if (deposit.error) throw new Error(`xrpl_deposit_address: ${deposit.text}`);
    const at = deposit.value as { xAddress: string; account: string; tag: number };
    await ledger.connect();
    const payer = xrpl.Wallet.generate();
    await poll(async () => { await ledger.fundWallet(payer).catch(() => undefined); return Number(await ledger.getXrpBalance(payer.address).catch(() => '0')) >= 60; }, 6, 5_000);
    const paid = await ledger.submitAndWait({ TransactionType: 'Payment', Account: payer.address, Destination: at.account, DestinationTag: at.tag, Amount: xrpl.xrpToDrops(50) }, { wallet: payer });
    let xrp = { amount: 0, notes: 0 };
    await poll(async () => (xrp = (await call('xrpl_balance', { symbol: 'XRP' })).value as typeof xrp).amount >= found.amount + 50, 40, 5_000);
    check('XRP paid to the deposit address becomes notes', xrp.amount >= found.amount + 50, `${(paid.result.meta as { TransactionResult: string }).TransactionResult} to ${at.xAddress}; ${xrp.amount} XRP in ${xrp.notes} notes`);

    // ── 15 ────────────────────────────────────────────────────────────────
    const payerHad = Number(await ledger.getXrpBalance(payer.address));
    const xsent = await call('xrpl_send', { symbol: 'XRP', amount: 10, to: payer.address });
    const id = String(xsent.value['id']);
    let notes: string[] = [];
    await poll(async () => {
      notes = ((JSON.parse((await call('xrpl_activity')).text) as { id: string; notes: string[] }[]).find((s) => s.id === id)?.notes) ?? [];
      return notes.length > 0 && notes.every((n) => n === 'SETTLED' || n === 'FAILED');
    }, 60, 5_000);
    const arrived = Number(await ledger.getXrpBalance(payer.address)) - payerHad;
    // Each note spent keeps the pool's spendFee (the nullifier credential's reserve and the fee).
    const due = 10 - notes.length * Number(xrplDeployment.pools.find((p) => p.symbol === 'XRP')!.spendFee) / 1e6;
    check('xrpl_send pays 10 XRP privately, it arrives less the fee per note, and xrpl_activity lists it', notes.length > 0 && notes.every((n) => n === 'SETTLED') && Math.abs(arrived - due) < 1e-6, `notes ${notes.join(', ')}; ${arrived} XRP arrived of ${due} due`);
  } catch (error) {
    failures++;
    log(`FAIL  ${(error as Error).stack ?? error}`);
  } finally {
    await approver.close();
    await ledger.disconnect().catch(() => undefined);
  }
}

log(failures === 0 ? '\nopaque-mcp on Arc testnet passed' : `\nopaque-mcp on Arc testnet FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
