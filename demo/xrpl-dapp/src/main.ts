// The dapp's side: xrpl-connect's WalletManager, with Opaque as one adapter.
// Nothing here is Opaque-specific beyond `new OpaqueAdapter(...)`. Beside it,
// xrpl-connect's own GemWallet and Crossmark adapters, untouched: with the
// Opaque extension (extension/) they reach Opaque too. With ?wc=, its
// WalletConnect adapter: a dapp that has never heard of Opaque, which a user
// connects by pasting its link into Opaque.
//
// ?wallet=<Opaque connect page>&currency=<hex>&issuer=<r…>&nftOffer=<id>&wc=<Reown project id>
// Without currency and issuer: the testnet RLUSD market. Without nftOffer: mint one.

import { Client, encode } from 'xrpl';
import QRCode from 'qrcode';
import { Adapters, WalletManager } from 'xrpl-connect';

import deployment from '../../../deployments/xrpl/testnet.json';
import { OpaqueAdapter } from '../../../frontend/src/lib/opaque-adapter.ts';

const q = new URLSearchParams(location.search);
const rlusd = deployment.pools.find((p) => p.symbol === 'RLUSD')!.asset as { currency: string; issuer: string };
const currency = q.get('currency') ?? rlusd.currency;
const issuer = q.get('issuer') ?? rlusd.issuer;
const nftOffer = q.get('nftOffer');
const el = (id: string) => document.getElementById(id)!;
const adapter = new OpaqueAdapter(q.get('wallet') === null ? {} : { walletUrl: q.get('wallet')! });
// The hosted build has the hosted wallet's Reown project (npm run deploy); locally, ?wc= turns it on.
const projectId = q.get('wc') ?? import.meta.env.VITE_WC_PROJECT ?? null;
const walletConnect = projectId === null ? undefined : new Adapters.WalletConnect({
  projectId, useModal: false, modalMode: 'never',
  metadata: { name: 'Demo XRPL dapp', description: 'An ordinary dapp on xrpl-connect', url: location.origin, icons: [] },
  onQRCode: (uri) => { el('wc-uri').textContent = uri; el('copy-wc').hidden = false; void QRCode.toCanvas(el('wc-qr'), uri, { width: 240, margin: 2 }); },
});
const extensions = [new Adapters.GemWallet(), new Adapters.Crossmark()];
const manager = new WalletManager({ adapters: [adapter as never, ...extensions, ...(walletConnect === undefined ? [] : [walletConnect])], network: 'testnet' });
if (walletConnect !== undefined) el('connect-wc').hidden = false;
if (nftOffer === null) el('nft').textContent = 'Mint an NFT (dapp submits)';

/** A submitted transaction's result, read from the ledger when the wallet's answer has none. */
async function resultOf(hash: string): Promise<string> {
  const client = new Client('wss://s.altnet.rippletest.net:51233');
  await client.connect();
  try {
    for (let i = 0; i < 30; i++) {
      const tx = await client.request({ command: 'tx', transaction: hash }).catch(() => null);
      if (tx?.result.validated === true && typeof tx.result.meta === 'object') return tx.result.meta.TransactionResult;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    return 'not validated';
  } finally {
    await client.disconnect();
  }
}
const log = (line: string) => { el('log').textContent += `${line}\n`; };
const account = () => manager.account?.address ?? '';
const run = (id: string, action: () => Promise<string>) => el(id).addEventListener('click', () => {
  action().then((line) => log(`${id}: ${line}`), (e: Error) => log(`${id} failed: ${e.message}`));
});

const connectWith = (id: string) => async () => {
  // Switching wallets, as a dapp's wallet menu does: xrpl-connect holds one connection.
  if (manager.connected) await manager.disconnect();
  const a = await manager.connect(id, { network: 'testnet' } as never);
  el('account').textContent = a.address;
  return `connected ${a.address} on ${a.network.id}`;
};
run('connect', connectWith('opaque'));
run('connect-wc', connectWith('walletconnect'));
run('connect-gem', connectWith('gemwallet'));
run('connect-crossmark', connectWith('crossmark'));
// A long link wraps after its '?', and selecting the first line copies a link with no key.
el('copy-wc').addEventListener('click', () => {
  navigator.clipboard.writeText(el('wc-uri').textContent ?? '').then(
    () => { el('copy-wc').textContent = 'Copied'; },
    () => { getSelection()?.selectAllChildren(el('wc-uri')); },
  );
});
// WalletConnect answers with the signed tx_json and its hash, and no result: the dapp reads that from the ledger.
const outcome = async (r: { hash: string; engine_result?: string }) => `${r.hash} ${r.engine_result ?? await resultOf(r.hash)}`;
run('trade', async () => outcome(await manager.signAndSubmit({
  TransactionType: 'OfferCreate', Account: account(), TakerGets: '2000000',
  TakerPays: { currency, issuer, value: '1.5' }, Flags: 0x0002_0000, // tfImmediateOrCancel
} as never) as never));
run('amm', async () => outcome(await manager.signAndSubmit({
  TransactionType: 'AMMDeposit', Account: account(), Asset: { currency: 'XRP' }, Asset2: { currency, issuer },
  Amount: '1000000', Flags: 0x0008_0000, // tfSingleAsset
} as never) as never));
run('nft', async () => {
  // A sign-only dapp: it gets the blob (or, over WalletConnect, the signed tx_json) and submits it through its own node.
  const signed = await manager.sign((nftOffer === null
    ? { TransactionType: 'NFTokenMint', Account: account(), NFTokenTaxon: 0, Flags: 0x0000_0008 } // tfTransferable
    : { TransactionType: 'NFTokenAcceptOffer', Account: account(), NFTokenSellOffer: nftOffer }) as never);
  const { hash: _hash, ...tx } = (signed.tx_json ?? {}) as Record<string, unknown>;
  const blob = signed.tx_blob ?? encode(tx as never);
  const client = new Client('wss://s.altnet.rippletest.net:51233');
  await client.connect();
  try {
    const r = await client.submitAndWait(blob);
    return `${r.result.hash} ${typeof r.result.meta === 'object' ? r.result.meta.TransactionResult : '?'}`;
  } finally {
    await client.disconnect();
  }
});
run('message', async () => {
  const m = await manager.signMessage('sign in to the demo dapp');
  return `signature ${m.signature.slice(0, 16)}… by ${m.publicKey.slice(0, 10)}…`;
});
