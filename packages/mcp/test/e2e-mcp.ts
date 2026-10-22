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

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

const client = new Client({ name: 'e2e', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'serve', '--dir', dir], env, stderr: 'ignore' }));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 }) as { isError?: boolean; content: { text: string }[] };
  const text = r.content[0]!.text;
  return { error: r.isError === true, text, value: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; } })() };
};

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
    await call('arc_deposit', { usdc: 1 });
    for (let i = 0; i < 40 && balance.private < 1; i++) { await new Promise((r) => setTimeout(r, 3_000)); balance = (await call('arc_balance')).value as typeof balance; }
  }
  const before = deployer.usdc;
  const paid = await call('fund_deployer', { index: 2, usdc: 1 });
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

log(failures === 0 ? '\nopaque-mcp on Arc testnet passed' : `\nopaque-mcp on Arc testnet FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
