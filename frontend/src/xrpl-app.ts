// The XRPL wallet page: private XRP and RLUSD. Everything it does goes through
// lib/xrpl-runtime.ts, which talks to this origin and Opaque's stack only.

import type { NoteSummary, UnixSeconds } from '@opaque/protocol-types';

import { isAccount } from '../../backend/xrpl/protocol.ts';
import { xrplDeployment } from '../../deployments/xrpl.ts';
import { networkPicker } from './lib/network-picker.ts';
import { paymentDeadline } from './lib/payment-deadline.ts';
import { poolBySymbol, startXrplWallet, symbolOf, UNIT, type ReceiveTag, type Sent, type XrplWallet } from './lib/xrpl-runtime.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing #${id}`);
  return found as T;
};
const setStatus = (id: string, message: string) => { el(id).textContent = message; };
const units = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 6 });
const feeOf = (symbol: string) => Number(poolBySymbol(symbol).spendFee) / UNIT;
const explorerTx = (hash: string) => `${xrplDeployment.network.explorer}/transactions/${hash}`;

let wallet: XrplWallet;
let current: ReceiveTag | undefined;

// ── views ─────────────────────────────────────────────────────────────────
type View = 'home' | 'send' | 'receive' | 'activity' | 'apps';
const VIEWS = ['home', 'send', 'receive', 'activity', 'apps'] as const;
function showView(name: View): void {
  for (const v of VIEWS) {
    el(`view-${v}`).hidden = v !== name;
    el(`tab-${v}`).setAttribute('aria-selected', String(v === name));
  }
  if (name === 'activity') void renderActivity(true);
  if (name === 'receive') void renderTags();
  if (name === 'apps') renderSites();
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
  const rows: HTMLElement[] = [];
  for (const p of wallet.pools) {
    const held = all.filter((n) => n.state === 'AVAILABLE' && symbolOf(n.scope) === p.symbol);
    const total = held.reduce((s, n) => s + n.scope.denomination / UNIT, 0);
    const row = document.createElement('div');
    row.className = 'asset';
    const sizes = p.sizes.map((s) => `${held.filter((n) => n.scope.denomination === s).length}×${s / UNIT}`).join(' · ');
    row.innerHTML = '<i></i><span><b></b><small></small></span><span class="asset-value"><b></b><small></small></span>';
    row.querySelector('i')!.textContent = p.symbol === 'XRP' ? '✕' : '$';
    row.querySelector('span > b')!.textContent = p.symbol;
    row.querySelector('span > small')!.textContent = { XRP: 'XRP Ledger native', IOU: 'Trust-line token', MPT: 'Multi-Purpose Token' }[p.asset.kind];
    row.querySelector('.asset-value b')!.textContent = `${units(total)} ${p.symbol}`;
    row.querySelector('.asset-value small')!.textContent = `${held.length} notes (${sizes})`;
    rows.push(row);
    if (p.symbol === 'XRP') {
      el('balance-main').textContent = units(total);
      el('note-count').textContent = `${held.length} private ${held.length === 1 ? 'note' : 'notes'} in this browser`;
    }
  }
  el('assets').replaceChildren(...rows);
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
async function onReceive(): Promise<void> {
  const symbol = el<HTMLSelectElement>('receive-asset').value;
  const expected = Number(el<HTMLInputElement>('receive-expected').value || '0');
  el<HTMLButtonElement>('receive-button').disabled = true;
  setStatus('receive-status', 'Making notes in this browser and registering a fresh tag through the mesh…');
  try {
    current = await wallet.receive(symbol, Number.isFinite(expected) ? expected : 0);
    el('receive-address').textContent = current.pool;
    el('receive-tag').textContent = String(current.tag);
    el('receive-result').hidden = false;
    el('buy-box').hidden = !(wallet.config.buy && poolBySymbol(symbol).moonpay);
    el('faucet-box').hidden = !(symbol === 'XRP' && xrplDeployment.network.name === 'xrpl-testnet');
    setStatus('receive-status', `Ready. Payments to this address with tag ${current.tag} become your ${symbol} notes, usually within seconds of arriving.`);
    await renderTags();
  } catch (error) {
    setStatus('receive-status', `Could not make a tag: ${(error as Error).message}`);
  } finally {
    el<HTMLButtonElement>('receive-button').disabled = false;
  }
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
    const row = document.createElement('div');
    row.className = 'intent';
    row.innerHTML = '<div class="intent-head"><span class="intent-amt"></span><span class="intent-state"></span></div><p class="intent-meta"></p>';
    row.querySelector('.intent-amt')!.textContent = `${t.symbol} · tag ${t.tag}`;
    try {
      const s = await wallet.tagStatus(t);
      row.querySelector('.intent-state')!.textContent = s.notes === 0 ? 'waiting' : `${s.notes} notes`;
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
    row.querySelector('.intent-amt')!.textContent = `${s.amount} ${s.symbol}`;
    const state = row.querySelector('.intent-state')!;
    state.textContent = settled === s.notes.length ? 'settled' : s.notes.some((n) => n.state === 'FAILED') ? 'partly failed' : `${settled}/${s.notes.length} settled`;
    if (settled === s.notes.length) state.classList.add('settled');
    const meta = row.querySelector('.intent-meta')!;
    meta.append(`to ${s.destination.account}${s.destination.tag === null ? '' : ` (tag ${s.destination.tag})`} · ${new Date(s.createdAt).toLocaleString()}`);
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
  networkPicker(el<HTMLSelectElement>('network-switch'), 'xrpl');
  el('account-network').textContent = xrplDeployment.network.displayName;
  for (const v of VIEWS) el(`tab-${v}`).addEventListener('click', () => showView(v));
  for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => showView('home'));
  el('action-send').addEventListener('click', () => showView('send'));
  el('action-receive').addEventListener('click', () => showView('receive'));
  el('account-button').addEventListener('click', () => el<HTMLDialogElement>('account-dialog').showModal());
  el('backup-export').addEventListener('click', () => void onBackupExport());
  el('backup-import').addEventListener('click', () => el('backup-file').click());
  el<HTMLInputElement>('backup-file').addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void onBackupImport(file);
  });

  try {
    wallet = await startXrplWallet();
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
  el('wait-for-privacy').addEventListener('change', syncPrivacyWait);
  el<HTMLFormElement>('send-form').addEventListener('submit', (e) => void onSend(e));
  el('receive-button').addEventListener('click', () => void onReceive());
  el('buy-button').addEventListener('click', () => void onBuy());
  el('faucet-button').addEventListener('click', () => void onFaucet());
  el('copy-address').addEventListener('click', () => void navigator.clipboard.writeText(current?.pool ?? ''));
  el('copy-tag').addEventListener('click', () => void navigator.clipboard.writeText(String(current?.tag ?? '')));
  el('refresh').addEventListener('click', () => void refresh(true));
  el('refresh-tags').addEventListener('click', () => void renderTags());

  await renderBalances();
  await refresh();
  void renderPlan();
  // The polls double as cover traffic for the reads that matter.
  setInterval(() => void refresh(), 20_000);
  setInterval(() => void renderActivity(true), 15_000);
}

void init();
