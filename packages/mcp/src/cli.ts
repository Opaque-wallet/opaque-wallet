#!/usr/bin/env node
// opaque-mcp: Opaque for an AI agent, on this machine.
//
//   opaque-mcp init [--dir D] [--network testnet|mainnet] [--import-key | --import-phrase --account N]
//   opaque-mcp serve [--dir D] [--password-command "…"]     the MCP server, over stdio
//   opaque-mcp policy [--dir D] [--set policy.json]          show or change what it may pay
//   opaque-mcp deployer-key <index> [--dir D]                a deployer's key, here in the terminal
//
// The wallet's password comes from a prompt, or for `serve` (which an MCP
// client starts) from --password-command (a keychain entry that asks you) or,
// less safely, OPAQUE_PASSWORD (password.ts).
// The default folder is ~/.opaque/agent.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { createWallet, deployerKeyOf, openWallet } from '@opaque/sdk';

import { takePassword } from './password.ts';
import { asPolicy, DEFAULT_POLICY } from './policy.ts';
import { POLICY, serve } from './server.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', default: join(homedir(), '.opaque', 'agent') },
    network: { type: 'string', default: 'testnet' },
    'import-key': { type: 'boolean', default: false },
    'import-phrase': { type: 'boolean', default: false },
    account: { type: 'string', default: '0' },
    set: { type: 'string' },
    'password-command': { type: 'string' },
  },
});
const dir = resolve(values.dir!);
const say = (s: string) => process.stderr.write(`${s}\n`);

/** Piped in, not typed: every line, read once. */
let piped: string[] | undefined;
/** A line typed without echo. */
async function secret(question: string): Promise<string> {
  process.stderr.write(question);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    if (piped === undefined) { let all = ''; for await (const chunk of stdin) all += String(chunk); piped = all.split('\n'); }
    process.stderr.write('\n');
    return (piped.shift() ?? '').trim();
  }
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((done) => {
    let typed = '';
    const on = (data: Buffer) => {
      for (const c of data.toString('utf8')) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); process.stderr.write('\n'); done(typed); return; }
        if (c === '\u0003') process.exit(130);
        typed = c === '\u007f' ? typed.slice(0, -1) : typed + c;
      }
    };
    stdin.on('data', on);
  });
}

async function password(): Promise<string> {
  return takePassword(process.env, values['password-command']) ?? secret('Wallet password: ');
}

switch (positionals[0]) {
  case 'init': {
    const pass = await secret('A password for the agent\'s wallet (8+ characters): ');
    if (pass !== await secret('Again: ')) { say('The two passwords differ.'); process.exit(1); }
    const network = values.network as 'testnet' | 'mainnet';
    const wallet = await createWallet({
      dir, password: pass, network,
      ...(values['import-key'] ? { accountKey: await secret('Account key (opq1…): ') } : {}),
      ...(values['import-phrase'] ? { phrase: await secret('Recovery phrase: '), account: Number(values.account) } : {}),
    });
    wallet.data.set(POLICY, JSON.stringify(DEFAULT_POLICY));
    say(`Made the agent's wallet in ${dir}, on ${network}. Opening Arc…`);
    const arc = await wallet.arc();
    say(`
Its Arc address: ${arc.address}
Send it USDC on Arc${network === 'testnet' ? ' Testnet (faucet.circle.com)' : ''}: only what you'd let the agent spend.
The agent turns it into private notes with arc_deposit.${values['import-key'] || values['import-phrase'] ? '' : `
This account exists only in ${dir}: keep the folder and its password, or what it holds is lost.`}

Limits (opaque-mcp policy to change): ${Object.entries(DEFAULT_POLICY.limits).map(([a, l]) => `${a} ${l.perPayment}/payment, ${l.perDay}/day, asks above ${l.askAbove}`).join('; ')}.

Keep the password in your keychain, set to ask you each time something reads it (-T ""):
  security add-generic-password -s opaque-mcp -a "$USER" -T "" -w
Then, for Claude Code:
  claude mcp add opaque -- opaque-mcp serve --dir ${dir} --password-command "security find-generic-password -s opaque-mcp -w"
Don't put the password in the client's config: an agent that can run commands can read that file.`);
    wallet.close();
    process.exit(0);
  }
  case 'serve': {
    await serve(await openWallet({ dir, password: await password() }));
    break;
  }
  case 'policy': {
    const wallet = await openWallet({ dir, password: await password() });
    if (values.set !== undefined) wallet.data.set(POLICY, JSON.stringify(asPolicy(JSON.parse(readFileSync(values.set, 'utf8')))));
    process.stdout.write(`${JSON.stringify(JSON.parse(wallet.data.get(POLICY) ?? JSON.stringify(DEFAULT_POLICY)), null, 2)}\n`);
    wallet.close();
    process.exit(0);
  }
  case 'deployer-key': {
    const index = Number(positionals[1]);
    if (!Number.isInteger(index) || index < 0) { say('Which deployer? opaque-mcp deployer-key 0'); process.exit(1); }
    const { address, key } = await deployerKeyOf({ dir, password: await password() }, index);
    say(`Deployer ${index}: ${address}`);
    process.stdout.write(`PRIVATE_KEY=${key}\n`);
    process.exit(0);
  }
  default:
    say('opaque-mcp init | serve | policy | deployer-key <index>   (--dir, default ~/.opaque/agent)');
    process.exit(positionals[0] === undefined || positionals[0] === 'help' ? 0 : 1);
}
