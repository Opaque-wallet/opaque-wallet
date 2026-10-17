// The dapp's side: xrpl-connect's WalletManager, with Opaque as one adapter.
// Nothing here is Opaque-specific beyond `new OpaqueAdapter(...)`. With ?wc=,
// xrpl-connect's own WalletConnect adapter too: a dapp that has never heard of
// Opaque, which a user connects by pasting its link into Opaque.
//
// ?wallet=<Opaque connect page>&currency=<hex>&issuer=<r…>&nftOffer=<id>&wc=<Reown project id>

import { Client, encode } from 'xrpl';
import { Adapters, WalletManager } from 'xrpl-connect';

import { OpaqueAdapter } from '../../../frontend/src/lib/opaque-adapter.ts';

const q = new URLSearchParams(location.search);
const currency = q.get('currency') ?? '';
const issuer = q.get('issuer') ?? '';
const el = (id: string) => document.getElementById(id)!;
const adapter = new OpaqueAdapter(q.get('wallet') === null ? {} : { walletUrl: q.get('wallet')! });
const projectId = q.get('wc');
const walletConnect = projectId === null ? undefined : new Adapters.WalletConnect({
  projectId, useModal: false, modalMode: 'never',
  metadata: { name: 'Demo XRPL dapp', description: 'An ordinary dapp on xrpl-connect', url: location.origin, icons: [] },
  onQRCode: (uri) => { el('wc-uri').textContent = uri; },
});
const manager = new WalletManager({ adapters: [adapter as never, ...(walletConnect === undefined ? [] : [walletConnect])], network: 'testnet' });
if (walletConnect !== undefined) el('connect-wc').hidden = false;

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
  const a = await manager.connect(id, { network: 'testnet' } as never);
  el('account').textContent = a.address;
  return `connected ${a.address} on ${a.network.id}`;
};
run('connect', connectWith('opaque'));
run('connect-wc', connectWith('walletconnect'));
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
  const signed = await manager.sign({ TransactionType: 'NFTokenAcceptOffer', Account: account(), NFTokenSellOffer: q.get('nftOffer') } as never);
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
