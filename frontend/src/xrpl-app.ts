// The XRPL wallet page: private XRP and RLUSD. Everything it does goes through
// lib/xrpl-runtime.ts, which talks to this origin and Opaque's stack only.

// First: it seals and opens what the wallet stores, so nothing reads storage before it.
import { unlockGate } from './lib/lock.ts';
import type { NoteSummary, UnixSeconds } from '@opaque/protocol-types';

import { isAccount } from '../../backend/xrpl/protocol.ts';
import { xrplDeployment } from '../../deployments/xrpl.ts';
import { networkPicker } from './lib/network-picker.ts';
import { paymentDeadline } from './lib/payment-deadline.ts';
import { backupTransport, cachedAddress, hasBrowserWallet, poolBySymbol, startXrplWallet, symbolOf, UNIT, type ReceiveTag, type ReusableAddress, type Sent, type XrplWallet } from './lib/xrpl-runtime.ts';
import { accountKeys, accountLabel, activeAccount, saveWalletState, storedPhrase, walletState, type AccountKeys } from './lib/xrpl-keys.ts';
import { acceptTerms, copy, idOf, markOf, openOnboarding, setupWalletScreens, swapProgress, tokenBadge } from './lib/wallet-ui.ts';
import type { SweepPlan } from '../../backend/xrpl/sweep.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing #${id}`);
  return found as T;
};
const setStatus = (id: string, message: string) => { el(id).textContent = message; };
const units = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 6 });
const feeOf = (symbol: string) => Number(poolBySymbol(symbol).spendFee) / UNIT;
const explorerTx = (hash: string) => `${xrplDeployment.network.explorer}/transactions/${hash}`;
const still = matchMedia('(prefers-reduced-motion: reduce)');
const usd = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** The balance counts to its new value; a first value, or reduced motion, just appears. */
function countTo(node: HTMLElement, value: number, format: (n: number) => string = units): void {
  const from = Number(node.dataset['value']);
  node.dataset['value'] = String(value);
  if (!Number.isFinite(from) || from === value || still.matches) { node.textContent = format(value); return; }
  const start = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - start) / 650), eased = 1 - (1 - k) ** 3;
    node.textContent = k < 1 ? format(Math.round((from + (value - from) * eased) * 100) / 100) : format(value);
    if (k < 1 && node.dataset['value'] === String(value)) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
/** A token's badge: its first letter, in its own shade of the palette. */
const badge = (symbol: string) => `<i class="tok tok-${symbol.replace(/^t/, '').toLowerCase()}">${symbol.replace(/^t/, '')[0]}</i>`;

let wallet: XrplWallet;
let current: ReceiveTag | undefined;
/** The account open now: one of the phrase's, the browser wallet, or none before onboarding. */
let account: AccountKeys | 'browser' | null = null;
// ── views ─────────────────────────────────────────────────────────────────
type View = (typeof VIEWS)[number];
const VIEWS = ['home', 'send', 'swap', 'receive', 'activity', 'apps'] as const;
function showView(name: View): void {
  for (const v of VIEWS) {
    el(`view-${v}`).hidden = v !== name;
    el(`tab-${v}`).setAttribute('aria-selected', String(v === name));
  }
  window.scrollTo(0, 0);
  if (name === 'activity') void renderActivity(true);
  if (name === 'receive') { void renderTags(); void renderAddress(); }
  if (name === 'apps') renderSites();
  if (name === 'swap') void renderSwapHave();
  if (name === 'send') void renderPlan();
}

// Home's two tabs: the notes, and how they stay private.
const HOME_TABS = [['hometab-notes', 'home-notes'], ['hometab-privacy', 'home-privacy']] as const;
function showHomeTab(tab: string): void {
  for (const [t, panel] of HOME_TABS) {
    el(t).setAttribute('aria-selected', String(t === tab));
    el(panel).hidden = t !== tab;
  }
}

// On testnet, a card points an empty wallet at the faucet until it is dismissed.
const PROMO_DISMISSED = 'opaque-xrpl:faucet-card-dismissed';
let promoWanted = false;
function setupPromo(): void {
  let dismissed = false;
  try { dismissed = localStorage.getItem(PROMO_DISMISSED) === '1'; } catch { /* storage blocked: show it */ }
  promoWanted = !dismissed && xrplDeployment.network.name === 'xrpl-testnet';
  el('promo').hidden = !promoWanted;
  el('promo-go').addEventListener('click', () => showView('receive'));
  el('promo-close').addEventListener('click', () => {
    promoWanted = false;
    el('promo').hidden = true;
    try { localStorage.setItem(PROMO_DISMISSED, '1'); } catch { /* it comes back next time */ }
  });
}

// ── apps: per-site accounts ───────────────────────────────────────────────
function renderSites(): void {
  const sites = wallet.sites();
  if (sites.length === 0) { el('site-list').innerHTML = '<p class="empty">No apps yet. Connect one with “Opaque” in its wallet list.</p>'; return; }
  el('site-list').replaceChildren(...sites.map((s) => {
    const row = document.createElement('div');
    row.className = 'intent';
    row.innerHTML = '<div class="intent-head"><span class="intent-amt"></span><button class="secondary" type="button">Close into notes</button></div><p class="intent-meta"></p>';
    row.querySelector('.intent-amt')!.textContent = new URL(s.origin).host;
    row.querySelector('.intent-meta')!.textContent = `${s.address} · single-use key #${s.index} · since ${new Date(s.createdAt).toLocaleDateString()}`;
    const button = row.querySelector('button')!;
    button.dataset['origin'] = s.origin;
    button.addEventListener('click', () => void onCloseSite(s.origin, button));
    return row;
  }));
}

async function onCloseSite(origin: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const hash = await wallet.closeSite(origin, (line) => setStatus('apps-status', line));
    setStatus('apps-status', `Closed ${new URL(origin).host}: AccountDelete ${hash.slice(0, 12)}…. Its XRP becomes notes as soon as the pool credits the tag.`);
    renderSites();
  } catch (error) {
    // Most often: the ledger keeps an account for 256 ledgers (~15 min) after it is made.
    setStatus('apps-status', `Not closed: ${(error as Error).message}`);
    button.disabled = false;
  }
}

// ── balances ──────────────────────────────────────────────────────────────
async function renderBalances(notes?: readonly NoteSummary[]): Promise<void> {
  const all = notes ?? await wallet.notes();
  // The total in dollars, as the ledger prices each asset; without a price for XRP, XRP alone as before.
  const prices = await wallet.usdPrices().catch(() => ({} as Readonly<Record<string, number | null>>));
  const xrpPrice = prices['XRP'] ?? null;
  const rows: HTMLElement[] = [];
  const chips: HTMLElement[] = [];
  let dollars = 0;
  let notesHeld = 0;
  for (const p of wallet.pools) {
    const held = all.filter((n) => n.state === 'AVAILABLE' && symbolOf(n.scope) === p.symbol);
    const total = held.reduce((s, n) => s + n.scope.denomination / UNIT, 0);
    const price = prices[p.symbol] ?? null;
    if (price !== null) dollars += total * price;
    notesHeld += held.length;
    const row = document.createElement('div');
    row.className = 'asset';
    const sizes = p.sizes.map((s) => [held.filter((n) => n.scope.denomination === s).length, s / UNIT] as const).filter(([n]) => n > 0).map(([n, s]) => `${n}×${s}`).join(' · ') || 'none';
    row.innerHTML = `${badge(p.symbol)}<span><b></b><small></small></span><span class="asset-value"><b></b><small></small></span>`;
    row.querySelector('span > b')!.textContent = p.symbol;
    row.querySelector('span > small')!.textContent = { XRP: 'XRP Ledger native', IOU: 'Trust-line token', MPT: 'Multi-Purpose Token' }[p.asset.kind];
    row.querySelector('.asset-value b')!.textContent = `${units(total)} ${p.symbol}`;
    row.querySelector('.asset-value small')!.textContent = `${price !== null && total > 0 ? `≈ $${usd(total * price)} · ` : ''}${held.length} notes (${sizes})`;
    rows.push(row);
    const chip = document.createElement('span');
    chip.className = `chip${total > 0 ? ' on' : ''}`;
    // The breakdown, under the total: each asset's own amount.
    chip.innerHTML = `${badge(p.symbol)}<b><span id="balance-${p.symbol.toLowerCase()}"></span> ${p.symbol}</b>`;
    chip.querySelector('span')!.textContent = units(total);
    chips.push(chip);
    if (p.symbol === 'XRP') {
      if (xrpPrice === null) countTo(el('balance-main'), total);
      el('promo').hidden = !promoWanted || held.length > 0;
    }
  }
  if (xrpPrice !== null) countTo(el('balance-main'), dollars, (n) => `$${usd(n)}`);
  el('balance-main-unit').textContent = xrpPrice === null ? 'XRP' : '';
  el('note-count').textContent = `${notesHeld} private ${notesHeld === 1 ? 'note' : 'notes'} in this browser${xrpPrice === null ? '' : ` · XRP at $${usd(xrpPrice)} on the ledger`}`;
  if (account !== null && xrpPrice !== null) saveWalletState({ balances: { ...walletState().balances, [idOf(account)]: dollars } });
  el('assets').replaceChildren(...rows);
  el('hero-assets').replaceChildren(...chips);
}

async function refresh(deep = false): Promise<void> {
  setStatus('home-status', 'Checking the ledger through the mesh…');
  try {
    await renderBalances(await wallet.refresh(deep));
    setStatus('home-status', '');
  } catch (error) {
    setStatus('home-status', `Could not refresh: ${(error as Error).message}`);
  }
}

// ── send ──────────────────────────────────────────────────────────────────
const sendSymbol = () => el<HTMLSelectElement>('send-asset').value;
async function renderPlan(): Promise<void> {
  const symbol = sendSymbol();
  el('send-unit').textContent = symbol;
  tokenBadge('send-tok', symbol);
  void wallet.balance(symbol).then((b) => { if (sendSymbol() === symbol) el('send-have').textContent = `${units(b.units)} ${symbol}`; });
  const amount = Number(el<HTMLInputElement>('send-amount').value);
  if (!Number.isInteger(amount) || amount <= 0) { setStatus('send-plan', 'Whole amounts only: notes are 1, 10 and 100.'); return; }
  const plan = await wallet.plan(symbol, amount);
  if (plan === undefined) { setStatus('send-plan', `Your ${symbol} notes can't make ${amount} exactly. Deposit more, or pick an amount they make.`); return; }
  const count = [...plan.values()].reduce((a, b) => a + b, 0);
  const fees = count * feeOf(symbol);
  const parts = [...plan].map(([size, n]) => `${n} × ${size}`).join(' + ');
  setStatus('send-plan', `${parts} ${symbol} notes. The recipient receives ${units(amount - fees)} ${symbol}: each note keeps ${units(feeOf(symbol))} for its spent-note record on the ledger and the network fee.`);
}

function syncPrivacyWait(): void {
  const wait = el<HTMLInputElement>('wait-for-privacy').checked;
  el('privacy-deadline-wrap').hidden = !wait;
  el<HTMLInputElement>('privacy-deadline').disabled = !wait;
  el('immediate-settlement').hidden = wait;
  if (wait && el<HTMLInputElement>('privacy-deadline').value === '') {
    const d = new Date(Date.now() + 3_600_000);
    el<HTMLInputElement>('privacy-deadline').value = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }
}

/** The review before anything leaves, as a wallet confirms a transaction. */
async function confirmSend(rows: readonly (readonly [string, string])[]): Promise<boolean> {
  const dialog = el<HTMLDialogElement>('send-confirm-dialog');
  el('send-confirm-rows').replaceChildren(...rows.map(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'detail';
    row.append(Object.assign(document.createElement('span'), { textContent: label }), Object.assign(document.createElement('strong'), { textContent: value }));
    return row;
  }));
  dialog.returnValue = '';
  dialog.showModal();
  await new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
  return dialog.returnValue === 'confirm';
}

async function onSend(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const symbol = sendSymbol();
  const amount = Number(el<HTMLInputElement>('send-amount').value);
  const account = el<HTMLInputElement>('recipient').value.trim();
  const tagText = el<HTMLInputElement>('recipient-tag').value.trim();
  if (!isAccount(account)) { setStatus('send-status', 'Enter an XRPL address starting with r.'); return; }
  const tag = tagText === '' ? null : Number(tagText);
  if (tag !== null && (!Number.isInteger(tag) || tag < 0 || tag > 0xffff_ffff)) { setStatus('send-status', 'A destination tag is a whole number up to 4294967295.'); return; }
  let deadline: UnixSeconds;
  try {
    const wait = el<HTMLInputElement>('wait-for-privacy').checked;
    deadline = paymentDeadline({ waitForPrivacy: wait, nowMs: Date.now(), ...(wait ? { selectedMs: new Date(el<HTMLInputElement>('privacy-deadline').value).getTime() } : {}) }) as UnixSeconds;
  } catch (error) { setStatus('send-status', (error as Error).message); return; }

  const plan = await wallet.plan(symbol, amount);
  if (plan === undefined) { setStatus('send-status', `Your ${symbol} notes can't make ${amount} exactly.`); return; }
  const count = [...plan.values()].reduce((a, b) => a + b, 0);
  const fees = count * feeOf(symbol);
  const confirmed = await confirmSend([
    ['Send', `${amount} ${symbol}`],
    ['To', tag === null ? account : `${account} · tag ${tag}`],
    ['Recipient receives', `${units(amount - fees)} ${symbol}`],
    ['Fees', `${units(fees)} ${symbol} (${count} ${count === 1 ? 'note' : 'notes'} × ${units(feeOf(symbol))})`],
    ['Notes spent', [...plan].map(([size, n]) => `${n} × ${size}`).join(' + ')],
    ['Settles', el<HTMLInputElement>('wait-for-privacy').checked ? `once privacy is stronger, by ${new Date(Number(deadline) * 1000).toLocaleString()}` : 'now, usually within a minute'],
  ]);
  if (!confirmed) { setStatus('send-status', 'Rejected: nothing was sent.'); return; }

  const dialog = el<HTMLDialogElement>('send-progress-dialog');
  const progress = (line: string) => { el('send-progress-log').textContent = line; };
  el<HTMLButtonElement>('send-button').disabled = true;
  dialog.showModal();
  try {
    const sent = await wallet.send({
      symbol, amount, destination: { account, tag }, waitForPrivacy: el<HTMLInputElement>('wait-for-privacy').checked, deadline, onProgress: progress,
    });
    const failed = sent.notes.filter((n) => n.state === 'FAILED').length;
    setStatus('send-status', failed === 0
      ? `Sent: ${sent.notes.length} ${sent.notes.length === 1 ? 'note is' : 'notes are'} on the way. Activity shows when each settles.`
      : `${sent.notes.length - failed} of ${sent.notes.length} notes are on the way; ${failed} could not be sent and stay yours.`);
    await renderBalances();
  } catch (error) {
    setStatus('send-status', (error as Error).message);
  } finally {
    dialog.close();
    el<HTMLButtonElement>('send-button').disabled = false;
  }
}

// ── receive ───────────────────────────────────────────────────────────────
/** The account's reusable address for the asset picked: made the first time, then the same every time. */
let shown: ReusableAddress | undefined;
const shortX = (x: string) => `${x.slice(0, 8)}…${x.slice(-6)}`;
async function renderAddress(): Promise<void> {
  const symbol = el<HTMLSelectElement>('receive-asset').value;
  el('address-symbol').textContent = symbol;
  const keyed = account !== null && account !== 'browser';
  el('address-card').hidden = !keyed;
  el('address-none').hidden = keyed;
  if (!keyed) return;
  shown = undefined;
  for (const id of ['address-x', 'address-pool', 'address-tag']) el(id).textContent = id === 'address-x' ? 'Making your address…' : '—';
  el('address-faucet').hidden = true;
  try {
    const a = await wallet.address(symbol);
    if (a === null || el<HTMLSelectElement>('receive-asset').value !== symbol) return;
    shown = a;
    el('address-x').textContent = a.xAddress;
    el('address-pool').textContent = a.pool;
    el('address-tag').textContent = String(a.tag);
    el('address-faucet').hidden = !(symbol === 'XRP' && xrplDeployment.network.name === 'xrpl-testnet');
    setStatus('address-status', '');
  } catch (error) {
    el('address-x').textContent = 'Not ready yet';
    setStatus('address-status', `Could not make your address: ${(error as Error).message}`);
  }
}
async function onAddressFaucet(): Promise<void> {
  if (shown === undefined) return;
  const a = shown;
  el<HTMLButtonElement>('address-faucet').disabled = true;
  setStatus('address-status', 'Asking the testnet faucet to pay your address, through the mesh…');
  try {
    const { xrp } = await wallet.faucet({ symbol: a.symbol, pool: a.pool, tag: a.tag, createdAt: Date.now() });
    setStatus('address-status', `The faucet paid ${xrp} XRP to your address. Your notes appear on Home within seconds.`);
    await refresh(true);
  } catch (error) {
    setStatus('address-status', `Faucet unavailable: ${(error as Error).message}`);
  } finally {
    el<HTMLButtonElement>('address-faucet').disabled = false;
  }
}

async function onReceive(): Promise<void> {
  const symbol = el<HTMLSelectElement>('receive-asset').value;
  const expected = Number(el<HTMLInputElement>('receive-expected').value || '0');
  el<HTMLButtonElement>('receive-button').disabled = true;
  setStatus('receive-status', 'Making notes in this browser and registering a fresh tag through the mesh…');
  try {
    showTag(await wallet.receive(symbol, Number.isFinite(expected) ? expected : 0));
    await renderTags();
  } catch (error) {
    setStatus('receive-status', `Could not make a tag: ${(error as Error).message}`);
  } finally {
    el<HTMLButtonElement>('receive-button').disabled = false;
  }
}

/** The pay-to panel for a tag: a fresh one, or one picked from the list. */
function showTag(t: ReceiveTag): void {
  current = t;
  el('receive-address').textContent = t.pool;
  el('receive-tag').textContent = String(t.tag);
  el('receive-result').hidden = false;
  el('buy-box').hidden = !(wallet.config.buy && poolBySymbol(t.symbol).moonpay);
  el('faucet-box').hidden = !(t.symbol === 'XRP' && xrplDeployment.network.name === 'xrpl-testnet');
  setStatus('receive-status', `Ready. Payments to this address with tag ${t.tag} become your ${t.symbol} notes, usually within seconds of arriving.`);
}

async function onBuy(): Promise<void> {
  if (current === undefined) return;
  const fiat = Number(el<HTMLInputElement>('buy-amount').value);
  try {
    const url = await wallet.buyUrl(current, fiat);
    // A new tab: this page never contacts MoonPay itself.
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (error) {
    setStatus('receive-status', `Buy unavailable: ${(error as Error).message}`);
  }
}

async function onFaucet(): Promise<void> {
  if (current === undefined) return;
  const tag = current;
  el<HTMLButtonElement>('faucet-button').disabled = true;
  setStatus('receive-status', `Asking the testnet faucet to pay tag ${tag.tag}, through the mesh…`);
  try {
    const { xrp } = await wallet.faucet(tag);
    setStatus('receive-status', `The faucet paid ${xrp} XRP to tag ${tag.tag}. Your notes appear on the Overview within seconds.`);
    await refresh(true);
    await renderTags();
  } catch (error) {
    setStatus('receive-status', `Faucet unavailable: ${(error as Error).message}`);
  } finally {
    el<HTMLButtonElement>('faucet-button').disabled = false;
  }
}

async function renderTags(): Promise<void> {
  const tags = wallet.tags().slice(0, 10);
  if (tags.length === 0) { el('tag-list').innerHTML = '<p class="empty">No deposit tags yet.</p>'; return; }
  const rows = await Promise.all(tags.map(async (t) => {
    // A button: picking a tag shows its address again, and its faucet on testnet.
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'intent';
    row.addEventListener('click', () => { showTag(t); el('receive-result').scrollIntoView({ block: 'nearest' }); });
    row.innerHTML = '<div class="intent-head"><span class="intent-amt"></span><span class="intent-state"></span></div><p class="intent-meta"></p>';
    row.querySelector('.intent-amt')!.textContent = `${t.symbol} · tag ${t.tag}`;
    try {
      const s = await wallet.tagStatus(t);
      row.querySelector('.intent-state')!.textContent = s.notes === 0 ? 'waiting for a payment' : `${s.notes} notes`;
      if (s.notes > 0) row.querySelector('.intent-state')!.classList.add('settled');
      row.querySelector('.intent-meta')!.textContent = `${new Date(t.createdAt).toLocaleString()}${s.carried > 0n ? ` · ${units(Number(s.carried) / UNIT)} ${t.symbol} waiting to fill a note` : ''}`;
    } catch {
      row.querySelector('.intent-state')!.textContent = 'unknown';
      row.querySelector('.intent-meta')!.textContent = 'Could not reach the privacy backend.';
    }
    return row;
  }));
  el('tag-list').replaceChildren(...rows);
}

// ── activity ──────────────────────────────────────────────────────────────
async function renderActivity(poll = false): Promise<void> {
  const all: readonly Sent[] = poll ? await wallet.pollActivity() : wallet.activity();
  if (all.length === 0) { el('sent-list').innerHTML = '<p class="empty">No private transfers yet.</p>'; return; }
  el('sent-list').replaceChildren(...all.slice(0, 30).map((s) => {
    const row = document.createElement('div');
    row.className = 'intent';
    row.innerHTML = '<div class="intent-head"><span class="intent-amt"></span><span class="intent-state"></span></div><p class="intent-meta"></p>';
    const settled = s.notes.filter((n) => n.state === 'SETTLED').length;
    row.querySelector('.intent-amt')!.textContent = s.swapTo === undefined ? `${s.amount} ${s.symbol}` : `${s.amount} ${s.symbol} → ${s.swapTo}`;
    const state = row.querySelector('.intent-state')!;
    state.textContent = settled === s.notes.length ? 'settled' : s.notes.some((n) => n.state === 'FAILED') ? 'partly failed' : `${settled}/${s.notes.length} settled`;
    if (settled === s.notes.length) state.classList.add('settled');
    const meta = row.querySelector('.intent-meta')!;
    meta.append(`${s.swapTo === undefined ? `to ${s.destination.account}${s.destination.tag === null ? '' : ` (tag ${s.destination.tag})`}` : `swapped privately into ${s.swapCarry ? `your ${s.swapTo} swap tag` : `a fresh ${s.swapTo} tag`} (${s.destination.tag})`} · ${new Date(s.createdAt).toLocaleString()}`);
    for (const n of s.notes) {
      meta.append(document.createElement('br'), `${n.size} ${s.symbol}: ${n.state.toLowerCase()}${n.error ? ` — ${n.error}` : ''} `);
      if (n.txHash) {
        const a = document.createElement('a');
        a.href = explorerTx(n.txHash);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'ledger ↗';
        meta.append(a);
      }
    }
    return row;
  }));
}

/** The first time an imported phrase's account opens: its notes from the ledger, and (for Account 1) its other accounts. */
async function recoverIfImported(keys: AccountKeys): Promise<void> {
  const state = walletState();
  // A phrase brought from elsewhere, or one account brought in by its key.
  if (!(state.imported || keys.imported !== undefined) || state.scanned[keys.id]) return;
  const progress = (line: string) => setStatus('home-status', line);
  const kept = await wallet.recover(progress);
  let count = state.count;
  if (keys.index === 0 && keys.imported === undefined) {
    for (let n = 1; n < 20; n++) {
      progress(`Looking for Account ${n + 1} of this phrase…`);
      if (await wallet.probe(accountKeys(storedPhrase()!, n)) === 0) break;
      count = n + 1;
    }
  }
  saveWalletState({ count: Math.max(count, walletState().count), scanned: { ...walletState().scanned, [keys.id]: true } });
  const others = count - 1;
  progress(`Found ${kept} ${kept === 1 ? 'note' : 'notes'} of ${accountLabel(keys)} on the ledger${others > 0 ? `, and ${others} more ${others === 1 ? 'account' : 'accounts'} of this phrase` : ''}.`);
}

// ── an ordinary XRPL wallet, swept in ─────────────────────────────────────
let sweepPlanned: SweepPlan | undefined;
function setupSweep(): void {
  const dialog = el<HTMLDialogElement>('sweep-dialog');
  const secret = el<HTMLInputElement>('sweep-secret');
  // The secret leaves the page's fields whenever the sheet closes.
  const reset = () => { secret.value = ''; sweepPlanned = undefined; el('sweep-plan').hidden = true; setStatus('sweep-status', ''); };
  el('sweep-open').addEventListener('click', () => { reset(); dialog.showModal(); secret.focus(); });
  dialog.addEventListener('close', reset);
  secret.addEventListener('input', () => { sweepPlanned = undefined; el('sweep-plan').hidden = true; });
  el('sweep-check').addEventListener('click', () => void (async () => {
    setStatus('sweep-status', 'Reading the wallet through the relays…');
    try {
      const plan = await wallet.sweepPlan(secret.value);
      const xrp = Number(plan.xrp) / UNIT;
      el('sweep-address').textContent = plan.address;
      el('sweep-moves').textContent = [...(xrp > 0 ? [`${units(xrp)} XRP`] : []), ...plan.tokens.map((t) => `${t.value} ${t.symbol}`)].join(' + ') || 'nothing';
      el('sweep-stays').textContent = [plan.deletes ? 'nothing: the account is closed' : `${units(Number(plan.kept) / UNIT)} XRP as its reserve`, ...plan.left].join(' · ');
      el('sweep-into').textContent = account === null ? 'this account' : accountLabel(account);
      el('sweep-go').hidden = xrp <= 0 && plan.tokens.length === 0;
      el('sweep-plan').hidden = false;
      sweepPlanned = plan;
      setStatus('sweep-status', '');
    } catch (error) {
      setStatus('sweep-status', (error as Error).message);
    }
  })());
  el('sweep-go').addEventListener('click', () => void (async () => {
    if (sweepPlanned === undefined) return;
    const go = el<HTMLButtonElement>('sweep-go');
    go.disabled = true;
    try {
      const hashes = await wallet.sweep(secret.value, sweepPlanned, (line) => setStatus('sweep-status', line));
      secret.value = '';
      el('sweep-plan').hidden = true;
      setStatus('sweep-status', `Swept in ${hashes.length} ${hashes.length === 1 ? 'transaction' : 'transactions'}. The notes appear on Home within seconds.`);
      await refresh(true);
      await renderTags();
    } catch (error) {
      setStatus('sweep-status', `Not swept: ${(error as Error).message}`);
    } finally {
      go.disabled = false;
    }
  })());
}

// ── swap: private, from one pool into another ─────────────────────────────
// The notes are spent through rings into a fresh tag of the other pool, and
// the ledger's AMMs convert them on the way (backend/xrpl/swap.ts).
const swappable = () => wallet.pools.filter((p) => p.asset.kind !== 'MPT');
const swapFrom = () => el<HTMLSelectElement>('swap-from').value;
const swapTo = () => el<HTMLSelectElement>('swap-to').value;
const swapAmount = (): number | undefined => { const raw = el<HTMLInputElement>('swap-amount').value.trim(); return /^[1-9]\d{0,6}$/.test(raw) ? Number(raw) : undefined; };
const swapKey = () => `${swapFrom()}>${swapTo()}:${swapAmount() ?? ''}`;
const fromUnits = (units: bigint) => units6(Number(units) / UNIT);
const units6 = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 6 });
let swapQuoted: string | undefined;
/** The notes the quoted swap spends, for the first estimate of how long it takes. */
let swapNotes = 1;
let swapTimer: ReturnType<typeof setTimeout> | undefined;
let swapping = false;
const progress = swapProgress();
/**
 * How long a swap takes, in seconds, from what the testnet runs show: a few to
 * make the tag, each note proved here two at a time, ~30 s until the first
 * payout is on the ledger, then ~8 s for each after it, since a pool pays out
 * one Batch at a time. ponytail: fixed figures; re-estimated from the notes
 * that settle, which is what the countdown shows after the first.
 */
const FIRST_SETTLES_S = 30;
const EACH_AFTER_S = 8;
const swapEstimate = (notes: number) => 6 + Math.ceil(notes / 2) * 7 + FIRST_SETTLES_S + EACH_AFTER_S * (notes - 1);
/** Off by default: carrying links this account's swaps into one asset to each other. */
const CARRY_KEY = 'opaque:xrpl-swap-carry';
const carryOn = (): boolean => { try { return account !== null && account !== 'browser' && localStorage.getItem(CARRY_KEY) === 'on'; } catch { return false; } };
let tracking = 0;

async function renderSwapHave(): Promise<void> {
  tokenBadge('swap-from-tok', swapFrom());
  tokenBadge('swap-to-tok', swapTo());
  const [a, b] = await Promise.all([wallet.balance(swapFrom()), wallet.balance(swapTo())]);
  el('swap-have').textContent = `${units(a.units)} ${swapFrom()}`;
  el('swap-have-to').textContent = `${units(b.units)} ${swapTo()}`;
}

function scheduleSwapQuote(): void {
  swapQuoted = undefined;
  clearTimeout(swapTimer);
  el('swap-quote').hidden = true;
  el('swap-out').textContent = '0';
  const go = el<HTMLButtonElement>('swap-go');
  go.disabled = true;
  if (swapAmount() === undefined) { go.textContent = 'Enter an amount'; setStatus('swap-status', ''); return; }
  go.textContent = 'Reading the ledger\'s AMMs…';
  swapTimer = setTimeout(() => void quoteSwap(), 400);
}

async function quoteSwap(): Promise<void> {
  const [from, to, amount, key] = [swapFrom(), swapTo(), swapAmount(), swapKey()];
  const go = el<HTMLButtonElement>('swap-go');
  if (amount === undefined) return;
  try {
    const q = await wallet.swapQuote(from, to, amount);
    if (key !== swapKey()) return;
    if (q === undefined) {
      go.textContent = `Your notes can't make ${amount} ${from}`;
      setStatus('swap-status', `Each note is spent whole: choose an amount your ${from} notes add up to exactly.`);
      return;
    }
    const out = fromUnits(q.out);
    el('swap-out').textContent = out;
    el('swap-rate').textContent = `1 ${from} ≈ ${(Number(q.out) / UNIT / amount).toPrecision(5).replace(/\.?0+$/, '')} ${to}, after fees`;
    // Notes are whole: what arrives under one more note stays in the pool.
    el('swap-min').textContent = `${units(Math.floor(Number(q.least) / UNIT))} ${to} as notes`;
    el('swap-route').textContent = from === 'XRP' || to === 'XRP' ? 'XRP Ledger AMM' : 'XRP Ledger AMMs, through XRP';
    el('swap-fee').textContent = `${fromUnits(q.fees)} ${from} (${q.notes} ${q.notes === 1 ? 'note' : 'notes'})`;
    // What earlier swaps left on the swap tag joins this one's.
    const carried = carryOn() ? await wallet.swapCarried(to).catch(() => 0n) : 0n;
    if (key !== swapKey()) return;
    el('swap-carried-row').hidden = carried === 0n;
    el('swap-carried').textContent = `${fromUnits(carried)} ${to}`;
    el('swap-min').textContent = `${units(Math.floor(Number(q.least + carried) / UNIT))} ${to} as notes`;
    el('swap-quote').hidden = false;
    swapQuoted = key;
    swapNotes = q.notes;
    go.disabled = swapping;
    go.textContent = `Swap ${amount} ${from} for ~${out} ${to}`;
    const feeShare = Number(q.fees) / (amount * UNIT);
    setStatus('swap-status', `${feeShare >= 0.1 ? `Pool fees are ${Math.round(feeShare * 100)}% of this swap: each note costs ${fromUnits(q.fees / BigInt(q.notes))} ${from} to spend, so many small notes cost more than a few large ones. ` : ''}What arrives becomes whole ${to} notes; ${carryOn() ? `what is under 1 ${to} carries to your next ${to} swap.` : `less than 1 ${to} of it stays in the pool.`}`);
  } catch (error) {
    if (key !== swapKey()) return;
    go.textContent = 'No route right now';
    setStatus('swap-status', (error as Error).message);
  }
}

async function onSwap(): Promise<void> {
  const [from, to, amount] = [swapFrom(), swapTo(), swapAmount()];
  if (amount === undefined || swapping || swapQuoted !== swapKey()) return;
  const go = el<HTMLButtonElement>('swap-go');
  swapping = true;
  go.disabled = true;
  go.textContent = 'Swapping…';
  tracking++;
  const before = (await wallet.balance(to)).units;
  progress.start(swapEstimate(swapNotes), `Making a fresh ${to} tag for what the swap brings…`);
  try {
    const deadline = paymentDeadline({ waitForPrivacy: false, nowMs: Date.now() }) as UnixSeconds;
    const { sent } = await wallet.swap({ from, to, amount, deadline, carry: carryOn(), onProgress: (line) => progress.say(`${line[0]!.toUpperCase()}${line.slice(1)}`) });
    const failed = sent.notes.filter((n) => n.state === 'FAILED').length;
    el<HTMLInputElement>('swap-amount').value = '';
    void renderSwapHave();
    if (failed === sent.notes.length) progress.fail(`Not swapped: ${sent.notes[0]?.error ?? 'every note failed'}. Your ${from} is still yours.`);
    else void trackSwap(sent, from, to, before);
  } catch (error) {
    progress.fail(`Swap failed: ${(error as Error).message}`);
  } finally {
    swapping = false;
    scheduleSwapQuote();
  }
}

/**
 * Follows a swap until what it bought is in the wallet: its notes' payouts,
 * polled every few seconds, and the countdown re-estimated from the pace
 * they settle at.
 */
async function trackSwap(sent: Sent, from: string, to: string, before: number): Promise<void> {
  const me = tracking;
  const n = sent.notes.length;
  const settledAt: number[] = [];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let failed = 0;
  progress.update(FIRST_SETTLES_S + EACH_AFTER_S * (n - 1), `0 of ${n} ${n === 1 ? 'note' : 'notes'} settled · the ledger's AMM converts each into ${to}`);
  for (;;) {
    await sleep(4_000);
    if (me !== tracking) return; // another swap took over the screen
    const mine = (await wallet.pollActivity().catch(() => [] as readonly Sent[])).find((s) => s.id === sent.id);
    const states = mine?.notes.map((x) => x.state) ?? [];
    const settled = states.filter((s) => s === 'SETTLED').length;
    failed = states.filter((s) => s === 'FAILED').length;
    while (settledAt.length < settled) settledAt.push(Date.now());
    const left = n - settled - failed;
    if (left <= 0) break;
    // The pace so far: the gap between payouts once two have landed, the usual one before.
    const gap = settledAt.length >= 2 ? (settledAt[settledAt.length - 1]! - settledAt[0]!) / (settledAt.length - 1) : EACH_AFTER_S * 1000;
    if (settledAt.length > 0) progress.update(Math.max(2, (settledAt[settledAt.length - 1]! + left * gap - Date.now()) / 1000), `${settled} of ${n} notes settled · the ledger's AMM converts each into ${to}`);
  }
  // On the ledger: the other pool credits the tag, and the wallet reads its new notes.
  progress.update(6, `All ${n - failed} settled · reading your new ${to} notes…`);
  let got = 0;
  for (let i = 0; i < 8 && got <= 0 && me === tracking; i++) {
    await refresh(true).catch(() => undefined);
    got = (await wallet.balance(to)).units - before;
    if (got <= 0) await sleep(3_000);
  }
  if (me !== tracking) return;
  void renderSwapHave();
  const back = failed > 0 ? ` ${failed} ${failed === 1 ? 'note' : 'notes'} didn't go through and ${failed === 1 ? 'is' : 'are'} back in your ${from}.` : '';
  const carried = sent.swapCarry ? await wallet.swapCarried(to).catch(() => 0n) : 0n;
  const carry = carried > 0n ? ` ${fromUnits(carried)} ${to} carries to your next ${to} swap.` : '';
  progress.finish(got > 0 ? `Arrived: ${units(got)} ${to} as private notes.${carry}${back}` : `Settled on the ledger; your ${to} notes show on Home in a moment.${carry}${back}`);
}

function setupSwap(): void {
  for (const id of ['swap-from', 'swap-to']) el<HTMLSelectElement>(id).replaceChildren(...swappable().map((p) => new Option(p.symbol, p.symbol)));
  el<HTMLSelectElement>('swap-from').value = 'XRP';
  el<HTMLSelectElement>('swap-to').value = swappable().find((p) => p.symbol !== 'XRP')!.symbol;
  const keepApart = (changed: 'swap-from' | 'swap-to') => {
    const other = changed === 'swap-from' ? 'swap-to' : 'swap-from';
    if (el<HTMLSelectElement>(changed).value === el<HTMLSelectElement>(other).value) {
      el<HTMLSelectElement>(other).value = swappable().find((p) => p.symbol !== el<HTMLSelectElement>(changed).value)!.symbol;
    }
    void renderSwapHave();
    scheduleSwapQuote();
  };
  el('swap-from').addEventListener('change', () => keepApart('swap-from'));
  el('swap-to').addEventListener('change', () => keepApart('swap-to'));
  el('swap-amount').addEventListener('input', () => {
    const input = el<HTMLInputElement>('swap-amount');
    const cleaned = input.value.replace(/\D+/g, '').replace(/^0+(?=\d)/, '');
    if (cleaned !== input.value) input.value = cleaned;
    scheduleSwapQuote();
  });
  el('swap-max').addEventListener('click', () => void wallet.balance(swapFrom()).then((b) => {
    el<HTMLInputElement>('swap-amount').value = b.units > 0 ? String(Math.floor(b.units)) : '';
    scheduleSwapQuote();
  }));
  el('swap-flip').addEventListener('click', () => {
    const [from, to] = [swapFrom(), swapTo()];
    el<HTMLSelectElement>('swap-from').value = to;
    el<HTMLSelectElement>('swap-to').value = from;
    void renderSwapHave();
    scheduleSwapQuote();
  });
  el('swap-go').addEventListener('click', () => void onSwap());
  // The browser account has no phrase to draw a swap tag from.
  el('swap-carry-wrap').hidden = account === null || account === 'browser';
  el<HTMLInputElement>('swap-carry').checked = carryOn();
  el('swap-carry').addEventListener('change', () => {
    try { localStorage.setItem(CARRY_KEY, el<HTMLInputElement>('swap-carry').checked ? 'on' : 'off'); } catch { /* this visit only */ }
    scheduleSwapQuote();
  });
}

// ── backup ────────────────────────────────────────────────────────────────
async function onBackupExport(): Promise<void> {
  try {
    const blob = await wallet.exportBackup(el<HTMLInputElement>('backup-pass').value);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `opaque-xrpl-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5_000);
    setStatus('backup-status', 'Backup downloaded. Keep the file and the passphrase apart.');
  } catch (error) { setStatus('backup-status', (error as Error).message); }
}
async function onBackupImport(file: File): Promise<void> {
  try {
    const added = await wallet.restoreBackup(file, el<HTMLInputElement>('backup-pass').value);
    setStatus('backup-status', `Restored ${added} ${added === 1 ? 'note' : 'notes'}.`);
    await refresh(true);
  } catch (error) { setStatus('backup-status', (error as Error).message); }
}

// ── wiring ────────────────────────────────────────────────────────────────
async function init(): Promise<void> {
  networkPicker(el<HTMLButtonElement>('network-switch'), 'xrpl');
  el('account-network').textContent = xrplDeployment.network.displayName;
  for (const v of VIEWS) el(`tab-${v}`).addEventListener('click', () => showView(v));
  for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => showView('home'));
  el('action-send').addEventListener('click', () => showView('send'));
  el('action-receive').addEventListener('click', () => showView('receive'));
  el('action-apps').addEventListener('click', () => showView('apps'));
  el('action-activity').addEventListener('click', () => showView('activity'));
  el('action-swap').addEventListener('click', () => showView('swap'));
  el('action-accounts').addEventListener('click', () => el('account-button').click());
  // The balance card catches the light where the pointer is.
  el('hero').addEventListener('pointermove', (e) => {
    const r = el('hero').getBoundingClientRect();
    el('hero').style.setProperty('--mx', `${e.clientX - r.left}px`);
    el('hero').style.setProperty('--my', `${e.clientY - r.top}px`);
  });
  for (const [tab] of HOME_TABS) el(tab).addEventListener('click', () => showHomeTab(tab));
  setupPromo();
  el('backup-export').addEventListener('click', () => void onBackupExport());
  el('backup-import').addEventListener('click', () => el('backup-file').click());
  el<HTMLInputElement>('backup-file').addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void onBackupImport(file);
  });

  setupWalletScreens({
    views: VIEWS, account: () => account, hasBrowserWallet, where: 'on the ledger',
    browserNote: 'This browser only, backed up by file',
    addressOf: (key) => cachedAddress(key.id, 'XRP')?.xAddress ?? null,
    shortAddress: shortX,
    // Only the open account's: making an address registers its tag with the pool.
    fillAddresses: async (keys) => {
      if (account === null || account === 'browser' || !keys.some((k) => k.id === (account as AccountKeys).id)) return false;
      await wallet.address('XRP');
      return true;
    },
    balanceOf: (key) => { const b = walletState().balances[key === 'browser' ? 'browser' : key.id]; return b === undefined ? '' : `$${usd(b)}`; },
    rescan: async (progress) => { const kept = await wallet.recover(progress); await renderBalances(); return kept; },
    backup: backupTransport(),
  });
  // Nothing opens before the Terms of Use and Privacy Policy are accepted.
  await acceptTerms();
  // A wallet with a password opens locked.
  await unlockGate();
  account = activeAccount(hasBrowserWallet());
  // Nothing to open yet: a new wallet, or one brought from elsewhere.
  if (account === null) { openOnboarding('ob-welcome'); return; }
  el('account-name').textContent = accountLabel(account);
  document.querySelector('.acct .mark')!.innerHTML = markOf(account === 'browser' ? -1 : account.index);
  if (account !== 'browser' && account.imported !== undefined) document.querySelector('.acct .mark')!.classList.add('imported');
  el('phrase-card').hidden = !(account === 'browser' && storedPhrase() === null);

  try {
    wallet = await startXrplWallet(undefined, account === 'browser' ? null : account);
  } catch (error) {
    const footer = el('boot-error');
    footer.textContent = `The privacy backend is not reachable: ${(error as Error).message}`;
    footer.hidden = false;
    el('account-short').textContent = 'Offline';
    return;
  }
  el('account-short').textContent = 'Notes in this browser';
  el('account-stack').textContent = 'Connected through 3 relays per request';

  for (const select of ['send-asset', 'receive-asset']) {
    el<HTMLSelectElement>(select).replaceChildren(...wallet.pools.map((p) => new Option(p.symbol, p.symbol)));
  }
  el('send-asset').addEventListener('change', () => void renderPlan());
  el('send-amount').addEventListener('input', () => void renderPlan());
  // Every note at once: a total the notes always make.
  el('send-max').addEventListener('click', () => void wallet.balance(sendSymbol()).then((b) => {
    if (b.units > 0) { el<HTMLInputElement>('send-amount').value = String(Math.floor(b.units)); void renderPlan(); }
  }));
  el('wait-for-privacy').addEventListener('change', syncPrivacyWait);
  el<HTMLFormElement>('send-form').addEventListener('submit', (e) => void onSend(e));
  el('receive-button').addEventListener('click', () => void onReceive());
  el('receive-asset').addEventListener('change', () => void renderAddress());
  el('address-copy').addEventListener('click', () => { if (shown) copy(shown.xAddress, 'Address'); });
  el('address-copy-pool').addEventListener('click', () => { if (shown) copy(shown.pool, 'Classic address'); });
  el('address-copy-tag').addEventListener('click', () => { if (shown) copy(String(shown.tag), 'Destination tag'); });
  el('address-faucet').addEventListener('click', () => void onAddressFaucet());
  el('buy-button').addEventListener('click', () => void onBuy());
  el('faucet-button').addEventListener('click', () => void onFaucet());
  el('copy-address').addEventListener('click', () => copy(current?.pool ?? '', 'Address'));
  el('copy-tag').addEventListener('click', () => copy(String(current?.tag ?? ''), 'Destination tag'));
  el('refresh').addEventListener('click', () => void refresh(true));
  el('refresh-tags').addEventListener('click', () => void renderTags());
  setupSweep();
  setupSwap();

  await renderBalances();
  await refresh();
  void renderPlan();
  // The open account's address, made now so Accounts and Deposit show it at once.
  if (account !== 'browser') void wallet.address('XRP').catch(() => undefined);
  if (account !== 'browser') {
    await recoverIfImported(account).catch((error: Error) => setStatus('home-status', `Could not look for your notes: ${error.message}. Rescan from the account menu.`));
    await renderBalances();
  }
  // The polls double as cover traffic for the reads that matter.
  setInterval(() => void refresh(), 20_000);
  setInterval(() => void renderActivity(true), 15_000);
}

void init();
