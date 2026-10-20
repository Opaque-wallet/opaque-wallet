#!/usr/bin/env node
// Proves on XRPL TESTNET what a swap payout relies on: a Batch's inner Payment
// can be cross-currency and partial, routed through the AMMs, and the ledger
// holds it to DeliverMin. A throwaway account stands in for a pool.
//
//   cd backend && node --use-system-ca xrpl/spike-swap.ts
//
// 1. XRP → USDC: SendMax 10 XRP, DeliverMin from the AMM quote less 2%
// 2. USDC → RLUSD through XRP (Paths), the same way
// 3. a DeliverMin above what the AMM can give: the Batch applies nothing

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BatchFlags, Client, Wallet, type Batch } from 'xrpl';

import { xrplDeployment } from '../../deployments/xrpl.ts';
import { payoutBatch } from './batch.ts';
import { deliverMinOf, quoteSwap } from './swap.ts';
import { UNIT, type XrplAsset } from './protocol.ts';

const STACK = join(dirname(fileURLToPath(import.meta.url)), '..', '.stack', 'xrpl');
const log = (s: string) => process.stdout.write(`${s}\n`);
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => { if (!ok) failures++; log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`); };

const client = new Client(xrplDeployment.network.wss);
await client.connect();
const read = <T>(command: string, params: Record<string, unknown>) => client.request({ command, ...params } as never).then((r) => (r as { result: T }).result);
const assetOf = (symbol: string) => xrplDeployment.pools.find((p) => p.symbol === symbol)!.asset as XrplAsset;
const [XRP, USDC, RLUSD] = [assetOf('XRP'), assetOf('USDC'), assetOf('RLUSD')];
const line = (a: XrplAsset) => { const { currency, issuer } = a as { currency: string; issuer: string }; return { currency, issuer }; };

try {
  const { wallet: payer } = await client.fundWallet(null, { amount: '1000' } as never);
  const { wallet: payee } = await client.fundWallet(null, { amount: '100' } as never);
  for (const a of [USDC, RLUSD]) {
    for (const w of [payer, payee]) {
      await client.submitAndWait({ TransactionType: 'TrustSet', Account: w.address, LimitAmount: { ...line(a), value: '1000000' } }, { wallet: w, autofill: true });
    }
  }
  const usdcIssuer = Wallet.fromSeed((JSON.parse(readFileSync(join(STACK, 'issuer-usdc.json'), 'utf8')) as { seed: string }).seed);
  await client.submitAndWait({ TransactionType: 'Payment', Account: usdcIssuer.address, Destination: payer.address, Amount: { ...line(USDC), value: '50' } }, { wallet: usdcIssuer, autofill: true });

  const balance = async (a: XrplAsset) => {
    const lines = await read<{ lines: { currency: string; account: string; balance: string }[] }>('account_lines', { account: payee.address });
    const l = lines.lines.find((x) => x.currency === line(a).currency && x.account === line(a).issuer);
    return Number(l?.balance ?? 0);
  };
  /** The payout Batch a pool would send, from `payer`, and whether its Payment applied. */
  async function payout(asset: XrplAsset, units: bigint, deliver: { asset: XrplAsset; min: bigint }): Promise<string> {
    const batch = payoutBatch({ pool: payer.address, asset, nullifiers: [`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}` as never], destination: { account: payee.address, tag: null }, units, deliver, nextSigners: [], quorum: 1 });
    // Without the signer list: this account has none. The credential stays, as a pool's payout has it.
    const only = { ...batch, Flags: BatchFlags.tfAllOrNothing, RawTransactions: batch.RawTransactions.filter((r) => r.RawTransaction.TransactionType !== 'SignerListSet') } as Batch;
    const result = await client.submitAndWait(only, { wallet: payer, autofill: true });
    const hashOfInner = (result.result as { tx_json?: Batch }).tx_json?.RawTransactions?.[0];
    void hashOfInner;
    return typeof result.result.meta === 'object' ? result.result.meta.TransactionResult : 'unknown';
  }

  // 1. XRP → USDC
  const sendXrp = 10n * UNIT;
  const quote1 = await quoteSwap(read, XRP, USDC, sendXrp);
  const before1 = await balance(USDC);
  await payout(XRP, sendXrp, { asset: USDC, min: deliverMinOf(quote1) });
  const got1 = (await balance(USDC)) - before1;
  check('XRP → USDC inside a Batch, partial and routed through the AMM', got1 * 1e6 >= Number(deliverMinOf(quote1)), `quote ${Number(quote1) / 1e6}, got ${got1}`);

  // 2. USDC → RLUSD through XRP
  const sendUsdc = 5n * UNIT;
  const quote2 = await quoteSwap(read, USDC, RLUSD, sendUsdc);
  const before2 = await balance(RLUSD);
  await payout(USDC, sendUsdc, { asset: RLUSD, min: deliverMinOf(quote2) });
  const got2 = (await balance(RLUSD)) - before2;
  check('USDC → RLUSD through XRP, the same way', got2 * 1e6 >= Number(deliverMinOf(quote2)), `quote ${Number(quote2) / 1e6}, got ${got2}`);

  // 3. too high a DeliverMin
  const before3 = await balance(USDC);
  await payout(XRP, sendXrp, { asset: USDC, min: quote1 * 2n });
  check('a DeliverMin the AMM cannot meet: nothing applies', (await balance(USDC)) === before3, `still ${before3} USDC`);
} catch (error) {
  failures++;
  log(`FAIL  ${(error as Error).stack ?? error}`);
} finally {
  await client.disconnect();
}
log(failures === 0 ? '\nswap payouts work on testnet' : `\nswap spike FAILED: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
