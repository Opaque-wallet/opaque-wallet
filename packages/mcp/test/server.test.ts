// The MCP server through a real MCP client, over an in-memory link, with a
// stand-in wallet: what the agent may do, what it must ask, what it never sees.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { OpaqueWallet } from '@opaque/sdk';

import { takePassword } from '../src/password.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { createOpaqueServer, keyFilePath, unitsOf, writeKeyFile } from '../src/server.ts';

const KEY = `0x${'5a'.repeat(32)}`;
const TO = '0x1111111111111111111111111111111111111111';
const DEPLOYED = '0x4444444444444444444444444444444444444444';

function fakeWallet(options: { canPay?: boolean; policy?: unknown } = {}) {
  const data = new Map<string, string>();
  if (options.policy !== undefined) data.set('opaque:app:mcp:policy', JSON.stringify(options.policy));
  const sent: { to: string; usdc: number }[] = [];
  const signed: string[] = [];
  const arc = {
    address: '0x2222222222222222222222222222222222222222',
    swapTokens: [{ symbol: 'USDC', address: '0x36', decimals: 6 }],
    balance: async () => ({ private: 30, waiting: 0, notes: 3, public: 1 }),
    send: async (to: string, usdc: number) => { sent.push({ to, usdc }); return [{ handle: `h-${sent.length}`, usdc }]; },
    deployer: (index: number) => ({ index, address: '0x3333333333333333333333333333333333333333', key: KEY }),
    fundDeployer: async (_i: number, usdc: number) => { sent.push({ to: 'deployer', usdc }); return [{ handle: 'd', usdc }]; },
    fundsAt: async () => 0,
    canPay: async () => options.canPay ?? true,
    keyStatus: async () => ({ left: 30, max: 32 }),
    riskOf: (_to: string, data: string) => (data.startsWith('0x095ea7b3') ? 'This lets someone spend your USDC.' : null),
    call: async (to: string, data: string) => { signed.push(`call ${to} ${data}`); return '0xtx'; },
    deploy: async () => { signed.push('deploy'); return { address: DEPLOYED, tx: '0xtx' }; },
  };
  const wallet = {
    network: 'testnet', accountId: 'acct', accountKey: () => 'opq1secret',
    arc: async () => arc, xrpl: async () => { throw new Error('no xrpl here'); },
    data: { get: (n: string) => data.get(`opaque:app:${n}`) ?? null, set: (n: string, v: string) => void data.set(`opaque:app:${n}`, v) },
    close: () => undefined,
  } as unknown as OpaqueWallet;
  return { wallet, sent, signed };
}

async function connect(wallet: OpaqueWallet, answer?: boolean) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' }, { capabilities: answer === undefined ? {} : { elicitation: {} } });
  if (answer !== undefined) client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { approve: answer } }));
  await Promise.all([createOpaqueServer(wallet).connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
    return { error: r.isError === true, text: r.content[0]!.text };
  };
  return { client, call };
}

test('the tools an agent gets', async () => {
  const { client } = await connect(fakeWallet().wallet);
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ['wallet_info', 'arc_balance', 'arc_deposit', 'arc_send', 'payment_status', 'get_deployer', 'fund_deployer', 'get_deployer_key', 'arc_deploy', 'arc_call', 'xrpl_send', 'xrpl_deposit_address']) assert.ok(names.includes(n), n);
});

test('a payment within its limits goes, and counts toward the day', async () => {
  const { wallet, sent } = fakeWallet();
  const { call } = await connect(wallet);
  assert.equal((await call('arc_send', { to: TO, usdc: 5 })).error, false);
  assert.deepEqual(sent, [{ to: TO, usdc: 5 }]);
  assert.match((await call('wallet_info')).text, /"paidToday": 5/);
});

test('over a payment\'s limit, it is refused and nothing is sent', async () => {
  const { wallet, sent } = fakeWallet();
  const { call } = await connect(wallet);
  const r = await call('arc_send', { to: TO, usdc: 11 });
  assert.equal(r.error, true);
  assert.match(r.text, /over the 10 a payment may be/);
  assert.equal(sent.length, 0);
});

test('above askAbove, the person decides: a client that can\'t ask gets a refusal', async () => {
  for (const [answer, goes] of [[undefined, false], [false, false], [true, true]] as const) {
    const { wallet, sent } = fakeWallet();
    const { call } = await connect(wallet, answer);
    const r = await call('arc_send', { to: TO, usdc: 8 });
    assert.equal(!r.error, goes, `answer ${answer}`);
    assert.equal(sent.length, goes ? 1 : 0);
  }
});

test('the day\'s limit holds across payments', async () => {
  const { wallet } = fakeWallet();
  const { call } = await connect(wallet, true);
  for (let i = 0; i < 5; i++) assert.equal((await call('arc_send', { to: TO, usdc: 10 })).error, false);
  assert.match((await call('arc_send', { to: TO, usdc: 1 })).text, /over the 50 a day may be/);
});

test('a call that hands tokens over asks first; a plain one to a contract this agent deployed doesn\'t', async () => {
  const approve = `0x095ea7b3${'00'.repeat(64)}`;
  assert.equal((await (await connect(fakeWallet().wallet)).call('arc_call', { to: TO, data: approve })).error, true);
  assert.equal((await (await connect(fakeWallet().wallet, true)).call('arc_call', { to: TO, data: approve })).error, false);
  const { call } = await connect(fakeWallet().wallet);
  assert.equal((await call('arc_deploy', { initcode: '0x6000' })).error, false);
  assert.equal((await call('arc_call', { to: DEPLOYED, data: '0x12345678' })).error, false);
});

test('a deployer\'s key goes into a git-ignored file only you can read, never into the conversation', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'opaque-mcp-'));
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  const { call } = await connect(fakeWallet().wallet, true);
  const r = await call('get_deployer_key', { index: 0, path: join(repo, '.env') });
  assert.equal(r.error, false);
  assert.doesNotMatch(r.text, /5a5a/);
  assert.match(readFileSync(join(repo, '.env'), 'utf8'), new RegExp(`^PRIVATE_KEY=${KEY}$`, 'm'));
  assert.equal(statSync(join(repo, '.env')).mode & 0o777, 0o600);
  // One git would commit is refused.
  const tracked = await call('get_deployer_key', { index: 0, path: join(repo, '.env.local') });
  assert.match(tracked.text, /isn't in \.gitignore/);
  // And without the person's yes, nothing is written.
  const { call: noAsk } = await connect(fakeWallet().wallet);
  assert.match((await noAsk('get_deployer_key', { index: 1, path: join(repo, '.env') })).text, /approval/);
  assert.match(readFileSync(join(repo, '.env'), 'utf8'), new RegExp(`^PRIVATE_KEY=${KEY}$`, 'm'));
});

test('amounts in whole tokens become smallest units exactly', () => {
  const usdc = { symbol: 'USDC', address: '0x36' as never, decimals: 6 };
  assert.equal(unitsOf('2.5', usdc), 2_500_000n);
  assert.equal(unitsOf('1', usdc), 1_000_000n);
  assert.equal(unitsOf('0.000001', usdc), 1n);
  assert.throws(() => unitsOf('0.0000001', usdc), /decimals/);
  assert.throws(() => unitsOf('-1', usdc), /isn't an amount/);
});

// ── overlord F-30…F-44 (2026-10-22): each built from the auditor's proof of concept ──

test('F-30: calldata hiding an invisible character is refused, so the prompt and the signature can\'t read it differently', async () => {
  const { wallet, signed } = fakeWallet();
  const { call } = await connect(wallet, true);
  // approve(ATT, "0" … ) as shown, 2^248-1 once whitespace (U+FEFF) is stripped.
  const poc = `0x095ea7b3${'00'.repeat(12)}${'ee'.repeat(20)}00${'\uFEFF'.repeat(62)}${'f'.repeat(62)}`;
  const r = await call('arc_call', { to: TO, data: poc });
  assert.equal(r.error, true);
  assert.match(r.text, /hex digits, two per byte, and nothing else/);
  assert.deepEqual(signed, []);
  assert.equal((await call('contract_risk', { to: TO, data: poc })).error, true);
});

test('F-31: a key file\'s git check doesn\'t run a repo\'s fsmonitor command', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'opaque-mcp-'));
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  const pwned = join(repo, 'PWNED');
  execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', `touch ${pwned}`]);
  keyFilePath(join(repo, '.env'));
  assert.equal(existsSync(pwned), false);
});

test('F-32: the password leaves the environment once read, and git never sees it', () => {
  const env: Record<string, string | undefined> = { OPAQUE_PASSWORD: 'hunter22', OTHER: 'x' };
  assert.equal(takePassword(env, undefined), 'hunter22');
  assert.equal(env['OPAQUE_PASSWORD'], undefined);
  assert.equal(takePassword({ OPAQUE_PASSWORD: 'a' }, 'printf b', (c) => execFileSync('sh', ['-c', c], { encoding: 'utf8' })), 'b');
  // git, as keyFilePath runs it, gets only PATH and HOME.
  const bin = mkdtempSync(join(tmpdir(), 'opaque-git-'));
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nenv > "${bin}/env.txt"\nexit 0\n`, { mode: 0o755 });
  const path = process.env['PATH'];
  process.env['PATH'] = `${bin}:${path}`;
  process.env['OPAQUE_PASSWORD'] = 'hunter22';
  try { keyFilePath(join(bin, '.env')); } finally { process.env['PATH'] = path; delete process.env['OPAQUE_PASSWORD']; }
  assert.doesNotMatch(readFileSync(join(bin, 'env.txt'), 'utf8'), /hunter22|OPAQUE_PASSWORD/);
});

test('F-34: a deployer whose key was written out is paid like anyone else', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'opaque-mcp-'));
  const { wallet } = fakeWallet({ policy: { ...DEFAULT_POLICY, recipients: [TO] } });
  const { call } = await connect(wallet, true);
  assert.equal((await call('fund_deployer', { index: 3, usdc: 1 })).error, false);
  assert.equal((await call('get_deployer_key', { index: 3, path: join(repo, '.env') })).error, false);
  const r = await call('fund_deployer', { index: 3, usdc: 1 });
  assert.match(r.text, /isn't among the recipients/);
  assert.equal((await call('fund_deployer', { index: 4, usdc: 1 })).error, false);
});

test('F-35: payments approved side by side still keep to the day\'s limit', async () => {
  const { wallet, sent } = fakeWallet({ policy: { ...DEFAULT_POLICY, limits: { 'arc:USDC': { perPayment: 10, perDay: 20, askAbove: 5 } } } });
  const { call } = await connect(wallet, true);
  await Promise.all(Array.from({ length: 5 }, () => call('arc_send', { to: TO, usdc: 8 })));
  assert.ok(sent.reduce((t, s) => t + s.usdc, 0) <= 20, `${sent.length} payments went`);
});

test('F-38: the key goes only into a plain env file, never through a link, mode 600, the rest kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opaque-mcp-'));
  writeFileSync(join(dir, 'Tracked.sol'), 'contract X {}\n');
  symlinkSync(join(dir, 'Tracked.sol'), join(dir, '.env'));
  assert.throws(() => writeKeyFile(keyFilePath(join(dir, '.env')), KEY), /ELOOP|plain file/);
  assert.equal(readFileSync(join(dir, 'Tracked.sol'), 'utf8'), 'contract X {}\n');
  linkSync(join(dir, 'Tracked.sol'), join(dir, '.env.hard'));
  assert.throws(() => writeKeyFile(keyFilePath(join(dir, '.env.hard')), KEY), /plain file/);
  assert.throws(() => keyFilePath(join(dir, '.zshrc')), /only in an env file/);
  writeFileSync(join(dir, '.env.local'), 'A=1\n\nB=2\nPRIVATE_KEY=0xold\n', { mode: 0o644 });
  writeKeyFile(keyFilePath(join(dir, '.env.local')), KEY);
  assert.equal(readFileSync(join(dir, '.env.local'), 'utf8'), `A=1\n\nB=2\nPRIVATE_KEY=${KEY}\n`);
  assert.equal(statSync(join(dir, '.env.local')).mode & 0o777, 0o600);
});

test('F-39: account operations stop at the day\'s count', async () => {
  const { wallet, signed } = fakeWallet({ policy: { ...DEFAULT_POLICY, operationsPerDay: 2 } });
  const { call } = await connect(wallet);
  assert.equal((await call('arc_deploy', { initcode: '0x6000' })).error, false);
  assert.equal((await call('arc_deploy', { initcode: '0x6000' })).error, false);
  assert.match((await call('arc_deploy', { initcode: '0x6000' })).text, /operationsPerDay/);
  assert.equal(signed.length, 2);
});

test('F-40: a call to a contract this agent didn\'t deploy asks, even when it looks harmless', async () => {
  const { wallet, signed } = fakeWallet();
  assert.match((await (await connect(wallet)).call('arc_call', { to: TO, data: '0x12345678' })).text, /didn't deploy/);
  assert.deepEqual(signed, []);
  assert.equal((await (await connect(wallet, true)).call('arc_call', { to: TO, data: '0x12345678' })).error, false);
});

test('F-41: a payment can wait for privacy 7 days at most', async () => {
  const { wallet, sent } = fakeWallet();
  const r = await (await connect(wallet, true)).call('arc_send', { to: TO, usdc: 1, waitForPrivacy: true, deadline: '9999-01-01T00:00:00Z' });
  assert.match(r.text, /7 days at most/);
  assert.equal(sent.length, 0);
});

test('F-42: a payment the notes can\'t make is refused before it counts', async () => {
  const { wallet } = fakeWallet({ canPay: false });
  const { call } = await connect(wallet);
  assert.match((await call('arc_send', { to: TO, usdc: 3 })).text, /can't make exactly 3/);
  assert.match((await call('arc_send', { to: TO, usdc: 11 })).text, /over the 10 a payment may be/, 'its limits are said first');
  assert.match((await call('wallet_info')).text, /"paidToday": 0/);
});

test('F-43: tools that pay or sign say so; reads say they only read', async () => {
  const { client } = await connect(fakeWallet().wallet);
  const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t.annotations]));
  for (const n of ['arc_send', 'arc_call', 'arc_deploy', 'arc_withdraw', 'fund_deployer', 'get_deployer_key', 'xrpl_send', 'arc_swap', 'arc_deposit']) assert.equal(tools.get(n)?.destructiveHint, true, n);
  for (const n of ['arc_balance', 'wallet_info', 'payment_status', 'contract_risk']) assert.equal(tools.get(n)?.readOnlyHint, true, n);
  assert.equal(tools.get('get_deployer')?.readOnlyHint, false);
});
