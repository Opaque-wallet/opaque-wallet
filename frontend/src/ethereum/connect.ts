// The wallet's side of "Connect with Opaque" for Ethereum dapps (lib/opaque-eth-provider.ts):
// the window a dapp opens. A dapp connects to this wallet's Sepolia account, a post-quantum
// ERC-4337 account, and each transaction it asks for is shown here with the site that asked:
// event.origin, which the browser sets. Nothing is signed until you approve it here, and
// what signs is the account's FORS+C key, through the relays, as the wallet's own sends are.

// First: it seals and opens what the wallet stores, so nothing reads storage before it.
import { unlockGate } from '../lib/lock.ts';
import { hasBrowserAccount, startWallet, type WalletRuntime } from '../lib/runtime.js';
import { riskOfCall } from '../lib/contracts.ts';
import { accountLabel, activeAccount } from '../lib/wallet-keys.ts';
import { termsAccepted } from '../lib/wallet-ui.ts';
import { formatEther } from '../../../backend/ethereum/frame.ts';

// The extension serves this page to any https site (web_accessible_resources), so a site could
// frame it under its own page and steer a click onto Approve. It runs only as a window of its own.
if (window.top !== window.self) {
  document.documentElement.replaceChildren(Object.assign(document.createElement('body'), { textContent: 'Opaque opens only in its own window.' }));
  throw new Error('Opaque opens only in its own window');
}

type Outcome = { result?: unknown; error?: string; code?: number };
interface Pending { readonly method: string; readonly params: unknown[]; readonly origin: string; readonly reply: (o: Outcome) => void }
interface Tx { from?: string; to?: string; value?: string; data?: string; input?: string }

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const HEX = /^0x[0-9a-fA-F]*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EXPLORER = 'https://sepolia.etherscan.io';
const queue: Pending[] = [];
let rt: WalletRuntime | undefined;
let me: `0x${string}` | undefined;
let busy = false;
let unavailable: string | undefined;

function facts(rows: readonly (readonly [string, string, boolean?])[]): void {
  el('request-facts').replaceChildren(...rows.flatMap(([label, value, mono]) => {
    const dt = Object.assign(document.createElement('dt'), { textContent: label });
    const dd = Object.assign(document.createElement('dd'), { textContent: value });
    if (mono === true) dd.className = 'mono';
    return [dt, dd];
  }));
}

const decision = (): Promise<boolean> => new Promise((resolve) => {
  const approve = el<HTMLButtonElement>('approve');
  const reject = el<HTMLButtonElement>('reject');
  const done = (ok: boolean) => { approve.onclick = null; reject.onclick = null; resolve(ok); };
  approve.onclick = () => done(true);
  reject.onclick = () => done(false);
});

/** The site's transaction, checked: one call from this account, nothing Opaque can't carry. */
function callOf(tx: Tx): { to: `0x${string}`; data: `0x${string}`; value: bigint } {
  if (tx.from !== undefined && tx.from.toLowerCase() !== me) throw new Error(`the site asked to send from ${tx.from}, which is not this Opaque account`);
  if (tx.to === undefined || !ADDRESS.test(tx.to)) throw new Error('Opaque sends to a contract or address: a deploy (no "to") is not taken here');
  const data = tx.data ?? tx.input ?? '0x';
  if (!HEX.test(data) || data.length % 2 !== 0) throw new Error('the transaction\'s data is not hex');
  if (tx.value !== undefined && !HEX.test(tx.value)) throw new Error('the transaction\'s value is not a hex quantity');
  return { to: tx.to.toLowerCase() as `0x${string}`, data: data as `0x${string}`, value: BigInt(tx.value ?? '0x0') };
}

async function handle(p: Pending): Promise<void> {
  const w = rt!;
  el('idle').hidden = true;
  el('request').hidden = false;
  el('request-origin').textContent = p.origin;
  el('progress').hidden = true;
  el('request-raw').hidden = true;
  el('request-perms').hidden = true;
  const progress = (line: string | Node) => { el('progress').hidden = false; el('progress').replaceChildren(line); };
  const buttons = (on: boolean) => { el<HTMLButtonElement>('approve').disabled = !on; el<HTMLButtonElement>('reject').disabled = !on; };
  buttons(false);

  let call: ReturnType<typeof callOf> | undefined;
  if (p.method === 'eth_requestAccounts') {
    el('request-title').textContent = 'Connect';
    el('request-summary').textContent = 'Share this wallet\'s Sepolia account with the site. It is a post-quantum account: every transaction it makes is signed with a FORS+C key, never ECDSA alone.';
    facts([['Network', 'Ethereum Sepolia'], ['Account', me!, true], ['Signs with', 'FORS+C, a hash-based post-quantum signature, through ERC-4337']]);
    el('request-perms').hidden = false;
  } else {
    try { call = callOf((p.params[0] ?? {}) as Tx); } catch (error) { p.reply({ error: (error as Error).message, code: -32602 }); return; }
    const have = await w.ethBalance(me!).catch(() => undefined);
    el('request-title').textContent = 'Send a transaction';
    el('request-summary').textContent = riskOfCall(call.to, call.data)
      ?? (call.data === '0x' ? `Send ${formatEther(call.value)} ETH to ${call.to}.` : `Call the contract at ${call.to}${call.value > 0n ? `, sending ${formatEther(call.value)} ETH` : ''}.`);
    facts([
      ['Network', 'Ethereum Sepolia'],
      ['From', me!, true],
      ['To', call.to, true],
      ['Value', `${formatEther(call.value)} ETH`],
      ['Data', call.data === '0x' ? 'none' : `${(call.data.length - 2) / 2} bytes, function ${call.data.slice(0, 10)}`, call.data !== '0x'],
      ['Account holds', have === undefined ? 'unknown' : `${formatEther(have)} ETH`],
      ['Gas', 'From this account\'s ETH; the site\'s gas and fee fields are ignored'],
      ['Signed by', 'This account\'s FORS+C key, as one ERC-4337 operation sent through Opaque\'s relays'],
    ]);
    if (call.data !== '0x') {
      el('request-raw').hidden = false;
      el('request-details').textContent = call.data;
    }
  }

  buttons(true);
  const approved = await decision();
  buttons(false);
  if (!approved) { progress('Rejected: nothing was signed.'); p.reply({ error: 'rejected in Opaque', code: 4001 }); return; }
  try {
    if (call === undefined) {
      p.reply({ result: [me] });
      progress('Connected. You can go back to the site; keep this window open for its transactions.');
      return;
    }
    progress('Signing with this account\'s post-quantum key, and sending it through the relays…');
    const hash = await w.execute(me!, [call]);
    p.reply({ result: hash });
    const done = document.createElement('span');
    done.append('Sent. ', Object.assign(document.createElement('a'), { href: `${EXPLORER}/tx/${hash}`, target: '_blank', rel: 'noopener', textContent: 'View the transaction' }));
    progress(done);
  } catch (error) {
    progress(`Not sent: ${(error as Error).message}`);
    p.reply({ error: (error as Error).message, code: -32603 });
  }
}

async function drain(): Promise<void> {
  if (busy || rt === undefined) return;
  busy = true;
  try { while (queue.length > 0) await handle(queue.shift()!); } finally { busy = false; }
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; id?: unknown; method?: unknown; params?: unknown };
  if (data?.type !== 'opaque:request' || event.source === null || typeof data.id !== 'string') return;
  if (data.method !== 'eth_requestAccounts' && data.method !== 'eth_sendTransaction') return;
  const source = event.source as WindowProxy;
  const id = data.id;
  if (event.origin === 'null') { source.postMessage({ type: 'opaque:response', id, error: 'Opaque needs a site with a real origin', code: 4100 }, '*'); return; }
  const origin = event.origin;
  if (unavailable !== undefined) { source.postMessage({ type: 'opaque:response', id, error: unavailable, code: 4100 }, origin); return; }
  queue.push({ method: data.method, params: Array.isArray(data.params) ? data.params : [], origin, reply: (o) => source.postMessage({ type: 'opaque:response', id, ...o }, origin) });
  void drain();
});

el('to-wallet').hidden = window.opener !== null;
const accepted = termsAccepted();
if (accepted) await unlockGate();
const account = accepted ? activeAccount(await hasBrowserAccount()) : null;
if (account === null) {
  unavailable = accepted ? 'Opaque has no wallet yet: open it, then create or import one' : 'Open Opaque and accept its Terms of Use first';
  el('idle-title').textContent = accepted ? 'No wallet yet' : 'Terms not accepted yet';
  el('idle-status').textContent = accepted ? 'Open Opaque, then create a wallet or import your recovery phrase.' : 'Open Opaque and accept its Terms of Use and Privacy Policy, then connect again.';
  el('to-wallet').hidden = false;
  window.opener?.postMessage({ type: 'opaque:ready' }, '*');
} else {
  try {
    rt = await startWallet(undefined, account);
    await rt.open();
    me = (await rt.app.walletState()).accountAddress.toLowerCase() as `0x${string}`;
    el('idle-title').textContent = 'Ready';
    el('idle-status').textContent = `Waiting for the site's request. ${accountLabel(account)} answers it.`;
    el('request-account').textContent = `With ${accountLabel(account)}`;
    // Nothing secret in it: a site learns only that the window has loaded.
    window.opener?.postMessage({ type: 'opaque:ready' }, '*');
    void drain();
  } catch (error) {
    el('idle-title').textContent = 'Not connected';
    el('idle-status').textContent = `The privacy backend is not reachable: ${(error as Error).message}`;
  }
}
