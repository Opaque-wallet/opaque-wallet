#!/usr/bin/env node
// Contracts on ARC TESTNET, deployed and owned by an Opaque account's
// post-quantum key, from the outside.
//
//   cd backend && npm run arc:e2e:contracts [-- <site origin>] [--fund]
//
//   1. the Contracts screen names this account as the owner to pass, and works
//      out where the bytecode will land (viem agrees, independently)
//   2. bad bytecode is refused before anything is signed
//   3. a deploy too large for one mesh message (a 16 KB constructor blob) has
//      its gas estimated across the relays, in chunks
//
// --fund then waits for USDC at the printed address (send 2 testnet USDC, e.g.
// from faucet.circle.com), and on chain (its account's phrase is kept in
// backend/.stack/e2e-contracts.phrase, so what you send it is never stranded:
// the next --fund run opens the same account):
//   4. the contract is deployed through the CREATE2 factory, at that address,
//      owned by the account
//   5. a call only the owner may make, signed by the same key, lands
//   6. the pages talked to their origin and Opaque's services only
//
// The origin defaults to https://www.opaque.credit; http://127.0.0.1:<port> is
// a vite dev server.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPublicClient, encodeAbiParameters, encodeFunctionData, getContractAddress, http, parseAbi } from 'viem';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { requireService } from '../../deployments/index.ts';
import { acceptTerms, ARC_READY, createWallet, passkeyOffer, unlockIfAsked } from './xrpl-wallet-page.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const ORIGIN = args.find((a) => !a.startsWith('--')) ?? 'https://www.opaque.credit';
const FUND = args.includes('--fund');
const clean = ORIGIN.includes('opaque.credit');
const base = /\/\/(127\.0\.0\.1|localhost):/.test(ORIGIN) ? ORIGIN : `${ORIGIN}/testnet`;
const ARC = `${base}/app${clean ? '' : '.html'}`;
const FACTORY = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
const PHRASE_FILE = join(HERE, '..', '.stack', 'e2e-contracts.phrase');
const network = (JSON.parse(readFileSync(join(HERE, '..', '..', 'deployments', 'arc-testnet.json'), 'utf8')) as { network: { rpcUrl: string } }).network;
const chain = createPublicClient({ transport: http(network.rpcUrl) });
const NOTE = parseAbi(['function owner() view returns (address)', 'function blobSize() view returns (uint256)', 'function note() view returns (string)', 'function setNote(string)']);
const log = (s: string) => process.stdout.write(`${s}\n`);
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
};

const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
const build = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().pop() : undefined;
const executablePath = process.env['CHROMIUM']
  ?? (build && join(cache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'));
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chromium' }), headless: true });
const bytecode = execFileSync('forge', ['inspect', 'OwnedNote', 'bytecode'], { cwd: join(HERE, '..', '..', 'contracts'), encoding: 'utf8' }).trim() as `0x${string}`;
const ours = [new URL(ORIGIN).origin, new URL(requireService('meshExitUrl')).origin];
/** What the page says after `button`: its status line, once it stops working. */
const said = async (page: any, button: string) => {
  await page.click(button);
  const s = await page.waitForFunction(() => {
    const t = document.getElementById('contracts-status')?.textContent ?? '';
    return t !== '' && !t.startsWith('Signing') ? t : null;
  }, null, { timeout: 300_000, polling: 1_000 });
  return String(await s.jsonValue());
};

try {
  const page = await (await browser.newContext()).newPage();
  const outside: string[] = [];
  page.on('request', (r: any) => { const u = r.url(); if (!ours.some((o) => u.startsWith(o)) && !/^(data|blob):/.test(u)) outside.push(u); });
  page.on('dialog', (d: any) => void d.accept());
  await page.goto(ARC);
  if (FUND && existsSync(PHRASE_FILE)) {
    // The account an earlier --fund run made, and perhaps was sent USDC: opened again by its phrase.
    await acceptTerms(page);
    await page.click('#ob-import');
    await page.fill('#ob-phrase', readFileSync(PHRASE_FILE, 'utf8').trim());
    await page.click('#ob-restore-go');
    await passkeyOffer(page);
    await page.waitForFunction(ARC_READY, null, { timeout: 180_000 });
  } else {
    const phrase = await createWallet(page, 180_000, ARC_READY);
    // Kept before anyone is asked for USDC: a stopped run must not strand what was sent.
    if (FUND) { mkdirSync(dirname(PHRASE_FILE), { recursive: true }); writeFileSync(PHRASE_FILE, phrase, { mode: 0o600 }); }
  }
  await page.waitForFunction(() => /^0x[0-9a-f]{40}$/i.test(document.getElementById('receive-address')?.textContent ?? ''), null, { timeout: 180_000 });
  const account = String(await page.textContent('#receive-address')).toLowerCase() as `0x${string}`;

  // ── 1. the screen ──────────────────────────────────────────────────────────
  await page.click('#tab-contracts');
  await page.waitForSelector('#view-contracts', { state: 'visible', timeout: 30_000 });
  check('Contracts names this account as the owner to pass', String(await page.textContent('#contracts-account')).toLowerCase() === account, account);
  const initcode = `${bytecode}${encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], [account, `0x${'ab'.repeat(16_384)}`]).slice(2)}` as `0x${string}`;
  await page.fill('#deploy-code', initcode);
  const salt = await page.inputValue('#deploy-salt') as `0x${string}`;
  const expected = getContractAddress({ opcode: 'CREATE2', from: FACTORY, salt, bytecode: initcode });
  check('and works out where it will land (viem agrees)', String(await page.textContent('#deploy-at')) === expected, `${expected}, ${(initcode.length - 2) / 2} bytes`);

  // ── 2. refused before signing ──────────────────────────────────────────────
  await page.fill('#deploy-code', '0x608');
  check('bad bytecode is refused before anything is signed', /two digits per byte/.test(String(await page.textContent('#deploy-at'))), String(await page.textContent('#deploy-at')));
  await page.fill('#deploy-code', initcode);

  // ── 3. too large for one message ───────────────────────────────────────────
  if (!FUND) {
    const answer = await said(page, '#deploy-go');
    // Unfunded, the account stops at paying for gas: the estimate itself crossed the relays, in chunks.
    check('a deploy too large for one mesh message is estimated across the relays', /^Not deployed: /.test(answer) && !/too large|exceeds size class|did not complete/i.test(answer), answer.slice(0, 160));
  } else {
    if (await page.isVisible('#contracts-auto')) await page.click('#contracts-auto-off');
    log(`\n  send 2 testnet USDC to ${account} (faucet.circle.com, Arc Testnet)\n`);
    await page.waitForFunction(() => Number.parseFloat(document.getElementById('contracts-gas')?.textContent ?? '0') >= 1, null, { timeout: 1_800_000, polling: 5_000 })
      // A long wait locks the wallet (15 idle minutes) and reloads it: unlocked, as a person would.
      .catch(async () => { await page.reload().catch(() => undefined); await unlockIfAsked(page); await page.waitForFunction(ARC_READY, null, { timeout: 180_000 }); await page.click('#tab-contracts'); });
    await unlockIfAsked(page);
    for (let i = 0; i < 60 && Number.parseFloat(String(await page.textContent('#contracts-gas'))) < 1; i++) {
      await page.click('#refresh-balance').catch(() => undefined);
      await page.click('#tab-contracts');
      await new Promise((r) => setTimeout(r, 10_000));
    }
    const gas = Number.parseFloat(String(await page.textContent('#contracts-gas')));
    if (!(gas >= 1)) throw new Error(`no USDC arrived at ${account}: send 2 testnet USDC, then run again (the same account opens)`);
    await page.fill('#deploy-code', initcode);
    await page.fill('#deploy-salt', salt);

    // ── 4. deployed, owned by the account ────────────────────────────────────
    const answer = await said(page, '#deploy-go');
    const [code, owner, blobSize] = await Promise.all([
      chain.getCode({ address: expected }),
      chain.readContract({ address: expected, abi: NOTE, functionName: 'owner' }).catch(() => '0x'),
      chain.readContract({ address: expected, abi: NOTE, functionName: 'blobSize' }).catch(() => 0n),
    ]);
    check('deployed through the factory, where it said, owned by the account', answer.startsWith(`Deployed at ${expected}`) && (code ?? '0x').length > 2 && String(owner).toLowerCase() === account && blobSize === 16_384n, answer.slice(0, 120));

    // ── 5. an owner-only call ────────────────────────────────────────────────
    await page.fill('#call-data', encodeFunctionData({ abi: NOTE, functionName: 'setNote', args: ['signed post-quantum'] }));
    const sent = await said(page, '#call-go');
    const note = await chain.readContract({ address: expected, abi: NOTE, functionName: 'note' });
    check('a call only the owner may make, signed by the same key, lands', /^Sent, in 0x/.test(sent) && note === 'signed post-quantum', `${sent.slice(0, 60)}; note() = "${note}"`);
    check('the deployed contract is listed', (await page.locator('#contracts-list a').count()) === 1, String(await page.getAttribute('#contracts-list a', 'href')));
  }

  // ── 6. nobody else ─────────────────────────────────────────────────────────
  check('the page talked to its origin and Opaque\'s services only', outside.length === 0, outside.slice(0, 3).join(', ') || 'none');
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).stack ?? error}`);
} finally {
  await browser.close().catch(() => undefined);
}

log(failures === 0 ? `\nArc contracts passed (${ORIGIN}${FUND ? ', on chain' : ''})` : `\nArc contracts FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
