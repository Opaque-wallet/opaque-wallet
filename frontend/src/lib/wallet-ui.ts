// What every wallet page shows the same way: onboarding (a new recovery
// phrase, or one brought in), the account list, and the small things around
// them. One phrase holds every chain's accounts, so the XRPL and Arc pages list
// the same accounts; what differs per chain (an account's address and balance,
// how its notes are looked for again) comes from the page.

import { accountKeys, accountKeyText, accountLabel, importAccountKey, importedAccounts, isAccountKeyText, isPhrase, newPhrase, normalizePhrase, savePhrase, saveWalletState, storedPhrase, walletState, type AccountKeys } from './xrpl-keys.ts';
import { changePassword, confirmPassword, hasPassword, lockNow, MIN_PASSWORD, setPassword } from './lock.ts';
import { backupState, createBackup, hasSomethingToBackUp, passkeySupported, removeBackup, restoreFromPasskey, syncBackup, type BackupTransport } from './passkey-backup.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing #${id}`);
  return found as T;
};
const setStatus = (id: string, message: string) => { el(id).textContent = message; };

// The homepage's opening plays once: back from the wallet by its logo, it opens on the page itself (site/main.js).
try { sessionStorage.setItem('opaque:opening', 'seen'); } catch { /* fine */ }

export const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/></svg>';

// A click on the dim area around a sheet closes it, when its × would: a sheet
// without one (a warning, a review, a payment in progress) waits for its own
// buttons. Both press and release must land outside, so a text selection that
// ends past the edge closes nothing.
const outside = (d: HTMLDialogElement, e: MouseEvent): boolean => {
  const r = d.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
};
function closeOnOutsideClick(): void {
  let pressedOutside = false;
  document.addEventListener('pointerdown', (e) => { pressedOutside = e.target instanceof HTMLDialogElement && outside(e.target, e); });
  document.addEventListener('click', (e) => {
    const d = e.target;
    if (pressedOutside && d instanceof HTMLDialogElement && d.open && outside(d, e) && d.querySelector('.dialog-head button') !== null) d.close();
  });
}

/** A short confirmation at the bottom of the screen. */
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string): void {
  const t = el('toast');
  // An open sheet sits above the page, so the toast goes inside it.
  const host = document.querySelector('dialog[open]') ?? document.body;
  if (t.parentElement !== host) host.append(t);
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}
/** Copies `text`, and says so. A secret gets a reminder that the clipboard holds it. */
export function copy(text: string, what: string, secret = false): void {
  navigator.clipboard.writeText(text).then(
    () => toast(secret ? `${what} copied. Paste it somewhere safe, then copy something else over it.` : `${what} copied`),
    () => toast(`Couldn't copy: select the ${what.toLowerCase()} and copy it by hand`),
  );
}

/** The ring of eight with one note larger: which one tells the accounts apart (none, the browser wallet). */
export function markOf(index: number): string {
  const dots = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4 - Math.PI / 2, lead = i === index % 8;
    return `<circle cx="${(20 + 13 * Math.cos(a)).toFixed(2)}" cy="${(20 + 13 * Math.sin(a)).toFixed(2)}" r="${lead ? 4.8 : 3.4}"${lead || index < 0 ? '' : ' opacity=".6"'}/>`;
  }).join('');
  return `<svg viewBox="0 0 40 40" aria-hidden="true"><g fill="#070608">${dots}</g></svg>`;
}

/** A token picker's badge: the symbol's first letter, in that token's shade. */
export function tokenBadge(id: string, symbol: string): void {
  const node = document.getElementById(id);
  if (node === null) return;
  const name = symbol.replace(/^t/, '');
  node.className = `tok tok-${name.toLowerCase()}`;
  node.textContent = name[0] ?? '';
}

// ── the Terms of Use and Privacy Policy: accepted once, again when they change ──
/** Raise when the terms or the policy change materially: every browser is asked again. */
export const TERMS_VERSION = '2026-10-19';
const TERMS_KEY = 'opaque:terms-accepted';
const SITE = 'https://www.opaque.credit';
export const termsAccepted = (): boolean => { try { return localStorage.getItem(TERMS_KEY) === TERMS_VERSION; } catch { return false; } };

/** Resolves once this browser has accepted the current terms, asking first if it hasn't. Nothing else opens before. */
export function acceptTerms(): Promise<void> {
  if (termsAccepted()) return Promise.resolve();
  let updated = false;
  try { updated = localStorage.getItem(TERMS_KEY) !== null; } catch { /* asked as new */ }
  const dialog = document.createElement('dialog');
  dialog.id = 'terms-dialog';
  dialog.className = 'terms';
  dialog.innerHTML = `
    <div class="dialog-head"><div><p class="eyebrow">${updated ? 'We updated our terms' : 'Before you start'}</p><h2>Terms of Use and Privacy Policy</h2></div></div>
    <ul class="terms-points">
      <li>Opaque is self-custodial: your recovery phrase is your wallet, and nobody, including us, can recover it or reverse a payment.</li>
      <li>It is in public beta. Arc mainnet is not audited yet, and we recommend not depositing there.</li>
      <li>Don't use Opaque for anything illegal, including money laundering or sanctions evasion.</li>
      <li>Privacy has limits: deposits and settlements are public on the blockchain.</li>
    </ul>
    <p class="terms-links">Read the <a href="${SITE}/terms" target="_blank" rel="noopener">Terms of Use</a> and the <a href="${SITE}/privacy" target="_blank" rel="noopener">Privacy Policy</a> in full.</p>
    <label class="privacy-toggle ob-check" for="terms-agree"><input id="terms-agree" type="checkbox" autofocus><span><b>I agree to the Terms of Use and the Privacy Policy</b><small>And I am 18 or older.</small></span></label>
    <button class="primary" id="terms-continue" type="button" disabled>Continue</button>`;
  document.body.append(dialog);
  const box = dialog.querySelector<HTMLInputElement>('#terms-agree')!;
  const go = dialog.querySelector<HTMLButtonElement>('#terms-continue')!;
  box.addEventListener('change', () => { go.disabled = !box.checked; });
  // Escape does not skip it.
  dialog.addEventListener('cancel', (e) => e.preventDefault());
  return new Promise((resolve) => {
    go.addEventListener('click', () => {
      try { localStorage.setItem(TERMS_KEY, TERMS_VERSION); } catch { /* asked again next time */ }
      dialog.close();
      dialog.remove();
      resolve();
    });
    dialog.showModal();
  });
}

// ── a swap under way: seconds left, counted down, re-estimated as it goes ───
export interface SwapProgress {
  /** Shows the countdown: `seconds` from now. */
  start(seconds: number, line: string): void;
  /** A new estimate, `seconds` from now, as the swap gets along. */
  update(seconds: number, line: string): void;
  /** A new line under it, the estimate kept. */
  say(line: string): void;
  finish(line: string): void;
  fail(line: string): void;
  hide(): void;
}
export function swapProgress(): SwapProgress {
  let timer: ReturnType<typeof setInterval> | undefined;
  let [started, until, shown, line, late] = [0, 0, 0, '', false];
  const stop = () => { clearInterval(timer); timer = undefined; };
  const paint = () => {
    const now = Date.now();
    // Past the estimate and not done: a few seconds more, said plainly, never a 0 that sits there.
    if (now >= until) { until = now + 5_000; late = true; }
    const left = Math.ceil((until - now) / 1000);
    el('swap-eta').textContent = String(left);
    el('swap-eta-unit').textContent = left === 1 ? 'second left' : 'seconds left';
    // The bar only moves forward, however the estimate moves.
    shown = Math.max(shown, Math.min(97, ((now - started) / Math.max(1, until - started)) * 100));
    el('swap-bar').style.width = `${shown}%`;
    el('swap-progress-text').textContent = late ? `${line} · taking a little longer than usual` : line;
  };
  const end = (mark: string, unit: string, text: string) => {
    stop();
    el('swap-eta').textContent = mark;
    el('swap-eta-unit').textContent = unit;
    el('swap-bar').style.width = '100%';
    el('swap-progress-text').textContent = text;
  };
  return {
    start(seconds, text) {
      stop();
      [started, until, shown, line, late] = [Date.now(), Date.now() + seconds * 1000, 0, text, false];
      el('swap-progress').hidden = false;
      paint();
      timer = setInterval(paint, 1000);
    },
    update(seconds, text) { until = Date.now() + seconds * 1000; line = text; late = false; if (timer !== undefined) paint(); },
    say(text) { line = text; if (timer !== undefined) paint(); },
    finish: (text) => end('✓', 'done', text),
    fail: (text) => end('!', 'stopped', text),
    hide() { stop(); el('swap-progress').hidden = true; },
  };
}

export type OpenAccount = AccountKeys | 'browser';
export const idOf = (a: OpenAccount): string => (a === 'browser' ? 'browser' : a.id);

/** What a page tells the shared screens about its chain. */
export interface AccountsPage {
  /** The page's views, hidden while onboarding. */
  readonly views: readonly string[];
  /** The account open now, or null before there is one. */
  account(): OpenAccount | null;
  /** Whether this browser holds an account from before recovery phrases. */
  hasBrowserWallet(): boolean;
  /** Under the browser account's name. */
  readonly browserNote: string;
  /** Where a rescan looks, to say it found nothing: "on the ledger". */
  readonly where: string;
  /** An account's address as far as this browser knows it, to copy from the list; null if not yet. */
  addressOf(key: AccountKeys): string | null;
  shortAddress(address: string): string;
  /** Works out addresses the list lacks; true if it found any, and the list is drawn again. */
  fillAddresses?(keys: readonly AccountKeys[]): Promise<boolean>;
  /** The last balance an account showed, formatted, or ''. */
  balanceOf(key: OpenAccount): string;
  /** Looks for the open account's notes again; returns how many were new. */
  rescan(progress: (line: string) => void): Promise<number>;
  /** The passkey backup's way to its store, through this page's relays. */
  readonly backup: BackupTransport;
}
let page: AccountsPage;

// ── accounts: the phrase's, imported ones, and the browser wallet from before phrases ──
export function renderAccounts(): void {
  const phrase = storedPhrase();
  const { count } = walletState();
  const account = page.account();
  const missing: AccountKeys[] = [];
  const isOpen = (key: OpenAccount) => account !== null && idOf(account) === idOf(key);
  const row = (key: OpenAccount): HTMLElement => {
    const open = account !== null && idOf(account) === idOf(key);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `account-row${key === 'browser' ? ' browser' : key.imported !== undefined ? ' imported' : ''}`;
    b.setAttribute('aria-current', String(open));
    b.innerHTML = `<span class="mark">${markOf(key === 'browser' ? -1 : key.index)}</span><span><b></b><small></small></span><span class="balance-cell"></span>`;
    b.querySelector('b')!.textContent = accountLabel(key);
    b.querySelector('small')!.textContent = key === 'browser' ? page.browserNote : open ? 'Open now' : key.imported !== undefined ? 'Brought in by its key' : 'From your recovery phrase';
    b.querySelector('.balance-cell')!.textContent = page.balanceOf(key);
    const item = document.createElement('div');
    item.className = 'account-item';
    item.append(b);
    // Its address, as MetaMask shows one under each account: copy it without opening the account.
    const address = key === 'browser' ? null : page.addressOf(key);
    if (key !== 'browser' && address === null) missing.push(key);
    // The open account's is being made: say so, rather than show nothing.
    if (address === null && key !== 'browser' && isOpen(key)) {
      const pending = Object.assign(document.createElement('span'), { className: 'addr-chip pending' });
      pending.innerHTML = `<code>${addressFailed ? 'Couldn\'t make the address: reopen to retry' : 'Making address…'}</code>`;
      item.append(pending);
      item.classList.add('has-address');
    }
    if (address !== null) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'addr-chip';
      chip.title = 'Copy address';
      chip.innerHTML = `<code></code>${COPY_ICON}`;
      chip.querySelector('code')!.textContent = page.shortAddress(address);
      chip.addEventListener('click', () => copy(address, `${accountLabel(key)}'s address`));
      item.append(chip);
      item.classList.add('has-address');
    }
    // Each account is a wallet of its own: opening one starts it afresh.
    b.addEventListener('click', () => {
      if (open) return;
      saveWalletState({ active: key === 'browser' ? 'browser' : key.imported !== undefined ? `imported:${key.imported}` : key.index });
      location.reload();
    });
    return item;
  };
  const rows: HTMLElement[] = [];
  if (phrase !== null) for (let n = 0; n < count; n++) rows.push(row(accountKeys(phrase, n)));
  const imported = importedAccounts();
  if (imported.length > 0) rows.push(Object.assign(document.createElement('p'), { className: 'eyebrow list-label', textContent: 'Imported accounts' }), ...imported.map(row));
  if (page.hasBrowserWallet()) rows.push(row('browser'));
  el('account-list').replaceChildren(...rows);
  el('account-add').hidden = phrase === null;
  el('phrase-box').hidden = phrase === null;
  el('phrase-setup-box').hidden = phrase !== null;
  el('account-rescan').hidden = account === 'browser';
  el('key-box').hidden = account === null || account === 'browser';
  el('key-text').hidden = true;
  el('key-copy').hidden = true;
  el('key-show').textContent = 'Show account key';
  renderPasskey();
  el('password-text').textContent = hasPassword()
    ? 'On. Your recovery phrase, keys and notes are encrypted in this browser under it. Opaque locks itself after 15 idle minutes, and when this tab closes.'
    : 'Off. Anything that can read this browser\'s storage can read your recovery phrase and keys. A password encrypts them.';
  el('password-change').hidden = !hasPassword();
  el('lock-now').hidden = !hasPassword();
  // Addresses this browser has not worked out yet: they then show above.
  if (missing.length > 0 && el<HTMLDialogElement>('account-dialog').open) {
    addressFailed = false;
    void page.fillAddresses?.(missing).then(
      (found) => { if (found && el<HTMLDialogElement>('account-dialog').open) renderAccounts(); },
      () => { addressFailed = true; if (el<HTMLDialogElement>('account-dialog').open) renderAccounts(); },
    );
  }
}
let addressFailed = false;

export function setupAccounts(): void {
  const openAccounts = () => { el<HTMLDialogElement>('account-dialog').showModal(); renderAccounts(); };
  el('account-button').addEventListener('click', openAccounts);
  document.getElementById('menu-button')?.addEventListener('click', openAccounts);
  el('account-add').addEventListener('click', () => {
    const { count } = walletState();
    saveWalletState({ count: count + 1, active: count });
    location.reload();
  });
  el('phrase-show').addEventListener('click', () => void (async () => {
    const list = el('phrase-words');
    const showing = list.hidden;
    if (showing && !(await confirmPassword('your recovery phrase'))) return;
    list.replaceChildren(...(showing ? (storedPhrase() ?? '').split(' ').map((w) => Object.assign(document.createElement('li'), { textContent: w })) : []));
    list.hidden = !showing;
    el('phrase-copy').hidden = !showing;
    el('phrase-show').textContent = showing ? 'Hide recovery phrase' : 'Show recovery phrase';
  })());
  el('phrase-copy').addEventListener('click', () => copy(storedPhrase() ?? '', 'Recovery phrase', true));
  el('account-rescan').addEventListener('click', () => void (async () => {
    const button = el<HTMLButtonElement>('account-rescan');
    button.disabled = true;
    try {
      const kept = await page.rescan((line) => setStatus('phrase-status', line));
      setStatus('phrase-status', kept === 0 ? `Nothing new ${page.where}.` : `Found ${kept} more ${kept === 1 ? 'note' : 'notes'}.`);
    } catch (error) {
      setStatus('phrase-status', `Could not rescan: ${(error as Error).message}`);
    } finally {
      button.disabled = false;
    }
  })());
  el('account-import').addEventListener('click', () => {
    el<HTMLDialogElement>('account-dialog').close();
    openOnboarding('ob-welcome', true);
    // One account, beside this wallet's own: its key, not a phrase.
    el('ob-restore-title').textContent = 'Import an account';
    el('ob-restore-lede').textContent = 'Paste one account\'s key (opq1…), from Accounts → Show account key in any Opaque wallet. That account alone joins yours, on every chain, and its notes are found again. Whoever holds the key can spend that account.';
    el('ob-phrase-label').textContent = 'Account key';
    el<HTMLTextAreaElement>('ob-phrase').placeholder = 'opq1…';
    obStep('ob-restore');
  });
  el('key-show').addEventListener('click', () => void (async () => {
    const account = page.account();
    if (account === null || account === 'browser') return;
    const showing = el('key-text').hidden;
    if (showing && !(await confirmPassword('this account\'s key'))) return;
    el('key-text').textContent = showing ? accountKeyText(account) : '';
    el('key-text').hidden = !showing;
    el('key-copy').hidden = !showing;
    el('key-show').textContent = showing ? 'Hide account key' : 'Show account key';
  })());
  el('key-copy').addEventListener('click', () => copy(el('key-text').textContent ?? '', 'Account key', true));
  el('passkey-go').addEventListener('click', () => void (async () => {
    el<HTMLButtonElement>('passkey-go').disabled = true;
    setStatus('passkey-status', 'Follow your browser\'s passkey prompt…');
    try { await createBackup(page.backup); setStatus('passkey-status', ''); toast('Backed up with your passkey'); } catch (error) { setStatus('passkey-status', `Not backed up: ${(error as Error).message}`); }
    el<HTMLButtonElement>('passkey-go').disabled = false;
    renderPasskey();
  })());
  el('passkey-remove').addEventListener('click', () => void (async () => {
    if (!confirm('Remove the passkey backup? Clearing this browser would then leave only your written recovery phrase.')) return;
    try { await removeBackup(page.backup); setStatus('passkey-status', 'Removed. Opaque no longer keeps a copy.'); } catch (error) { setStatus('passkey-status', `Not removed: ${(error as Error).message}`); }
    renderPasskey();
  })());
  el('lock-now').addEventListener('click', () => void lockNow());
  el('password-change').addEventListener('click', () => { el('password-change-form').hidden = !el('password-change-form').hidden; });
  el('password-change-form').addEventListener('submit', (e) => void (async () => {
    e.preventDefault();
    const [current, next, again] = ['password-current', 'password-next', 'password-again'].map((id) => el<HTMLInputElement>(id).value) as [string, string, string];
    if (next !== again) { setStatus('password-status', 'The two new passwords don\'t match.'); return; }
    setStatus('password-status', 'Changing…');
    try {
      await changePassword(current, next);
      for (const id of ['password-current', 'password-next', 'password-again']) el<HTMLInputElement>(id).value = '';
      el('password-change-form').hidden = true;
      setStatus('password-status', 'Changed. Use the new password from now on.');
    } catch (error) { setStatus('password-status', `Not changed: ${(error as Error).message}`); }
  })());
  const setUp = () => { el<HTMLDialogElement>('account-dialog').close(); openOnboarding('ob-show', true); };
  el('phrase-setup').addEventListener('click', setUp);
  document.getElementById('phrase-card-go')?.addEventListener('click', setUp);
}

// ── onboarding: a new wallet, or one brought from elsewhere ───────────────
let draft = '';
/** Opened from inside a browser wallet: going back returns to it. */
let fromWallet = false;
export const obStep = (id: string): void => { for (const step of document.querySelectorAll<HTMLElement>('.ob-step')) step.hidden = step.id !== id; window.scrollTo(0, 0); };

export function openOnboarding(step: 'ob-welcome' | 'ob-show', inWallet = false): void {
  fromWallet = inWallet;
  document.body.classList.add('onboarding');
  for (const v of page.views) el(`view-${v}`).hidden = true;
  el('onboard').hidden = false;
  if (step === 'ob-show') startDraft(); else obStep(step);
}

function startDraft(): void {
  draft = newPhrase();
  el('ob-words').replaceChildren(...draft.split(' ').map((w) => Object.assign(document.createElement('li'), { textContent: w })));
  el('ob-words').classList.add('is-hidden');
  el('ob-reveal').hidden = false;
  el('ob-copy').hidden = true;
  Object.assign(el<HTMLInputElement>('ob-saved'), { checked: false, disabled: true });
  el<HTMLButtonElement>('ob-next').disabled = true;
  obStep('ob-show');
}

/** A wallet was just made or brought in: offer the passkey backup once, then open it. */
/** A wallet was just made or brought in: a password first, then the passkey backup offered once, then it opens. */
async function opened(): Promise<void> {
  if (!hasPassword()) { obStep('ob-password'); el<HTMLInputElement>('ob-pass').focus(); return; }
  if (backupState() === null && await passkeySupported()) { obStep('ob-passkey'); return; }
  location.reload();
}

function setupOnboarding(): void {
  el('ob-create').addEventListener('click', startDraft);
  el('ob-passkey-restore').addEventListener('click', () => void (async () => {
    const button = el<HTMLButtonElement>('ob-passkey-restore');
    button.disabled = true;
    setStatus('ob-welcome-status', 'Choose your Opaque passkey…');
    try {
      const back = await restoreFromPasskey(page.backup);
      setStatus('ob-welcome-status', back.phrase ? 'Your wallet is back. Opening it and looking for your notes…' : 'Restored. Opening…');
      void opened();
    } catch (error) {
      setStatus('ob-welcome-status', `Not restored: ${(error as Error).message}`);
      button.disabled = false;
    }
  })());
  el('ob-passkey-go').addEventListener('click', () => void (async () => {
    el<HTMLButtonElement>('ob-passkey-go').disabled = true;
    setStatus('ob-passkey-status', 'Follow your browser\'s passkey prompt…');
    try { await createBackup(page.backup); location.reload(); } catch (error) {
      setStatus('ob-passkey-status', `Not backed up: ${(error as Error).message} You can try again from Accounts.`);
      el<HTMLButtonElement>('ob-passkey-go').disabled = false;
    }
  })());
  el('ob-passkey-skip').addEventListener('click', () => location.reload());
  el('ob-password').addEventListener('submit', (e) => void (async () => {
    e.preventDefault();
    const [pass, again] = [el<HTMLInputElement>('ob-pass').value, el<HTMLInputElement>('ob-pass2').value];
    if (pass.length < MIN_PASSWORD) { setStatus('ob-pass-status', `At least ${MIN_PASSWORD} characters.`); return; }
    if (pass !== again) { setStatus('ob-pass-status', 'The two passwords don\'t match.'); return; }
    el<HTMLButtonElement>('ob-pass-go').disabled = true;
    setStatus('ob-pass-status', 'Sealing this wallet under it…');
    try { await setPassword(pass); await opened(); } catch (error) {
      setStatus('ob-pass-status', `Not set: ${(error as Error).message}`);
      el<HTMLButtonElement>('ob-pass-go').disabled = false;
    }
  })());
  el('ob-import').addEventListener('click', () => obStep('ob-restore'));
  for (const b of document.querySelectorAll<HTMLElement>('[data-ob]')) {
    b.addEventListener('click', () => (fromWallet && b.dataset['ob'] === 'ob-welcome' ? location.reload() : obStep(b.dataset['ob']!)));
  }
  el('ob-reveal').addEventListener('click', () => {
    el('ob-words').classList.remove('is-hidden');
    el('ob-reveal').hidden = true;
    el('ob-copy').hidden = false;
    el<HTMLInputElement>('ob-saved').disabled = false;
  });
  el('ob-copy').addEventListener('click', () => copy(draft, 'Recovery phrase', true));
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
    savePhrase(draft, false, page.hasBrowserWallet() ? 'browser' : 0);
    void opened();
  });
  el('ob-restore-go').addEventListener('click', () => {
    const text = el<HTMLTextAreaElement>('ob-phrase').value;
    if (isAccountKeyText(text)) {
      try { importAccountKey(text); } catch (error) { setStatus('ob-restore-status', `Not imported: ${(error as Error).message}.`); return; }
      void opened();
      return;
    }
    if (!isPhrase(text)) { setStatus('ob-restore-status', 'That is neither the 12 words of a recovery phrase nor an account key (opq1…): check the spelling and the order.'); return; }
    if (storedPhrase() !== null) { setStatus('ob-restore-status', 'This wallet has a recovery phrase already. To bring in one account of another wallet, use that account\'s key (opq1…).'); return; }
    savePhrase(text, true, 0);
    void opened();
  });
}

// ── the passkey backup: offered, shown in Accounts, kept up to date ───────
let passkeyReady = false;
/** The Accounts dialog's passkey section: on and when last saved, or the offer. */
function renderPasskey(): void {
  const local = backupState();
  el('passkey-box').hidden = !passkeyReady || (local === null && !hasSomethingToBackUp());
  el('passkey-go').hidden = local !== null;
  el('passkey-remove').hidden = local === null;
  el('passkey-text').textContent = local === null
    ? 'Clearing this browser would leave only your written recovery phrase. A passkey (Touch ID, Face ID, your phone or your password manager) brings every account back instead. Opaque keeps an encrypted copy it can\'t open.'
    : `On${local.savedAt === undefined ? '' : `, saved ${new Date(local.savedAt).toLocaleString()}`}. If this browser is cleared, choose “Restore with a passkey” when Opaque opens.${local.leftOut ? ' The Browser account\'s notes were too many to include: move them into Account 1, or keep a backup file.' : ''}`;
}

/** Shows the offer and the restore button where a passkey can work, and keeps a backup up to date. */
async function setupPasskey(): Promise<void> {
  passkeyReady = await passkeySupported();
  if (!passkeyReady) return;
  el('ob-passkey-restore').hidden = false;
  const card = document.getElementById('passkey-card');
  const later = () => { try { return sessionStorage.getItem('opaque:passkey-card') === 'later'; } catch { return false; } };
  document.getElementById('passkey-card-go')?.addEventListener('click', () => void (async () => {
    try { await createBackup(page.backup); card!.hidden = true; toast('Backed up with your passkey'); } catch (error) { toast(`Not backed up: ${(error as Error).message}`); }
  })());
  document.getElementById('passkey-card-x')?.addEventListener('click', () => { card!.hidden = true; try { sessionStorage.setItem('opaque:passkey-card', 'later'); } catch { /* fine */ } });
  // Once an account is open: the offer on Home, or, with a backup, the backup re-sealed when what it holds has
  // changed (a deposit, an import, a new app account), without the passkey.
  const tick = () => {
    if (page.account() === null) return;
    if (backupState() !== null) { void syncBackup(page.backup).catch(() => undefined); return; }
    if (card !== null) card.hidden = later() || !hasSomethingToBackUp();
  };
  setTimeout(tick, 3_000);
  setInterval(tick, 60_000);
}

/** Wires onboarding and the account list to this page. Call once, before anything opens either. */
export function setupWalletScreens(of: AccountsPage): void {
  page = of;
  closeOnOutsideClick();
  setupOnboarding();
  setupAccounts();
  void setupPasskey();
  // A wallet without a password: the offer on Home, once an account is open.
}
