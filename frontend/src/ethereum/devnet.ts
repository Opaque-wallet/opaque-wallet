// The wallet's page for the EIP-8141 devnet: "Fully post-quantum". The account
// answers to one FORS+C key drawn from the recovery phrase, and no step needs
// an ECDSA key: its factory creates it and pays for that, and every
// transaction after is signed by the FORS key alone (backend/ethereum/frame.ts,
// contracts/frame/).
//
// It talks straight to the devnet's gateway. This devnet has no relay mesh, so
// the page shows the transaction, not Opaque's network privacy.

import { accountOf, balanceOf, createAccount, devnet, faucet, FIRST_NONCE, formatEther, forsKey, hasCode, isAddress, keyOf, MAX_USES, nonceOf, parseEther, sendCalls, settled, txUrl, type ForsKey } from '../../../backend/ethereum/frame.ts';
import { unlockGate } from '../lib/lock.ts';
import { networkPicker } from '../lib/network-picker.ts';
import { accountLabel, activeAccount, stream } from '../lib/wallet-keys.ts';
import { copy, termsAccepted } from '../lib/wallet-ui.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
/** Lets the status paint before a step that holds the page (signing takes about a second). */
const paint = (): Promise<void> => new Promise((ok) => requestAnimationFrame(() => setTimeout(ok, 0)));
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const status = (text: string): void => { el('status').textContent = text; };
const buttons = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('#home button')];

let key: ForsKey;
let account: `0x${string}`;

function facts(rows: readonly (readonly [string, string, (() => void)?])[]): void {
  el('facts').replaceChildren(...rows.flatMap(([term, value, onCopy]) => {
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (onCopy !== undefined) {
      const b = Object.assign(document.createElement('button'), { className: 'link', type: 'button', textContent: 'Copy' });
      b.addEventListener('click', onCopy);
      dd.append(' ', b);
    }
    return [Object.assign(document.createElement('dt'), { textContent: term }), dd];
  }));
}

async function refresh(): Promise<void> {
  const [created, wei, nonce] = await Promise.all([hasCode(account), balanceOf(account), nonceOf(account)]);
  const used = created ? nonce - FIRST_NONCE : 0n;
  el('balance').textContent = Number(formatEther(wei)).toFixed(4);
  facts([
    ['Account', short(account), () => copy(account, 'Address')],
    ['Status', created ? 'Created' : 'Not created yet: its address is fixed by its key, so it can be funded first'],
    ['Key', `FORS+C, k=13 a=13: ${short(keyOf(key))}`],
    ['Signatures left', `${MAX_USES - used} of ${MAX_USES}, then the account hands over to its next key`],
  ]);
  el('create').hidden = created;
  el('send-form').hidden = !created;
}

function logged(hash: `0x${string}`, what: string): void {
  const a = Object.assign(document.createElement('a'), { href: txUrl(hash), target: '_blank', rel: 'noopener', textContent: short(hash) });
  const dd = document.createElement('dd');
  dd.append(a);
  el('activity').prepend(Object.assign(document.createElement('dt'), { textContent: what }), dd);
}

/** One step at a time: the buttons wait, the status says what is happening, the facts refresh after. */
async function step(doing: string, run: () => Promise<string>): Promise<void> {
  for (const b of buttons()) b.disabled = true;
  status(doing);
  await paint();
  let said: string;
  try {
    said = await run();
  } catch (error) {
    said = `Didn't go through: ${(error as Error).message}`;
  }
  // The facts first, so the status never runs ahead of what the page shows.
  await refresh().catch(() => undefined);
  for (const b of buttons()) b.disabled = false;
  status(said);
}

el('faucet').addEventListener('click', () => void step('Asking the devnet faucet…', async () => {
  logged(await faucet(account), 'Funded by the faucet');
  return 'Funded. The faucet pays each address once an hour.';
}));

el('create').addEventListener('click', () => void step('Creating your account. The factory pays; nothing signs…', async () => {
  const hash = await createAccount(keyOf(key));
  await settled(hash);
  logged(hash, 'Account created');
  return 'Created. From now on your FORS+C key is its only authority.';
}));

el('send-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const to = el<HTMLInputElement>('send-to').value.trim();
  const amount = el<HTMLInputElement>('send-amount').value.trim();
  if (!isAddress(to)) { status('Enter a 0x address to send to.'); return; }
  let value: bigint;
  try { value = parseEther(amount); } catch { status('Enter an amount in ETH, like 0.001.'); return; }
  void step('Signing with your post-quantum key…', async () => {
    // A transfer to an account that does not exist yet creates it, which costs state gas (EIP-8037).
    const hash = await sendCalls(account, key, [{ to, value, gas: 50_000n, state: 200_000n }]);
    status('Sent through the alt mempool. Waiting for a block…');
    await settled(hash);
    logged(hash, `Sent ${amount} ETH to ${short(to)}`);
    return `Sent. The only signature in it is FORS+C (${short(hash)}).`;
  });
});

el('to-wallet').addEventListener('click', () => { location.href = 'xrpl.html'; });
networkPicker(el<HTMLButtonElement>('network-switch'), 'devnet');

// The phrase's account open in the wallet holds this account too; no phrase, no account.
const accepted = termsAccepted();
if (accepted) await unlockGate();
const open = accepted ? activeAccount(false) : null;
if (open === null || open === 'browser') {
  el('none').hidden = false;
  if (!accepted) {
    el('none-title').textContent = 'Terms not accepted yet';
    el('none-status').textContent = 'Open Opaque and accept its Terms of Use and Privacy Policy first.';
  }
} else {
  el('home').hidden = false;
  status(`Drawing ${accountLabel(open)}'s post-quantum key from your recovery phrase…`);
  await paint();
  // A key of its own for this chain: a few-time key must never sign on two.
  key = forsKey(stream(open.key, `eip8141/${devnet.chainId}/fors/0`)(32));
  account = await accountOf(keyOf(key));
  await refresh();
  status(`${accountLabel(open)}, on the EIP-8141 devnet.`);
}
