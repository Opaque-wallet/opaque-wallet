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
import { withoutOpaque, type WithoutOpaque } from './lib/without-opaque.ts';
import { exitablePools } from '../../backend/chain/ring-exit.ts';
import { keyStoreName } from './lib/backup.ts';
import { asHexBytes, CREATE2_FACTORY, deployment as deployOf, MAX_INITCODE, newSalt, riskOfCall } from './lib/contracts.ts';
import { accountKeys, accountLabel, activeAccount, saveWalletState, storedPhrase, walletState, type AccountKeys } from './lib/wallet-keys.ts';
import { acceptTerms, copy, idOf, markOf, openOnboarding, setupWalletScreens, swapProgress, tokenBadge, type OpenAccount } from './lib/wallet-ui.ts';
import { deployment, NETWORK, requireService, type SwapToken } from '../../deployments/index.ts';
import type { SwapQuote } from '../../backend/chain/wallet-rpc.ts';
import { oneOperationAtATime } from '../../backend/chain/pq-wallet-chain.ts';
import { networkPicker } from './lib/network-picker.ts';
import { ENS, ETHEREUM_COIN, ethCall, dnsEncode, isName, opaqueNameFree, opaqueNameOf, resolveName } from './ethereum/ens-name.ts';
import { commitmentOf, masterKey, REGISTRY_ABI as NAME_REGISTRY_ABI, signExecute } from '../../backend/ethereum/ens.ts';
import { decodeFunctionResult, encodeFunctionData, formatEther, parseAbi, parseEther } from '../../backend/ethereum/frame.ts';
import { stream } from './lib/wallet-keys.ts';
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
const GAS_IN_USDC = deployment.network.nativeCurrency.symbol === 'USDC';
const DEPOSIT_GAS_USDC = GAS_IN_USDC ? 0.2 : 0; // Sepolia pays gas in ETH
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
/** The chain this build runs on, as the copy names it: app.html was written for Arc. */
const CHAIN = NETWORK === 'sepolia' ? 'Sepolia' : 'Arc';
/** Puts the chain's name where app.html says Arc, on another chain's build. */
function nameTheChain(): void {
  if (CHAIN === 'Arc') return;
  const swap = (text: string) => text.replace(/\bAn Arc\b/g, `A ${CHAIN}`).replace(/\ban Arc\b/g, `a ${CHAIN}`).replace(/\bArc\b/g, CHAIN);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) n.nodeValue = swap(n.nodeValue ?? '');
  for (const e of document.querySelectorAll<HTMLInputElement>('[placeholder]')) e.placeholder = swap(e.placeholder);
  document.title = swap(document.title);
}


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
    const { pkCommitment: before, accountAddress } = await rt.app.walletState();
    // In the account's queue: signed beside a deposit or a call, the rotation and
    // the operation would each spend a signature for one use count (F-59).
    await oneOperationAtATime(accountAddress, () => rt.app.rotateWallet());
    await settle(async () => (await rt.app.walletState()).pkCommitment !== before);
    setStatus('rotate-status', 'Rotated. A fresh key is active, with the next one already committed behind it.');
    await renderBudget();
  } catch (error) {
    setStatus('rotate-status', `Could not rotate this key: ${(error as Error).message}. Reload to try once more, or back up and restore into a new wallet.`);
  } finally { rotating = false; }
}

async function onWithdraw(): Promise<void> {
  const to = el<HTMLInputElement>('withdraw-to').value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(to)) { setStatus('wallet-status', `Enter a ${CHAIN} address to withdraw to.`); return; }
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
    if (input.dataset['decimal'] === '1') return; // an ETH amount (setSendAsset): parseEther checks it
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
    if (input.dataset['decimal'] === '1') return; // an ETH amount: 0.001 is not "empty"
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
  else if (accountUsdc >= 0.01) parts.push(`${accountUsdc.toFixed(2)} USDC at your address ${GAS_IN_USDC ? 'pays for gas and ' : ''}joins your next deposit`);
  el('balance').textContent = `${total}.00`;
  if (account !== null && runtimeReady) saveArcState({ balances: { ...arcState().balances, [idOf(account)]: total } });
  el('note-count').textContent = parts.join(' · ');
  el('asset-balance').textContent = `${total}.00`;
  el('asset-notes').textContent = `${available.length} private note${available.length === 1 ? '' : 's'}`;
  el<HTMLButtonElement>('arm').disabled = !sendEth && available.length === 0;
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
  // Test networks only: real USDC is deposited when its owner says so.
  if (NETWORK === 'mainnet') return false;
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
/** A network LI.FI does not serve (Sepolia: no testnets there) has no swaps, and no Swap tab. */
const SWAPS = SWAP_TOKENS.length > 1;
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
  if (!GAS_IN_USDC) {
    ethHeld = await rt.ethBalance(opaqueAddress as `0x${string}`);
    if (!el('view-contracts').hidden) el('contracts-gas').textContent = `${ethText(ethHeld)} ETH`;
  }
  if (SWAPS) renderSwapSides();
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
  if (ethHeld !== undefined) {
    const row = document.createElement('div');
    row.className = 'asset at-address';
    row.innerHTML = `<i class="tok tok-eth">E</i><span><b>${CHAIN} ETH</b><small>At your address, public · pays gas</small></span><span class="asset-value"><b></b><button class="link" type="button">Send</button></span>`;
    row.querySelector('.asset-value b')!.textContent = `${ethText(ethHeld)} ETH`;
    row.querySelector('button')!.addEventListener('click', () => { setSendAsset(true); showView('send'); });
    el('assets').append(row);
  }
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
        progress(`Looking for Account ${n + 1} of this phrase on ${CHAIN}…`);
        if (!await rt.inUse(arcAddressOf(accountKeys(phrase, n)))) break;
        more = n;
      }
      if (more + 1 > walletState().count) saveWalletState({ count: more + 1 });
    }
    await refreshNotes();
    // Said for a phrase brought in, found or not; for one made here, only when there was something.
    const imported = walletState().imported || keys.imported !== undefined;
    progress(found === 0 && more === 0 && !imported ? '' : `Found ${found} ${found === 1 ? 'note' : 'notes'} of ${accountLabel(keys)} on ${CHAIN}${more > 0 ? `, and ${more} more ${more === 1 ? 'account' : 'accounts'} of this phrase` : ''}.`);
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

// ── opaque.eth, held by a FORS+C key (Sepolia) ───────────────────────────
// PQNameController (contracts/src/ethereum/ens/) owns the name and acts only on
// a signature from its key in PQKeyRegistry. This wallet draws a key of its own
// for names from the phrase; claiming hands the controller to it (the stack's
// key signs two rotations), and from then on this page signs the name's
// changes and the stack only submits them, paying the gas.
const NAME = 'opaque.eth';
const RESOLVER_ABI = parseAbi(['function setAddress(bytes name, uint256 coinType, bytes addressBytes)', 'function setText(bytes name, string key, string value)', 'function multicall(bytes[] calls) returns (bytes[])']);
function setupNameCard(keys: AccountKeys): void {
  const nameKey = (g: number) => masterKey(stream(keys.key, 'opaque/v1/ens/names')(32), 'opaque/v1/ens/wallet', g);
  const stackUrl = new URL(requireService('meshExitUrl')).origin;
  // opaque.eth itself is its owner's to claim, with the code: behind a link, or shown once this wallet holds it.
  el('name-owner').addEventListener('click', () => { el('name-card').hidden = false; el('name-owner').hidden = true; });
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${stackUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) });
    const out = await res.json().catch(() => ({})) as { message?: string; hash?: string; hashes?: string[]; ok?: boolean };
    if (!res.ok) throw new Error(out.message ?? `the stack answered ${res.status}`);
    return out;
  };
  const state = async () => decodeFunctionResult({ abi: NAME_REGISTRY_ABI, functionName: 'stateOf', data: await ethCall(ENS.pqKeyRegistry, encodeFunctionData({ abi: NAME_REGISTRY_ABI, functionName: 'stateOf', args: [ENS.controller] })) });
  /** Which of this wallet's name keys the controller answers to, if any (each costs about a second to draw). */
  let mine: number | undefined;
  async function show(): Promise<void> {
    const s = await state();
    mine = [0, 1, 2].find((g) => commitmentOf(nameKey(g)) === s.pkCommitment.toLowerCase());
    const ours = mine !== undefined;
    if (ours) { el('name-card').hidden = false; el('name-owner').hidden = true; }
    el('name-claim-row').hidden = ours;
    el('name-point').hidden = !ours;
    el('name-copy').textContent = ours
      ? `${NAME} answers to this wallet's post-quantum key (${s.useCount} of ${s.maxUses} signatures used). Only a FORS+C signature from it changes the name.`
      : `${NAME} is held by a FORS+C key on ENSv2. Claim it for this wallet's key with the claim code.`;
    const at = await resolveName(NAME, ETHEREUM_COIN).then((r) => r.address, () => '—');
    el('name-records').textContent = `Resolves to ${at}`;
  }
  el('name-claim').addEventListener('click', () => void (async () => {
    const code = el<HTMLInputElement>('name-code').value.trim();
    if (code === '') { setStatus('name-status', 'Enter the claim code.'); return; }
    setStatus('name-status', 'Drawing this wallet\'s name keys, then asking the name\'s key to hand over…');
    try {
      const out = await post('/v1/ens/claim', { code, pk: commitmentOf(nameKey(0)), next: commitmentOf(nameKey(1)) });
      setStatus('name-status', `Claimed: ${NAME} now answers to this wallet's key (${out.hashes?.length ?? 0} rotations).`);
      // A public RPC a block behind still shows the stack's key for a few seconds.
      for (let tries = 0; tries < 20 && (await show(), mine === undefined); tries++) await new Promise((r) => setTimeout(r, 3_000));
    } catch (error) { setStatus('name-status', `Not claimed: ${(error as Error).message}`); }
  })());
  el('name-point').addEventListener('click', () => void (async () => {
    if (mine === undefined || opaqueAddress === '') return;
    setStatus('name-status', `Signing ${NAME}'s records with this wallet's post-quantum key…`);
    try {
      const s = await state();
      const name = dnsEncode(NAME);
      const data = encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'multicall', args: [[
        encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setAddress', args: [name, ETHEREUM_COIN, opaqueAddress as `0x${string}`] }),
        encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setText', args: [name, 'pq-key', commitmentOf(nameKey(mine))] }),
      ]] });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const signature = signExecute(nameKey(mine), BigInt(deployment.network.chainId), ENS.controller, s.useCount, ENS.resolver, data, deadline);
      const out = await post('/v1/ens/execute', { target: ENS.resolver, data, deadline, signature });
      if (out.ok !== true) throw new Error(`the call reverted: ${out.hash}`);
      setStatus('name-status', `${NAME} now resolves to this wallet: ${out.hash}`);
      await show();
      // A public RPC a block behind still reads the old record; the call above succeeded, so this is the record.
      el('name-records').textContent = `Resolves to ${opaqueAddress}`;
    } catch (error) { setStatus('name-status', `Not changed: ${(error as Error).message}`); }
  })());
  void show().catch((error: Error) => setStatus('name-status', error.message));
}
// ── name.opaque.eth (Sepolia) ─────────────────────────────────────────────
// Any wallet claims one name under opaque.eth: a call to OpaqueNames its own
// account makes, signed by its FORS+C key, so the name is held by the account
// and resolves to it. OpaqueNames refuses any caller that is not a PQ account.

const NAMES_ABI = parseAbi(['function claim(string label)', 'function release()']);
let refreshSubname = async (): Promise<void> => undefined;

function setupSubname(): void {
  const names = ENS.names;
  if (names === undefined) return;
  el('sub-card').hidden = false;
  let held = '';
  refreshSubname = async () => {
    if (opaqueAddress === '') return;
    held = await opaqueNameOf(opaqueAddress as `0x${string}`).catch(() => held);
    el('sub-claim-row').hidden = held !== '';
    el('sub-held').hidden = held === '';
    el('sub-name').textContent = held === '' ? '' : `${held}.opaque.eth`;
    el('sub-copy').textContent = held === ''
      ? 'A name under opaque.eth for this wallet: anyone can pay it by name, and only this wallet\'s post-quantum key holds it.'
      : `This wallet's name. Anyone can pay ${held}.opaque.eth: it resolves to this wallet's address, and only its post-quantum key holds the name.`;
  };
  /** One call from the account, signed by its key; then the read waits out a public RPC a block behind. */
  const run = async (data: `0x${string}`, doing: string, done: (tx: string) => string, changed: () => boolean, also: readonly { to: `0x${string}`; data: `0x${string}` }[] = []) => {
    if (!runtimeReady || opaqueAddress === '') { setStatus('sub-status', 'Opaque is still starting.'); return; }
    setStatus('sub-status', doing);
    try {
      const tx = await rt.execute(opaqueAddress as `0x${string}`, [{ to: names, data }, ...also]);
      if (also.length > 0) void refreshStealth();
      for (let tries = 0; tries < 20 && (await refreshSubname(), !changed()); tries++) await new Promise((r) => setTimeout(r, 3_000));
      setStatus('sub-status', done(tx));
      void refreshTokens().catch(() => undefined);
      void renderBudget().catch(() => undefined);
    } catch (error) { setStatus('sub-status', `Not done: ${gasWhy(error)}`); }
  };
  el('sub-claim').addEventListener('click', () => void (async () => {
    const label = el<HTMLInputElement>('sub-label').value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(label)) { setStatus('sub-status', 'Use 3 to 32 of a to z, 0 to 9 and hyphens, not at either end.'); return; }
    if (!await opaqueNameFree(label).catch(() => true)) { setStatus('sub-status', `${label}.opaque.eth is taken. Try another.`); return; }
    // A name is for being paid by: receiving privately is turned on with it, under the same signature.
    const stealth = rt.stealth !== undefined && !(await rt.stealth.isOn(opaqueAddress as `0x${string}`).catch(() => true)) ? [rt.stealth.turnOnCall] : [];
    await run(encodeFunctionData({ abi: NAMES_ABI, functionName: 'claim', args: [label] }),
      `Claiming ${label}.opaque.eth: this wallet's post-quantum key signs it…`,
      (tx) => `${label}.opaque.eth is yours${stealth.length > 0 ? ', and payments to it land at one-time addresses' : ''}: ${tx}`, () => held === label, stealth);
  })());
  el('sub-release').addEventListener('click', () => void (async () => {
    const was = held;
    if (!confirm(`Release ${was}.opaque.eth? Anyone can claim it after you.`)) return;
    await run(encodeFunctionData({ abi: NAMES_ABI, functionName: 'release' }),
      `Releasing ${was}.opaque.eth…`, () => `${was}.opaque.eth is free again.`, () => held === '');
  })());
}

// ── receive privately (post-quantum stealth payments) ─────────────────────
// lib/stealth.ts. Payments to this wallet land at one-time PQ accounts that only its
// ML-KEM key can find; each is swept into notes once its balance stops changing.

let refreshStealth = async (): Promise<void> => undefined;
function setupStealth(): void {
  const s = rt.stealth;
  if (s === undefined || opaqueAddress === '') return;
  const me = opaqueAddress as `0x${string}`;
  el('stealth-card').hidden = false;
  let on = false;
  let sweeping = false;
  // A payment of several notes lands one settlement at a time: swept once two looks agree.
  const lastHeld = new Map<string, number>();
  const render = () => {
    const rows = s.payments().slice().reverse().map((p) => {
      const row = document.createElement('div');
      row.className = 'stealth-row';
      const held = lastHeld.get(p.stealthAddress) ?? 0;
      row.innerHTML = '<code></code><span></span>';
      row.querySelector('code')!.textContent = shortAddress(p.stealthAddress);
      row.querySelector('code')!.title = p.stealthAddress;
      row.querySelector('span')!.textContent = held >= 1 ? `${held} USDC arrived: moving it into your notes…`
        : p.state === 'swept' ? `${p.usdc ?? ''} USDC, in your notes` : 'Announced; the payment has not landed yet';
      return row;
    });
    el('stealth-list').replaceChildren(...rows);
  };
  refreshStealth = async () => {
    on = await s.isOn(me).catch(() => on);
    el('stealth-on').hidden = on;
    el('stealth-copy').textContent = on
      ? 'On. Every payment to this wallet or its name lands at a one-time address only this wallet can find, then moves into your notes by itself. Nobody reading the chain can tell those payments are yours, even with a quantum computer.'
      : 'Payments to this wallet can land at one-time addresses only it can find: nobody reading the chain, now or with a quantum computer, can tell they are yours. Turning it on publishes one post-quantum key (ML-KEM-768) in the standard stealth-address registry.';
    if (!on) return;
    await s.scan();
    for (const p of s.payments()) {
      const held = await s.held(p).catch(() => 0);
      const settled = held >= 1 && lastHeld.get(p.stealthAddress) === held;
      lastHeld.set(p.stealthAddress, held);
      if (!settled || sweeping) continue;
      sweeping = true;
      render();
      try {
        await refreshPools();
        const counts = makeAmount(held, readySizes())!;
        const parts = rt.scopes.filter((x) => counts.has(Number(x.denomination) / 1e6)).map((x) => ({ scope: x, count: counts.get(Number(x.denomination) / 1e6)! }));
        const tx = await s.sweep(p, (depositMany) => rt.depositFrom(depositMany, parts));
        lastHeld.set(p.stealthAddress, 0);
        setStatus('stealth-status', `${held} USDC paid to a one-time address is now in your notes: ${tx}`);
        await refreshNotes();
      } catch (error) { setStatus('stealth-status', `Could not move a payment into your notes yet: ${gasWhy(error)}`); }
      finally { sweeping = false; }
    }
    render();
  };
  el('stealth-on').addEventListener('click', () => void (async () => {
    setStatus('stealth-status', 'Publishing this wallet\'s post-quantum stealth key: its FORS+C key signs it…');
    try {
      const tx = await rt.execute(me, [s.turnOnCall]);
      for (let tries = 0; tries < 20 && !(await s.isOn(me).catch(() => false)); tries++) await new Promise((r) => setTimeout(r, 3_000));
      setStatus('stealth-status', `On: ${tx}`);
      await refreshStealth();
    } catch (error) { setStatus('stealth-status', `Not turned on: ${gasWhy(error)}`); }
  })());
  const tick = () => void refreshStealth().catch(() => undefined).finally(() => setTimeout(tick, 30_000));
  tick();
}

// ── your way out (exitable pools) ─────────────────────────────────────────
// A note leaves its pool alone: lib/without-opaque.ts, through anon-rpc, signed by the
// account's key, with no server of Opaque's asked anything.

let exitStarted = false;
function offerExit(account: AccountKeys, why?: string): void {
  el('exit-card').hidden = false;
  if (why !== undefined) el('exit-copy').textContent = why;
  if (exitStarted) return;
  exitStarted = true;
  const address = arcAddressOf(account);
  let api: WithoutOpaque | undefined;
  const status = (text: string) => setStatus('exit-status', text);
  const render = async (): Promise<void> => {
    const notes = await api!.notes();
    const now = Math.floor(Date.now() / 1000);
    const rows = notes.filter((n) => n.state !== 'spent').map((n) => {
      const row = document.createElement('div');
      row.className = 'exit-row';
      const left = n.payableAt === undefined ? 0 : n.payableAt - now;
      const what = { held: 'In its pool', waiting: `Exit announced: ready in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`, payable: 'Ready to withdraw', spent: 'Withdrawn' }[n.state];
      row.innerHTML = '<span><b></b><small></small></span>';
      row.querySelector('b')!.textContent = `${n.pool.denomination / 1e6} tUSDC note`;
      row.querySelector('small')!.textContent = what;
      if (n.state === 'held' || n.state === 'payable') {
        const go = Object.assign(document.createElement('button'), { className: n.state === 'held' ? 'secondary' : 'primary', type: 'button', textContent: n.state === 'held' ? 'Start exit' : 'Withdraw to this wallet' });
        go.dataset['note'] = n.id;
        go.addEventListener('click', () => void (async () => {
          go.disabled = true;
          status(n.state === 'held' ? 'Announcing the exit: this wallet\'s key signs it, and it goes to the bundler through anon-rpc…' : 'Withdrawing: the pool checks the note\'s secret on chain and pays this wallet…');
          try {
            const tx = n.state === 'held' ? await api!.announce(n) : await api!.withdraw(n);
            status(n.state === 'held' ? `Exit announced in ${tx}. Withdraw once the pool's delay has passed.` : `Withdrawn in ${tx}: ${n.pool.denomination / 1e6} tUSDC at this wallet's address.`);
          } catch (error) { status(`Not done: ${gasWhy(error)}`); go.disabled = false; }
          await render().catch(() => undefined);
        })());
        row.append(go);
      }
      return row;
    });
    el('exit-notes').replaceChildren(...rows);
    if (rows.length === 0) status(notes.length === 0 ? 'No notes in an exitable pool on this account.' : 'Every note has left its pool.');
  };
  el('exit-find').addEventListener('click', () => void (async () => {
    el<HTMLButtonElement>('exit-find').disabled = true;
    status('Starting anon-rpc (the Nox mixnet) and reading your notes from the chain through it…');
    try {
      api ??= await withoutOpaque(account, address);
      await render();
      if (el('exit-status').textContent?.startsWith('Starting')) status('');
      // Waiting rows count down; payable ones appear by themselves.
      setInterval(() => void render().catch(() => undefined), 15_000);
    } catch (error) {
      status(`Could not read your notes: ${(error as Error).message}`);
      el<HTMLButtonElement>('exit-find').disabled = false;
    }
  })());
}

// ── ETH, where gas is ETH (Sepolia) ─────────────────────────────────────
// Public, at the account's address: it pays gas, and Send can move it as an
// ordinary transfer the account's FORS+C key signs. Only USDC goes privately.

/** The account's ETH, read through the mesh; undefined where gas is USDC. */
let ethHeld: bigint | undefined;
let sendEth = false;
const ethText = (wei: bigint): string => Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 5 });

function setSendAsset(eth: boolean): void {
  sendEth = eth;
  el('send-title').textContent = eth ? 'Send ETH' : 'Send privately';
  const tok = el('send-asset-tok');
  tok.className = `tok tok-${eth ? 'eth' : 'usdc'}`;
  tok.textContent = eth ? 'E' : 'U';
  el('send-asset-name').textContent = eth ? 'ETH' : 'USDC';
  el('send-asset-mode').textContent = `${eth ? 'Public' : 'Private'} on ${CHAIN}`;
  el('send-unit').textContent = eth ? 'ETH' : 'USDC';
  const amount = el<HTMLInputElement>('send-amount');
  amount.dataset['decimal'] = eth ? '1' : '0';
  amount.inputMode = eth ? 'decimal' : 'numeric';
  amount.pattern = eth ? '[0-9]*[.]?[0-9]*' : '[0-9]*';
  amount.maxLength = eth ? 24 : 6;
  amount.value = eth ? '0.001' : '1';
  el('arm').textContent = eth ? 'Send ETH' : 'Send privately';
  el('send-privacy').hidden = eth;
  el('send-how').hidden = eth;
  el('send-public-note').hidden = !eth;
  setStatus('send-status', '');
  renderBalance();
}

/** ETH from the account's address: one operation, its value the amount, signed by the account's PQ key. */
async function sendEthTo(to: `0x${string}`): Promise<void> {
  const status = el('send-status');
  let value = 0n;
  try { value = parseEther(el<HTMLInputElement>('send-amount').value.trim()); } catch { /* checked below */ }
  if (value <= 0n) { status.textContent = 'Enter an amount of ETH, like 0.001.'; return; }
  if (!runtimeReady || opaqueAddress === '') { status.textContent = 'Opaque is still starting.'; return; }
  const have = await rt.ethBalance(opaqueAddress as `0x${string}`).catch(() => undefined);
  if (have !== undefined && value >= have) { status.textContent = `The account holds ${ethText(have)} ETH, and its gas comes from that too: send less.`; return; }
  const button = el<HTMLButtonElement>('arm');
  button.disabled = true;
  status.textContent = 'Signing with this account\'s post-quantum key, and sending it through the relays…';
  try {
    const tx = await rt.execute(opaqueAddress as `0x${string}`, [{ to, data: '0x', value }]);
    status.textContent = '';
    status.append(`Sent ${ethText(value)} ETH to ${to}. `, Object.assign(document.createElement('a'), { href: `${ARC_EXPLORER}/tx/${tx}`, target: '_blank', rel: 'noopener', textContent: 'View the transaction' }));
    void refreshTokens().catch(() => undefined);
    void renderBudget().catch(() => undefined);
  } catch (error) {
    status.textContent = `Not sent: ${gasWhy(error)}`;
  } finally {
    button.disabled = false;
  }
}

// ── sending ───────────────────────────────────────────────────────────────

async function onSend(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const status = el('send-status');
  let recipient = el<HTMLInputElement>('recipient').value.trim().toLowerCase();
  // An ENS name, on Sepolia: ENSv2's own UniversalResolver names the address it is paid at.
  if (NETWORK === 'sepolia' && isName(recipient)) {
    status.textContent = `Looking up ${recipient} on ENS…`;
    try {
      const found = await resolveName(recipient, ETHEREUM_COIN);
      status.textContent = `${recipient} → ${found.address}${found.pq ? ', a name a FORS+C key holds' : ''}`;
      recipient = found.address.toLowerCase();
    } catch (error) { status.textContent = (error as Error).message; return; }
  }
  if (!/^0x[0-9a-f]{40}$/.test(recipient)) {
    el('recipient').focus();
    status.textContent = 'Enter a recipient address (0x followed by 40 hex characters).';
    return;
  }
  if (sendEth) { await sendEthTo(recipient as `0x${string}`); return; }
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
  let stealthPaid = false;
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

    // A payee that receives privately is paid at a one-time address only it can find.
    if (rt.stealth !== undefined) {
      progressLog.textContent = 'Checking whether the payee receives privately…';
      const oneTime = await rt.stealth.addressFor(recipient as `0x${string}`);
      if (oneTime !== undefined) {
        progressLog.textContent = 'The payee receives privately: paying a one-time address only they can find, announced on chain…';
        stealthPaid = true;
        recipient = oneTime;
      }
    }

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
    status.textContent = `Sent across the mesh${stealthPaid ? ' to a one-time address only the payee can find' : ''}. It usually settles within seconds. Check the Activity tab to see when it lands.`;
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
  if (!/AA21/.test(message)) return message;
  return GAS_IN_USDC ? 'this account has no USDC to pay gas. Send it 1 or 2 USDC from your notes first.' : `this account has too little ${CHAIN} ETH to pay gas. Get test funds on Home, or send it some.`;
};

const contractsOf = () => (account === null ? [] : arcState().contracts?.[idOf(account)] ?? []);

function renderContracts(): void {
  el('contracts-account').textContent = opaqueAddress || 'Starting…';
  el('contracts-gas').textContent = !runtimeReady ? '—' : GAS_IN_USDC ? `${accountUsdc} USDC` : `${ethText(ethHeld ?? 0n)} ETH`;
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
  if (SWAPS) setupSwap();
  else for (const id of ['tile-swap', 'tab-swap']) el(id).hidden = true;
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
  nameTheChain();
  // Nothing opens before the Terms of Use and Privacy Policy are accepted.
  await acceptTerms();
  // A wallet with a password opens locked.
  await unlockGate();
  // Real USDC on unaudited contracts: every visit to mainnet starts with this warning.
  if (NETWORK === 'mainnet') el<HTMLDialogElement>('mainnet-warning').showModal();
  document.querySelectorAll<HTMLElement>('[data-back]').forEach((node) => node.addEventListener('click', () => showView('home')));
  renderRingSvg();

  // One recovery phrase holds every chain's accounts (lib/wallet-keys.ts); an
  // Arc account from before phrases stays here as the browser account.
  browserAccount = await hasBrowserAccount();
  if (!arcState().seen) {
    // The first visit since Arc took phrases: an account this browser already has stays the one that opens.
    if (browserAccount) saveWalletState({ active: 'browser' });
    saveArcState({ seen: true });
  }
  setupWalletScreens({
    views: ['home', 'send', 'swap', 'ring', 'activity', 'contracts'], account: () => account, hasBrowserWallet: () => browserAccount,
    browserNote: 'This browser only, backed up by file', where: `on ${CHAIN}`,
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
  // Test networks turn arriving USDC into notes by themselves, if the switch says so.
  if (NETWORK !== 'mainnet') {
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
  if (NETWORK === 'sepolia') {
    // Sepolia's stack gives a new wallet gas and test dollars (stack.ts FAUCET), so nothing else is needed to try it.
    el('test-faucet').hidden = false;
    el('test-faucet').addEventListener('click', () => void (async () => {
      if (opaqueAddress === '') { setStatus('deposit-status', 'Your address is still being drawn: a moment.'); return; }
      setStatus('deposit-status', 'Asking Opaque\'s faucet for test funds…');
      const res = await fetch(`${new URL(requireService('meshExitUrl')).origin}/v1/faucet`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: opaqueAddress }),
      }).catch(() => undefined);
      const body = await res?.json().catch(() => ({})) as { message?: string };
      setStatus('deposit-status', res?.ok ? 'On its way: 100 tUSDC and a little Sepolia ETH for gas, in a few seconds.' : `The faucet said no: ${body.message ?? 'it is not reachable'}.`);
      if (res?.ok) setTimeout(() => void refreshNotes().catch(() => undefined), 15_000);
    })());
  }
  if (!GAS_IN_USDC) {
    // ETH is the account's second asset here: picked on Send, named in Receive.
    const picker = el<HTMLDialogElement>('asset-dialog');
    el<HTMLButtonElement>('send-asset').disabled = false;
    el('send-asset').addEventListener('click', () => picker.showModal());
    el('asset-usdc').addEventListener('click', () => { picker.close(); setSendAsset(false); });
    el('asset-eth').addEventListener('click', () => { picker.close(); setSendAsset(true); });
    picker.addEventListener('click', (e) => { if (e.target === picker) picker.close(); });
    el('receive-eth').hidden = false;
  }
  if (account !== 'browser' && exitablePools().length > 0) {
    el('exit-link-wrap').hidden = false;
    el('exit-link').addEventListener('click', () => { offerExit(account as AccountKeys); showView('home'); el('exit-card').scrollIntoView({ behavior: 'smooth' }); });
  }
  if (NETWORK === 'sepolia') {
    el<HTMLInputElement>('recipient').placeholder = '0x… or an ENS name, like opaque.eth';
    el('recipient').nextElementSibling!.textContent = 'A Sepolia address or an ENS name.';
    if (account !== 'browser') setupNameCard(account);
    setupSubname();
  }
  loadSent(arcStorageOf(account, keyStoreName()).sent);
  renderActivity();

  try {
    rt = await startWallet(undefined, account);
    // A phrase's account comes back from the chain: its key, however many rotations on.
    await rt.open();
  } catch (error) {
    showBootError(`Could not start: ${(error as Error).message}`);
    // Opaque's servers are not answering: the notes still leave their pools, without them.
    if (account !== 'browser') offerExit(account, `Opaque's servers are not answering, so private payments are paused. Your notes are still yours: each one can leave its pool on its own, through EF's anon-rpc to a public RPC and bundler, signed by this wallet's post-quantum key. Two steps, a few minutes apart; the note you take out is no longer private.`);
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
  void refreshSubname();
  setupStealth();

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
