#!/usr/bin/env node
// The HOSTED XRPL wallet, from the outside, in Chrome: the page on Vercel
// boots against the relay root compiled into it, deposits from the testnet
// faucet by tag (asked through the mesh), and pays
// privately through the Railway service's relays, CRE stand-in and attesters,
// on XRPL TESTNET.
//
//   cd backend && npm run xrpl:smoke:hosted [-- https://<wallet> https://<service>]
//
// Fails if the page sent a request, or opened a socket, anywhere but its own
// origin and the service's. Outside backend's typecheck, like the other browser scripts: the
// waitForFunction callbacks run IN THE BROWSER.

import { Client } from 'xrpl';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { openWallet } from './xrpl-wallet-page.ts';
import { xrplDeployment, xrplPool } from '../../deployments/xrpl.ts';

const BASE = (process.argv[2] ?? 'https://opaque-xrpl.vercel.app').replace(/\/+$/, '');
const STACK = (process.argv[3] ?? 'https://opaque-xrpl-testnet-production.up.railway.app').replace(/\/+$/, '');
const log = (s: string) => process.stdout.write(`${s}\n`);
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
};

const pool = xrplPool('XRP');
const client = new Client(xrplDeployment.network.wss);
let browser: any;
try {
  await client.connect();
  const config = await (await fetch(`${STACK}/xrpl-stack.json`)).json() as { directoryChain?: unknown[]; credentialUrl?: string };
  check('the service serves its wallet config', Array.isArray(config.directoryChain) && config.credentialUrl === `${STACK}/v1/credential`, `${config.directoryChain?.length} directory link(s)`);

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const outside: string[] = [];
  const ours = [new URL(BASE).origin, new URL(STACK).origin];
  const isOurs = (u: string) => ours.some((o) => u.startsWith(`${o}/`) || u.startsWith(`${o.replace(/^http/, 'ws')}/`));
  page.on('request', (r: any) => { const u = r.url(); if (!isOurs(u) && !u.startsWith('blob:') && !u.startsWith('data:')) outside.push(u); });
  page.on('websocket', (ws: any) => { if (!isOurs(ws.url())) outside.push(ws.url()); });

  await page.goto(`${BASE}/testnet/xrpl.html`); // the site's home page is the one-pager
  await openWallet(page);
  check('the hosted wallet boots: the directory chains to the root compiled into it', true, new URL(page.url()).pathname);

  await page.click('#tab-receive');
  await page.click('#receive-button');
  await page.waitForFunction(() => (document.getElementById('receive-tag')?.textContent ?? '') !== '', null, { timeout: 120_000 });
  const tag = Number(await page.textContent('#receive-tag'));
  check('a receive tag, registered through the hosted mesh', tag > 0, `${pool.account} tag ${tag}`);

  await page.click('#faucet-button');
  await page.waitForFunction(() => /^The faucet paid|^Faucet unavailable/.test(document.getElementById('receive-status')?.textContent ?? ''), null, { timeout: 150_000 });
  await page.click('#tab-home');
  for (let i = 0; i < 30 && (await page.textContent('#balance-main')) !== '95'; i++) {
    await page.click('#refresh');
    await new Promise((r) => setTimeout(r, 4_000));
  }
  check('the faucet deposit became 95 private XRP in the page', (await page.textContent('#balance-main')) === '95', String(await page.textContent('#note-count')));

  const { wallet: recipient } = await client.fundWallet();
  const balance = async () => BigInt((await client.request({ command: 'account_info', account: recipient.address, ledger_index: 'validated' })).result.account_data.Balance);
  const before = await balance();
  const t0 = Date.now();
  await page.click('#tab-send');
  await page.fill('#send-amount', '1');
  await page.fill('#recipient', recipient.address);
  await page.click('#send-button');
  await page.click('#send-reject');
  await page.waitForFunction(() => (document.getElementById('send-status')?.textContent ?? '') !== '', null, { timeout: 10_000 }).catch(() => undefined);
  check('Reject on the review sends nothing', (await page.textContent('#send-status')) === 'Rejected: nothing was sent.', String(await page.textContent('#send-status')));
  await page.click('#send-button');
  await page.click('#send-confirm');
  await page.waitForFunction(() => /^Sent:/.test(document.getElementById('send-status')?.textContent ?? ''), null, { timeout: 300_000 });
  await page.click('#tab-activity');
  await page.waitForFunction(() => document.querySelector('#sent-list .intent-state')?.textContent === 'settled', null, { timeout: 300_000, polling: 3_000 });
  const after = await balance();
  check('a private payment SETTLED through the hosted service', after - before === 1_000_000n - BigInt(pool.spendFee), `recipient +${after - before} drops, ${Math.round((Date.now() - t0) / 1000)} s from click`);

  check('the page talked to its own origin and the service only', outside.length === 0, outside.length === 0 ? 'none' : outside.slice(0, 3).join(', '));
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).stack ?? (error as Error).message}`);
} finally {
  await browser?.close();
  await client.disconnect().catch(() => undefined);
}

log(failures === 0 ? `\nthe hosted XRPL wallet passed (${BASE}, ${STACK})` : `\nthe hosted XRPL wallet FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
