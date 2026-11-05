// The wallet's page for the EIP-8141 devnet: "Ethereum Devnet (Fully post-quantum)", in the same
// shell as the XRPL and Arc wallets, and private by default as Arc's is: the
// balance is private pqUSDC notes, and Send pays from them through Opaque's
// pools (devnet-private.ts, backend/ethereum/devnet-stack.ts). The account
// answers to one FORS+C key drawn from the recovery phrase: its factory creates
// it and pays for that, and every transaction after (a deposit, a public ETH
// send, a Uniswap v4 swap) is signed by the FORS key alone (backend/ethereum/
// frame.ts, uniswap.ts, contracts/frame/).

import { accountOf, balanceOf, createAccount, devnet, faucet, FIRST_NONCE, formatEther, forsKey, hasCode, isAddress, keyFor, keyOf, MAX_FEE, MAX_USES, nonceOf, parseEther, pqUSDCFaucet, sendCalls, settled, txUrl, type Call, type ForsKey } from '../../../backend/ethereum/frame.ts';
import { quote, swapCalls, tokenBalance } from '../../../backend/ethereum/uniswap.ts';
import { unlockGate } from '../lib/lock.ts';
import { scoped } from '../lib/storage-name.ts';
import { hasPrivacy, pqUSDC, startDevnetPrivacy, type DevnetPrivacy, type PrivateSend } from './devnet-private.ts';
import { networkPicker } from '../lib/network-picker.ts';
import { accountLabel, activeAccount, stream } from '../lib/wallet-keys.ts';
import { copy, termsAccepted } from '../lib/wallet-ui.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
/** Lets a status paint before a step that holds the page (signing takes about a second). */
const paint = (): Promise<void> => new Promise((ok) => requestAnimationFrame(() => setTimeout(ok, 0)));
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** 4 decimals, or 6 below 0.01, where 4 would round a swap's minimum to its quote. */
const amount = (wei: bigint): string => { const n = Number(formatEther(wei)); return n.toFixed(n > 0 && n < 0.01 ? 6 : 4); };
/** pqUSDC's 6 decimals, as whole units with cents. */
const usdc = (units: bigint | number): string => (Number(units) / 1e6).toFixed(2);
/** Leaves room for the transaction's own gas when sending everything. */
const GAS_RESERVE = parseEther('0.0005');

/** The phrase's i-th key for this chain. A key of its own: a few-time key must never sign on two. */
let keyAt: (i: number) => ForsKey;
/** The key the account answers to now, which of the phrase's keys it is, and the first nonce it signs. */
let key: ForsKey;
let keyIndex = 0;
let first = FIRST_NONCE;
/** The key a handover just passed the account to, so finding it again costs no second derivation. */
let handedTo: { key: ForsKey; i: number } | undefined;
let account: `0x${string}`;
let created = false;
let eth = 0n;
let usd = 0n;
/** The swap's direction: ETH for pqUSD, or pqUSD back for ETH. */
let ethIn = true;
/** Signatures this key has left. */
let left = MAX_USES;
/** pqUSDC at the account's address, in 6-decimal units, waiting to be deposited. */
let usdcPublic = 0n;
/** Private pqUSDC: units in spendable notes, and how many notes; null until the stack answers. */
let privateUnits: number | null = null;
let noteCount = 0;
/** What Send sends: private pqUSDC notes (the default, as on Arc) or public ETH. */
let sendPrivate = true;

// ── views, as the XRPL page has them ──────────────────────────────────────
const VIEWS = ['home', 'send', 'swap', 'ring', 'receive', 'activity'] as const;
type View = (typeof VIEWS)[number];
function showView(name: View): void {
  for (const v of VIEWS) {
    el(`view-${v}`).hidden = v !== name;
    el(`tab-${v}`).setAttribute('aria-selected', String(v === name));
  }
  window.scrollTo(0, 0);
  if (name === 'swap') void quoteSwap().catch(() => undefined);
  if (name === 'ring') void refreshRing();
  if (name === 'home' || name === 'activity' || name === 'send') void refreshPrivate();
}
const HOME_TABS = [['hometab-assets', 'home-assets'], ['hometab-pq', 'home-pq']] as const;
function showHomeTab(tab: string): void {
  for (const [t, panel] of HOME_TABS) {
    el(t).setAttribute('aria-selected', String(t === tab));
    el(panel).hidden = t !== tab;
  }
}

function assetRow(tok: string, letter: string, name: string, detail: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'asset';
  row.innerHTML = `<i class="tok ${tok}">${letter}</i><span><b></b><small></small></span><span class="asset-value"><b></b></span>`;
  row.querySelector('span b')!.textContent = name;
  row.querySelector('span small')!.textContent = detail;
  row.querySelector('.asset-value b')!.textContent = value;
  return row;
}
function chip(tok: string, letter: string, text: string, on: boolean): HTMLElement {
  const c = document.createElement('span');
  c.className = `chip${on ? ' on' : ''}`;
  c.innerHTML = `<i class="tok ${tok}">${letter}</i><b></b>`;
  c.querySelector('b')!.textContent = text;
  return c;
}

function facts(rows: readonly (readonly [string, string])[]): void {
  el('facts').replaceChildren(...rows.flatMap(([term, value]) => [
    Object.assign(document.createElement('dt'), { textContent: term }),
    Object.assign(document.createElement('dd'), { textContent: value }),
  ]));
}

/** The key the account answers to on chain, and the first nonce it signs (frame.ts keyFor). */
async function syncKey(): Promise<void> {
  ({ key, i: keyIndex, first } = await keyFor(account, keyAt, [{ key, i: keyIndex }, ...(handedTo === undefined ? [] : [handedTo])]));
}

/** Signs and sends with the key of the moment. Its last signature also hands the account to the next key. */
async function signed(calls: readonly Call[], atomic = false): Promise<`0x${string}`> {
  if (left === 1n) handedTo = { key: keyAt(keyIndex + 1), i: keyIndex + 1 };
  return sendCalls(account, key, calls, atomic, left === 1n ? keyOf(handedTo!.key) : undefined);
}

async function refresh(): Promise<void> {
  let nonce: bigint;
  [created, eth, nonce, usd, usdcPublic] = await Promise.all([
    hasCode(account), balanceOf(account), nonceOf(account), tokenBalance(account),
    hasPrivacy() ? tokenBalance(account, pqUSDC()) : Promise.resolve(0n),
  ]);
  if (created) await syncKey();
  left = created ? MAX_USES - (nonce - first) : MAX_USES;
  render();
}

/** Paints every figure from what is known: the chain's reads (refresh) and the notes' (refreshPrivate). */
function render(): void {
  const priv = privateUnits === null ? '—' : usdc(privateUnits);
  el('balance-main').textContent = priv;
  el('balance-sub').textContent = !created ? 'Not created yet: its address already works'
    : `${noteCount} private ${noteCount === 1 ? 'note' : 'notes'} · ${amount(eth)} ETH for gas · ${left} of ${MAX_USES} signatures left on key ${keyIndex + 1}`;
  el('account-short').textContent = short(account);
  el('hero-assets').replaceChildren(
    chip('tok-usdc', 'U', `${priv} pqUSDC private`, (privateUnits ?? 0) > 0),
    ...(usdcPublic > 0n ? [chip('tok-usdc', 'U', `${usdc(usdcPublic)} pqUSDC to deposit`, false)] : []),
    chip('tok-eth', 'E', `${amount(eth)} ETH`, eth > 0n),
    ...(usd > 0n ? [chip('tok-usdc', 'U', `${amount(usd)} pqUSD`, false)] : []),
  );
  el('assets').replaceChildren(
    assetRow('tok-usdc', 'U', 'pqUSDC, private', `${noteCount} notes in Opaque's pools: Send pays from these`, priv),
    assetRow('tok-usdc', 'U', 'pqUSDC, at your address', 'Public until you deposit it on Home', usdc(usdcPublic)),
    assetRow('tok-eth', 'E', 'ETH', 'Gas for deposits, swaps and public sends', amount(eth)),
    assetRow('tok-usdc', 'U', 'pqUSD', 'Post-Quantum Test Dollar, from Uniswap v4', amount(usd)),
  );
  el('deposit-copy').textContent = usdcPublic > 0n
    ? `${usdc(usdcPublic)} pqUSDC is at your address, public. Deposit it to make it private notes.`
    : 'pqUSDC at your address becomes private notes.';
  facts([
    ['Account', account],
    ['Status', created ? 'Created' : 'Not created yet: its address is fixed by its key'],
    ['Key', `FORS+C, k=13 a=13, key ${keyIndex + 1}: ${short(keyOf(key))}`],
    ['Signatures left', `${left} of ${MAX_USES}; the last one also hands the account to your next key`],
  ]);
  el('promo-create').hidden = created;
  el('promo-fund').hidden = eth > 0n;
  el('address-x').textContent = account;
  el('address-state').textContent = created ? 'Created' : 'Not created yet';
  el('address-create').hidden = created;
  el('send-have').textContent = sendPrivate ? `${priv} pqUSDC` : `${amount(eth)} ETH`;
  const [pay, get] = ethIn ? [`${amount(eth)} ETH`, `${amount(usd)} pqUSD`] : [`${amount(usd)} pqUSD`, `${amount(eth)} ETH`];
  el('swap-have').textContent = pay;
  el('swap-have-to').textContent = get;
}

/** This account's transactions from this page, kept in this browser so a reload still shows them. */
interface Logged { readonly hash: `0x${string}`; readonly what: string; readonly at: number }
const activityKey = (): string => scoped(`opaque:eth-devnet:${account.toLowerCase()}:activity:v1`);
function activity(): Logged[] {
  try { return JSON.parse(localStorage.getItem(activityKey()) ?? '[]') as Logged[]; } catch { return []; }
}
function showActivity(): void {
  const all = activity();
  el('sent-list').replaceChildren(...(all.length === 0 ? [Object.assign(document.createElement('p'), { className: 'empty', textContent: 'Nothing yet.' })] : all.map((l) => {
    const row = Object.assign(document.createElement('a'), { className: 'asset', href: txUrl(l.hash), target: '_blank', rel: 'noopener' });
    row.innerHTML = '<i class="tok tok-eth">E</i><span><b></b><small></small></span><span class="asset-value"><small>Explorer ↗</small></span>';
    row.querySelector('span b')!.textContent = l.what;
    row.querySelector('span small')!.textContent = `${short(l.hash)} · ${new Date(l.at).toLocaleString()}`;
    return row;
  })));
}
function logged(hash: `0x${string}`, what: string): void {
  // The newest 200: enough history for a devnet account, and a bound on what this browser keeps.
  try { localStorage.setItem(activityKey(), JSON.stringify([{ hash, what, at: Date.now() }, ...activity()].slice(0, 200))); } catch { /* shown below all the same */ }
  showActivity();
  if (activity()[0]?.hash !== hash) el('sent-list').prepend(Object.assign(document.createElement('p'), { className: 'empty', textContent: `${what}: ${short(hash)}` }));
}

/**
 * The review before the key signs, as MetaMask asks before a transaction. A
 * private payment is no transaction of the account's (`signs` false): its
 * notes' proofs authorise it, and the pool pays.
 */
async function confirmSign(title: string, rows: readonly (readonly [string, string])[], signs = true): Promise<boolean> {
  const dialog = el<HTMLDialogElement>('sign-dialog');
  el('sign-title').textContent = title;
  el('sign-confirm').textContent = signs ? 'Sign with FORS+C' : 'Send privately';
  el('sign-note').textContent = signs
    ? 'Nothing is signed until you confirm. Your FORS+C key signs here, in this browser.'
    : 'Nothing is sent until you confirm. Your account signs nothing: each note\'s proof is built here, in this browser.';
  el('sign-rows').replaceChildren(...[
    ['Network', `Ethereum Devnet (chain ${devnet.chainId})`],
    ...(signs ? [['From', short(account)]] : []),
    ...rows,
    ...(signs ? [
      ['Network fee', `at most ${Number(MAX_FEE) / 1e9} gwei per gas, in devnet ETH`],
      ['Signed with', 'FORS+C, hash-based'],
      ['Key after this', left === 1n ? `this is its last signature: it also hands the account to key ${keyIndex + 2}, with ${MAX_USES}` : `${left - 1n} of ${MAX_USES} signatures left`],
    ] : []),
  ].map(([label, value]) => {
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

/** One step at a time: buttons wait, the status says what is happening, figures refresh before it reports. */
async function step(statusId: string, doing: string, run: () => Promise<string>): Promise<void> {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('main button')];
  for (const b of buttons) b.disabled = true;
  el(statusId).textContent = doing;
  await paint();
  let said: string;
  try {
    said = await run();
  } catch (error) {
    said = `Didn't go through: ${(error as Error).message}`;
  }
  await refresh().catch(() => undefined);
  for (const b of buttons) b.disabled = false;
  el(statusId).textContent = said;
}

const fund = (statusId: string) => () => void step(statusId, 'Asking for devnet ETH…', async () => {
  logged(await faucet(account), 'Devnet ETH received');
  return 'Funded with devnet ETH.';
});
const create = (statusId: string) => () => void step(statusId, 'Creating your account. The factory pays; nothing signs…', async () => {
  const hash = await createAccount(keyOf(key));
  await settled(hash);
  logged(hash, 'Account created');
  return 'Created. From now on your FORS+C key is its only authority.';
});
const needAccount = (statusId: string): boolean => {
  if (created) return true;
  el(statusId).textContent = 'Create your account first: on Home, or in Receive.';
  return false;
};

/** Counts quotes asked for, so a slow answer never overwrites a newer one. */
let quotes = 0;
/** What the amount in the swap box buys now, from the pool's own state. */
async function quoteSwap(): Promise<void> {
  const asked = ++quotes;
  let wei: bigint;
  try { wei = parseEther(el<HTMLInputElement>('swap-amount').value.trim() || '0'); } catch { el('swap-quote').hidden = true; return; }
  if (wei <= 0n) { el('swap-out').textContent = '0'; el('swap-quote').hidden = true; return; }
  const out = await quote(wei, ethIn);
  if (asked !== quotes) return;
  el('swap-out').textContent = amount(out);
  el('swap-rate').textContent = `1 ETH ≈ ${(ethIn ? Number(out) / Number(wei) : Number(wei) / Number(out)).toFixed(2)} pqUSD`;
  el('swap-min').textContent = `${amount((out * 99n) / 100n)} ${ethIn ? 'pqUSD' : 'ETH'}`;
  el('swap-quote').hidden = false;
}

// ── wiring ────────────────────────────────────────────────────────────────
networkPicker(el<HTMLButtonElement>('network-switch'), 'devnet');
for (const v of VIEWS) el(`tab-${v}`).addEventListener('click', () => showView(v));
for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => showView('home'));
for (const [t] of HOME_TABS) el(t).addEventListener('click', () => showHomeTab(t));
el('action-send').addEventListener('click', () => showView('send'));
el('action-receive').addEventListener('click', () => showView('receive'));
el('action-deposit').addEventListener('click', () => { el('deposit-card').scrollIntoView({ behavior: 'smooth', block: 'center' }); el('deposit-amount').focus(); });
el('action-privacy').addEventListener('click', () => showView('ring'));
el('action-activity').addEventListener('click', () => showView('activity'));
el('action-swap').addEventListener('click', () => showView('swap'));
el('account-button').addEventListener('click', () => showView('receive'));
el('address-copy').addEventListener('click', () => copy(account, 'Address'));
el('refresh').addEventListener('click', () => void refresh().catch(() => undefined));
el('promo-fund-go').addEventListener('click', fund('home-status'));
el('address-faucet').addEventListener('click', fund('address-status'));
el('promo-create-go').addEventListener('click', create('home-status'));
el('address-create').addEventListener('click', create('address-status'));
el('to-wallet').addEventListener('click', () => { location.href = 'xrpl.html'; });

/** Private pqUSDC (the default) or public ETH: the form, its words and its steps follow. */
function setSendMode(priv: boolean): void {
  sendPrivate = priv;
  el('send-mode-private').setAttribute('aria-selected', String(priv));
  el('send-mode-public').setAttribute('aria-selected', String(!priv));
  el('send-title').textContent = priv ? 'Send privately' : 'Send ETH';
  el('send-token').innerHTML = priv ? '<i class="tok tok-usdc">U</i><b>pqUSDC</b>' : '<i class="tok tok-eth">E</i><b>ETH</b>';
  el('send-unit').textContent = priv ? 'pqUSDC' : 'ETH';
  el<HTMLInputElement>('send-amount').value = priv ? '3' : '0.001';
  el('send-button').textContent = priv ? 'Send privately' : 'Sign with FORS+C and send';
  el('send-to-note').textContent = priv ? 'The pool pays them: nothing on chain names you.' : 'Public: the chain shows it came from your account.';
  el('send-how').textContent = priv ? 'How a private send works' : 'How a post-quantum send works';
  el('send-steps-private').hidden = !priv;
  el('send-steps-public').hidden = priv;
  el('send-status').textContent = '';
  render();
}
el('send-mode-private').addEventListener('click', () => setSendMode(true));
el('send-mode-public').addEventListener('click', () => setSendMode(false));
el('send-max').addEventListener('click', () => {
  el<HTMLInputElement>('send-amount').value = sendPrivate ? String(Math.floor((privateUnits ?? 0) / 1e6)) : eth > GAS_RESERVE ? formatEther(eth - GAS_RESERVE) : '0';
});
el('send-form').addEventListener('submit', (e) => {
  e.preventDefault();
  // A new send starts with no word from the last one.
  el('send-status').textContent = '';
  const to = el<HTMLInputElement>('recipient').value.trim();
  const text = el<HTMLInputElement>('send-amount').value.trim();
  if (!isAddress(to)) { el('send-status').textContent = 'Enter a 0x address to send to.'; return; }
  if (sendPrivate) { sendPrivately(to, text); return; }
  if (!needAccount('send-status')) return;
  let value: bigint;
  try { value = parseEther(text); } catch { el('send-status').textContent = 'Enter an amount in ETH, like 0.001.'; return; }
  void (async () => {
    if (!(await confirmSign('Confirm send', [['Send', `${text} ETH`], ['To', to], ['Public', 'an ETH transfer from your account']]))) { el('send-status').textContent = 'Rejected. Nothing was signed.'; return; }
    await step('send-status', 'Signing with your post-quantum key…', async () => {
      // A transfer to an address with no account yet creates one: state gas (EIP-8037).
      const hash = await signed([{ to, value, gas: 50_000n, state: 200_000n }]);
      el('send-status').textContent = 'Sent through the alt mempool. Waiting for a block…';
      await settled(hash);
      logged(hash, `Sent ${text} ETH to ${short(to)}`);
      return `Sent. The only signature in it is FORS+C (${short(hash)}).`;
    });
  })();
});

el('swap-amount').addEventListener('input', () => void quoteSwap().catch(() => undefined));
el('swap-flip').addEventListener('click', () => {
  ethIn = !ethIn;
  const [from, to] = [el('swap-from-label').innerHTML, el('swap-to-label').innerHTML];
  el('swap-from-label').innerHTML = to;
  el('swap-to-label').innerHTML = from;
  // What the other side came to becomes what is paid, as the sides change places.
  if (Number(el('swap-out').textContent) > 0) el<HTMLInputElement>('swap-amount').value = el('swap-out').textContent!;
  void refresh().catch(() => undefined);
  void quoteSwap().catch(() => undefined);
});
el('swap-go').addEventListener('click', () => {
  if (!needAccount('swap-status')) return;
  let wei: bigint;
  const [payIn, getOut] = ethIn ? ['ETH', 'pqUSD'] : ['pqUSD', 'ETH'];
  try { wei = parseEther(el<HTMLInputElement>('swap-amount').value.trim()); } catch { el('swap-status').textContent = `Enter an amount in ${payIn}, like ${ethIn ? '0.001' : '1'}.`; return; }
  // A swap that reverts still spends one of the key's signatures, so it must not be sent.
  if (wei > (ethIn ? eth : usd)) { el('swap-status').textContent = `You have ${amount(ethIn ? eth : usd)} ${payIn}.`; return; }
  const dir = ethIn;
  void (async () => {
    el('swap-status').textContent = 'Getting a quote…';
    let calls: Awaited<ReturnType<typeof swapCalls>>['calls'];
    try {
      const swap = await swapCalls(wei, dir);
      calls = swap.calls;
      el('swap-status').textContent = '';
      if (!(await confirmSign('Confirm swap', [
        ['You pay', `${formatEther(wei)} ${payIn}`],
        ['You get', `about ${amount(swap.expected)} ${getOut}`],
        ['You get at least', `${amount((swap.expected * 99n) / 100n)} ${getOut}`],
        ...(dir ? [] : [['Approves', `exactly ${formatEther(wei)} pqUSD, to Permit2 and the router, for this transaction only`] as const]),
        ['Interacting with', 'Uniswap v4 Universal Router'],
        ['Contract', short(calls.at(-1)!.to)],
      ]))) { el('swap-status').textContent = 'Rejected. Nothing was signed.'; return; }
    } catch (error) { el('swap-status').textContent = `Didn't go through: ${(error as Error).message}`; return; }
    await step('swap-status', 'Signing the swap with your post-quantum key…', async () => {
      const before = dir ? await tokenBalance(account) : await balanceOf(account);
      const hash = await signed(calls, true);
      el('swap-status').textContent = 'Swapping on Uniswap v4, through the alt mempool…';
      const r = await settled(hash);
      // ETH out: what the balance gained, plus the fee the transaction paid out of it.
      const got = (dir ? await tokenBalance(account) : (await balanceOf(account)) + BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice)) - before;
      logged(hash, `Swapped ${formatEther(wei)} ${payIn} for ${amount(got)} ${getOut}`);
      void quoteSwap().catch(() => undefined);
      return `Swapped on Uniswap v4: ${amount(got)} ${getOut}. The only signature in it is FORS+C.`;
    });
  })();
});

// ── private: Opaque's pools on the devnet (devnet-private.ts) ────────────
let openAccount: Parameters<typeof startDevnetPrivacy>[0];
let privacy: Promise<DevnetPrivacy> | undefined;
/** Started the first time the Private view needs it: it reads the stack's config and checks its relays. */
const privacyNow = (): Promise<DevnetPrivacy> => (privacy ??= startDevnetPrivacy(openAccount).catch((error: unknown) => { privacy = undefined; throw error; }));
const settledOf = (s: PrivateSend) => s.notes.filter((n) => n.state === 'SETTLED').length;

function privateRow(s: PrivateSend): HTMLElement {
  const tx = s.notes.find((n) => n.txHash !== undefined)?.txHash;
  const row = Object.assign(document.createElement(tx === undefined ? 'div' : 'a'), { className: 'asset' }) as HTMLElement;
  if (tx !== undefined) Object.assign(row, { href: txUrl(tx as `0x${string}`), target: '_blank', rel: 'noopener' });
  row.innerHTML = '<i class="tok tok-usdc">U</i><span><b></b><small></small></span><span class="asset-value"><small></small></span>';
  const failed = s.notes.filter((n) => n.state === 'FAILED');
  row.querySelector('span b')!.textContent = `${s.amount} pqUSDC privately to ${short(s.recipient)}`;
  row.querySelector('span small')!.textContent = failed.length > 0 ? `${failed.length} of ${s.notes.length} notes failed: ${failed[0]!.error ?? ''}` : `${settledOf(s)} of ${s.notes.length} notes paid by the pool`;
  row.querySelector('.asset-value small')!.textContent = tx === undefined ? '' : 'Explorer ↗';
  return row;
}

/** The notes, from the stack through the mesh: the private balance, and the private payments in Activity. */
async function refreshPrivate(): Promise<void> {
  if (!hasPrivacy() || account === undefined) return;
  try {
    const p = await privacyNow();
    const notes = await p.notes();
    const spendable = notes.filter((n) => n.state === 'AVAILABLE');
    privateUnits = spendable.reduce((sum, n) => sum + n.scope.denomination, 0);
    noteCount = spendable.length;
    render();
    // A deposit the stack has not indexed yet is looked for again while Home is open.
    if (notes.some((n) => n.state === 'DEPOSIT_PENDING') && !el('view-home').hidden) setTimeout(() => void refreshPrivate(), 5_000);
    const sends = await p.pollActivity();
    el('private-list').replaceChildren(...(sends.length === 0 ? [Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No private payments yet.' })] : sends.map(privateRow)));
  } catch (error) {
    el('home-status').textContent = `Opaque's devnet stack isn't reachable: ${(error as Error).message}`;
  }
}

const getUsdc = (statusId: string) => () => void step(statusId, 'Asking the pqUSDC faucet…', async () => {
  logged(await pqUSDCFaucet(account), 'Test pqUSDC received');
  return 'Got 100 test pqUSDC at your address. Deposit it to make it private.';
});
el('usdc-faucet').addEventListener('click', getUsdc('deposit-status'));
el('address-usdc').addEventListener('click', getUsdc('address-status'));

el('deposit').addEventListener('click', () => {
  el('deposit-status').textContent = '';
  if (!needAccount('deposit-status')) return;
  const whole = Number(el<HTMLInputElement>('deposit-amount').value.trim());
  if (!Number.isInteger(whole) || whole <= 0) { el('deposit-status').textContent = 'Deposit a whole number of pqUSDC, like 10.'; return; }
  void (async () => {
    const have = await tokenBalance(account, pqUSDC());
    if (BigInt(whole) * 1_000_000n > have) { el('deposit-status').textContent = `You have ${usdc(have)} pqUSDC at your address: tap "Get 100 test pqUSDC" first.`; return; }
    if (!(await confirmSign('Confirm private deposit', [
      ['Deposit', `${whole} pqUSDC`],
      ['Into', "Opaque's pools, as notes of 1 to 100"],
      ['Public', 'that this account deposited: payments from the notes are not'],
    ]))) { el('deposit-status').textContent = 'Rejected. Nothing was signed.'; return; }
    await step('deposit-status', 'Signing the deposit with your post-quantum key…', async () => {
      const p = await privacyNow();
      const { notes, calls } = await p.depositPlan(whole);
      const hash = await signed(calls, true);
      el('deposit-status').textContent = 'Depositing through the alt mempool…';
      await settled(hash);
      await p.deposited(notes, hash);
      logged(hash, `Deposited ${whole} pqUSDC into the pools`);
      await refreshPrivate();
      return `Deposited: ${notes.length} notes (${notes.map((n) => n.scope.denomination / 1e6).join(' + ')} pqUSDC), ready to spend privately.`;
    });
  })();
});

/** Send's private path: the notes pay, the account signs nothing, the pool pays the recipient. */
function sendPrivately(to: string, text: string): void {
  const whole = Number(text);
  if (!Number.isInteger(whole) || whole <= 0) { el('send-status').textContent = 'Send a whole number of pqUSDC, like 3.'; return; }
  if (privateUnits !== null && whole * 1e6 > privateUnits) { el('send-status').textContent = `You have ${usdc(privateUnits)} private pqUSDC: deposit some on Home first.`; return; }
  void (async () => {
    if (!(await confirmSign('Confirm private payment', [
      ['Pay', `${whole} pqUSDC`],
      ['To', to],
      ['Paid by', "Opaque's pool: nothing on chain names your account"],
      ['Each note', 'a ZKBoo ring proof built here, sealed, carried by three relays'],
    ], false))) { el('send-status').textContent = 'Not sent.'; return; }
    await step('send-status', 'Proving in this browser…', async () => {
      const p = await privacyNow();
      const say = (line: string) => { el('send-status').textContent = line; };
      const sent = await p.send(whole, to.toLowerCase() as never, say);
      // The stack attests and the pool pays: watched here until every note is settled or failed.
      for (let i = 0; i < 80; i++) {
        const s = (await p.pollActivity()).find((x) => x.id === sent.id)!;
        if (s.notes.every((n) => n.state === 'SETTLED' || n.state === 'FAILED')) break;
        say(`Sealed and sent through three relays: ${settledOf(s)} of ${s.notes.length} notes paid by the pool so far…`);
        await new Promise((ok) => setTimeout(ok, 3_000));
      }
      await refreshPrivate();
      const s = p.activity().find((x) => x.id === sent.id)!;
      const failed = s.notes.find((n) => n.state === 'FAILED');
      if (failed !== undefined) throw new Error(failed.error ?? 'a note was not paid');
      if (settledOf(s) < s.notes.length) return `Sent privately; ${settledOf(s)} of ${s.notes.length} notes paid so far. Activity shows the rest as they land.`;
      return `Paid privately: ${whole} pqUSDC, by the pool. Nothing on chain names your account.`;
    });
  })();
}

// ── Privacy: the ring, the pools, a relay path (as Arc's page draws them) ─
const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_SIZE = 8;
function renderRingSvg(): void {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 190 190');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Ring of ${RING_SIZE} identical members`);
  const orbit = document.createElementNS(SVG_NS, 'circle');
  orbit.setAttribute('cx', '95'); orbit.setAttribute('cy', '95'); orbit.setAttribute('r', '68');
  orbit.setAttribute('class', 'ring-orbit');
  svg.append(orbit);
  // Identical members: marking the user's own would leak it to anyone watching the screen.
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
async function refreshRing(): Promise<void> {
  if (el('ring-wrap').childElementCount === 0) renderRingSvg();
  if (!hasPrivacy()) { el('pool-size').textContent = 'No pools on the devnet yet'; return; }
  el('pool-size').textContent = 'Loading…';
  try {
    const p = await privacyNow();
    const [sizes, conditions, path] = await Promise.all([p.poolSizes(), p.readPrivacy(), p.samplePath()]);
    const total = [...sizes.values()].reduce((a, b) => a + b, 0);
    el('pool-size').replaceChildren(`${total.toLocaleString('en-US')} `, Object.assign(document.createElement('small'), {
      textContent: [...sizes].map(([size, n]) => `${n} at ${size} pqUSDC`).join(' · '),
    }));
    el('freshness-now').textContent = String(Math.round(Number(conditions.privacyScore) / 100));
    // A sample path, drawn fresh: each payment draws its own.
    el('hops').replaceChildren(...path.flatMap((hop, i) => [
      ...(i > 0 ? [Object.assign(document.createElement('span'), { className: 'hop-arrow', textContent: '→' })] : []),
      Object.assign(document.createElement('span'), { className: 'hop', textContent: hop }),
    ]));
  } catch (error) {
    el('freshness-now').textContent = '—';
    el('pool-size').textContent = `unreachable: ${(error as Error).message}`;
  }
}

// The phrase's account open in the wallet holds this account too; no phrase, no account.
const accepted = termsAccepted();
if (accepted) await unlockGate();
const open = accepted ? activeAccount(false) : null;
if (open === null || open === 'browser') {
  el('view-none').hidden = false;
  document.querySelector<HTMLElement>('.tabbar')!.hidden = true;
  el('account-short').textContent = 'No wallet yet';
  if (!accepted) {
    el('none-title').textContent = 'Terms not accepted yet';
    el('none-status').textContent = 'Open Opaque and accept its Terms of Use and Privacy Policy first.';
  }
} else {
  showView('home');
  openAccount = open;
  el('account-name').textContent = accountLabel(open);
  await paint();
  keyAt = (i) => forsKey(stream(open.key, `eip8141/${devnet.chainId}/fors/${i}`)(32));
  // The address is fixed by the first key, whichever key the account answers to now.
  key = keyAt(0);
  account = await accountOf(keyOf(key));
  showActivity();
  await refresh();
  void refreshPrivate();
}
