// Loads the hosted wallet page in headless Chromium and checks it boots against
// its own network: no wallet extension, no keys, nothing signed or spent.
//
//   OPAQUE_NETWORK=mainnet node scripts/smoke-page.ts            # https://www.opaque.credit
//   APP_URL=http://localhost:5173/app.html node scripts/smoke-page.ts
//
// Passes when the runtime starts (relay directory verified against the
// compiled-in root, PQ account created in the page), the header names this
// network, and the page contacted nothing but its own origin and the stack.

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';

import { deployment, requireService } from '../../deployments/index.ts';

const APP_URL = process.env['APP_URL'] ?? 'https://www.opaque.credit/app.html';
const stackOrigin = new URL(requireService('meshExitUrl')).origin;
const allowed = new Set([new URL(APP_URL).origin, stackOrigin]);

// Installed Chrome: Playwright's own build often lags its version.
const browser = await chromium.launch({ channel: process.env['E2E_CHANNEL'] ?? 'chrome' });
const page = await browser.newPage();
const hosts = new Set<string>();
const errors: string[] = [];
page.on('request', (r) => hosts.add(new URL(r.url()).origin));
page.on('pageerror', (e) => errors.push(e.message));

let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}  (${detail})`);
};

console.log(`\n  ${APP_URL} — expecting ${deployment.network.displayName}\n`);
const t0 = Date.now();
await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
const started = await page.waitForFunction(() => (globalThis as { opaque?: unknown }).opaque !== undefined, undefined, { timeout: 120_000 })
  .then(() => true, () => false);
const bootError = await page.evaluate(() => document.body.innerText.match(/Could not start:[^\n]*/)?.[0] ?? '');
check('wallet runtime started', started && bootError === '', bootError || `${Date.now() - t0} ms`);

if (started) {
  const picker = await page.$eval('#network-switch', (e) => { const s = e as HTMLSelectElement; return { chosen: s.selectedOptions[0]?.text, all: [...s.options].map((o) => o.text) }; });
  check('network picker shows this network, offers the others', picker.chosen === deployment.network.displayName && picker.all.length > 1, `"${picker.chosen}" of ${picker.all.join(' / ')}`);
  const state = await page.evaluate(async () => {
    const rt = (globalThis as { opaque?: any }).opaque;
    const s = await rt.app.walletState();
    return { account: String(s.accountAddress ?? s.address ?? ''), stack: rt.config.capabilities, pools: rt.scopes.length, chain: String(rt.scopes[0]?.chainId) };
  });
  check('PQ account created in the page', /^0x[0-9a-fA-F]{40}$/.test(state.account), state.account);
  check(`pools are ${deployment.network.displayName}'s`, state.pools === deployment.pools.filter((p) => p.proofMode === 'RING_8').length && state.chain === String(deployment.network.chainId), `${state.pools} pools on chain ${state.chain}`);
  const hops = await page.evaluate(async () => (await (globalThis as { opaque?: any }).opaque.pathFor()).length as number);
  check('a 3-hop mesh path builds from the verified directory', hops === 3, `${hops} hops`);
  // Give the page's own reads (notes, pools, ring, activity) a moment over the mesh.
  await page.waitForTimeout(8_000);
  const notes = await page.textContent('#note-count');
  check('notes read without error', !/Could not/.test(notes ?? ''), `"${notes?.trim()}"`);
}

const strangers = [...hosts].filter((h) => !allowed.has(h) && !h.startsWith('data:') && !h.startsWith('blob:'));
check('page contacted only its origin and the stack', strangers.length === 0, strangers.join(', ') || [...hosts].join(', '));
check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | ') || 'none');

await browser.close();
console.log(failed === 0 ? '\n  all checks passed\n' : `\n  ${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);
