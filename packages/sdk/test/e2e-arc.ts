#!/usr/bin/env node
// The SDK on ARC TESTNET, from Node alone: no browser, no page.
//
//   cd packages/sdk && npm run e2e:arc
//
//   1. a wallet made from the funded contracts account (backend/.stack/e2e-contracts.phrase,
//      the account e2e-arc-contracts.ts --fund keeps) opens, its keys adopted from the chain
//   2. it reads its balance through the mesh
//   3. it deploys a contract through the CREATE2 factory, signed by its PQ key, where it said
//   4. a call that would approve its USDC away is refused before anything is signed
//   5. closed and opened again, it signs once more: the key's signing log survived on disk
//   6. a second process can't open the wallet while it is open
//   7. --pay: 2 USDC deposited as notes, then 1 paid privately to a fresh deployer
//      (proved on a worker thread, sent across the mesh), and it arrives
//
// Each deploy costs the account ~0.03 testnet USDC of gas; --pay, 2 USDC more.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWallet, openWallet } from '../src/index.ts';

const PHRASE = new URL('../../../backend/.stack/e2e-contracts.phrase', import.meta.url);
const RPC = 'https://rpc.testnet.arc.io';
// initcode whose runtime returns 42: PUSH1 0x2a PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN.
const INITCODE = '0x600a600c600039600a6000f3602a60005260206000f3';
const log = (s: string) => process.stdout.write(`${s}\n`);
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => { if (!ok) failures++; log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`); };
const codeAt = async (address: string): Promise<string> => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }) });
  return ((await r.json()) as { result: string }).result;
};

if (!existsSync(PHRASE)) { log('no backend/.stack/e2e-contracts.phrase: run backend e2e-arc-contracts.ts --fund first'); process.exit(1); }
const dir = mkdtempSync(join(tmpdir(), 'opaque-sdk-e2e-'));
const password = `e2e-${Date.now()}`;

try {
  // ── 1–2 ─────────────────────────────────────────────────────────────────
  let wallet = await createWallet({ dir, password, network: 'testnet', phrase: readFileSync(PHRASE, 'utf8').trim(), account: 0 });
  let arc = await wallet.arc();
  const address = arc.address;
  const before = await arc.balance();
  check('the account opens from Node, its keys from the chain', /^0x[0-9a-f]{40}$/i.test(address), address);
  check('its balance reads through the mesh', before.public >= 0.1, `${before.public} USDC at the address, ${before.private} in notes`);

  // ── 3 ───────────────────────────────────────────────────────────────────
  const first = await arc.deploy(INITCODE);
  const code = await codeAt(first.address);
  check('a contract deploys through the factory, signed by the PQ key, where it said', code === '0x602a60005260206000f3', `${first.address} in ${first.tx}`);

  // ── 4 ───────────────────────────────────────────────────────────────────
  const approve = `0x095ea7b3${'00'.repeat(12)}${'ee'.repeat(20)}${'ff'.repeat(32)}`;
  const refused = await arc.call('0x3600000000000000000000000000000000000000', approve).then(() => 'signed', (e: Error) => e.message);
  check('an approval of the account\'s USDC is refused unless allowed', /spend unlimited units of USDC/.test(refused) && /allowRisk/.test(refused), refused.slice(0, 100));

  // ── 5 ───────────────────────────────────────────────────────────────────
  wallet.close();
  wallet = await openWallet({ dir, password });
  arc = await wallet.arc();
  const second = await arc.deploy(INITCODE);
  check('opened again, the same account signs on from its saved log', arc.address === address && await codeAt(second.address) === '0x602a60005260206000f3', `${second.address} in ${second.tx}`);

  // ── 6 ───────────────────────────────────────────────────────────────────
  const other = spawnSync(process.execPath, ['-e', `import('${new URL('../src/index.ts', import.meta.url).href}').then(m => m.openWallet({ dir: ${JSON.stringify(dir)}, password: ${JSON.stringify(password)} })).then(() => console.log('opened'), e => console.log(e.message))`], { encoding: 'utf8' });
  check('a second process can\'t open the wallet while it is open', /another process/.test(other.stdout), other.stdout.trim());

  // ── 7 ───────────────────────────────────────────────────────────────────
  if (process.argv.includes('--pay')) {
    const deposit = await arc.deposit(2);
    let notes = (await arc.balance()).notes;
    for (let i = 0; i < 40 && notes < 2; i++) { await new Promise((r) => setTimeout(r, 3_000)); notes = (await arc.balance()).notes; }
    check('a deposit becomes private notes', notes >= 2, `${JSON.stringify(deposit.notes)}; ${notes} notes`);
    const deployer = await arc.nextDeployer();
    const [payment] = await arc.fundDeployer(deployer.index, 1);
    let status = await arc.status(payment!.handle);
    for (let i = 0; i < 60 && status.state !== 'SETTLED' && status.state !== 'FAILED'; i++) { await new Promise((r) => setTimeout(r, 5_000)); status = await arc.status(payment!.handle); }
    const arrived = await arc.fundsAt(deployer.address);
    check('a private payment, proved on a worker thread, reaches a fresh deployer', status.state === 'SETTLED' && arrived > 0, `${status.state}; deployer ${deployer.index} ${deployer.address} holds ${arrived} USDC`);
  }
  wallet.close();
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).stack ?? error}`);
}

log(failures === 0 ? '\nSDK on Arc testnet passed' : `\nSDK on Arc testnet FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
