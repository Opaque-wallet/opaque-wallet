// The dapp's side: xrpl-connect's WalletManager, with Opaque as one adapter.
// Nothing here is Opaque-specific beyond `new OpaqueAdapter(...)`.
//
// ?wallet=<Opaque connect page>&currency=<hex>&issuer=<r…>&nftOffer=<id>

import { Client } from 'xrpl';
import { WalletManager } from 'xrpl-connect';

import { OpaqueAdapter } from '../../../frontend/src/lib/opaque-adapter.ts';

const q = new URLSearchParams(location.search);
const currency = q.get('currency') ?? '';
const issuer = q.get('issuer') ?? '';
const adapter = new OpaqueAdapter({ walletUrl: q.get('wallet') ?? 'https://opaque.credit/xrpl-connect.html' });
const manager = new WalletManager({ adapters: [adapter as never], network: 'testnet' });

const el = (id: string) => document.getElementById(id)!;
const log = (line: string) => { el('log').textContent += `${line}\n`; };
const account = () => manager.account?.address ?? '';
const run = (id: string, action: () => Promise<string>) => el(id).addEventListener('click', () => {
  action().then((line) => log(`${id}: ${line}`), (e: Error) => log(`${id} failed: ${e.message}`));
});

run('connect', async () => {
  const a = await manager.connect('opaque', { network: 'testnet' } as never);
  el('account').textContent = a.address;
  return `connected ${a.address} on ${a.network.id}`;
});
run('trade', async () => {
  const r = await manager.signAndSubmit({
    TransactionType: 'OfferCreate', Account: account(), TakerGets: '2000000',
    TakerPays: { currency, issuer, value: '1.5' }, Flags: 0x0002_0000, // tfImmediateOrCancel
  } as never);
  return `${r.hash} ${String((r as { engine_result?: string }).engine_result)}`;
});
run('amm', async () => {
  const r = await manager.signAndSubmit({
    TransactionType: 'AMMDeposit', Account: account(), Asset: { currency: 'XRP' }, Asset2: { currency, issuer },
    Amount: '1000000', Flags: 0x0008_0000, // tfSingleAsset
  } as never);
  return `${r.hash} ${String((r as { engine_result?: string }).engine_result)}`;
});
run('nft', async () => {
  // A sign-only dapp: it gets the blob and submits it through its own node.
  const signed = await manager.sign({ TransactionType: 'NFTokenAcceptOffer', Account: account(), NFTokenSellOffer: q.get('nftOffer') } as never);
  const client = new Client('wss://s.altnet.rippletest.net:51233');
  await client.connect();
  try {
    const r = await client.submitAndWait(signed.tx_blob!);
    return `${r.result.hash} ${typeof r.result.meta === 'object' ? r.result.meta.TransactionResult : '?'}`;
  } finally {
    await client.disconnect();
  }
});
run('message', async () => {
  const m = await manager.signMessage('sign in to the demo dapp');
  return `signature ${m.signature.slice(0, 16)}… by ${m.publicKey.slice(0, 10)}…`;
});
