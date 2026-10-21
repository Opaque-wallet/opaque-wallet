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
//   overlord regressions (2026-10-21):
//   8. F-8   a backup file is made only after the password, again
//   9. F-19  Arc's wallet record no longer shows the account's address on disk; WalletConnect's records are sealed
//  10. F-10  Lock now in one tab locks the others
//  11. F-9   a page left keeps its session for seconds, not fifteen minutes
//  12. F-22  a new password is a new data key: the old password and wrapped key open nothing after
//  13. F-21  a browser holding only app accounts is made to set a password
//  14. F-18  two tabs setting a password at once leave every record open under the one that won
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
/**
 * Opens every sealed record with `password` and the wrapped key on disk, by WebCrypto alone
 * (not the lock's own code): how many open, how many don't, and the plain values by name.
 */
const openAllWith = (page: any, password: string): Promise<{ ok: number; failed: number; meta: { id: string; prev?: string }; plain: Record<string, string> }> => page.evaluate(async (pw: string) => {
  const b = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const raw = (k: string) => (localStorage as unknown as Record<string, string | undefined>)[k];
  const meta = JSON.parse(raw('opaque:lock:v1')!) as { id: string; salt: string; iterations: number; wrapped: string; prev?: string };
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const kek = await crypto.subtle.importKey('raw', await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b(meta.salt), iterations: meta.iterations }, base, 256), 'AES-GCM', false, ['decrypt']);
  const open = async (key: CryptoKey, box: Uint8Array) => new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.slice(0, 12) }, key, box.slice(12)));
  let dataKey: CryptoKey;
  try { dataKey = await crypto.subtle.importKey('raw', await open(kek, b(meta.wrapped)), 'AES-GCM', false, ['decrypt']); } catch { return { ok: 0, failed: -1, meta, plain: {} }; }
  let ok = 0; let failed = 0; const plain: Record<string, string> = {};
  for (const k of Object.keys(localStorage)) {
    const v = raw(k)!;
    if (!v.startsWith('sealed:v1:')) continue;
    try { plain[k] = new TextDecoder().decode(await open(dataKey, b(v.slice(10)))); ok++; } catch { failed++; }
  }
  return { ok, failed, meta, plain };
}, password);
/** Arc's raw IndexedDB records of a store: what is on disk, not what the wallet reads. */
const rawArc = (page: any, store: 'signers' | 'wallets'): Promise<Record<string, unknown>[]> => page.evaluate(async (name: string) => {
  const out: Record<string, unknown>[] = [];
  for (const { name: db } of await indexedDB.databases()) {
    if (!db?.startsWith('opaque-pq-account-v1')) continue;
    await new Promise<void>((resolve) => {
      const r = indexedDB.open(db);
      r.onsuccess = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains(name)) { d.close(); resolve(); return; }
        const all = d.transaction(name).objectStore(name).getAll();
        all.onsuccess = () => { out.push(...(all.result as Record<string, unknown>[])); d.close(); resolve(); };
      };
    });
  }
  return out;
}, store);
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
  await old.keyboard.press('Escape');

  // ── 8. F-8: a backup file only after the password ──────────────────────────
  let downloaded = false;
  old.on('download', () => { downloaded = true; });
  await old.click('#account-button');
  await old.fill('#backup-pass', 'a long enough passphrase');
  await old.click('#backup-export');
  // OMEGA's PoC: an unlocked wallet left in front of someone, who saves its notes under their own passphrase.
  check('a backup file asks for the password first (F-8)', await old.waitForSelector('#confirm-password', { timeout: 30_000 }).then(() => true, () => false), 'asked');
  await old.click('#confirm-cancel');
  await old.waitForTimeout(1_000);
  check('and cancelled, nothing is saved', !downloaded, 'no download');
  await old.keyboard.press('Escape');
  await old.goto(ARC);
  await old.waitForFunction(ARC_READY, null, { timeout: 180_000 });
  await old.waitForFunction(() => /^0x[0-9a-f]{40}$/i.test(document.getElementById('receive-address')?.textContent ?? ''), null, { timeout: 180_000 });
  const arcAddress = String(await old.textContent('#receive-address')).toLowerCase();

  // ── 9. F-19: Arc's wallet record and WalletConnect's records, sealed on disk ─
  const wallets = await rawArc(old, 'wallets');
  // OMEGA's PoC: indexedDB 'opaque-pq-account-v1' → wallets showed the Arc address in the clear.
  check('Arc\'s wallet record keeps the account address sealed (F-19)', wallets.length > 0 && wallets.every((w) => w['sealed'] === 1 && String(w['accountAddress']).toLowerCase() !== arcAddress)
    && !JSON.stringify(wallets, (_k, v) => (typeof v === 'bigint' ? String(v) : v)).toLowerCase().includes(arcAddress.slice(2)), `${wallets.length} record(s)`);
  await old.evaluate(() => localStorage.setItem('opaque:wc:v1:probe', JSON.stringify({ topic: 'a WalletConnect session' })));
  check('and WalletConnect\'s records are sealed like the rest', String(await onDisk(old, 'opaque:wc:v1:probe')).startsWith('sealed:v1:'), 'opaque:wc:v1:*');
  await old.evaluate(() => localStorage.removeItem('opaque:wc:v1:probe'));

  // ── 10. F-10: Lock now in one tab locks the others ─────────────────────────
  const other = await old.context().newPage();
  await other.goto(XRPL);
  await unlockIfAsked(other);
  await other.waitForFunction(READY, null, { timeout: 120_000 });
  await old.click('#account-button');
  await old.click('#lock-now');
  // OMEGA's PoC: Lock now in one view left every other view open.
  check('Lock now in one tab locks the other (F-10)', await other.waitForSelector('#lock-password', { timeout: 30_000 }).then(() => true, () => false), 'the other tab shows the lock screen');

  // ── 11. F-9: a page left keeps its session for seconds ─────────────────────
  await unlockIfAsked(other);
  await other.waitForFunction(READY, null, { timeout: 120_000 });
  const left = await other.evaluate(() => {
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    return (JSON.parse(sessionStorage.getItem('opaque:unlocked:v1') ?? '{}') as { until?: number }).until! - Date.now();
  });
  // OMEGA's PoC: close the tab, Ctrl+Shift+T within fifteen minutes, and it opened unlocked.
  check('a page left keeps its session ten seconds, not fifteen minutes (F-9)', left > 0 && left <= 10_000, `${Math.round(left / 1000)} s`);
  await other.reload();
  await unlockIfAsked(other);
  await other.waitForFunction(READY, null, { timeout: 120_000 });

  // ── 12. F-22: a new password, a new data key ───────────────────────────────
  const before12 = await openAllWith(other, PASSWORD);
  // The wrapped key as it is on disk now: what someone who copied it before the change would hold.
  const oldMeta = JSON.parse(String(await onDisk(other, 'opaque:lock:v1'))) as { salt: string; iterations: number; wrapped: string };
  await other.click('#account-button');
  await other.click('#password-change');
  await other.fill('#password-current', PASSWORD);
  await other.fill('#password-next', 'a rotated password');
  await other.fill('#password-again', 'a rotated password');
  await other.click('#password-change-form button[type=submit]');
  await other.waitForFunction(() => /^Changed/.test(document.getElementById('password-status')?.textContent ?? ''), null, { timeout: 120_000 });
  const after12 = await openAllWith(other, 'a rotated password');
  const stale = await other.evaluate(async (m: { salt: string; iterations: number; wrapped: string }) => {
    // OMEGA's PoC: the old wrapped key and the old password, kept from before the change.
    const b = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode('opaque test password'), 'PBKDF2', false, ['deriveBits']);
    const kek = await crypto.subtle.importKey('raw', await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b(m.salt), iterations: m.iterations }, base, 256), 'AES-GCM', false, ['decrypt']);
    const w = b(m.wrapped);
    const old = await crypto.subtle.importKey('raw', new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: w.slice(0, 12) }, kek, w.slice(12))), 'AES-GCM', false, ['decrypt']);
    let opened = 0;
    for (const k of Object.keys(localStorage)) {
      const v = (localStorage as unknown as Record<string, string>)[k]!;
      if (!v.startsWith('sealed:v1:')) continue;
      const box = b(v.slice(10));
      try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.slice(0, 12) }, old, box.slice(12)); opened++; } catch { /* sealed under the new key */ }
    }
    return opened;
  }, oldMeta);
  check('a new password is a new data key, every record moved to it (F-22)', after12.meta.id !== before12.meta.id && after12.failed === 0 && after12.ok === before12.ok && after12.meta.prev === undefined, `${after12.ok} records under the new key`);
  check('and the old password with the old wrapped key opens none of them', stale === 0, `${stale} opened`);
  const signers = await rawArc(other, 'signers');
  check('Arc\'s keys moved too', signers.length > 0 && signers.every((r) => r['by'] === after12.meta.id), `${signers.length} keys`);

  // ── 13. F-21: app accounts alone are a wallet ──────────────────────────────
  const sitesOnly = await (await browser.newContext()).newPage();
  await sitesOnly.goto(XRPL);
  await acceptTerms(sitesOnly);
  // OMEGA's PoC: a passkey restore whose spent notes were dropped leaves app accounts only.
  await sitesOnly.evaluate(() => localStorage.setItem('opaque:xrpl-sites:v1', JSON.stringify({ 'https://app.example': { address: 'rApp', key: 'secret' } })));
  await sitesOnly.goto(XRPL);
  check('app accounts alone make it set a password (F-21)', await sitesOnly.waitForSelector('#lock-new', { timeout: 90_000 }).then(() => true, () => false), 'Set a password');

  // ── 14. F-18: two tabs setting a password at once ──────────────────────────
  const race = await browser.newContext();
  const r1 = await race.newPage();
  await r1.goto(XRPL);
  await acceptTerms(r1);
  await r1.evaluate((p: string) => {
    localStorage.setItem('opaque:xrpl-phrase:v1', JSON.stringify(p));
    localStorage.setItem('opaque:xrpl-accounts:v1', JSON.stringify({ count: 1, active: 0, balances: {}, imported: true, scanned: {} }));
  }, phrase);
  await r1.goto(XRPL);
  const r2 = await race.newPage();
  await r2.goto(XRPL);
  for (const [tab, pw] of [[r1, 'race password one'], [r2, 'race password two']] as const) {
    await tab.waitForSelector('#lock-new', { timeout: 90_000 });
    await tab.fill('#lock-new', pw);
    await tab.fill('#lock-new2', pw);
  }
  // OMEGA's PoC: both submitted within the time the password takes to stretch.
  // Whichever finishes first, the other tab sees the new key and moves to the lock screen: its click may find nothing.
  await Promise.allSettled([r1.click('#lock-new-go', { timeout: 10_000 }), r2.click('#lock-new-go', { timeout: 10_000 })]);
  await r1.waitForTimeout(8_000);
  const one = await openAllWith(r1, 'race password one');
  const which = one.failed === -1 ? await openAllWith(r1, 'race password two') : one;
  check('two tabs setting a password at once: every record opens under the one that won (F-18)', which.failed === 0 && which.ok > 0
    && JSON.parse(which.plain['opaque:xrpl-phrase:v1'] ?? 'null') === phrase, `${which.ok} open, ${which.failed} orphaned`);
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).stack ?? error}`);
} finally {
  await browser.close().catch(() => undefined);
}

log(failures === 0 ? `\nthe wallet password passed (${ORIGIN})` : `\nthe wallet password FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
