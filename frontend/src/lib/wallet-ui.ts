// What every wallet page shows the same way: onboarding (a new recovery
// phrase, or one brought in), the account list, and the small things around
// them. One phrase holds every chain's accounts, so the XRPL and Arc pages list
// the same accounts; what differs per chain (an account's address and balance,
// how its notes are looked for again) comes from the page.

import { accountKeys, accountKeyText, accountLabel, importAccountKey, importedAccounts, isAccountKeyText, isPhrase, newPhrase, normalizePhrase, savePhrase, saveWalletState, storedPhrase, walletState, type AccountKeys } from './xrpl-keys.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing #${id}`);
  return found as T;
};
const setStatus = (id: string, message: string) => { el(id).textContent = message; };

export const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/></svg>';

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
}
let page: AccountsPage;

// ── accounts: the phrase's, imported ones, and the browser wallet from before phrases ──
export function renderAccounts(): void {
  const phrase = storedPhrase();
  const { count } = walletState();
  const account = page.account();
  const missing: AccountKeys[] = [];
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
  // Addresses this browser has not worked out yet: they then show above.
  if (missing.length > 0 && el<HTMLDialogElement>('account-dialog').open) {
    void page.fillAddresses?.(missing).then((found) => { if (found && el<HTMLDialogElement>('account-dialog').open) renderAccounts(); }, () => undefined);
  }
}

export function setupAccounts(): void {
  const openAccounts = () => { el<HTMLDialogElement>('account-dialog').showModal(); renderAccounts(); };
  el('account-button').addEventListener('click', openAccounts);
  document.getElementById('menu-button')?.addEventListener('click', openAccounts);
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
    el('phrase-copy').hidden = !showing;
    el('phrase-show').textContent = showing ? 'Hide recovery phrase' : 'Show recovery phrase';
  });
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
    obStep('ob-restore');
  });
  el('key-show').addEventListener('click', () => {
    const account = page.account();
    if (account === null || account === 'browser') return;
    const showing = el('key-text').hidden;
    el('key-text').textContent = showing ? accountKeyText(account) : '';
    el('key-text').hidden = !showing;
    el('key-copy').hidden = !showing;
    el('key-show').textContent = showing ? 'Hide account key' : 'Show account key';
  });
  el('key-copy').addEventListener('click', () => copy(el('key-text').textContent ?? '', 'Account key', true));
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

function setupOnboarding(): void {
  el('ob-create').addEventListener('click', startDraft);
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

/** Wires onboarding and the account list to this page. Call once, before anything opens either. */
export function setupWalletScreens(of: AccountsPage): void {
  page = of;
  setupOnboarding();
  setupAccounts();
}
