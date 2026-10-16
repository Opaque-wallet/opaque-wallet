// The wallet's side of the Opaque xrpl-connect adapter (lib/opaque-adapter.ts):
// the popup a dapp opens. Each request is shown with the site that made it —
// event.origin, which the browser sets — and nothing is signed until you
// approve it here. The site's account, keys and notes stay on this origin.

import { xrplDeployment } from '../../deployments/xrpl.ts';
import { startXrplWallet, type XrplWallet } from './lib/xrpl-runtime.ts';

type Method = 'connect' | 'sign' | 'signAndSubmit' | 'signMessage';
interface Pending {
  readonly id: string;
  readonly method: Method;
  readonly params: Record<string, unknown>;
  readonly origin: string;
  readonly source: MessageEventSource;
}

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const queue: Pending[] = [];
let wallet: XrplWallet | undefined;
let busy = false;

const currency = (code: string) =>
  /^[0-9A-F]{40}$/i.test(code) ? new TextDecoder().decode(Uint8Array.from(code.match(/../g)!.map((b) => parseInt(b, 16)))).replace(/\0/g, '') : code;
const amount = (a: unknown): string =>
  typeof a === 'string' ? `${Number(a) / 1e6} XRP`
    : typeof a === 'object' && a !== null ? `${(a as { value?: string }).value ?? '?'} ${currency(String((a as { currency?: string }).currency ?? '?'))}` : '?';

/** What the transaction does, in words: the JSON stays below for the details. */
function describe(tx: Record<string, unknown>): string {
  switch (tx['TransactionType']) {
    case 'Payment': return `Pay ${amount(tx['Amount'])} to ${String(tx['Destination'])}${tx['DestinationTag'] === undefined ? '' : ` (tag ${String(tx['DestinationTag'])})`}.`;
    case 'OfferCreate': return `Trade on the DEX: give up to ${amount(tx['TakerGets'])}, get ${amount(tx['TakerPays'])}.`;
    case 'OfferCancel': return 'Cancel a DEX offer.';
    case 'AMMDeposit': return `Deposit ${tx['Amount'] === undefined ? 'into' : `${amount(tx['Amount'])} into`} the ${currency(String((tx['Asset'] as { currency?: string })?.currency ?? '?'))}/${currency(String((tx['Asset2'] as { currency?: string })?.currency ?? '?'))} AMM.`;
    case 'AMMWithdraw': return 'Withdraw from an AMM.';
    case 'NFTokenAcceptOffer': return `Accept an NFT offer${tx['NFTokenSellOffer'] ? ' (buy)' : ' (sell)'}.`;
    case 'NFTokenCreateOffer': return `Offer an NFT for ${amount(tx['Amount'])}.`;
    case 'TrustSet': return `Hold ${currency(String((tx['LimitAmount'] as { currency?: string })?.currency ?? '?'))} (a trust line, 0.2 XRP reserve).`;
    default: return `A ${String(tx['TransactionType'])} transaction.`;
  }
}

function respond(p: Pending, outcome: { result?: unknown; error?: string }): void {
  (p.source as WindowProxy).postMessage({ type: 'opaque:response', id: p.id, ...outcome }, p.origin);
}

/** Waits for Approve or Reject on the card on screen. */
const decision = (): Promise<boolean> => new Promise((resolve) => {
  const approve = el<HTMLButtonElement>('approve');
  const reject = el<HTMLButtonElement>('reject');
  const done = (ok: boolean) => { approve.onclick = null; reject.onclick = null; resolve(ok); };
  approve.onclick = () => done(true);
  reject.onclick = () => done(false);
});

async function handle(p: Pending): Promise<void> {
  const w = wallet!;
  const site = w.site(p.origin);
  el('idle').hidden = true;
  el('request').hidden = false;
  el('request-origin').textContent = p.origin;
  el('progress').hidden = true;
  el('fund-box').hidden = true;
  el('request-details').hidden = true;
  const progress = (line: string) => { el('progress').hidden = false; el('progress').textContent = line; };
  const buttons = (on: boolean) => { el<HTMLButtonElement>('approve').disabled = !on; el<HTMLButtonElement>('reject').disabled = !on; };
  buttons(true);

  if (p.method === 'connect') {
    const wanted = p.params['network'];
    if (typeof wanted === 'string' && wanted !== w.network.id) { respond(p, { error: `Opaque is on ${w.network.id}, the site asked for ${wanted}` }); return; }
    if (site !== undefined) {
      el('request-title').textContent = 'Connect';
      el('request-summary').textContent = `Share this site's own account, ${site.address}. It has never been linked to you.`;
    } else {
      el('request-title').textContent = 'Connect privately';
      const balance = await w.balance('XRP');
      el('request-summary').textContent = `You hold ${balance.units} private XRP.`;
      el('fund-box').hidden = false;
    }
  } else if (p.method === 'signMessage') {
    el('request-title').textContent = 'Sign a message';
    el('request-summary').textContent = 'Signed by this site account\'s original key, which can no longer move funds.';
    el('request-details').hidden = false;
    el('request-details').textContent = String(p.params['message'] ?? `hex ${String(p.params['hex'])}`);
  } else {
    const tx = (p.params['transaction'] ?? {}) as Record<string, unknown>;
    el('request-title').textContent = p.method === 'sign' ? 'Sign (the site submits it)' : 'Sign and submit';
    el('request-summary').textContent = site === undefined ? 'This site has no account: connect first.' : describe(tx);
    el('request-details').hidden = false;
    el('request-details').textContent = JSON.stringify(tx, null, 2);
  }

  if (!await decision()) { respond(p, { error: 'rejected in Opaque' }); return; }
  buttons(false);
  try {
    if (p.method === 'connect') {
      const account = site ?? await w.openSite(p.origin, Number(el<HTMLInputElement>('fund-amount').value), el<HTMLInputElement>('fund-tokens').checked, progress);
      respond(p, { result: { address: account.address, network: w.network } });
    } else {
      progress('Signing through the mesh…');
      respond(p, { result: await w.siteRequest(p.origin, p.method, p.params) });
    }
    progress(`Done. You can go back to ${new URL(p.origin).host}.`);
  } catch (error) {
    progress((error as Error).message);
    respond(p, { error: (error as Error).message });
  }
}

async function drain(): Promise<void> {
  if (busy || wallet === undefined) return;
  busy = true;
  try {
    while (queue.length > 0) await handle(queue.shift()!);
  } finally {
    busy = false;
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; id?: unknown; method?: unknown; params?: unknown };
  if (data?.type !== 'opaque:request' || event.source === null || typeof data.id !== 'string') return;
  if (!['connect', 'sign', 'signAndSubmit', 'signMessage'].includes(String(data.method))) return;
  // Sandboxed frames and file:// pages are all origin "null": they would share one account.
  if (event.origin === 'null') {
    (event.source as WindowProxy).postMessage({ type: 'opaque:response', id: data.id, error: 'Opaque needs a site with a real origin' }, '*');
    return;
  }
  queue.push({ id: data.id, method: data.method as Method, params: (data.params ?? {}) as Record<string, unknown>, origin: event.origin, source: event.source });
  void drain();
});

el('network').textContent = xrplDeployment.network.displayName;
try {
  wallet = await startXrplWallet();
  el('idle-title').textContent = 'Ready';
  el('idle-status').textContent = 'Waiting for the site’s request.';
  // Nothing secret in it: a site learns only that the popup has loaded.
  window.opener?.postMessage({ type: 'opaque:ready' }, '*');
  void drain();
} catch (error) {
  el('idle-title').textContent = 'Not connected';
  el('idle-status').textContent = `The privacy backend is not reachable: ${(error as Error).message}`;
}
