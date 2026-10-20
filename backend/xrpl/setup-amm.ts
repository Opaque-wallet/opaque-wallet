#!/usr/bin/env node
// Liquidity for private swaps on XRPL TESTNET: an AMM between XRP and each
// trust-line token the pools hold (RLUSD, USDC), which the ledger's own
// path-finding routes through. The tokens are Opaque's test issuers', so a
// market maker account takes some, and puts them in beside faucet XRP.
//
//   cd backend && node --use-system-ca xrpl/setup-amm.ts [--check]
//
// --check reads the AMMs and changes nothing. Without it, a pair that has no
// AMM gets one, XRP_PER_AMM XRP and enough of the token for PRICE; one that is
// shallower than that is deepened at its own price. The maker's seed is kept
// in .stack/xrpl/amm-maker.json.
// Testnet only: the tokens and the XRP are worthless.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AMMDepositFlags, Client, Wallet, xrpToDrops, type AMMCreate, type AMMDeposit, type Payment, type TrustSet } from 'xrpl';

import { xrplDeployment } from '../../deployments/xrpl.ts';

const STACK = join(dirname(fileURLToPath(import.meta.url)), '..', '.stack', 'xrpl');
const CHECK = process.argv.includes('--check');
/** XRP per AMM, and tokens per XRP: testnet's stand-in for a market price. */
const XRP_PER_AMM = 900;
const PRICE: Record<string, number> = { RLUSD: 1, USDC: 1 };
const TRADING_FEE = 300; // 0.3%, in units of 1/100,000
const log = (s: string) => process.stdout.write(`${s}\n`);

if (xrplDeployment.network.networkId !== 1) throw new Error('setup-amm.ts is for XRPL testnet only');
const client = new Client(xrplDeployment.network.wss);
await client.connect();
const send = async (tx: Payment | TrustSet | AMMCreate | AMMDeposit, wallet: Wallet) => {
  const r = await client.submitAndWait(tx, { wallet, autofill: true });
  const result = typeof r.result.meta === 'object' ? r.result.meta.TransactionResult : 'unknown';
  if (result !== 'tesSUCCESS') throw new Error(`${tx.TransactionType} failed: ${result}`);
};

const tokens = xrplDeployment.pools.flatMap((p) => (p.asset.kind === 'IOU' ? [{ symbol: p.symbol, currency: p.asset.currency, issuer: p.asset.issuer }] : []));
const ammOf = (t: (typeof tokens)[number]) => client.request({ command: 'amm_info', asset: { currency: 'XRP' }, asset2: { currency: t.currency, issuer: t.issuer } } as never)
  .then((r) => (r as { result: { amm: { amount: string; amount2: { value: string }; trading_fee: number } } }).result.amm, () => null);

try {
  for (const t of tokens) {
    const amm = await ammOf(t);
    log(amm === null ? `${t.symbol}: no AMM` : `${t.symbol}: AMM holds ${Number(amm.amount) / 1e6} XRP and ${amm.amount2.value} ${t.symbol}, fee ${amm.trading_fee / 1000}%`);
  }
  if (!CHECK) {
    const makerFile = join(STACK, 'amm-maker.json');
    const maker = existsSync(makerFile) ? Wallet.fromSeed((JSON.parse(readFileSync(makerFile, 'utf8')) as { seed: string }).seed) : Wallet.generate();
    if (!existsSync(makerFile)) writeFileSync(makerFile, JSON.stringify({ seed: maker.seed }), { mode: 0o600 });
    for (const t of tokens) {
      const existing = await ammOf(t);
      if (existing !== null && Number(existing.amount) / 1e6 >= XRP_PER_AMM / 2) continue;
      // An AMM someone made already keeps its price; a new one starts at PRICE.
      const xrp = existing === null ? XRP_PER_AMM : XRP_PER_AMM - Math.floor(Number(existing.amount) / 1e6);
      const price = existing === null ? PRICE[t.symbol]! : Number(existing.amount2.value) / (Number(existing.amount) / 1e6);
      // Faucet XRP until the maker can put XRP_PER_AMM in, and keep its reserves.
      for (;;) {
        const balance = await client.getXrpBalance(maker.address).catch(() => 0);
        if (balance >= xrp + 20) break;
        log(`  maker ${maker.address}: ${balance} XRP, asking the faucet for more…`);
        await client.fundWallet(maker, { amount: '1000' } as never);
      }
      const issuers = { RLUSD: 'issuer.json', USDC: 'issuer-usdc.json' } as Record<string, string>;
      const issuer = Wallet.fromSeed((JSON.parse(readFileSync(join(STACK, issuers[t.symbol]!), 'utf8')) as { seed: string }).seed);
      if (issuer.address !== t.issuer) throw new Error(`${issuers[t.symbol]} is not ${t.symbol}'s issuer`);
      // A little over the price for a deposit: tfTwoAsset takes both in the AMM's ratio, and no more.
      const value = (xrp * price * (existing === null ? 1 : 1.02)).toFixed(6);
      await send({ TransactionType: 'TrustSet', Account: maker.address, LimitAmount: { currency: t.currency, issuer: t.issuer, value: '1000000000' } }, maker);
      await send({ TransactionType: 'Payment', Account: issuer.address, Destination: maker.address, Amount: { currency: t.currency, issuer: t.issuer, value } }, issuer);
      const token = { currency: t.currency, issuer: t.issuer };
      await send(existing === null
        ? { TransactionType: 'AMMCreate', Account: maker.address, Amount: xrpToDrops(xrp), Amount2: { ...token, value }, TradingFee: TRADING_FEE }
        : { TransactionType: 'AMMDeposit', Account: maker.address, Asset: { currency: 'XRP' }, Asset2: token, Amount: xrpToDrops(xrp), Amount2: { ...token, value }, Flags: AMMDepositFlags.tfTwoAsset }, maker);
      const amm = await ammOf(t);
      log(`${t.symbol}: AMM ${existing === null ? 'made' : 'deepened'}, now ${Number(amm!.amount) / 1e6} XRP and ${amm!.amount2.value} ${t.symbol}`);
    }
  }
} finally {
  await client.disconnect();
}
