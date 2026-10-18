// The XRPL wallet page: private XRP and RLUSD. Everything it does goes through
// lib/xrpl-runtime.ts, which talks to this origin and Opaque's stack only.

import type { NoteSummary, UnixSeconds } from '@opaque/protocol-types';

import { isAccount } from '../../backend/xrpl/protocol.ts';
import { xrplDeployment } from '../../deployments/xrpl.ts';
import { networkPicker } from './lib/network-picker.ts';
import { paymentDeadline } from './lib/payment-deadline.ts';
import { hasBrowserWallet, poolBySymbol, startXrplWallet, symbolOf, UNIT, type ReceiveTag, type Sent, type XrplWallet } from './lib/xrpl-runtime.ts';
import { accountKeys, accountKeyText, accountLabel, activeAccount, importAccountKey, importedAccounts, isAccountKeyText, isPhrase, newPhrase, normalizePhrase, savePhrase, saveWalletState, storedPhrase, walletState, type AccountKeys } from './lib/xrpl-keys.ts';
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

let wallet: XrplWallet;
let current: ReceiveTag | undefined;
/** The account open now: one of the phrase's, the browser wallet, or none before onboarding. */
let account: AccountKeys | 'browser' | null = null;
const idOf = (a: AccountKeys | 'browser') => (a === 'browser' ? 'browser' : a.id);

/** The ring of eight with one note larger: which one tells the accounts apart (none, the browser wallet). */
function markOf(index: number): string {
  const dots = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4 - Math.PI / 2, lead = i === index % 8;
    return `<circle cx="${(20 + 13 * Math.cos(a)).toFixed(2)}" cy="${(20 + 13 * Math.sin(a)).toFixed(2)}" r="${lead ? 4.8 : 3.4}"${lead || index < 0 ? '' : ' opacity=".6"'}/>`;
  }).join('');
  return `<svg viewBox="0 0 40 40" aria-hidden="true"><g fill="#070608">${dots}</g></svg>`;
}

// ── views ─────────────────────────────────────────────────────────────────
type View = 'home' | 'send' | 'receive' | 'activity' | 'apps';
const VIEWS = ['home', 'send', 'receive', 'activity', 'apps'] as const;
function showView(name: View): void {
  for (const v of VIEWS) {
    el(`view-${v}`).hidden = v !== name;
    el(`tab-${v}`).setAttribute('aria-selected', String(v === name));
  }
  window.scrollTo(0, 0);
  if (name === 'activity') void renderActivity(true);
  if (name === 'receive') void renderTags();
  if (name === 'apps') renderSites();
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
      if (account !== null) saveWalletState({ balances: { ...walletState().balances, [idOf(account)]: total } });
      el('promo').hidden = !promoWanted || held.length > 0;
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

// ── accounts: the phrase's, and the browser wallet from before phrases ─────
function renderAccounts(): void {
  const phrase = storedPhrase();
  const { count, balances } = walletState();
  const row = (key: AccountKeys | 'browser'): HTMLElement => {
    const open = account !== null && idOf(account) === idOf(key);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `account-row${key === 'browser' ? ' browser' : key.imported !== undefined ? ' imported' : ''}`;
    b.setAttribute('aria-current', String(open));
    b.innerHTML = `<span class="mark">${markOf(key === 'browser' ? -1 : key.index)}</span><span><b></b><small></small></span><span class="balance-cell"></span>`;
    b.querySelector('b')!.textContent = accountLabel(key);
    b.querySelector('small')!.textContent = key === 'browser' ? 'This browser only, backed up by file' : open ? 'Open now' : key.imported !== undefined ? 'Brought in by its key' : 'From your recovery phrase';
    const balance = balances[idOf(key)];
    b.querySelector('.balance-cell')!.textContent = balance === undefined ? '' : `${units(balance)} XRP`;
    // Each account is a wallet of its own: opening one starts it afresh.
    b.addEventListener('click', () => {
      if (open) return;
      saveWalletState({ active: key === 'browser' ? 'browser' : key.imported !== undefined ? `imported:${key.imported}` : key.index });
      location.reload();
    });
    return b;
  };
  const rows: HTMLElement[] = [];
  if (phrase !== null) for (let n = 0; n < count; n++) rows.push(row(accountKeys(phrase, n)));
  const imported = importedAccounts();
  if (imported.length > 0) rows.push(Object.assign(document.createElement('p'), { className: 'eyebrow list-label', textContent: 'Imported accounts' }), ...imported.map(row));
  if (hasBrowserWallet()) rows.push(row('browser'));
  el('account-list').replaceChildren(...rows);
  el('account-add').hidden = phrase === null;
  el('phrase-box').hidden = phrase === null;
  el('phrase-setup-box').hidden = phrase !== null;
  el('account-rescan').hidden = account === 'browser';
  el('key-box').hidden = account === null || account === 'browser';
  el('key-text').hidden = true;
  el('key-copy').hidden = true;
  el('key-show').textContent = 'Show account key';
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

// ── onboarding: a new wallet, or one brought from elsewhere ───────────────
let draft = '';
/** Opened from inside a browser wallet: going back returns to it. */
let fromWallet = false;
const obStep = (id: string) => { for (const step of document.querySelectorAll<HTMLElement>('.ob-step')) step.hidden = step.id !== id; window.scrollTo(0, 0); };

function openOnboarding(step: 'ob-welcome' | 'ob-show', inWallet = false): void {
  fromWallet = inWallet;
  document.body.classList.add('onboarding');
  for (const v of VIEWS) el(`view-${v}`).hidden = true;
  el('onboard').hidden = false;
  if (step === 'ob-show') startDraft(); else obStep(step);
}

function startDraft(): void {
  draft = newPhrase();
  el('ob-words').replaceChildren(...draft.split(' ').map((w) => Object.assign(document.createElement('li'), { textContent: w })));
  el('ob-words').classList.add('is-hidden');
  el('ob-reveal').hidden = false;
  Object.assign(el<HTMLInputElement>('ob-saved'), { checked: false, disabled: true });
  el<HTMLButtonElement>('ob-next').disabled = true;
  obStep('ob-show');
}

function setupOnboarding(): void {
  el('ob-create').addEventListener('click', startDraft);
  el('ob-import').addEventListener('click', () => obStep('ob-restore'));
  for (const b of document.querySelectorAll<HTMLElement>('[data-ob]')) {
    b.addEventListener('click', () => (fromWallet && b.dataset['ob'] === 'ob-welcome' ? location.reload() : obStep(b.dataset['ob']!)));
  }
  el('ob-reveal').addEventListener('click', () => {
    el('ob-words').classList.remove('is-hidden');
    el('ob-reveal').hidden = true;
    el<HTMLInputElement>('ob-saved').disabled = false;
  });
  el('ob-saved').addEventListener('change', () => { el<HTMLButtonElement>('ob-next').disabled = !el<HTMLInputElement>('ob-saved').checked; });
  el('ob-next').addEventListener('click', () => {
    // Three of the twelve places, picked at random, asked in order.
    const places = [...crypto.getRandomValues(new Uint32Array(12))].map((r, i) => [r, i] as const)
      .sort((a, b) => a[0] - b[0]).slice(0, 3).map(([, i]) => i).sort((a, b) => a - b);
    el('ob-quiz').replaceChildren(...places.map((i) => {
      const label = document.createElement('label');
      label.className = 'field';
      label.htmlFor = `ob-q-${i}`;
      label.innerHTML = `<span>Word ${i + 1}</span><input id="ob-q-${i}" data-pos="${i}" class="mono" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">`;
      return label;
    }));
    setStatus('ob-confirm-status', '');
    obStep('ob-confirm');
  });
  el('ob-finish').addEventListener('click', () => {
    const words = draft.split(' ');
    for (const input of el('ob-quiz').querySelectorAll<HTMLInputElement>('input')) {
      const place = Number(input.dataset['pos']);
      if (normalizePhrase(input.value) !== words[place]) {
        setStatus('ob-confirm-status', `That isn't word ${place + 1}. Check what you wrote down.`);
        input.focus();
        return;
      }
    }
    // A browser wallet with notes stays open; the phrase's Account 1 waits in the account list.
    savePhrase(draft, false, hasBrowserWallet() ? 'browser' : 0);
    location.reload();
  });
  el('ob-restore-go').addEventListener('click', () => {
    const text = el<HTMLTextAreaElement>('ob-phrase').value;
    if (isAccountKeyText(text)) {
      try { importAccountKey(text); } catch (error) { setStatus('ob-restore-status', `Not imported: ${(error as Error).message}.`); return; }
      location.reload();
      return;
    }
    if (!isPhrase(text)) { setStatus('ob-restore-status', 'That is neither the 12 words of a recovery phrase nor an account key (opq1…): check the spelling and the order.'); return; }
    if (storedPhrase() !== null) { setStatus('ob-restore-status', 'This wallet has a recovery phrase already. To bring in one account of another wallet, use that account\'s key (opq1…).'); return; }
    savePhrase(text, true, 0);
    location.reload();
  });
}

function setupAccounts(): void {
  const openAccounts = () => { renderAccounts(); el<HTMLDialogElement>('account-dialog').showModal(); };
  el('account-button').addEventListener('click', openAccounts);
  el('menu-button').addEventListener('click', openAccounts);
  el('account-add').addEventListener('click', () => {
    const { count } = walletState();
    saveWalletState({ count: count + 1, active: count });
    location.reload();
  });
  el('phrase-show').addEventListener('click', () => {
    const list = el('phrase-words');
    const showing = list.hidden;
    list.replaceChildren(...(showing ? (storedPhrase() ?? '').split(' ').map((w) => Object.assign(document.createElement('li'), { textContent: w })) : []));
    list.hidden = !showing;
    el('phrase-show').textContent = showing ? 'Hide recovery phrase' : 'Show recovery phrase';
  });
  el('account-rescan').addEventListener('click', () => void (async () => {
    const button = el<HTMLButtonElement>('account-rescan');
    button.disabled = true;
    try {
      const kept = await wallet.recover((line) => setStatus('phrase-status', line));
      setStatus('phrase-status', kept === 0 ? 'Nothing new on the ledger.' : `Found ${kept} more ${kept === 1 ? 'note' : 'notes'}.`);
      await renderBalances();
    } catch (error) {
      setStatus('phrase-status', `Could not rescan: ${(error as Error).message}`);
    } finally {
      button.disabled = false;
    }
  })());
  el('account-import').addEventListener('click', () => {
    el<HTMLDialogElement>('account-dialog').close();
    openOnboarding('ob-welcome', true);
    obStep('ob-restore');
  });
  el('key-show').addEventListener('click', () => {
    if (account === null || account === 'browser') return;
    const showing = el('key-text').hidden;
    el('key-text').textContent = showing ? accountKeyText(account) : '';
    el('key-text').hidden = !showing;
    el('key-copy').hidden = !showing;
    el('key-show').textContent = showing ? 'Hide account key' : 'Show account key';
  });
  el('key-copy').addEventListener('click', () => void navigator.clipboard.writeText(el('key-text').textContent ?? ''));
  const setUp = () => { el<HTMLDialogElement>('account-dialog').close(); openOnboarding('ob-show', true); };
  el('phrase-setup').addEventListener('click', setUp);
  el('phrase-card-go').addEventListener('click', setUp);
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
  el('action-apps').addEventListener('click', () => showView('apps'));
  el('action-activity').addEventListener('click', () => showView('activity'));
  for (const [tab] of HOME_TABS) el(tab).addEventListener('click', () => showHomeTab(tab));
  setupPromo();
  el('backup-export').addEventListener('click', () => void onBackupExport());
  el('backup-import').addEventListener('click', () => el('backup-file').click());
  el<HTMLInputElement>('backup-file').addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void onBackupImport(file);
  });

  setupOnboarding();
  setupAccounts();
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
  el('wait-for-privacy').addEventListener('change', syncPrivacyWait);
  el<HTMLFormElement>('send-form').addEventListener('submit', (e) => void onSend(e));
  el('receive-button').addEventListener('click', () => void onReceive());
  el('buy-button').addEventListener('click', () => void onBuy());
  el('faucet-button').addEventListener('click', () => void onFaucet());
  el('copy-address').addEventListener('click', () => void navigator.clipboard.writeText(current?.pool ?? ''));
  el('copy-tag').addEventListener('click', () => void navigator.clipboard.writeText(String(current?.tag ?? '')));
  el('refresh').addEventListener('click', () => void refresh(true));
  el('refresh-tags').addEventListener('click', () => void renderTags());
  setupSweep();

  await renderBalances();
  await refresh();
  void renderPlan();
  if (account !== 'browser') {
    await recoverIfImported(account).catch((error: Error) => setStatus('home-status', `Could not look for your notes: ${error.message}. Rescan from the account menu.`));
    await renderBalances();
  }
  // The polls double as cover traffic for the reads that matter.
  setInterval(() => void refresh(), 20_000);
  setInterval(() => void renderActivity(true), 15_000);
}

void init();
