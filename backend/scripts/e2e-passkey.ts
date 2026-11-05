#!/usr/bin/env node
// The passkey backup, from the outside, with Chrome's virtual authenticator
// standing in for Touch ID (it supports PRF, as iCloud Keychain and Google
// Password Manager do).
//
//   cd backend && npm run e2e:passkey [-- <site origin>]
//
//   1. a new wallet backs itself up with a passkey, right after it is made
//   2. notes kept only in this browser join the backup within a minute, without the passkey
//   3. the browser is cleared; "Restore with a passkey" brings the phrase back, and those notes
//   4. cleared again, the Arc page restores the same wallet from the same passkey
//   5. Remove backup: Opaque's copy is gone, and a restore says so
//   6. the pages talked to nobody but their origin and Opaque's services
//
// The origin defaults to https://www.opaque.credit.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { requireService } from '../../deployments/index.ts';
import { ARC_READY, acceptTerms, createWallet, passkeyOffer, PASSWORD } from './wallet-page.ts';

const ORIGIN = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'https://www.opaque.credit';
const clean = ORIGIN.includes('opaque.credit');
// A vite dev server (frontend: npx vite) serves the testnet pages at its root.
const base = /\/\/(127\.0\.0\.1|localhost):/.test(ORIGIN) ? ORIGIN : `${ORIGIN}/testnet`;
const XRPL = `${base}/xrpl${clean ? '' : '.html'}`;
const ARC = `${base}/app${clean ? '' : '.html'}`;
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
const STORE = 'https://opaque-mainnet-production-28a9.up.railway.app/v1/backup';
const ours = [new URL(ORIGIN).origin, new URL(requireService('meshExitUrl')).origin, 'https://opaque-xrpl-testnet-production.up.railway.app'];

/** Everything this origin keeps, gone, as "Clear site data" leaves it. */
const clearSite = (page: any) => page.evaluate(async () => {
  localStorage.clear();
  sessionStorage.clear();
  for (const db of await indexedDB.databases()) if (db.name) indexedDB.deleteDatabase(db.name);
});
const stored = (page: any, key: string) => page.evaluate((k: string) => localStorage.getItem(k), key);
/** Restores from the welcome screen; returns what it said. */
async function restore(page: any): Promise<string> {
  await acceptTerms(page);
  await page.waitForSelector('#ob-passkey-restore', { state: 'visible', timeout: 60_000 });
  await page.click('#ob-passkey-restore');
  const said = String(await (await page.waitForFunction(() => {
    const t = document.getElementById('ob-welcome-status')?.textContent ?? '';
    return /^Not restored/.test(t) ? t : document.getElementById('ob-password')?.hidden === false ? 'opened' : null;
  }, null, { timeout: 120_000 })).jsonValue());
  // Restored: a password for it here, as for any wallet brought in.
  if (said === 'opened') await passkeyOffer(page);
  return said;
}

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const outside: string[] = [];
  page.on('request', (r: any) => { const u = r.url(); if (!ours.some((o) => u.startsWith(o)) && !/^(data|blob):/.test(u)) outside.push(u); });
  page.on('dialog', (d: any) => void d.accept());
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
    hasPrf: true, automaticPresenceSimulation: true,
  } });

  // ── 1. a new wallet, backed up as it is made ───────────────────────────────
  await page.goto(XRPL);
  const phrase = await createWallet(page, 180_000, undefined, true);
  const first = JSON.parse(String(await stored(page, 'opaque:passkey-backup:v1'))) as { savedAt?: number };
  check('the wallet is backed up with a passkey as it is made', typeof first.savedAt === 'number', `saved ${new Date(first.savedAt ?? 0).toISOString()}`);
  await page.click('#account-button');
  check('Accounts says the backup is on', /^On, saved/.test(String(await page.textContent('#passkey-text'))), String(await page.textContent('#passkey-text')));
  await page.keyboard.press('Escape');

  // ── 2. notes only this browser holds join it, without the passkey ──────────
  // A browser account's records, as one from before recovery phrases keeps them: one note unspent, one spent.
  await page.evaluate(() => localStorage.setItem('opaque:xrpl-notes:v1', JSON.stringify({ kept: { id: 'kept', state: 'AVAILABLE', secret: '0x11' }, gone: { id: 'gone', state: 'SPENT', secret: '0x22' } })));
  await page.waitForFunction((t: number) => (JSON.parse(localStorage.getItem('opaque:passkey-backup:v1') ?? '{}') as { savedAt?: number }).savedAt! > t, first.savedAt, { timeout: 90_000, polling: 2_000 });
  check('notes kept only in this browser joined the backup within a minute', true, 'resealed without asking for the passkey');

  // ── 3. cleared, and back ───────────────────────────────────────────────────
  await clearSite(page);
  await page.reload();
  const said = await restore(page);
  await page.waitForFunction(() => document.getElementById('account-short')?.textContent === 'Notes in this browser', null, { timeout: 120_000 });
  check('after clearing the browser, the passkey brings the wallet back', JSON.parse(String(await stored(page, 'opaque:xrpl-phrase:v1'))) === phrase, `${said}; ${await page.textContent('#account-name')}`);
  const notes = JSON.parse(String(await stored(page, 'opaque:xrpl-notes:v1') ?? '{}')) as Record<string, unknown>;
  check('and the browser-only notes, the spent one left out', 'kept' in notes && !('gone' in notes), Object.keys(notes).join(', ') || 'none');

  // ── 4. the Arc page, from the same passkey ─────────────────────────────────
  await clearSite(page);
  await page.goto(ARC);
  const arcSaid = await restore(page);
  await page.waitForFunction(ARC_READY, null, { timeout: 180_000 });
  check('the Arc page restores the same wallet from the same passkey', JSON.parse(String(await stored(page, 'opaque:xrpl-phrase:v1'))) === phrase, arcSaid);

  // ── 5. removed ─────────────────────────────────────────────────────────────
  const { id } = JSON.parse(String(await stored(page, 'opaque:passkey-backup:v1'))) as { id: string };
  await page.click('#account-button');
  await page.click('#passkey-remove');
  // F-8 (overlord): removing it asks for the password too.
  await page.waitForSelector('#confirm-password', { timeout: 30_000 });
  await page.fill('#confirm-password', PASSWORD);
  await page.click('#confirm-go');
  await page.waitForFunction(() => /^Removed/.test(document.getElementById('passkey-status')?.textContent ?? ''), null, { timeout: 60_000 });
  await page.keyboard.press('Escape');
  await clearSite(page);
  await page.goto(XRPL);
  const gone = await restore(page);
  const kept = await (await fetch(STORE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'GET', encodedRequest: `0x${Buffer.from(JSON.stringify({ id })).toString('hex')}` }) })).json() as { value: string };
  check('once removed, Opaque keeps no copy', JSON.parse(Buffer.from(kept.value.slice(2), 'hex').toString()).result === null, 'the store answers nothing for its id');
  // The passkey goes too, where the browser lets a page say so (Chrome 132+): either way, nothing comes back.
  check('and a restore says there is nothing to bring back', /no Opaque (backup|passkey)/.test(gone), gone);

  check('the pages talked to their origin and Opaque\'s services only', outside.length === 0, outside.slice(0, 3).join(', ') || 'none');
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).stack ?? error}`);
} finally {
  await browser.close().catch(() => undefined);
}

log(failures === 0 ? `\npasskey backup passed (${ORIGIN})` : `\npasskey backup FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
