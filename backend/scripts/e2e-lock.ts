#!/usr/bin/env node
// The wallet password, from the outside.
//
//   cd backend && npm run e2e:lock [-- <site origin>]
//
//   1. a new wallet gets a password as it is made; its phrase is stored sealed
//   2. the Arc page, in the same tab, opens without asking; Arc's signing keys
//      are sealed too, and still open (the backup file decrypts every seed)
//   3. a second tab opens locked: a wrong password is refused, the right one opens Account 1
//   4. Lock now locks; a changed password opens it, the old one no longer does
//   5. a forgotten password: Reset removes the wallet here, and the phrase brings it back
//   6. a wallet from before passwords (its phrase in the clear) can't open until it sets one:
//      the phrase is sealed on the spot, and the Arc page opens on it without asking
//   7. the recovery phrase and the account key are shown only after the password, again
//
// The origin defaults to https://www.opaque.credit; http://127.0.0.1:<port> is a vite dev server.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { ARC_READY, acceptTerms, createWallet, importWallet, PASSWORD, unlockIfAsked } from './xrpl-wallet-page.ts';

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

/** What is on disk for a name, as anything reading the browser's storage would see it (property access skips getItem). */
const onDisk = (page: any, key: string) => page.evaluate((k: string) => (localStorage as unknown as Record<string, string | undefined>)[k] ?? null, key);
const READY = () => document.getElementById('account-short')?.textContent === 'Notes in this browser';
/** Arc's signing keys in this browser: whether each is sealed. */
const arcKeys = (page: any): Promise<{ sealed: unknown }[]> => page.evaluate(async () => {
  const out: { sealed: unknown }[] = [];
  for (const { name } of await indexedDB.databases()) {
    if (!name?.startsWith('opaque-pq-account-v1')) continue;
    await new Promise<void>((resolve) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('signers')) { db.close(); resolve(); return; }
        const all = db.transaction('signers').objectStore('signers').getAll();
        all.onsuccess = () => { out.push(...(all.result as { sealed: unknown }[]).map((x) => ({ sealed: x.sealed }))); db.close(); resolve(); };
      };
    });
  }
  return out;
});
const seedsOpen = (page: any): Promise<string> => page.evaluate(async () => {
  try { return (await (globalThis as any).opaque.exportBackup('a long enough passphrase')).size > 0 ? 'decrypted' : 'empty'; } catch (e) { return String((e as Error).message); }
});

/** Types a password into the lock screen; what it then says. */
async function tryPassword(page: any, password: string): Promise<string> {
  await page.waitForSelector('#lock-password', { timeout: 90_000 });
  await page.fill('#lock-password', password);
  await page.click('#lock-go');
  const said = await page.waitForFunction(() => document.documentElement.dataset['lock'] === 'open' ? 'opened'
    : /doesn't open/.test(document.getElementById('lock-status')?.textContent ?? '') ? 'refused' : null, null, { timeout: 60_000 });
  return String(await said.jsonValue());
}

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('dialog', (d: any) => void d.accept());

  // ── 1. made with a password ────────────────────────────────────────────────
  await page.goto(XRPL);
  const phrase = await createWallet(page, 180_000);
  const sealed = String(await onDisk(page, 'opaque:xrpl-phrase:v1'));
  check('the wallet is made with a password, and its phrase is stored sealed', sealed.startsWith('sealed:v1:') && !sealed.includes(phrase.split(' ')[0]!), `${sealed.slice(0, 24)}…`);
  const notesSealed = await page.evaluate(() => Object.keys(localStorage).filter((k) => /^opaque:xrpl:[0-9a-f]+:(notes|addresses):v1/.test(k))
    .every((k) => ((localStorage as unknown as Record<string, string>)[k] ?? '').startsWith('sealed:v1:')));
  check('and so are its notes and addresses', notesSealed, 'every record of Account 1');

  // ── 2. the Arc page, same tab ──────────────────────────────────────────────
  await page.goto(ARC);
  await page.waitForFunction(ARC_READY, null, { timeout: 180_000 });
  await page.waitForFunction(() => /^0x[0-9a-f]{40}$/i.test(document.getElementById('receive-address')?.textContent ?? ''), null, { timeout: 180_000 });
  check('the Arc page opens in the same tab without asking again', await page.evaluate(() => document.getElementById('lock-password') === null), String(await page.textContent('#account-name')));
  const records = await arcKeys(page);
  check('Arc\'s signing keys are sealed too', records.length > 0 && records.every((r) => r.sealed === 1), `${records.length} keys`);
  const opened = await seedsOpen(page);
  check('and still open: every seed decrypts', opened === 'decrypted', opened);

  // ── 3. a second tab ────────────────────────────────────────────────────────
  const second = await context.newPage();
  await second.goto(XRPL);
  check('a second tab opens locked, and a wrong password is refused', (await tryPassword(second, 'not the password')) === 'refused', String(await second.textContent('#lock-status')));
  await second.fill('#lock-password', '');
  check('the right one opens it', (await tryPassword(second, PASSWORD)) === 'opened', 'unlocked');
  await second.waitForFunction(READY, null, { timeout: 120_000 });
  check('on the same account', (await second.textContent('#account-name')) === 'Account 1', String(await second.textContent('#account-name')));

  // ── 4. Lock now, and a new password ────────────────────────────────────────
  await second.click('#account-button');
  await second.click('#password-change');
  await second.fill('#password-current', PASSWORD);
  await second.fill('#password-next', 'a brand new password');
  await second.fill('#password-again', 'a brand new password');
  await second.click('#password-change-form button[type=submit]');
  await second.waitForFunction(() => /^Changed/.test(document.getElementById('password-status')?.textContent ?? ''), null, { timeout: 60_000 });
  await second.click('#lock-now');
  check('Lock now locks the wallet', await second.waitForSelector('#lock-password', { timeout: 60_000 }).then(() => true, () => false), 'the lock screen');
  check('the old password no longer opens it', (await tryPassword(second, PASSWORD)) === 'refused', 'refused');
  await second.fill('#lock-password', '');
  check('the new one does', (await tryPassword(second, 'a brand new password')) === 'opened', 'unlocked');

  // ── 5. forgotten ───────────────────────────────────────────────────────────
  const third = await context.newPage();
  third.on('dialog', (d: any) => void d.accept());
  await third.goto(XRPL);
  await third.waitForSelector('#lock-password', { timeout: 90_000 });
  await third.click('#lock-forgot');
  await third.click('#lock-reset-go');
  await third.waitForSelector('#ob-import', { state: 'visible', timeout: 90_000 });
  check('Reset removes the wallet from this browser', (await onDisk(third, 'opaque:xrpl-phrase:v1')) === null && (await onDisk(third, 'opaque:lock:v1')) === null, 'no phrase, no password');
  const found = await importWallet(third, phrase);
  check('and the phrase brings it back, under a new password', (await third.textContent('#account-name')) === 'Account 1' && String(await onDisk(third, 'opaque:xrpl-phrase:v1')).startsWith('sealed:v1:'), found);
  await unlockIfAsked(third);

  // ── 6. a wallet from before passwords ──────────────────────────────────────
  const old = await (await browser.newContext()).newPage();
  old.on('dialog', (d: any) => void d.accept());
  await old.goto(XRPL);
  await acceptTerms(old);
  await old.evaluate((p: string) => {
    localStorage.setItem('opaque:xrpl-phrase:v1', JSON.stringify(p));
    localStorage.setItem('opaque:xrpl-accounts:v1', JSON.stringify({ count: 1, active: 0, balances: {}, imported: true, scanned: {} }));
  }, phrase);
  await old.goto(XRPL);
  await old.waitForSelector('#lock-new', { timeout: 90_000 });
  check('a wallet from before passwords opens on "Set a password", and nothing else',
    await old.evaluate(() => document.documentElement.dataset['lock'] !== 'open' && document.getElementById('account-short')?.textContent !== 'Notes in this browser'),
    `phrase still in the clear: ${JSON.parse(String(await onDisk(old, 'opaque:xrpl-phrase:v1'))) === phrase}`);
  await old.fill('#lock-new', 'short');
  await old.fill('#lock-new2', 'short');
  await old.click('#lock-new-go');
  check('a short one is refused', /At least/.test(String(await old.textContent('#lock-status'))), String(await old.textContent('#lock-status')));
  await unlockIfAsked(old);
  await old.waitForFunction(READY, null, { timeout: 120_000 });
  check('once set, the phrase is sealed and the wallet opens', String(await onDisk(old, 'opaque:xrpl-phrase:v1')).startsWith('sealed:v1:'), String(await old.textContent('#account-name')));
  await old.goto(ARC);
  await old.waitForFunction(ARC_READY, null, { timeout: 180_000 });
  const arcAfter = await arcKeys(old);
  check('the Arc page opens on it without asking, its keys sealed', await old.evaluate(() => document.getElementById('lock-new') === null && document.getElementById('lock-password') === null)
    && arcAfter.length > 0 && arcAfter.every((r) => r.sealed === 1), `${arcAfter.length} keys; ${await seedsOpen(old)}`);

  // ── 7. secrets shown only after the password ───────────────────────────────
  await old.goto(XRPL);
  await old.waitForFunction(READY, null, { timeout: 120_000 });
  await old.click('#account-button');
  await old.click('#phrase-show');
  await old.waitForSelector('#confirm-password', { timeout: 30_000 });
  await old.fill('#confirm-password', 'not the password');
  await old.click('#confirm-go');
  await old.waitForFunction(() => /isn't the password/.test(document.getElementById('confirm-status')?.textContent ?? ''), null, { timeout: 60_000 });
  check('Show recovery phrase asks for the password, and a wrong one shows nothing', await old.evaluate(() => (document.getElementById('phrase-words') as HTMLElement).hidden), 'refused');
  await old.fill('#confirm-password', PASSWORD);
  await old.click('#confirm-go');
  await old.waitForFunction(() => !(document.getElementById('phrase-words') as HTMLElement).hidden, null, { timeout: 60_000 });
  const shown = await old.$$eval('#phrase-words li', (items: Element[]) => items.map((li) => li.textContent!.trim()).join(' '));
  check('the right one shows it', shown === phrase, `${shown.split(' ').length} words`);
  await old.click('#key-show');
  await old.waitForSelector('#confirm-password', { timeout: 30_000 });
  await old.click('#confirm-cancel');
  check('Show account key asks too; cancelled, it stays hidden', await old.evaluate(() => (document.getElementById('key-text') as HTMLElement).hidden && document.getElementById('confirm-password') === null), 'cancelled');
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).stack ?? error}`);
} finally {
  await browser.close().catch(() => undefined);
}

log(failures === 0 ? `\nthe wallet password passed (${ORIGIN})` : `\nthe wallet password FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
