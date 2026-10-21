// The wallet's side of the Opaque xrpl-connect adapter (lib/opaque-adapter.ts):
// the popup a dapp opens. Each request is shown with the site that made it —
// event.origin, which the browser sets — and nothing is signed until you
// approve it here. The site's account, keys and notes stay on this origin.
//
// The same page takes WalletConnect sessions (lib/walletconnect.ts), for dapps
// on other wallet SDKs: paste the link, and their requests join the same queue.

// First: it seals and opens what the wallet stores, so nothing reads storage before it.
import { unlockGate } from './lib/lock.ts';
import { xrplDeployment } from '../../deployments/xrpl.ts';
import { hasBrowserWallet, startXrplWallet, type XrplWallet } from './lib/xrpl-runtime.ts';
import { accountLabel, activeAccount } from './lib/xrpl-keys.ts';
import { termsAccepted } from './lib/wallet-ui.ts';
import { startWalletConnect } from './lib/walletconnect.ts';

// The extension serves this page to any https site (web_accessible_resources), so a site
// could frame it, unlocked, under its own page and steer a click onto Approve. It runs
// only as a window of its own: framed, it shows nothing and does nothing.
const FRAMED = window.top !== window.self;
if (FRAMED) {
  document.documentElement.replaceChildren(Object.assign(document.createElement('body'), { textContent: 'Opaque opens only in its own window.' }));
  // Nothing below runs: no listener for a site's requests, no wallet.
  throw new Error('Opaque opens only in its own window');
}

type Method = 'connect' | 'sign' | 'signAndSubmit' | 'signMessage';
type Outcome = { result?: unknown; error?: string };
interface Pending {
  readonly id: string;
  readonly method: Method;
  readonly params: Record<string, unknown>;
  /** The key the site's account is kept under: its origin, or `walletconnect:<origin>` when unverified. */
  readonly origin: string;
  /** What the card names as the requester, and a line under it. */
  readonly label?: string;
  readonly note?: string;
  readonly reply: (outcome: Outcome) => void;
}

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const queue: Pending[] = [];
let wallet: XrplWallet | undefined;
let busy = false;
/** Why no request can be served here, when none can. */
let unavailable: string | undefined;

const currency = (code: string) =>
  /^[0-9A-F]{40}$/i.test(code) ? new TextDecoder().decode(Uint8Array.from(code.match(/../g)!.map((b) => parseInt(b, 16)))).replace(/\0/g, '') : code;
const amount = (a: unknown): string =>
  typeof a === 'string' ? `${Number(a) / 1e6} XRP`
    : typeof a === 'object' && a !== null ? `${(a as { value?: string }).value ?? '?'} ${currency(String((a as { currency?: string }).currency ?? '?'))}` : '?';
const hostOf = (key: string): string => {
  try { return new URL(key.replace(/^walletconnect:/, '')).host; } catch { return 'the app'; }
};

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
  el('request-origin').textContent = p.label ?? p.origin;
  el('request-note').hidden = p.note === undefined;
  el('request-note').textContent = p.note ?? '';
  el('progress').hidden = true;
  el('fund-box').hidden = true;
  el('request-details').hidden = true;
  const progress = (line: string) => { el('progress').hidden = false; el('progress').textContent = line; };
  const buttons = (on: boolean) => { el<HTMLButtonElement>('approve').disabled = !on; el<HTMLButtonElement>('reject').disabled = !on; };
  buttons(false);

  if (p.method === 'connect') {
    const wanted = p.params['network'];
    if (typeof wanted === 'string' && wanted !== w.network.id) { p.reply({ error: `Opaque is on ${w.network.id}, the site asked for ${wanted}` }); return; }
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
    el('request-summary').textContent = 'Signed by this site account\'s original key. It can no longer move funds, but a future quantum computer could forge messages from it.';
    el('request-details').hidden = false;
    el('request-details').textContent = String(p.params['message'] ?? `hex ${String(p.params['hex'])}`);
  } else {
    const tx = (p.params['transaction'] ?? {}) as Record<string, unknown>;
    el('request-title').textContent = p.method === 'sign' ? 'Sign (the site submits it)' : 'Sign and submit';
    el('request-summary').textContent = site === undefined ? 'This site has no account: connect first.' : describe(tx);
    el('request-details').hidden = false;
    el('request-details').textContent = JSON.stringify(tx, null, 2);
  }

  buttons(true);
  const approved = await decision();
  // Settled either way: the card must never offer buttons for a request that is gone.
  buttons(false);
  if (!approved) { progress('Rejected: nothing was signed.'); p.reply({ error: 'rejected in Opaque' }); return; }
  try {
    if (p.method === 'connect') {
      const account = site ?? await w.openSite(p.origin, Number(el<HTMLInputElement>('fund-amount').value), el<HTMLInputElement>('fund-tokens').checked, progress);
      p.reply({ result: { address: account.address, network: w.network } });
    } else {
      progress('Signing through the mesh…');
      p.reply({ result: await w.siteRequest(p.origin, p.method, p.params) });
    }
    progress(`Done. You can go back to ${hostOf(p.origin)}.`);
  } catch (error) {
    progress((error as Error).message);
    p.reply({ error: (error as Error).message });
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
  const source = event.source as WindowProxy;
  const id = data.id;
  // Sandboxed frames and file:// pages are all origin "null": they would share one account.
  if (event.origin === 'null') {
    source.postMessage({ type: 'opaque:response', id, error: 'Opaque needs a site with a real origin' }, '*');
    return;
  }
  const origin = event.origin;
  if (unavailable !== undefined) { source.postMessage({ type: 'opaque:response', id, error: unavailable }, origin); return; }
  queue.push({
    id, method: data.method as Method, params: (data.params ?? {}) as Record<string, unknown>, origin,
    reply: (outcome) => source.postMessage({ type: 'opaque:response', id, ...outcome }, origin),
  });
  void drain();
});

// ── WalletConnect: a session's requests join the same queue ───────────────
const WC_USED = 'opaque:xrpl-walletconnect:v1';
const enqueue = (p: Omit<Pending, 'id' | 'reply'>): Promise<Outcome> =>
  new Promise((resolve) => { queue.push({ ...p, id: `wc-${crypto.randomUUID()}`, reply: resolve }); void drain(); });
const labelOf = (siteKey: string) => (siteKey.startsWith('walletconnect:') ? `${siteKey.slice('walletconnect:'.length)} (unverified)` : siteKey);

/**
 * A wc: link from the camera. Frames are decoded on this page and nothing
 * about them leaves it. Runs until a WalletConnect code shows or `active` ends.
 */
async function scanLink(video: HTMLVideoElement, active: () => boolean): Promise<string> {
  const [{ default: jsQR }, stream] = await Promise.all([import('jsqr'), navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })]);
  video.srcObject = stream;
  video.hidden = false;
  try {
    await video.play();
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    while (active()) {
      await new Promise((r) => setTimeout(r, 150));
      if (video.videoWidth === 0) continue;
      // A 640-wide frame decodes fast enough on a phone and still reads a WalletConnect code.
      const scale = Math.min(1, 640 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const code = jsQR(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      if (code?.data.startsWith('wc:') === true) return code.data;
    }
    throw new Error('stopped');
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.hidden = true;
    video.srcObject = null;
  }
}

function offerWalletConnect(w: XrplWallet): void {
  const config = w.config.walletConnect;
  if (config == null) return;
  el('wc-form').hidden = false;
  let started: ReturnType<typeof startWalletConnect> | undefined;
  const start = () => started ??= startWalletConnect(config, `xrpl:${xrplDeployment.network.networkId}`, {
    connect: async (p) => {
      const o = await enqueue({
        method: 'connect', params: {}, origin: p.siteKey, label: labelOf(p.siteKey),
        note: p.verified ? `${p.name}, through WalletConnect.` : `${p.name}, through WalletConnect. Reown could not verify this app's address, so it gets an account of its own, apart from any site it claims to be.`,
      });
      return o.error === undefined ? (o.result as { address: string }).address : null;
    },
    request: async (siteKey, method, tx) => {
      const o = await enqueue({ method, params: { transaction: tx }, origin: siteKey, label: labelOf(siteKey), note: 'Through WalletConnect.' });
      if (o.error !== undefined) throw new Error(o.error);
      const r = o.result as { hash: string; tx_json: Record<string, unknown> };
      return { ...r.tx_json, hash: r.hash };
    },
    siteOf: (address) => w.sites().find((s) => s.address === address)?.origin,
    refused: (reason) => { el('wc-status').textContent = reason; },
  });
  // Sessions this browser holds come back with the page, and so do their requests.
  try { if (localStorage.getItem(WC_USED) !== null) void start(); } catch { /* storage refused: pair again */ }
  const scan = el<HTMLButtonElement>('wc-scan');
  let scanning = false;
  scan.addEventListener('click', () => {
    if (scanning) { scanning = false; return; }
    scanning = true;
    scan.textContent = 'Stop camera';
    el('wc-status').textContent = 'Point the camera at the app\'s WalletConnect QR code.';
    void scanLink(el<HTMLVideoElement>('wc-camera'), () => scanning).then(
      (uri) => { el<HTMLInputElement>('wc-uri').value = uri; el<HTMLFormElement>('wc-form').requestSubmit(); },
      (error: Error) => { el('wc-status').textContent = scanning ? `Camera unavailable: ${error.message}` : 'Camera off.'; },
    ).finally(() => { scanning = false; scan.textContent = 'Scan QR'; });
  });
  el<HTMLFormElement>('wc-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const uri = el<HTMLInputElement>('wc-uri').value.trim();
    if (!uri.startsWith('wc:')) { el('wc-status').textContent = 'A WalletConnect link starts with wc:'; return; }
    el('wc-status').textContent = 'Pairing through Opaque…';
    void start().then((c) => c.pair(uri)).then(() => {
      try { localStorage.setItem(WC_USED, '1'); } catch { /* the session still works while this page is open */ }
      el<HTMLInputElement>('wc-uri').value = '';
      el('wc-status').textContent = 'Paired. The app\'s request appears here; keep this page open while you use it.';
    }, (error: Error) => { el('wc-status').textContent = `Could not pair: ${error.message}`; });
  });
}

el('network').textContent = xrplDeployment.network.displayName;
// Opened as a page of its own (the installed app), not as a dapp's popup: a way back.
el('to-wallet').hidden = window.opener !== null;
// The account open in the wallet answers: each account has apps of its own.
// No app is answered before this browser has accepted the Terms of Use, in the wallet.
const accepted = termsAccepted();
// A locked wallet answers no app until its password is given, here.
if (accepted) await unlockGate();
const account = accepted ? activeAccount(hasBrowserWallet()) : null;
if (account === null) {
  unavailable = accepted ? 'Opaque has no wallet yet: open it, then create or import one' : 'Open Opaque and accept its Terms of Use first';
  el('idle-title').textContent = accepted ? 'No wallet yet' : 'Terms not accepted yet';
  el('idle-status').textContent = accepted ? 'Open Opaque, then create a wallet or import your recovery phrase.' : 'Open Opaque and accept its Terms of Use and Privacy Policy, then connect again.';
  el('to-wallet').hidden = false;
  window.opener?.postMessage({ type: 'opaque:ready' }, '*');
} else {
  try {
    wallet = await startXrplWallet(undefined, account === 'browser' ? null : account);
    el('idle-title').textContent = 'Ready';
    el('idle-status').textContent = `Waiting for the site’s request. ${accountLabel(account)} answers it.`;
    el('request-account').textContent = `With ${accountLabel(account)}`;
    offerWalletConnect(wallet);
    // Nothing secret in it: a site learns only that the popup has loaded.
    window.opener?.postMessage({ type: 'opaque:ready' }, '*');
    void drain();
  } catch (error) {
    el('idle-title').textContent = 'Not connected';
    el('idle-status').textContent = `The privacy backend is not reachable: ${(error as Error).message}`;
  }
}
