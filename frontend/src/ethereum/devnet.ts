// The wallet's page for the EIP-8141 devnet: "Ethereum Devnet (Fully post-quantum)", in the same
// shell as the XRPL and Arc wallets. The account answers to one FORS+C key
// drawn from the recovery phrase, and no step needs an ECDSA key: its factory
// creates it and pays for that, and every transaction after, a send or a
// Uniswap v4 swap, is signed by the FORS key alone (backend/ethereum/frame.ts,
// uniswap.ts, contracts/frame/).
//
// It talks straight to the devnet's gateway and miner. This devnet has no relay
// mesh yet, so the page shows the transaction, not Opaque's network privacy.

import { accountOf, balanceOf, createAccount, devnet, faucet, FIRST_NONCE, formatEther, forsKey, hasCode, isAddress, keyOf, MAX_FEE, MAX_USES, nonceOf, parseEther, sendCalls, settled, txUrl, type ForsKey } from '../../../backend/ethereum/frame.ts';
import { quote, swapCall, tokenBalance } from '../../../backend/ethereum/uniswap.ts';
import { unlockGate } from '../lib/lock.ts';
import { networkPicker } from '../lib/network-picker.ts';
import { accountLabel, activeAccount, stream } from '../lib/wallet-keys.ts';
import { copy, termsAccepted } from '../lib/wallet-ui.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
/** Lets a status paint before a step that holds the page (signing takes about a second). */
const paint = (): Promise<void> => new Promise((ok) => requestAnimationFrame(() => setTimeout(ok, 0)));
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const amount = (wei: bigint): string => Number(formatEther(wei)).toFixed(4);
/** Leaves room for the transaction's own gas when sending everything. */
const GAS_RESERVE = parseEther('0.0005');

let key: ForsKey;
let account: `0x${string}`;
let created = false;
let eth = 0n;
/** Signatures this key has left. */
let left = MAX_USES;

// ── views, as the XRPL page has them ──────────────────────────────────────
const VIEWS = ['home', 'send', 'swap', 'receive', 'activity'] as const;
type View = (typeof VIEWS)[number];
function showView(name: View): void {
  for (const v of VIEWS) {
    el(`view-${v}`).hidden = v !== name;
    el(`tab-${v}`).setAttribute('aria-selected', String(v === name));
  }
  window.scrollTo(0, 0);
  if (name === 'swap') void quoteSwap().catch(() => undefined);
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

async function refresh(): Promise<void> {
  const [made, wei, nonce, usd] = await Promise.all([hasCode(account), balanceOf(account), nonceOf(account), tokenBalance(account)]);
  created = made;
  eth = wei;
  left = created ? MAX_USES - (nonce - FIRST_NONCE) : MAX_USES;
  el('balance-main').textContent = amount(eth);
  el('balance-sub').textContent = created ? `${left} of ${MAX_USES} signatures left on this key` : 'Not created yet: its address already works';
  el('account-short').textContent = short(account);
  el('hero-assets').replaceChildren(chip('tok-eth', 'E', `${amount(eth)} ETH`, eth > 0n), chip('tok-usdc', 'U', `${amount(usd)} pqUSD`, usd > 0n));
  el('assets').replaceChildren(
    assetRow('tok-eth', 'E', 'ETH', 'Gas and value, on the devnet', amount(eth)),
    assetRow('tok-usdc', 'U', 'pqUSD', 'Post-Quantum Test Dollar, from Uniswap v4', amount(usd)),
  );
  facts([
    ['Account', account],
    ['Status', created ? 'Created' : 'Not created yet: its address is fixed by its key'],
    ['Key', `FORS+C, k=13 a=13: ${short(keyOf(key))}`],
    ['Signatures left', `${left} of ${MAX_USES}, then the account hands over to its next key`],
  ]);
  el('promo-create').hidden = created;
  el('promo-fund').hidden = eth > 0n;
  el('address-x').textContent = account;
  el('address-state').textContent = created ? 'Created' : 'Not created yet';
  el('address-create').hidden = created;
  el('send-have').textContent = `${amount(eth)} ETH`;
  el('swap-have').textContent = `${amount(eth)} ETH`;
  el('swap-have-to').textContent = `${amount(usd)} pqUSD`;
}

function logged(hash: `0x${string}`, what: string): void {
  const row = Object.assign(document.createElement('a'), { className: 'asset', href: txUrl(hash), target: '_blank', rel: 'noopener' });
  row.innerHTML = '<i class="tok tok-eth">E</i><span><b></b><small></small></span><span class="asset-value"><small>Explorer ↗</small></span>';
  row.querySelector('span b')!.textContent = what;
  row.querySelector('span small')!.textContent = short(hash);
  el('sent-list').querySelector('.empty')?.remove();
  el('sent-list').prepend(row);
}

/** The review before the key signs, as MetaMask asks before a transaction. */
async function confirmSign(title: string, rows: readonly (readonly [string, string])[]): Promise<boolean> {
  const dialog = el<HTMLDialogElement>('sign-dialog');
  el('sign-title').textContent = title;
  el('sign-rows').replaceChildren(...[
    ['Network', `Ethereum Devnet (chain ${devnet.chainId})`],
    ['From', short(account)],
    ...rows,
    ['Network fee', `at most ${Number(MAX_FEE) / 1e9} gwei per gas, in devnet ETH`],
    ['Signed with', `FORS+C, hash-based: no ECDSA`],
    ['Key after this', `${left - 1n} of ${MAX_USES} signatures left`],
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
  el(statusId).textContent = 'Create your account first: on Home, or in Deposit.';
  return false;
};

/** What the amount in the swap box buys now, from the pool's own state. */
async function quoteSwap(): Promise<void> {
  let wei: bigint;
  try { wei = parseEther(el<HTMLInputElement>('swap-amount').value.trim() || '0'); } catch { el('swap-quote').hidden = true; return; }
  if (wei <= 0n) { el('swap-out').textContent = '0'; el('swap-quote').hidden = true; return; }
  const out = await quote(wei);
  el('swap-out').textContent = amount(out);
  el('swap-rate').textContent = `1 ETH ≈ ${(Number(out) / Number(wei)).toFixed(2)} pqUSD`;
  el('swap-min').textContent = `${amount((out * 99n) / 100n)} pqUSD`;
  el('swap-quote').hidden = false;
}

// ── wiring ────────────────────────────────────────────────────────────────
networkPicker(el<HTMLButtonElement>('network-switch'), 'devnet');
for (const v of VIEWS) el(`tab-${v}`).addEventListener('click', () => showView(v));
for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => showView('home'));
for (const [t] of HOME_TABS) el(t).addEventListener('click', () => showHomeTab(t));
el('action-receive').addEventListener('click', () => showView('receive'));
el('action-send').addEventListener('click', () => showView('send'));
el('action-swap').addEventListener('click', () => showView('swap'));
el('action-activity').addEventListener('click', () => showView('activity'));
el('action-key').addEventListener('click', () => { showHomeTab('hometab-pq'); el('home-pq').scrollIntoView({ behavior: 'smooth' }); });
el('action-explorer').addEventListener('click', () => window.open(devnet.explorer, '_blank', 'noopener'));
el('account-button').addEventListener('click', () => showView('receive'));
el('address-copy').addEventListener('click', () => copy(account, 'Address'));
el('refresh').addEventListener('click', () => void refresh().catch(() => undefined));
el('promo-fund-go').addEventListener('click', fund('home-status'));
el('address-faucet').addEventListener('click', fund('address-status'));
el('promo-create-go').addEventListener('click', create('home-status'));
el('address-create').addEventListener('click', create('address-status'));
el('to-wallet').addEventListener('click', () => { location.href = 'xrpl.html'; });

el('send-max').addEventListener('click', () => {
  el<HTMLInputElement>('send-amount').value = eth > GAS_RESERVE ? formatEther(eth - GAS_RESERVE) : '0';
});
el('send-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!needAccount('send-status')) return;
  const to = el<HTMLInputElement>('recipient').value.trim();
  const text = el<HTMLInputElement>('send-amount').value.trim();
  if (!isAddress(to)) { el('send-status').textContent = 'Enter a 0x address to send to.'; return; }
  let value: bigint;
  try { value = parseEther(text); } catch { el('send-status').textContent = 'Enter an amount in ETH, like 0.001.'; return; }
  void (async () => {
    if (!(await confirmSign('Confirm send', [['Send', `${text} ETH`], ['To', to]]))) { el('send-status').textContent = 'Rejected. Nothing was signed.'; return; }
    await step('send-status', 'Signing with your post-quantum key…', async () => {
      // A transfer to an address with no account yet creates one: state gas (EIP-8037).
      const hash = await sendCalls(account, key, [{ to, value, gas: 50_000n, state: 200_000n }]);
      el('send-status').textContent = 'Sent through the alt mempool. Waiting for a block…';
      await settled(hash);
      logged(hash, `Sent ${text} ETH to ${short(to)}`);
      return `Sent. The only signature in it is FORS+C (${short(hash)}).`;
    });
  })();
});

el('swap-amount').addEventListener('input', () => void quoteSwap().catch(() => undefined));
el('swap-go').addEventListener('click', () => {
  if (!needAccount('swap-status')) return;
  let wei: bigint;
  try { wei = parseEther(el<HTMLInputElement>('swap-amount').value.trim()); } catch { el('swap-status').textContent = 'Enter an amount in ETH, like 0.001.'; return; }
  void (async () => {
    el('swap-status').textContent = 'Getting a quote…';
    let call: Awaited<ReturnType<typeof swapCall>>['call'];
    try {
      const swap = await swapCall(wei);
      call = swap.call;
      el('swap-status').textContent = '';
      if (!(await confirmSign('Confirm swap', [
        ['You pay', `${formatEther(wei)} ETH`],
        ['You get', `about ${amount(swap.expected)} pqUSD`],
        ['You get at least', `${amount((swap.expected * 99n) / 100n)} pqUSD`],
        ['Interacting with', 'Uniswap v4 Universal Router'],
        ['Contract', short(call.to)],
      ]))) { el('swap-status').textContent = 'Rejected. Nothing was signed.'; return; }
    } catch (error) { el('swap-status').textContent = `Didn't go through: ${(error as Error).message}`; return; }
    await step('swap-status', 'Signing the swap with your post-quantum key…', async () => {
      const before = await tokenBalance(account);
      const hash = await sendCalls(account, key, [call]);
      el('swap-status').textContent = 'Swapping on Uniswap v4, through the alt mempool…';
      await settled(hash);
      const got = (await tokenBalance(account)) - before;
      logged(hash, `Swapped ${formatEther(wei)} ETH for ${amount(got)} pqUSD`);
      void quoteSwap().catch(() => undefined);
      return `Swapped on Uniswap v4: ${amount(got)} pqUSD. The only signature in it is FORS+C.`;
    });
  })();
});

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
  el('account-name').textContent = accountLabel(open);
  await paint();
  // A key of its own for this chain: a few-time key must never sign on two.
  key = forsKey(stream(open.key, `eip8141/${devnet.chainId}/fors/0`)(32));
  account = await accountOf(keyOf(key));
  await refresh();
}
