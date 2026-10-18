// Opaque for XRPL as a browser extension. Dapps that support GemWallet or
// Crossmark find Opaque without changing a line: this script runs in the page
// (world MAIN), answers both wallets' page protocols, and hands each request to
// Opaque's adapter, which opens the extension's own approval window, so the
// notes that pay are the ones in the extension's wallet. The window names the
// site from event.origin, which the browser sets, exactly as when a dapp loads
// the adapter itself. This script holds no key and approves nothing.
//
// ponytail: it answers as GemWallet AND Crossmark, on testnet only, and beside
// a real GemWallet or Crossmark both would answer. A per-site choice, and a
// mainnet wallet, when those exist.

import { OpaqueAdapter } from '../frontend/src/lib/opaque-adapter.ts';

interface Account { address: string; publicKey?: string; network: { id: string; name: string; wss: string } }
type Tx = Record<string, unknown>;

const WSS = 'wss://s.altnet.rippletest.net:51233';
const HOSTED = 'https://opaque-xrpl.vercel.app/testnet/xrpl-connect.html';
// bridge.js, which can ask the browser for this extension's address, leaves it
// on the page; anything else there is ignored and the hosted wallet answers.
const walletUrl = (): string => {
  const named = document.documentElement.dataset['opaqueWallet'] ?? '';
  return /^chrome-extension:\/\/[a-p]{32}\/xrpl-connect\.html$/.test(named) ? named : HOSTED;
};
let opened: OpaqueAdapter | undefined;
/** Made on first use: by then bridge.js has run, whichever script the browser started first. */
const adapter = (): OpaqueAdapter => (opened ??= new OpaqueAdapter({ walletUrl: walletUrl() }));
// One saved account per wallet: the extension's and the hosted one hold different notes.
const SAVED = () => `opaque-extension:account:${new URL(walletUrl()).origin}`;

// A site connects once; after that its address comes back without a popup, as
// a wallet's trusted sites do. Every signature still asks in the popup.
let account: Promise<Account> | undefined;
const saved = (): Account | null => { try { return JSON.parse(localStorage.getItem(SAVED()) ?? 'null') as Account | null; } catch { return null; } };
function connected(): Promise<Account> {
  account ??= (async () => {
    const known = saved();
    const a = known !== null ? await adapter().connect({ account: known }) : await adapter().connect({ network: { id: 'testnet' } });
    try { localStorage.setItem(SAVED(), JSON.stringify(a)); } catch { /* storage blocked: the next visit asks again */ }
    return a;
  })().catch((e: unknown) => { account = undefined; throw e; });
  return account;
}
const withAccount = async (tx: Tx | undefined): Promise<Tx> => ({ ...tx, Account: tx?.['Account'] ?? (await connected()).address });
const rejected = (e: unknown) => /rejected in Opaque|window was closed/.test(String((e as Error)?.message));
const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));

// ── GemWallet (@gemwallet/api 3): window.gemWallet, then window messages ─────

const PAYMENT_FIELDS: Record<string, string> = {
  amount: 'Amount', destination: 'Destination', destinationTag: 'DestinationTag', invoiceID: 'InvoiceID',
  paths: 'Paths', sendMax: 'SendMax', deliverMin: 'DeliverMin', sourceTag: 'SourceTag', fee: 'Fee',
};
/** sendPayment's fields as a Payment. Anything it can't carry is refused, never dropped. */
function paymentOf(p: Record<string, unknown>): Tx {
  const tx: Tx = { TransactionType: 'Payment' };
  for (const [key, value] of Object.entries(p)) {
    if (value === undefined) continue;
    if (key in PAYMENT_FIELDS) tx[PAYMENT_FIELDS[key]!] = value;
    else if (key === 'flags' && typeof value === 'number') tx['Flags'] = value;
    else if (key === 'memos' && Array.isArray(value)) {
      tx['Memos'] = value.map(({ memo }: { memo: Record<string, string | undefined> }) => ({ Memo: Object.fromEntries(
        Object.entries({ MemoType: memo.memoType, MemoData: memo.memoData, MemoFormat: memo.memoFormat }).filter(([, v]) => v !== undefined),
      ) }));
    } else throw new Error(`Opaque does not take ${key} in sendPayment; submitTransaction takes any Payment`);
  }
  return tx;
}

async function gem(type: string, p: Record<string, unknown>): Promise<unknown> {
  switch (type) {
    case 'REQUEST_GET_NETWORK/V3': return { chain: 'XRPL', network: 'Testnet', websocket: WSS };
    case 'REQUEST_GET_ADDRESS/V3': return { address: (await connected()).address };
    case 'REQUEST_GET_PUBLIC_KEY/V3': { const a = await connected(); return { address: a.address, publicKey: a.publicKey ?? '' }; }
    case 'REQUEST_SIGN_TRANSACTION/V3': return { signature: (await adapter().sign(await withAccount(p['transaction'] as Tx))).tx_blob };
    case 'REQUEST_SUBMIT_TRANSACTION/V3': return { hash: (await adapter().signAndSubmit(await withAccount(p['transaction'] as Tx))).hash };
    case 'REQUEST_SEND_PAYMENT/V3': return { hash: (await adapter().signAndSubmit(await withAccount(paymentOf(p)))).hash };
    case 'REQUEST_SIGN_MESSAGE/V3': {
      const message = String(p['message']);
      return { signedMessage: (await adapter().signMessage(p['isHex'] === true ? hexBytes(message) : message)).signature };
    }
    default: throw new Error(`Opaque does not answer ${type}; submitTransaction takes any transaction`);
  }
}

Object.assign(window, { gemWallet: true });
window.addEventListener('message', (event) => {
  const d = event.data as { source?: string; messageId?: number; type?: string; payload?: Record<string, unknown> } | null;
  if (event.source !== window || d?.source !== 'GEM_WALLET_MSG_REQUEST' || typeof d.type !== 'string') return;
  // `messagedId`, sic: the name GemWallet's API reads.
  const reply = (body: object) => window.postMessage({ source: 'GEM_WALLET_MSG_RESPONSE', messagedId: d.messageId, ...body }, location.origin);
  if (d.type === 'REQUEST_IS_INSTALLED/V3') { reply({ isInstalled: true }); return; }
  if (d.type === 'REQUEST_CONNECTION') { reply({ isConnected: true }); return; }
  gem(d.type, d.payload ?? {}).then(
    (result) => reply({ result }),
    // Neither a result nor an error is how GemWallet's API says the user refused.
    (e: Error) => reply(rejected(e) ? {} : { error: { name: 'Error', message: e.message, stack: '' } }),
  );
});

// ── Crossmark (@crossmarkio/sdk): window.xrpl.isCrossmark, then window messages ──

const NETWORK = { protocol: 'xrpl', type: 'testnet', label: 'XRPL', wss: WSS, rpc: 'https://s.altnet.rippletest.net:51234' };

async function crossmark(command: string, data: Record<string, unknown>): Promise<unknown> {
  const tx = data['tx'] as Tx | undefined;
  switch (command) {
    case 'network': return { network: NETWORK };
    // Polled by dapps: never a popup, only what is already connected.
    case 'address': return { address: (account === undefined ? saved() : await account.catch(() => null))?.address };
    case 'sign': {
      if (tx?.['TransactionType'] === 'SignIn') { const a = await connected(); return { address: a.address, publicKey: a.publicKey ?? '', network: NETWORK }; }
      return { txBlob: (await adapter().sign(await withAccount(tx))).tx_blob };
    }
    case 'sign-and-submit': return { resp: { result: { hash: (await adapter().signAndSubmit(await withAccount(tx))).hash } } };
    default: throw new Error(`Opaque does not answer Crossmark's ${command}`);
  }
}

Object.assign(window, { xrpl: Object.assign((window as { xrpl?: object }).xrpl ?? {}, { isCrossmark: true }) });
window.addEventListener('message', (event) => {
  const d = event.data as { type?: string; id?: string; command?: string; data?: Record<string, unknown> } | null;
  if (event.source !== window || d?.type !== 'request' || typeof d.id !== 'string' || typeof d.command !== 'string') return;
  // The request echoed back: the SDK's session files each answer under request.id.
  const reply = (data: unknown) => window.postMessage({ type: 'response', request: d, response: { type: 'response', id: d.id, data } }, location.origin);
  crossmark(d.command, d.data ?? {}).then(reply, (e: Error) => reply({ meta: rejected(e) ? { isRejected: true } : { isError: true }, error: e.message }));
});
