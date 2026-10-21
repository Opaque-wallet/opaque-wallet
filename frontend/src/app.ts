// opaque wallet — the UI, wired to the real protocol.
//
// Two rules kept strictly, because these exact bytes ship as the extension
// popup as well as the hosted page:
//
//   * every handler is attached with addEventListener — Manifest V3 forbids
//     inline handlers, so app.html has none to attach;
//   * nothing is eval'd or built from a string.
//
// Everything below reads real state: the note balance from this browser's
// vault, the ring and privacy score through the mesh, the path from the
// verified relay directory, payment status through the mesh. Nothing in the
// page is simulated.

// First: it seals and opens what the wallet stores, so nothing reads storage before it.
import { confirmPassword, unlockGate } from './lib/lock.ts';
import type { IntentStatus, NoteSummary, PrivacyScore, StatusHandle, UnixSeconds } from '@opaque/protocol-types';

import { fromUnits, makeAmount, MAX_NOTES_PER_DEPOSIT, swapHoldsPreview } from './lib/protocol/index.js';
import { paymentDeadline } from './lib/payment-deadline.js';
import { runPaymentLanes } from './lib/payment-lanes.js';
import { backupTransport, hasBrowserAccount, startWallet, type WalletRuntime } from './lib/runtime.js';
import { addressOfKey, arcAddressOf, arcState, arcStorageOf, deployerKey, saveArcState } from './lib/arc-keys.ts';
import { keyStoreName } from './lib/backup.ts';
import { asHexBytes, CREATE2_FACTORY, deployment as deployOf, MAX_INITCODE, newSalt, riskOfCall } from './lib/contracts.ts';
import { accountKeys, accountLabel, activeAccount, saveWalletState, storedPhrase, walletState, type AccountKeys } from './lib/xrpl-keys.ts';
import { acceptTerms, copy, idOf, markOf, openOnboarding, setupWalletScreens, swapProgress, tokenBadge, type OpenAccount } from './lib/wallet-ui.ts';
import { deployment, NETWORK, type SwapToken } from '../../deployments/index.ts';
import type { SwapQuote } from '../../backend/chain/wallet-rpc.ts';
import { networkPicker } from './lib/network-picker.ts';
import { scoped } from './lib/storage-name.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_SIZE = 8;

/** Throws rather than returning null: a missing id is a broken build, not a runtime case. */
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`app.html is missing #${id}`);
  return node as T;
}

// The wallet cannot start without the runtime, and a page that silently shows
// zeros would read as an empty wallet rather than a failure. This bar stays
// hidden until there is something the user has to know about.
function showBootError(message: string): void {
  const bar = el('boot-error');
  bar.textContent = message;
  bar.hidden = false;
}

let rt: WalletRuntime;
let runtimeReady = false;
/** USDC at the account's own address: sent to it, not yet deposited as notes. */
let accountUsdc = 0;
let notes: readonly NoteSummary[] = [];
/** Deposits in each ring pool, by pool address, as last read through the mesh. */
const poolSizes = new Map<string, number>();
let hops: readonly string[] = [];
let opaqueAddress = '';
/** The account open now: one of the recovery phrase's, or this browser's own from before phrases. */
let account: OpenAccount | null = null;
let browserAccount = false;

const ARC_CHAIN_ID = deployment.network.chainId;
const ARC_EXPLORER = deployment.network.explorer;
const ARC_NAME = deployment.network.displayName;
/**
 * USDC a deposit keeps in the account for its own gas. ponytail: a flat
 * margin over the ~0.03 a one-note operation costs; what it leaves over stays
 * in the account and pays for the next one.
 */
const DEPOSIT_GAS_USDC = 0.2;
/** A payment waiting for privacy settles when the mesh reaches this score. */
const MIN_FRESHNESS = 70;
/**
 * Independent notes share neither nullifier nor ring proof. Four lanes keep a
 * four-note payment responsive for hackathon demos; every lane remains an
 * independent, all-settled operation.
 */
const PAYMENT_LANES = 4;
const shortAddress = (value: string) => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : 'Not connected';
const isRejected = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 4001;

function setStatus(id: string, message: string): void { el(id).textContent = message; }


// ── payments this browser has sent ────────────────────────────────────────
//
// Kept locally so Activity survives a reload. A handle and a recipient only —
// no note secret, no proof. The handle is a capability: whoever holds it can
// read this payment's status, so it stays on this device.

interface SentPayment {
  readonly handle: string;
  readonly recipient: string;
  readonly at: number;
  /** The send it belongs to: one Activity row per send, however many notes. */
  readonly group?: string;
  /** The note's value; absent on payments from when every note was 1 USDC. */
  readonly usdc?: number;
  state?: IntentStatus['state'];
  txHash?: string;
}
/** Each account keeps its own: set once the page knows which account is open. */
let sentKey = scoped('opaque:sent:v1');
let sent: SentPayment[] = [];
function loadSent(key: string): void {
  sentKey = key;
  try { sent = JSON.parse(localStorage.getItem(sentKey) ?? '[]') as SentPayment[]; } catch { sent = []; }
}
const saveSent = () => localStorage.setItem(sentKey, JSON.stringify(sent));
const TERMINAL = new Set(['SETTLED', 'FAILED']);

// ── the PQ account key ────────────────────────────────────────────────────

async function renderBudget(): Promise<void> {
  const state = await rt.app.walletState();
  opaqueAddress = state.accountAddress as string;
  // The open account's address, for the account list: known here without working it out.
  if (account !== null && account !== 'browser' && arcState().addresses[account.id] === undefined) saveArcState({ addresses: { ...arcState().addresses, [account.id]: opaqueAddress.toLowerCase() } });
  el('account-short').textContent = shortAddress(opaqueAddress);
  el('account-address').textContent = opaqueAddress;
  el('receive-address').textContent = opaqueAddress;
  el<HTMLAnchorElement>('open-explorer').href = `${ARC_EXPLORER}/address/${opaqueAddress}`;
  const max = Number(state.maxUses);
  const left = Math.max(0, max - Number(state.localSigningReservations));
  const low = left <= Math.ceil(max / 4);

  el('sig-left').textContent = String(left);
  el('sig-max').textContent = `of ${max}`;
  // How far through the key we are, 0 → 1. The panel draws a fracture across
  // itself from this: the landing page's argument is that everything breaks
  // eventually, and for a few-time key that is not a metaphor — it is the
  // number above. Spent budget is literally how far the crack has got.
  const spent = max === 0 ? 1 : (max - left) / max;
  el('budget').style.setProperty('--spent', spent.toFixed(3));

  // One cell per signature, not a percentage bar. With a few-time scheme the
  // count is small enough to be countable, and "2 left" versus "3 left"
  // matters far more than twelve percent of a bar does.
  const meter = el('meter');
  meter.classList.toggle('low', low);
  meter.replaceChildren(...Array.from({ length: max }, (_, i) => {
    const cell = document.createElement('i');
    if (i < left) cell.className = 'on';
    return cell;
  }));

  const funds = await rt.accountFunds(opaqueAddress as `0x${string}`).catch(() => undefined);
  const balance = funds === undefined ? '' : ` · ${funds.usdc.toFixed(2)} USDC`;
  if (funds !== undefined) {
    accountUsdc = funds.usdc;
    // The Contracts screen's gas money, as it arrives.
    if (!el('view-contracts').hidden) el('contracts-gas').textContent = `${accountUsdc} USDC`;
    // USDC sent to the address from outside: offer it, and drop a stale
    // "send USDC first" from before it arrived.
    const ready = Math.floor(accountUsdc - DEPOSIT_GAS_USDC);
    const field = el<HTMLInputElement>('deposit-count');
    if (ready >= 1 && field.value.trim() === '') { field.value = String(ready); renderDepositSplit(); }
    if (ready >= 1 && /^Send /.test(el('deposit-status').textContent ?? '')) el('deposit-status').textContent = '';
    renderBalance();
    if (autoOn() && ready >= 1 && !depositing && !autoFailed && Date.now() > quietUntil) void autoDeposit(ready);
    void refreshTokens().catch(() => undefined);
  }
  el('account-state').textContent = state.active
    ? `Active${balance} · deposits are signed by its PQ key`
    : `Not on chain yet${balance} · your first deposit sets it up`;
  el('withdraw-box').hidden = (funds?.usdc ?? 0) === 0;
  if (state.active && low) void autoRotate();
}

// The key rotates itself once it is nearly spent. There is no button for this
// on purpose: a few-time key whose replacement waited on someone noticing a
// warning is one busy afternoon from being spent, and the old button needed a
// funding wallet the extension does not have. The mesh exit relays the
// rotation and pays for it, so nothing pops up here. Two of the key's 32
// signatures are held back for exactly this, so it can always afford to go.
//
// ONCE PER PAGE LOAD, WHATEVER HAPPENS. Signing the rotation spends one of
// those two reserved signatures whether or not the transaction lands, so a
// retry loop on a rotation that keeps failing would spend the second one too
// and leave the key unable to rotate or disable at all. A failure says so and
// stops; a reload is the retry, and a deliberate one.
let rotating = false;
let rotated = false;
async function autoRotate(): Promise<void> {
  if (rotating || rotated) return;
  rotating = true;
  rotated = true;
  setStatus('rotate-status', 'Few signatures left on this key. Rotating to the next one…');
  try {
    const before = (await rt.app.walletState()).pkCommitment;
    await rt.app.rotateWallet();
    await settle(async () => (await rt.app.walletState()).pkCommitment !== before);
    setStatus('rotate-status', 'Rotated. A fresh key is active, with the next one already committed behind it.');
    await renderBudget();
  } catch (error) {
    setStatus('rotate-status', `Could not rotate this key: ${(error as Error).message}. Reload to try once more, or back up and restore into a new wallet.`);
  } finally { rotating = false; }
}

async function onWithdraw(): Promise<void> {
  const to = el<HTMLInputElement>('withdraw-to').value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(to)) { setStatus('wallet-status', 'Enter an Arc address to withdraw to.'); return; }
  const button = el<HTMLButtonElement>('withdraw');
  button.disabled = true;
  setStatus('wallet-status', 'Signing the withdrawal with your PQ key; it goes to the bundler through the mesh…');
  try {
    const tx = await rt.withdraw(opaqueAddress as `0x${string}`, to as `0x${string}`);
    setStatus('wallet-status', `Withdrawn to ${shortAddress(to)} in ${shortAddress(tx)}.`);
    await renderBudget();
  } catch (error) {
    setStatus('wallet-status', `Could not withdraw: ${(error as Error).message}`);
  } finally { button.disabled = false; }
}

async function onBackupExport(): Promise<void> {
  const pass = el<HTMLInputElement>('backup-pass');
  // A file of the account's keys and notes, under a passphrase of the holder's choosing: the password first.
  if (!(await confirmPassword('save this account\'s keys and notes to a file'))) return;
  try {
    const url = URL.createObjectURL(await rt.exportBackup(pass.value));
    const link = document.createElement('a');
    link.href = url;
    link.download = `opaque-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    pass.value = '';
    setStatus('backup-status', 'Saved. Keep the file and the passphrase in different places.');
  } catch (error) {
    setStatus('backup-status', (error as Error).message);
  }
}

async function onBackupImport(file: File): Promise<void> {
  // A key used from two browsers can sign one index twice; restore replaces, it does not copy.
  if (!window.confirm('Restore switches this browser to the account in the backup. The current account stays in storage but is no longer shown. Use a backup on one device at a time. Continue?')) return;
  try {
    const added = await rt.restoreBackup(file, el<HTMLInputElement>('backup-pass').value);
    saveWalletState({ active: 'browser' });
    setStatus('backup-status', `Restored, with ${added} note${added === 1 ? '' : 's'} new to this browser. Reloading…`);
    window.setTimeout(() => window.location.reload(), 800);
  } catch (error) {
    setStatus('backup-status', `Could not restore: ${(error as Error).message}`);
  }
}

/**
 * Mined is not yet visible: the exit reads a load-balanced RPC whose next
 * answer can be a block behind the one that mined it. Look a few times.
 */
async function settle(done: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 10 && !await done().catch(() => false); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

// ── notes ─────────────────────────────────────────────────────────────────
//
// A note is 1, 2, 5, 10, 20, 50 or 100 USDC, each in its own pool (§6.6: a ring is formed
// only among notes of one size). A pool fills from anyone's deposits, and a
// note in it can be spent once it holds a ring's worth.

const usdcOf = (n: NoteSummary): number => Number(n.scope.denomination) / 1e6;
// Deposits are whole USDC into fixed-denomination pools. The field is a text input rather than
// type=number because a number input still accepts "1.5", "-3" and "1e5",
// and reports them as an empty value — which reads as 0, not as a mistake.
const MAX_AMOUNT_DIGITS = 6;
/** The whole USDC in an amount field, or undefined when it is not one ≥ 1. */
function wholeAmount(id: string): number | undefined {
  const raw = el<HTMLInputElement>(id).value.trim();
  if (!/^\d+$/.test(raw)) return undefined;
  const amount = Number(raw);
  return Number.isSafeInteger(amount) && amount >= 1 ? amount : undefined;
}
const depositAmount = (): number | undefined => wholeAmount('deposit-count');

function localDateTime(ms: number): string {
  const local = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function syncPrivacyWait(): void {
  const wait = el<HTMLInputElement>('wait-for-privacy').checked;
  const deadline = el<HTMLInputElement>('privacy-deadline');
  el('privacy-deadline-wrap').hidden = !wait;
  el('immediate-settlement').hidden = wait;
  deadline.disabled = !wait;
  deadline.required = wait;
  if (wait && deadline.value === '') deadline.value = localDateTime(Date.now() + 3_600_000);
}

function requestedDeadline(): UnixSeconds {
  const waitForPrivacy = el<HTMLInputElement>('wait-for-privacy').checked;
  const nowMs = Date.now();
  if (!waitForPrivacy) return paymentDeadline({ waitForPrivacy, nowMs }) as UnixSeconds;
  return paymentDeadline({ waitForPrivacy, selectedMs: el<HTMLInputElement>('privacy-deadline').valueAsNumber, nowMs }) as UnixSeconds;
}

/**
 * Keeps an amount field to digits only. The fields are type=text: a number
 * input still accepts "1.5", "-3" and "1e5", reports them as an empty value —
 * which reads as 0, not as a mistake — and paints spinner arrows that have no
 * place on an amount.
 */
function onlyWholeAmounts(input: HTMLInputElement, after: () => void): void {
  input.addEventListener('input', () => {
    // Strip as it arrives, typed or pasted; leading zeros go too, so "007"
    // does not read as an amount of its own.
    const cleaned = input.value.replace(/\D+/g, '').replace(/^0+(?=\d)/, '').slice(0, MAX_AMOUNT_DIGITS);
    if (cleaned !== input.value) {
      // Keep the caret where the user was typing, not thrown to the end.
      const at = input.selectionStart ?? cleaned.length;
      const removed = input.value.length - cleaned.length;
      input.value = cleaned;
      const to = Math.max(0, at - removed);
      input.setSelectionRange(to, to);
    }
    after();
  });
  // An empty or 0 field left behind on blur returns to the smallest amount.
  input.addEventListener('blur', () => {
    if (wholeAmount(input.id) === undefined) { input.value = '1'; after(); }
  });
}

const denominations = (): number[] => rt.scopes.map((s) => Number(s.denomination) / 1e6);
const countByValue = (list: readonly NoteSummary[]): Map<number, number> => {
  const counts = new Map<number, number>();
  for (const n of list) counts.set(usdcOf(n), (counts.get(usdcOf(n)) ?? 0) + 1);
  return counts;
};
/** 100 → 1, 1 → 3 reads "1×100 + 3×1". */
const describe = (counts: ReadonlyMap<number, number>): string =>
  [...counts].sort((a, b) => b[0] - a[0]).map(([usdc, n]) => `${n}×${usdc}`).join(' + ');
/**
 * The note sizes a deposit makes: those whose pool already holds a ring, so
 * every note can be sent at once. A newer pool joins as soon as it fills (from
 * anyone's deposits); until then a note there would only wait. 1 USDC is
 * always offered, so a deposit always works.
 */
const readySizes = (): number[] => rt.scopes
  .filter((s) => Number(s.denomination) === 1_000_000 || (poolSizes.get(s.pool) ?? 0) >= RING_SIZE)
  .map((s) => Number(s.denomination) / 1e6);
/** Unknown size counts as filled: a read that failed is no reason to alarm. */
const ringReady = (n: NoteSummary): boolean => (poolSizes.get(n.scope.pool) ?? RING_SIZE) >= RING_SIZE;

/** A sentence on the pools, among these values, with under a ring of deposits counting `adding` more. */
function fillNote(values: Iterable<number>, adding: ReadonlyMap<number, number> = new Map()): string {
  const wanted = new Set(values);
  const short = rt.scopes.flatMap((s) => {
    const usdc = Number(s.denomination) / 1e6;
    const size = (poolSizes.get(s.pool) ?? RING_SIZE) + (adding.get(usdc) ?? 0);
    return wanted.has(usdc) && size < RING_SIZE ? [`the ${usdc}-USDC pool has ${size}`] : [];
  });
  if (short.length === 0) return '';
  const text = `${short.join(' and ')} of the ${RING_SIZE} deposits a ring needs, counting yours: notes there can be sent once others deposit.`;
  return ` ${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/** Deposits in each pool, through the mesh. One that fails keeps its last reading. */
async function refreshPools(): Promise<void> {
  await Promise.all(rt.scopes.map(async (s) => {
    try { poolSizes.set(s.pool, (await rt.readRing(s)).candidates.length); } catch { /* retried next time */ }
  }));
  renderBalance();
  renderDepositSplit();
}

async function refreshNotes(): Promise<void> {
  notes = (await Promise.all(rt.scopes.map((s) => rt.app.listNotes(s)))).flat();
  renderBalance();
}

function renderBalance(): void {
  const available = notes.filter((n) => n.state === 'AVAILABLE');
  const total = available.reduce((sum, n) => sum + usdcOf(n), 0);
  const waiting = available.filter((n) => !ringReady(n)).reduce((sum, n) => sum + usdcOf(n), 0);
  const count = `${available.length} note${available.length === 1 ? '' : 's'}`;
  const parts = [count, ...(waiting > 0 ? [`${waiting} USDC waits for its pool to fill`] : [])];
  // What is actually depositable, which is the balance less the gas a deposit
  // keeps back. Printing the raw balance sends people to deposit a round
  // number the account cannot afford, and that failure reads as a bug.
  const depositable = Math.floor(accountUsdc - DEPOSIT_GAS_USDC);
  if (depositable >= 1) parts.push(`${depositable} USDC at your address, ready to deposit`);
  // Notes are whole USDC: what a deposit leaves at the address is not lost, it pays gas and joins the next one.
  else if (accountUsdc >= 0.01) parts.push(`${accountUsdc.toFixed(2)} USDC at your address pays for gas and joins your next deposit`);
  el('balance').textContent = `${total}.00`;
  if (account !== null && runtimeReady) saveArcState({ balances: { ...arcState().balances, [idOf(account)]: total } });
  el('note-count').textContent = parts.join(' · ');
  el('asset-balance').textContent = `${total}.00`;
  el('asset-notes').textContent = `${available.length} private note${available.length === 1 ? '' : 's'}`;
  el<HTMLButtonElement>('arm').disabled = available.length === 0;
}

function renderDepositSplit(): void {
  if (rt === undefined) return; // typed before the wallet started: rendered once it has
  const amount = depositAmount();
  if (amount === undefined) { el('deposit-split').textContent = 'Whole USDC only, 1 or more.'; return; }
  const counts = makeAmount(amount, readySizes())!;
  const notes = [...counts.values()].reduce((a, b) => a + b, 0);
  // Sizes the ideal split would use but whose pools are still filling.
  const filling = [...makeAmount(amount, denominations())!.keys()].filter((d) => !counts.has(d)).sort((a, b) => a - b);
  const later = filling.length === 0 ? '' : ` ${filling.join('-, ')}-USDC notes join once their pools hold ${RING_SIZE} deposits.`;
  // Say it here, while the amount is being typed, rather than letting the
  // deposit fail on a cap the field gives no hint of.
  if (notes > MAX_NOTES_PER_DEPOSIT) {
    el('deposit-split').textContent = `That is ${notes} notes (${describe(counts)}); one deposit holds up to ${MAX_NOTES_PER_DEPOSIT}.${later}`;
    return;
  }
  el('deposit-split').textContent = `As ${describe(counts)} USDC notes, each sendable at once.${later}`;
}

/**
 * Testnet only: USDC that reaches the address becomes notes by itself, as a
 * payment to an XRPL address does. Mainnet waits for the audit, and a tap.
 */
const AUTO_KEY = scoped('opaque:auto-deposit');
/** On by default; switched off on Home, to keep USDC at the address for a swap. */
const autoOn = (): boolean => {
  if (NETWORK !== 'testnet') return false;
  try { return localStorage.getItem(AUTO_KEY) !== 'off'; } catch { return true; }
};
let depositing = false;
/** A deposit that failed by itself is not tried again until a reload: each try signs with the few-time key. */
let autoFailed = false;
/**
 * Not before this: just after a deposit, a lagging RPC node can still show the
 * USDC it spent, and a deposit of that would fail.
 */
let quietUntil = 0;

let autoRunning = false;
async function autoDeposit(ready: number): Promise<void> {
  if (autoRunning) return; // two balance reads at once start one deposit
  autoRunning = true;
  try {
    await refreshPools();
    if (depositing) return; // a deposit pressed meanwhile takes it
    // The most of it one deposit holds: 27 notes.
    let amount = ready;
    while (amount > 1 && [...makeAmount(amount, readySizes())!.values()].reduce((a, b) => a + b, 0) > MAX_NOTES_PER_DEPOSIT) amount--;
    el<HTMLInputElement>('deposit-count').value = String(amount);
    renderDepositSplit();
    if (!(await onDeposit(true))) autoFailed = true;
  } finally { autoRunning = false; }
}

/** Deposits what the field says; `auto`, for USDC that just arrived, without the progress sheet. True if it landed. */
async function onDeposit(auto = false): Promise<boolean> {
  if (depositing) return false;
  const button = el<HTMLButtonElement>('deposit');
  const status = el('deposit-status');
  const amount = depositAmount();
  if (amount === undefined) {
    status.textContent = 'Choose a whole amount of USDC, 1 or more.';
    return false;
  }
  // Open before any network work. Reading which pools can hide a note is
  // eight queries across the mesh, and doing that first left the button dead
  // for seconds with nothing on screen to say the click had registered.
  depositing = true;
  button.disabled = true;
  const progressDialog = el<HTMLDialogElement>('deposit-progress-dialog');
  const progressLog = auto ? status : el('deposit-progress-log');
  if (!auto && !progressDialog.open) progressDialog.showModal();
  status.textContent = '';
  progressLog.textContent = auto ? `USDC arrived at your address: depositing ${amount} USDC as private notes…` : 'Checking which pools can hide your notes…';

  // The fewest notes, largest first, from pools that can hide them now.
  await refreshPools();
  const counts = makeAmount(amount, readySizes())!;
  const count = [...counts.values()].reduce((a, b) => a + b, 0);
  if (count > MAX_NOTES_PER_DEPOSIT) {
    progressDialog.close();
    button.disabled = false;
    depositing = false;
    status.textContent = `That is ${count} notes (${describe(counts)}); one deposit holds up to ${MAX_NOTES_PER_DEPOSIT}. Deposit it in two parts.`;
    return false;
  }
  const notes = count === 1 ? 'one note' : `${count} notes`;
  if (!auto) progressLog.textContent = 'Preparing your deposit…';
  try {
    // Deposits come from the account: ONE transaction however many notes,
    // signed by its PQ key, where a plain wallet would need a confirmation
    // per note. The first one also deploys the account, paid from the USDC at
    // its address. Opaque is a wallet of its own and never asks another one:
    // USDC is sent to the address from anywhere.
    const state = await rt.app.walletState();
    const account = state.accountAddress as `0x${string}`;
    const want = amount + DEPOSIT_GAS_USDC;
    const have = (await rt.accountFunds(account)).usdc;
    const topUp = Math.ceil((want - have) * 100) / 100;
    if (topUp > 0) {
      // A deposit keeps DEPOSIT_GAS_USDC back for its own gas, so a round
      // balance never covers the round number people type. Offer the amount
      // that does fit before sending anyone off to fetch more USDC: the
      // dialog below covers this message, and a covered message is how
      // "I pressed Deposit and nothing happened" begins.
      const affordable = Math.floor(have - DEPOSIT_GAS_USDC);
      if (affordable >= 1) {
        progressDialog.close();
        status.textContent = `Your address holds ${have.toFixed(2)} USDC, which covers ${affordable} USDC of notes plus gas. Deposit ${affordable}, or send ${topUp.toFixed(2)} USDC more to deposit ${amount}.`;
        return false;
      }
      status.textContent = `Send ${topUp.toFixed(2)} USDC to your Opaque address (${notes} and gas) from any wallet, then press Deposit again.`;
      // Close first: the receive dialog is the thing to act on, and two open
      // modals leave it behind the progress one.
      progressDialog.close();
      if (!auto) el<HTMLDialogElement>('receive-dialog').showModal();
      return false;
    }
    // Notes drawn from the phrase: first catch up with any another device made, so no index is used twice.
    if (rt.account !== 'browser') await rt.recover(false);
    if (!auto) progressLog.textContent = state.active
      ? `Signing one deposit of ${notes} with your account's PQ key; a public bundler submits it…`
      : `Signing your account's first operation with its PQ key: it sets the account up on chain and deposits ${notes}…`;
    const made = await rt.app.depositNotes(rt.scopes
      .filter((s) => counts.has(Number(s.denomination) / 1e6))
      .map((s) => ({ scope: s, count: counts.get(Number(s.denomination) / 1e6)! })));
    const waiting = made.filter((n) => n.state !== 'AVAILABLE').length;
    await refreshPools();
    if (!auto) progressLog.textContent = 'Deposit submitted on chain.';
    progressDialog.close();
    status.textContent = waiting === 0
      ? `Deposited ${amount} USDC as ${describe(counts)}, on chain.${fillNote(counts.keys()) || ' Spendable now.'}`
      : `Deposit sent; ${waiting} of ${notes} still wait for the chain to confirm them.`;
    depositing = false;
    quietUntil = Date.now() + 30_000;
    await Promise.all([refreshNotes(), renderBudget().catch(() => undefined)]);
    return true;
  } catch (error) {
    if (progressDialog.open) progressDialog.close();
    status.textContent = isRejected(error) ? '' : `Deposit failed: ${(error as Error).message}${auto ? ' Press Deposit to try again.' : ''}`;
    // A deposit stopped halfway (a later popup rejected) still funded the
    // notes before it; listing finds them, so the balance shows what landed.
    await refreshNotes().catch(() => undefined);
    return false;
  } finally {
    depositing = false;
    quietUntil = Date.now() + 30_000;
    button.disabled = false;
  }
}

// ── swap: tokens at the address, through LI.FI ────────────────────────────
//
// Public, like a deposit: the account swaps what its address holds, in one
// operation its PQ key signs. The route is asked through the mesh (the exit
// asks LI.FI, so LI.FI never sees this browser) and checked in the runtime
// before anything is signed.

const SWAP_TOKENS = deployment.swap.tokens;
const tokenOf = (symbol: string): SwapToken => SWAP_TOKENS.find((t) => t.symbol === symbol)!;
const isUsdc = (t: SwapToken) => t.address.toLowerCase() === deployment.tokens.usdc.address.toLowerCase();
/** Each swap token at the address, in its smallest units. */
let tokenHeld: Record<string, bigint> = {};
let swapQuoted: { readonly key: string; readonly quote: SwapQuote } | undefined;
/**
 * Previews are quoted for this placeholder, not the account: LI.FI then learns
 * the account and the amount only when Swap is pressed, when they go on chain
 * anyway, and never for amounts someone only looked at.
 */
const PREVIEW_ACCOUNT = '0x000000000000000000000000000000000000dead' as const;
let swapTimer: ReturnType<typeof setTimeout> | undefined;
let swapping = false;
const progress = swapProgress();
/** ponytail: from testnet runs, the route, a signature and a bundler's receipt take ~20 s together. */
const SWAP_SECONDS = 20;

/** "1.5" in a token of `decimals` places, or undefined when it is not an amount. */
function toUnits(text: string, decimals: number): bigint | undefined {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (m === null || (m[1] === '' && (m[2] ?? '') === '') || (m[2] ?? '').length > decimals) return undefined;
  return BigInt(m[1] || '0') * 10n ** BigInt(decimals) + BigInt(((m[2] ?? '') + '0'.repeat(decimals)).slice(0, decimals) || '0');
}
const swapFrom = () => tokenOf(el<HTMLSelectElement>('swap-from').value);
const swapTo = () => tokenOf(el<HTMLSelectElement>('swap-to').value);
const swapAmount = (): bigint | undefined => { const u = toUnits(el<HTMLInputElement>('swap-amount').value, swapFrom().decimals); return u !== undefined && u > 0n ? u : undefined; };
const swapKey = () => `${swapFrom().symbol}>${swapTo().symbol}:${swapAmount() ?? ''}`;
/** What a swap can take: all of it, less the gas a USDC swap keeps back. */
const spendable = (t: SwapToken): bigint => {
  const held = tokenHeld[t.symbol] ?? 0n;
  const gas = isUsdc(t) ? BigInt(Math.round(DEPOSIT_GAS_USDC * 1e6)) : 0n;
  return held > gas ? held - gas : 0n;
};

async function refreshTokens(): Promise<void> {
  if (!runtimeReady || !opaqueAddress) return;
  tokenHeld = await rt.tokenBalances(opaqueAddress as `0x${string}`);
  renderSwapSides();
  renderTokenAssets();
}

function renderSwapSides(): void {
  const [from, to] = [swapFrom(), swapTo()];
  tokenBadge('swap-from-tok', from.symbol);
  tokenBadge('swap-to-tok', to.symbol);
  el('swap-have').textContent = `${fromUnits(tokenHeld[from.symbol] ?? 0n, from.decimals)} ${from.symbol}`;
  el('swap-have-to').textContent = `${fromUnits(tokenHeld[to.symbol] ?? 0n, to.decimals)} ${to.symbol}`;
}

/** Tokens other than USDC at the address, under Your funds: public until swapped to USDC and deposited. */
function renderTokenAssets(): void {
  el('assets').querySelectorAll('.at-address').forEach((n) => n.remove());
  for (const t of SWAP_TOKENS) {
    const held = tokenHeld[t.symbol] ?? 0n;
    if (isUsdc(t) || held === 0n) continue;
    const row = document.createElement('div');
    row.className = 'asset at-address';
    row.innerHTML = `<i class="tok tok-${t.symbol.toLowerCase()}"></i><span><b></b><small>At your address, public</small></span><span class="asset-value"><b></b><button class="link" type="button">Swap to USDC</button></span>`;
    row.querySelector('i')!.textContent = t.symbol[0]!;
    row.querySelector('span > b')!.textContent = t.symbol;
    row.querySelector('.asset-value b')!.textContent = `${fromUnits(held, t.decimals)} ${t.symbol}`;
    row.querySelector('button')!.addEventListener('click', () => {
      el<HTMLSelectElement>('swap-from').value = t.symbol;
      el<HTMLSelectElement>('swap-to').value = SWAP_TOKENS.find(isUsdc)!.symbol;
      el<HTMLInputElement>('swap-amount').value = fromUnits(held, t.decimals, t.decimals).replace(/,/g, '');
      showView('swap');
      scheduleQuote();
    });
    el('assets').append(row);
  }
}

function scheduleQuote(): void {
  swapQuoted = undefined;
  clearTimeout(swapTimer);
  el('swap-quote').hidden = true;
  el('swap-out').textContent = '0';
  const go = el<HTMLButtonElement>('swap-go');
  go.disabled = true;
  if (swapAmount() === undefined) { go.textContent = 'Enter an amount'; setStatus('swap-status', ''); return; }
  go.textContent = 'Finding the best route…';
  swapTimer = setTimeout(() => void quoteSwap(), 500);
}

async function quoteSwap(): Promise<void> {
  const [from, to, amount, key] = [swapFrom(), swapTo(), swapAmount(), swapKey()];
  const go = el<HTMLButtonElement>('swap-go');
  if (amount === undefined || !runtimeReady) return;
  try {
    const quote = await rt.swapQuote(PREVIEW_ACCOUNT, from, to, amount);
    if (key !== swapKey()) return; // typed on meanwhile
    swapQuoted = { key, quote };
    const out = fromUnits(BigInt(quote.toAmount), to.decimals);
    const rate = (Number(quote.toAmount) / 10 ** to.decimals) / (Number(amount) / 10 ** from.decimals);
    el('swap-out').textContent = out;
    el('swap-rate').textContent = `1 ${from.symbol} ≈ ${rate.toPrecision(6).replace(/\.?0+$/, '')} ${to.symbol}`;
    el('swap-min').textContent = `${fromUnits(BigInt(quote.toAmountMin), to.decimals)} ${to.symbol}`;
    el('swap-route').textContent = `${quote.tool}, found by LI.FI`;
    el('swap-fee').textContent = quote.feeUsd > 0 ? `$${quote.feeUsd.toFixed(quote.feeUsd < 0.01 ? 4 : 2)}` : 'None';
    el('swap-quote').hidden = false;
    const short = amount > spendable(from);
    go.disabled = short || swapping;
    go.textContent = short ? `Not enough ${from.symbol} at your address` : `Swap ${fromUnits(amount, from.decimals)} ${from.symbol} for ${out} ${to.symbol}`;
    setStatus('swap-status', short && isUsdc(from) && autoOn() ? 'USDC at your address becomes private notes by itself: switch that off on Home to keep it here for a swap.'
      : short && isUsdc(from) ? `A swap from USDC keeps ${DEPOSIT_GAS_USDC} USDC at your address for gas.` : '');
  } catch (error) {
    if (key !== swapKey()) return;
    go.textContent = 'No route right now';
    setStatus('swap-status', (error as Error).message);
  }
}

async function onSwap(): Promise<void> {
  const [from, to, amount] = [swapFrom(), swapTo(), swapAmount()];
  if (amount === undefined || swapping) return;
  if (swapQuoted === undefined || swapQuoted.key !== swapKey() || el<HTMLButtonElement>('swap-go').disabled) return;
  const go = el<HTMLButtonElement>('swap-go');
  swapping = true;
  go.disabled = true;
  go.textContent = 'Swapping…';
  setStatus('swap-status', '');
  progress.start(SWAP_SECONDS, 'Getting the route for your account…');
  const before = tokenHeld[to.symbol] ?? 0n;
  try {
    // The route the account signs is asked now, for the account itself: the preview's was for a placeholder.
    const quote = await rt.swapQuote(opaqueAddress as `0x${string}`, from, to, amount);
    // Signed only if it is the swap that was shown: the price moved, or the floor dropped, and it is shown again first.
    if (!swapHoldsPreview(swapQuoted.quote, quote)) {
      progress.fail(`The price changed: this swap now gets at least ${fromUnits(BigInt(quote.toAmountMin), to.decimals)} ${to.symbol}, not ${fromUnits(BigInt(swapQuoted.quote.toAmountMin), to.decimals)}. Nothing was signed; check the new quote and swap again.`);
      return;
    }
    progress.update(SWAP_SECONDS - 4, `Signing with your account's post-quantum key, for at least ${fromUnits(BigInt(quote.toAmountMin), to.decimals)} ${to.symbol}; a public bundler puts it on chain…`);
    const tx = await rt.swap(opaqueAddress as `0x${string}`, from, to, amount, quote);
    progress.update(4, 'On chain. Reading your new balance…');
    await settle(async () => { await refreshTokens(); return (tokenHeld[to.symbol] ?? 0n) > before; });
    const got = (tokenHeld[to.symbol] ?? 0n) - before;
    progress.finish(`Swapped ${fromUnits(amount, from.decimals)} ${from.symbol} for ${fromUnits(got > 0n ? got : BigInt(quote.toAmount), to.decimals)} ${to.symbol} in ${shortAddress(tx)}.${isUsdc(to) && autoOn() ? ' It becomes private notes by itself.' : ''}`);
    el<HTMLInputElement>('swap-amount').value = '';
    void renderBudget().catch(() => undefined);
  } catch (error) {
    progress.fail(`Swap failed: ${(error as Error).message}`);
  } finally {
    swapping = false;
    go.textContent = 'Enter an amount';
    if (swapAmount() !== undefined) scheduleQuote();
  }
}

function setupSwap(): void {
  for (const id of ['swap-from', 'swap-to']) el(id).replaceChildren(...SWAP_TOKENS.map((t) => new Option(t.symbol, t.symbol)));
  el<HTMLSelectElement>('swap-from').value = SWAP_TOKENS.find(isUsdc)!.symbol;
  el<HTMLSelectElement>('swap-to').value = SWAP_TOKENS.find((t) => !isUsdc(t))!.symbol;
  // The other side never names the same token.
  const keepApart = (changed: 'swap-from' | 'swap-to') => {
    const other = changed === 'swap-from' ? 'swap-to' : 'swap-from';
    if (el<HTMLSelectElement>(changed).value === el<HTMLSelectElement>(other).value) {
      el<HTMLSelectElement>(other).value = SWAP_TOKENS.find((t) => t.symbol !== el<HTMLSelectElement>(changed).value)!.symbol;
    }
    renderSwapSides();
    scheduleQuote();
  };
  el('swap-from').addEventListener('change', () => keepApart('swap-from'));
  el('swap-to').addEventListener('change', () => keepApart('swap-to'));
  el('swap-amount').addEventListener('input', () => {
    const input = el<HTMLInputElement>('swap-amount');
    const cleaned = input.value.replace(/,/g, '.').replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
    if (cleaned !== input.value) input.value = cleaned;
    scheduleQuote();
  });
  el('swap-max').addEventListener('click', () => {
    const from = swapFrom();
    el<HTMLInputElement>('swap-amount').value = fromUnits(spendable(from), from.decimals, from.decimals).replace(/,/g, '');
    scheduleQuote();
  });
  el('swap-flip').addEventListener('click', () => {
    const [from, to] = [el<HTMLSelectElement>('swap-from').value, el<HTMLSelectElement>('swap-to').value];
    el<HTMLSelectElement>('swap-from').value = to;
    el<HTMLSelectElement>('swap-to').value = from;
    renderSwapSides();
    scheduleQuote();
  });
  el('swap-go').addEventListener('click', () => void onSwap());
}

/**
 * The first time a phrase account opens in this browser: its notes, found on
 * chain, and for an imported phrase's Account 1, the phrase's other accounts.
 */
async function firstLook(keys: AccountKeys): Promise<void> {
  const progress = (line: string) => setStatus('home-status', line);
  try {
    const found = await rt.recover(true, progress);
    let more = 0;
    const phrase = storedPhrase();
    if (keys.index === 0 && keys.imported === undefined && walletState().imported && phrase !== null) {
      for (let n = 1; n < 20; n++) {
        progress(`Looking for Account ${n + 1} of this phrase on Arc…`);
        if (!await rt.inUse(arcAddressOf(accountKeys(phrase, n)))) break;
        more = n;
      }
      if (more + 1 > walletState().count) saveWalletState({ count: more + 1 });
    }
    await refreshNotes();
    // Said for a phrase brought in, found or not; for one made here, only when there was something.
    const imported = walletState().imported || keys.imported !== undefined;
    progress(found === 0 && more === 0 && !imported ? '' : `Found ${found} ${found === 1 ? 'note' : 'notes'} of ${accountLabel(keys)} on Arc${more > 0 ? `, and ${more} more ${more === 1 ? 'account' : 'accounts'} of this phrase` : ''}.`);
  } catch (error) {
    progress(`Could not look for your notes: ${(error as Error).message}. Rescan from the account menu.`);
  }
}

// ── the ring, through the mesh ────────────────────────────────────────────

function renderRingSvg(): void {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 190 190');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Ring of ${RING_SIZE} identical members`);
  const orbit = document.createElementNS(SVG_NS, 'circle');
  orbit.setAttribute('cx', '95'); orbit.setAttribute('cy', '95'); orbit.setAttribute('r', '68');
  orbit.setAttribute('class', 'ring-orbit');
  svg.append(orbit);
  // Identical radius, identical fill, identical everything. Marking the user's
  // own member would leak it the moment anyone screen-shares, and a UI that
  // knows which member signed is a UI that can be made to say so.
  for (let i = 0; i < RING_SIZE; i++) {
    const angle = (i / RING_SIZE) * Math.PI * 2 - Math.PI / 2;
    const node = document.createElementNS(SVG_NS, 'circle');
    node.setAttribute('cx', (95 + Math.cos(angle) * 68).toFixed(1));
    node.setAttribute('cy', (95 + Math.sin(angle) * 68).toFixed(1));
    node.setAttribute('r', '8');
    node.setAttribute('class', 'ring-node');
    svg.append(node);
  }
  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('x', '95'); label.setAttribute('y', '101'); label.setAttribute('class', 'ring-q');
  label.textContent = 'one signed';
  svg.append(label);
  el('ring-wrap').replaceChildren(svg);
}

function renderHops(): void {
  const row = el('hops');
  row.replaceChildren();
  hops.forEach((hop, i) => {
    if (i > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'hop-arrow';
      arrow.textContent = '→';
      row.append(arrow);
    }
    const cell = document.createElement('span');
    cell.className = 'hop';
    cell.textContent = hop;
    row.append(cell);
  });
}

async function refreshRing(): Promise<void> {
  if (!runtimeReady || rt.scopes.length === 0) {
    el('freshness-now').textContent = '—';
    el('pool-size').textContent = 'Loading…';
    return;
  }
  try {
    // Once a pool holds a ring, its score is the mesh's: the 1-USDC one stands for all.
    const [privacy, path] = await Promise.all([rt.readPrivacy(rt.scopes[rt.scopes.length - 1]!), rt.pathFor(), refreshPools()]);
    // Seven pools do not fit one stat: the total, then the pools holding any.
    const smallFirst = [...rt.scopes].reverse();
    const held = smallFirst.filter((s) => (poolSizes.get(s.pool) ?? 0) > 0);
    const total = held.reduce((sum, s) => sum + poolSizes.get(s.pool)!, 0);
    const empty = smallFirst.length - held.length;
    el('pool-size').innerHTML = '';
    el('pool-size').append(
      `${total.toLocaleString('en-US')} `,
      Object.assign(document.createElement('small'), {
        textContent: [...held.map((s) => `${poolSizes.get(s.pool)!.toLocaleString('en-US')} at ${Number(s.denomination) / 1e6} USDC`), ...(empty > 0 ? [`${empty} empty`] : [])].join(' · '),
      }),
    );
    el('freshness-now').textContent = String(Math.round(Number(privacy.privacyScore) / 100));
    // A sample path, drawn fresh. Each payment draws its own; this one only
    // shows the shape — three distinct relays under three distinct operators.
    hops = path.map((n) => n.id as string);
    renderHops();
  } catch (error) {
    el('freshness-now').textContent = '—';
    el('pool-size').textContent = `unreachable: ${(error as Error).message}`;
  }
}

// ── sending ───────────────────────────────────────────────────────────────

async function onSend(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const status = el('send-status');
  const recipient = el<HTMLInputElement>('recipient').value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(recipient)) {
    el('recipient').focus();
    status.textContent = 'Enter a recipient address (0x followed by 40 hex characters).';
    return;
  }
  // Paid in whole notes, each its own payment, the fewest that make the
  // amount exactly: a note is spent whole, with no change (§6.6).
  const amount = wholeAmount('send-amount');
  const available = notes.filter((n) => n.state === 'AVAILABLE');
  const total = available.reduce((sum, n) => sum + usdcOf(n), 0);
  if (amount === undefined) {
    status.textContent = 'Send a whole amount of USDC, 1 or more.';
    return;
  }
  if (amount > total) {
    status.textContent = total === 0 ? 'No spendable note. Deposit first.' : `You hold ${total} USDC in notes. Deposit more to send ${amount}.`;
    return;
  }
  let deadline: UnixSeconds;
  try {
    deadline = requestedDeadline();
  } catch (error) {
    status.textContent = (error as Error).message;
    el<HTMLInputElement>('privacy-deadline').focus();
    return;
  }

  const button = el<HTMLButtonElement>('arm');
  button.disabled = true;
  const progressDialog = el<HTMLDialogElement>('send-progress-dialog');
  const progressLog = el('send-progress-log');
  if (!progressDialog.open) progressDialog.showModal();
  progressLog.textContent = 'Preparing your private transfer…';
  status.textContent = '';
  let done = 0;
  let count = 0;
  try {
    // Only notes whose pool already holds a ring's worth of deposits.
    progressLog.textContent = 'Checking which of your notes their pools can hide…';
    await refreshPools();
    const ready = available.filter(ringReady);
    const pick = makeAmount(amount, denominations(), countByValue(ready));
    if (pick === undefined) {
      const waiting = available.filter((n) => !ringReady(n));
      status.textContent = `Your notes can't make exactly ${amount} USDC: each is sent whole, with no change.`
        + (ready.length > 0 ? ` Ready to send: ${describe(countByValue(ready))}.` : '')
        + (waiting.length > 0 ? ` Waiting for their pool to fill: ${describe(countByValue(waiting))}.` : '');
      progressDialog.close();
      return;
    }
    const queue = [...pick].flatMap(([usdc, n]) => ready.filter((note) => usdcOf(note) === usdc).slice(0, n));
    count = queue.length;

    // Out of band, BEFORE paying: the authority learns a recipient, never a
    // payment, and cannot tie the credential to the moment it is used.
    progressLog.textContent = 'Getting a policy credential for this recipient…';
    const credentialHandle = await rt.obtainCredential(recipient as `0x${string}`);

    // Each note is its own payment, with its own proof and ~1 MB upload,
    // PAYMENT_LANES at a time.
    const group = `send-${Date.now()}`;
    progressLog.textContent = count === 1
      ? 'Building the ring proof in this browser (a few seconds — the note secret never leaves the page)…'
      : `Building ${count} ring proofs in this browser and sending each across the mesh (the note secrets never leave the page)…`;
    // Immediate: settle on arrival (score 0), with a deadline taken per note
    // so a long queue cannot outlive it. Waiting: the user's score and time.
    const waitForPrivacy = el<HTMLInputElement>('wait-for-privacy').checked;
    const results = await runPaymentLanes(queue, PAYMENT_LANES, async (note) => {
      const ref = await rt.app.submitPayment({
          noteId: note.id,
          recipient: recipient as never,
          minPrivacyScore: (waitForPrivacy ? MIN_FRESHNESS * 100 : 0) as PrivacyScore,
          deadline: waitForPrivacy ? deadline : requestedDeadline(),
          credentialHandle,
          idempotencyKey: `pay-${note.id}-${Date.now()}` as never,
      });
      // Recorded as each one goes, so a failure later still shows these.
      sent.unshift({ handle: ref.statusHandle as string, recipient, at: Date.now(), group, usdc: usdcOf(note) });
      saveSent();
      done++;
      if (count > 1) progressLog.textContent = `Sent ${done} of ${count} across the mesh…`;
    });
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length > 0) {
      const first = failures[0]!.reason as Error;
      throw new Error(`${failures.length} of ${count} note payments failed: ${first.message}`);
    }
    progressLog.textContent = 'Transfer submitted across the mesh.';
    progressDialog.close();
    status.textContent = 'Sent across the mesh. It usually settles within seconds. Check the Activity tab to see when it lands.';
    el<HTMLInputElement>('recipient').value = '';
    await refreshNotes();
    showView('activity');
    renderActivity();
  } catch (error) {
    if (progressDialog.open) progressDialog.close();
    status.textContent = done === 0
      ? `Not sent: ${(error as Error).message}`
      : `Sent ${done} of ${count}; the remaining note payments failed: ${(error as Error).message}`;
    if (done > 0) { await refreshNotes().catch(() => undefined); renderActivity(); }
  } finally {
    button.disabled = notes.every((n) => n.state !== 'AVAILABLE');
  }
}

// ── deployers: plain addresses the account funds privately ───────────────

function renderDeployers(): void {
  const keys = account === null || account === 'browser' ? null : account;
  el('deployer-box').hidden = keys === null;
  if (keys === null) return;
  const count = arcState().deployers?.[keys.id] ?? 0;
  el('deployer-list').replaceChildren(...Array.from({ length: count }, (_, i) => deployerRow(keys, i)));
}

function deployerRow(keys: AccountKeys, i: number): HTMLElement {
  const key = deployerKey(keys, i);
  const address = addressOfKey(key);
  const row = document.createElement('div');
  row.className = 'deployer';
  row.innerHTML = `<div class="detail"><span>Deployer ${i + 1}</span><code></code></div>
    <div class="detail"><span>Balance</span><strong><button class="link" type="button" data-do="balance">Check balance</button></strong></div>
    <code class="key-text" hidden></code>
    <div class="dialog-actions"><button class="secondary" type="button" data-do="fund">Fund privately</button><button class="secondary" type="button" data-do="address">Copy address</button><button class="secondary" type="button" data-do="show">Show key</button><button class="secondary" type="button" data-do="key" hidden>Copy key</button></div>`;
  const shown = row.querySelector('code')!;
  const balance = row.querySelector('strong')!;
  const keyText = row.querySelector<HTMLElement>('.key-text')!;
  const button = (name: string) => row.querySelector<HTMLButtonElement>(`[data-do="${name}"]`)!;
  shown.textContent = shortAddress(address);
  shown.title = address;
  // Read only when asked: read with every look at Accounts, beside the account's own reads, its
  // queries could let an exit tie the deployers to the account by their timing.
  button('balance').addEventListener('click', () => {
    if (!runtimeReady) return;
    balance.textContent = '…';
    rt.accountFunds(address).then((f) => { balance.textContent = `${f.usdc} USDC`; }, () => { balance.textContent = 'Could not read'; });
  });
  // Funding is an ordinary private send: the Send screen, its address filled in.
  button('fund').addEventListener('click', () => {
    el<HTMLDialogElement>('account-dialog').close();
    showView('send');
    el<HTMLInputElement>('recipient').value = address;
    el<HTMLInputElement>('send-amount').focus();
  });
  button('address').addEventListener('click', () => copy(address, 'Address'));
  button('show').addEventListener('click', () => void (async () => {
    const showing = keyText.hidden;
    if (showing && !(await confirmPassword('show this deployer\'s key'))) return;
    keyText.textContent = showing ? `PRIVATE_KEY=${key}` : '';
    keyText.hidden = !showing;
    button('key').hidden = !showing;
    button('show').textContent = showing ? 'Hide key' : 'Show key';
  })());
  button('key').addEventListener('click', () => copy(key, 'Deployer key', true));
  return row;
}

async function newDeployer(): Promise<void> {
  if (account === null || account === 'browser') return;
  const keys = account;
  const button = el<HTMLButtonElement>('deployer-new');
  button.disabled = true;
  setStatus('deployer-status', 'Making a fresh address…');
  try {
    let i = arcState().deployers?.[keys.id] ?? 0;
    // One this account made in another browser holds USDC: skipped, so no two projects share a deployer.
    while (runtimeReady && await rt.inUse(addressOfKey(deployerKey(keys, i)))) i++;
    saveArcState({ deployers: { ...arcState().deployers, [keys.id]: i + 1 } });
    setStatus('deployer-status', '');
    renderDeployers();
  } catch (error) {
    setStatus('deployer-status', `Not made: ${(error as Error).message}`);
  } finally {
    button.disabled = false;
  }
}

// ── contracts: deployed and called by the account's post-quantum key ─────

/** A bundler's refusal, in words: AA21 is an account with nothing to pay gas from. */
const gasWhy = (error: unknown): string => {
  const message = (error as Error).message;
  return /AA21/.test(message) ? 'this account has no USDC to pay gas. Send it 1 or 2 USDC from your notes first.' : message;
};

const contractsOf = () => (account === null ? [] : arcState().contracts?.[idOf(account)] ?? []);

function renderContracts(): void {
  el('contracts-account').textContent = opaqueAddress || 'Starting…';
  el('contracts-gas').textContent = runtimeReady ? `${accountUsdc} USDC` : '—';
  el('contracts-auto').hidden = NETWORK !== 'testnet' || !autoOn();
  if (el<HTMLInputElement>('deploy-salt').value === '') el<HTMLInputElement>('deploy-salt').value = newSalt();
  renderDeployAt();
  const list = contractsOf();
  el('contracts-box').hidden = list.length === 0;
  el('contracts-list').replaceChildren(...list.map((c) => {
    const link = Object.assign(document.createElement('a'), { href: `${ARC_EXPLORER}/address/${c.address}`, target: '_blank', rel: 'noopener' });
    link.append(Object.assign(document.createElement('b'), { textContent: shortAddress(c.address) }), Object.assign(document.createElement('small'), { textContent: localDateTime(c.at) }));
    return link;
  }));
}

/** The deploy's bytecode and salt, checked, or why not. */
function deployInputs(): { readonly salt: `0x${string}`; readonly initcode: `0x${string}` } {
  const initcode = asHexBytes(el<HTMLTextAreaElement>('deploy-code').value, 'bytecode', MAX_INITCODE);
  const salt = asHexBytes(el<HTMLInputElement>('deploy-salt').value, 'salt', 32);
  if (salt.length !== 66) throw new Error('the salt is 32 bytes: 64 hex digits');
  return { salt, initcode };
}

function renderDeployAt(): void {
  try {
    const { salt, initcode } = deployInputs();
    el('deploy-at').textContent = deployOf(salt, initcode).address;
  } catch (error) {
    const why = (error as Error).message;
    el('deploy-at').textContent = why.charAt(0).toUpperCase() + why.slice(1);
  }
}

async function onDeploy(): Promise<void> {
  let inputs: ReturnType<typeof deployInputs>;
  try { inputs = deployInputs(); } catch (error) { setStatus('contracts-status', `Not deployed: ${(error as Error).message}.`); return; }
  if (!runtimeReady || account === null) { setStatus('contracts-status', 'Opaque is still starting.'); return; }
  const { call, address } = deployOf(inputs.salt, inputs.initcode);
  const button = el<HTMLButtonElement>('deploy-go');
  button.disabled = true;
  setStatus('contracts-status', 'Signing with this account\'s post-quantum key, and sending it through the relays…');
  try {
    const tx = await rt.execute(opaqueAddress as `0x${string}`, [call]);
    saveArcState({ contracts: { ...arcState().contracts, [idOf(account)]: [{ address, tx, at: Date.now() }, ...contractsOf()] } });
    setStatus('contracts-status', `Deployed at ${address}, in ${tx}.`);
    el<HTMLInputElement>('deploy-salt').value = newSalt();
    el<HTMLInputElement>('call-to').value = address;
    void renderBudget().catch(() => undefined);
    renderContracts();
  } catch (error) {
    setStatus('contracts-status', `Not deployed: ${gasWhy(error)}`);
  } finally {
    button.disabled = false;
  }
}

async function onCall(): Promise<void> {
  const to = el<HTMLInputElement>('call-to').value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) { setStatus('contracts-status', 'Enter the contract\'s address: 0x and 40 hex digits.'); return; }
  let data: `0x${string}`;
  try { data = asHexBytes(el<HTMLTextAreaElement>('call-data').value, 'calldata', MAX_INITCODE); } catch (error) { setStatus('contracts-status', `Not sent: ${(error as Error).message}.`); return; }
  if (data.length < 10) { setStatus('contracts-status', 'Calldata starts with a 4-byte function selector: cast calldata makes it.'); return; }
  if (!runtimeReady) { setStatus('contracts-status', 'Opaque is still starting.'); return; }
  // A call that hands this account's tokens to someone is said in words, and asked about, before the key signs it.
  const names = Object.fromEntries([...deployment.swap.tokens.map((t) => [t.address.toLowerCase(), t.symbol]), [deployment.tokens.usdc.address.toLowerCase(), 'USDC']]);
  const risk = riskOfCall(to, data, names);
  if (risk !== null && !confirm(`${risk}\n\nSign it with this account's key?`)) { setStatus('contracts-status', 'Not sent.'); return; }
  const button = el<HTMLButtonElement>('call-go');
  button.disabled = true;
  setStatus('contracts-status', 'Signing with this account\'s post-quantum key, and sending it through the relays…');
  try {
    const tx = await rt.execute(opaqueAddress as `0x${string}`, [{ to: to as `0x${string}`, data }]);
    setStatus('contracts-status', `Sent, in ${tx}.`);
    void renderBudget().catch(() => undefined);
  } catch (error) {
    setStatus('contracts-status', `Not sent: ${gasWhy(error)}`);
  } finally {
    button.disabled = false;
  }
}

// ── activity, through the mesh ────────────────────────────────────────────

function renderActivity(): void {
  const list = el('intent-list');
  if (sent.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nothing sent yet.';
    list.replaceChildren(empty);
    return;
  }
  // One row per send, however many notes it took; payments from before
  // sends were grouped stand alone. `sent` is newest first, and a send's
  // payments are adjacent in it.
  const sends = new Map<string, SentPayment[]>();
  for (const p of sent) {
    const key = p.group ?? p.handle;
    sends.set(key, [...(sends.get(key) ?? []), p]);
  }
  list.replaceChildren(...[...sends.values()].map((payments) => {
    const row = document.createElement('div');
    row.className = 'intent';
    const head = document.createElement('div');
    head.className = 'intent-head';
    const amount = document.createElement('span');
    amount.className = 'intent-amt';
    amount.textContent = `${payments.reduce((sum, p) => sum + (p.usdc ?? 1), 0)}.00 USDC`;
    const badge = document.createElement('span');
    const settled = payments.filter((p) => p.state === 'SETTLED').length;
    const failed = payments.filter((p) => p.state === 'FAILED').length;
    const state = payments.length === 1 ? (payments[0]!.state ?? 'WAITING_FOR_PRIVACY').replaceAll('_', ' ').toLowerCase()
      : settled === payments.length ? 'settled'
      : failed > 0 ? `${failed} of ${payments.length} failed`
      : settled > 0 ? `${settled} of ${payments.length} settled` : 'waiting for privacy';
    badge.className = `intent-state ${state === 'settled' ? 'settled' : 'armed'}`;
    badge.textContent = state;
    head.append(amount, badge);
    const meta = document.createElement('p');
    meta.className = 'intent-meta';
    const short = document.createElement('code');
    const recipient = payments[0]!.recipient;
    short.textContent = `${recipient.slice(0, 6)}…${recipient.slice(-4)}`;
    meta.append('to ', short);
    if (payments.length > 1) meta.append(` · ${payments.length} private payments`);
    // Each note settles in its own transaction.
    const txs = payments.filter((p) => p.txHash !== undefined).reverse();
    txs.forEach((p, i) => {
      const link = document.createElement('a');
      link.href = `${ARC_EXPLORER}/tx/${p.txHash}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = payments.length === 1 ? 'view settlement' : `settlement ${i + 1}`;
      meta.append(i === 0 ? document.createElement('br') : ' · ', link);
    });
    row.append(head, meta);
    return row;
  }));
}

let polling = false;
async function pollActivity(): Promise<void> {
  // A round can outlast the interval when many payments are in flight.
  if (polling) return;
  polling = true;
  let changed = false;
  try {
    for (const p of sent) {
      if (p.state !== undefined && TERMINAL.has(p.state)) continue;
      try {
        const s = await rt.readStatus(p.handle as StatusHandle);
        if (s.state !== p.state || s.txHash !== p.txHash) {
          p.state = s.state;
          if (s.txHash !== undefined) p.txHash = s.txHash;
          changed = true;
        }
      } catch { /* a missed poll is retried next tick; it is not a failure */ }
    }
  } finally { polling = false; }
  if (changed) { saveSent(); renderActivity(); }
}

// ── wiring ────────────────────────────────────────────────────────────────

type View = 'home' | 'send' | 'swap' | 'ring' | 'activity' | 'contracts';
function showView(name: View): void {
  if (name === 'swap') { renderSwapSides(); void refreshTokens().catch(() => undefined); }
  if (name === 'contracts') renderContracts();
  for (const view of ['home', 'send', 'swap', 'ring', 'activity', 'contracts'] as const) {
    el(`view-${view}`).hidden = view !== name;
    el(`tab-${view}`).setAttribute('aria-selected', String(view === name));
  }
  window.scrollTo(0, 0);
}

async function init(): Promise<void> {
  el('tab-home').addEventListener('click', () => showView('home'));
  el('tab-send').addEventListener('click', () => showView('send'));
  el('tab-ring').addEventListener('click', () => { showView('ring'); void refreshRing(); });
  el('tab-activity').addEventListener('click', () => { showView('activity'); void pollActivity(); });
  el('tab-contracts').addEventListener('click', () => showView('contracts'));
  // No pinned factory on this network: no Contracts.
  el('tab-contracts').hidden = CREATE2_FACTORY === null;
  el('deploy-go').addEventListener('click', () => void onDeploy());
  el('call-go').addEventListener('click', () => void onCall());
  for (const id of ['deploy-code', 'deploy-salt']) el(id).addEventListener('input', renderDeployAt);
  el('contracts-auto-off').addEventListener('click', () => {
    el<HTMLInputElement>('auto-deposit').checked = false;
    el('auto-deposit').dispatchEvent(new Event('change'));
    renderContracts();
  });
  el<HTMLFormElement>('send-form').addEventListener('submit', (e) => void onSend(e as SubmitEvent));
  el<HTMLInputElement>('wait-for-privacy').addEventListener('change', syncPrivacyWait);
  syncPrivacyWait();
  el('deposit').addEventListener('click', () => void onDeposit());
  onlyWholeAmounts(el<HTMLInputElement>('deposit-count'), renderDepositSplit);
  onlyWholeAmounts(el<HTMLInputElement>('send-amount'), () => undefined);
  el('action-send').addEventListener('click', () => showView('send'));
  el('tile-deposit').addEventListener('click', () => { el('deposit-card').scrollIntoView({ block: 'center' }); el<HTMLInputElement>('deposit-count').focus(); });
  el('tile-privacy').addEventListener('click', () => el('tab-ring').click());
  el('tile-activity').addEventListener('click', () => el('tab-activity').click());
  el('tile-swap').addEventListener('click', () => showView('swap'));
  el('tab-swap').addEventListener('click', () => showView('swap'));
  setupSwap();
  // The balance card catches the light where the pointer is.
  el('hero').addEventListener('pointermove', (e) => {
    const r = el('hero').getBoundingClientRect();
    el('hero').style.setProperty('--mx', `${e.clientX - r.left}px`);
    el('hero').style.setProperty('--my', `${e.clientY - r.top}px`);
  });
  el('action-receive').addEventListener('click', () => el<HTMLDialogElement>('receive-dialog').showModal());
  el('copy-address').addEventListener('click', () => { if (opaqueAddress) copy(opaqueAddress, 'Address'); });
  el('refresh-balance').addEventListener('click', () => { void refreshNotes(); void renderBudget().catch(() => undefined); });
  el('withdraw').addEventListener('click', () => void onWithdraw());
  el('deployer-new').addEventListener('click', () => void newDeployer());
  for (const id of ['account-button', 'menu-button']) document.getElementById(id)?.addEventListener('click', renderDeployers);
  el('backup-export').addEventListener('click', () => void onBackupExport());
  el('backup-import').addEventListener('click', () => el<HTMLInputElement>('backup-file').click());
  el<HTMLInputElement>('backup-file').addEventListener('change', (event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (file !== undefined) void onBackupImport(file);
    (event.currentTarget as HTMLInputElement).value = '';
  });
  // The account is a wallet itself: the header picks the network, never a
  // browser wallet. Each network is its own page (opaque.credit/ and
  // /testnet/, the same in the extension), with its own storage names.
  networkPicker(el<HTMLButtonElement>('network-switch'), NETWORK);
  // Nothing opens before the Terms of Use and Privacy Policy are accepted.
  await acceptTerms();
  // A wallet with a password opens locked.
  await unlockGate();
  // Real USDC on unaudited contracts: every visit to mainnet starts with this warning.
  if (NETWORK === 'mainnet') el<HTMLDialogElement>('mainnet-warning').showModal();
  document.querySelectorAll<HTMLElement>('[data-back]').forEach((node) => node.addEventListener('click', () => showView('home')));
  renderRingSvg();

  // One recovery phrase holds every chain's accounts (lib/xrpl-keys.ts); an
  // Arc account from before phrases stays here as the browser account.
  browserAccount = await hasBrowserAccount();
  if (!arcState().seen) {
    // The first visit since Arc took phrases: an account this browser already has stays the one that opens.
    if (browserAccount) saveWalletState({ active: 'browser' });
    saveArcState({ seen: true });
  }
  setupWalletScreens({
    views: ['home', 'send', 'swap', 'ring', 'activity', 'contracts'], account: () => account, hasBrowserWallet: () => browserAccount,
    browserNote: 'This browser only, backed up by file', where: 'on Arc',
    addressOf: (key) => arcState().addresses[key.id] ?? null,
    shortAddress,
    // Two key generations each: one at a time, so the page keeps moving.
    fillAddresses: async (keys) => {
      for (const key of keys) { arcAddressOf(key); await new Promise((r) => setTimeout(r)); }
      return true;
    },
    balanceOf: (key) => { const b = arcState().balances[idOf(key)]; return b === undefined ? '' : `${b} USDC`; },
    rescan: async (progress) => { const kept = await rt.recover(true, progress); await refreshNotes(); return kept; },
    backup: backupTransport(),
  });
  account = activeAccount(browserAccount);
  // Nothing to open yet: a new wallet, or one brought from elsewhere.
  if (account === null) { openOnboarding('ob-welcome'); return; }
  el('account-name').textContent = accountLabel(account);
  el('receive-name').textContent = accountLabel(account);
  document.querySelector('.acct .mark')!.innerHTML = markOf(account === 'browser' ? -1 : account.index);
  if (account !== 'browser') {
    el('backup-export').hidden = true;
    el('backup-box').querySelector('p:not(.eyebrow):not(.status)')!.textContent = 'Your recovery phrase backs this account up. A backup file from before phrases brings that browser account back here.';
  }
  if (NETWORK === 'testnet') {
    const sayAuto = () => {
      el('deposit-copy').textContent = autoOn() ? 'USDC sent to your address becomes private notes by itself.' : 'USDC at your address becomes private notes when you deposit it.';
      el('receive-then').textContent = autoOn() ? 'on testnet it becomes private notes by itself' : 'Deposit turns it into private notes';
    };
    el('auto-wrap').hidden = false;
    el<HTMLInputElement>('auto-deposit').checked = autoOn();
    el('auto-deposit').addEventListener('change', () => {
      try { localStorage.setItem(AUTO_KEY, el<HTMLInputElement>('auto-deposit').checked ? 'on' : 'off'); } catch { /* this visit only */ }
      autoFailed = false;
      sayAuto();
      void renderBudget().catch(() => undefined);
    });
    sayAuto();
  }
  loadSent(arcStorageOf(account, keyStoreName()).sent);
  renderActivity();

  try {
    rt = await startWallet(undefined, account);
    // A phrase's account comes back from the chain: its key, however many rotations on.
    await rt.open();
  } catch (error) {
    showBootError(`Could not start: ${(error as Error).message}`);
    return;
  }
  try { await rt.app.walletState(); } catch (error) {
    // This browser's copy of a phrase account's keys is behind the chain: another
    // device with the phrase rotated the key. Built again from the chain, once.
    const REBUILT = 'opaque:arc-keys-rebuilt';
    if (account !== 'browser' && (error as { code?: string }).code === 'SIGNER_STATE_UNSAFE' && sessionStorage.getItem(REBUILT) === null) {
      sessionStorage.setItem(REBUILT, '1');
      rt.forgetKeys();
      location.reload();
      return;
    }
  }
  runtimeReady = true;

  // One failed read must not stop the rest of the page from starting.
  await Promise.all([
    refreshNotes().catch(() => { el('note-count').textContent = 'Could not read notes — Refresh to retry'; }),
    renderBudget().catch(() => undefined),
  ]);
  renderDepositSplit();
  void refreshPools();
  void refreshRing();
  if (account !== 'browser' && !arcState().scanned[account.id]) void firstLook(account);
  void pollActivity();
  setInterval(() => void pollActivity(), 5_000);
  // USDC sent to the address from any wallet shows up without a refresh.
  setInterval(() => void renderBudget().catch(() => undefined), 20_000);
  // Exposed for the end-to-end test and for poking at in devtools.
  (globalThis as { opaque?: WalletRuntime }).opaque = rt;
}

void init();
