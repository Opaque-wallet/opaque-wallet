// Seeds TESTNET rings for note sizes nobody has deposited yet.
//
//   cd backend && node --use-system-ca xrpl/seed-rings.ts [--max-xrp 1000]
//
// A size takes deposits once seven others sit in it (frontend: liveSizes), so
// a new size starts with seven deposits whose secrets are thrown away: decoys
// nobody can ever spend, from one operator, so an anonymity set in name only.
// Testnet only. Tokens come from our own test issuers, every size up to the
// largest; XRP from the faucet (100 a call), sizes up to --max-xrp.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BatchFlags, Client, GlobalFlags, Wallet, type Batch, type Payment } from 'xrpl';

import { xrplDeployment, type XrplPoolDeployment } from '../../deployments/xrpl/index.ts';
import { createNoteSecret, deriveCommitment } from '../zk/index.ts';
import { XRPL_STATE } from './node.ts';
import { createPoolSource } from './pool.ts';
import { amountOf, INVOICE_TAG, invoiceIdOf, scopeOf, type XrplAsset } from './protocol.ts';

if (xrplDeployment.network.name !== 'xrpl-testnet') throw new Error('seed-rings is for testnet only: its decoys are burned');
const MAX_XRP = Number(process.argv[process.argv.indexOf('--max-xrp') + 1] ?? 1000) || 1000;
const OTHERS = 7;
const UNIT = 1_000_000;
const log = (s: string) => process.stdout.write(`${s}\n`);

const client = new Client(xrplDeployment.network.wss);
await client.connect();
const keyOf = (file: string) => Wallet.fromSeed((JSON.parse(readFileSync(join(XRPL_STATE, file), 'utf8')) as { seed: string }).seed);
const issuers = ['issuer.json', 'issuer-usdc.json', 'issuer-mpt.json'].map(keyOf);
const assetOf = (p: XrplPoolDeployment): XrplAsset => p.asset as XrplAsset;

/** Who pays a pool's decoys: its token's issuer, or for XRP a faucet-funded seeder. */
function funderOf(p: XrplPoolDeployment): Wallet {
  const a = assetOf(p);
  if (a.kind === 'IOU') return issuers.find((w) => w.address === a.issuer) ?? (() => { throw new Error(`no issuer key for ${p.symbol}`); })();
  if (a.kind === 'MPT') return issuers[2]!;
  return Wallet.generate();
}

async function xrpOf(address: string): Promise<number> {
  return Number(await client.getXrpBalance(address).catch(() => '0'));
}

for (const p of xrplDeployment.pools) {
  const source = createPoolSource({ client, config: { account: p.account, asset: assetOf(p), sizes: p.sizes, deployedAtLedger: p.deployedAtLedger } });
  await source.sync();
  const have = new Map<number, number>();
  for (const d of source.log().deposits) have.set(d.denomination, (have.get(d.denomination) ?? 0) + 1);
  const cap = assetOf(p).kind === 'XRP' ? MAX_XRP * UNIT : Infinity;
  const todo = p.sizes.filter((s) => s <= cap).map((s) => [s, Math.max(0, OTHERS - (have.get(s) ?? 0))] as const).filter(([, n]) => n > 0);
  if (todo.length === 0) { log(`${p.symbol}: every size up to ${cap === Infinity ? 'the largest' : MAX_XRP} has a ring`); continue; }
  const funder = funderOf(p);
  if (assetOf(p).kind === 'XRP') {
    const need = todo.reduce((n, [s, k]) => n + (s / UNIT) * k, 0) + 20;
    log(`${p.symbol}: ${need} XRP from the faucet, 100 a call…`);
    for (let tries = 0; await xrpOf(funder.address) < need; tries++) {
      await client.fundWallet(funder).catch(async (e: Error) => {
        if (tries > 2_000) throw e;
        await new Promise((r) => setTimeout(r, 5_000));
      });
    }
  }
  // Eight payments a Batch, all or nothing.
  const queue = todo.flatMap(([s, n]) => Array.from({ length: n }, () => s));
  for (let i = 0; i < queue.length; i += 8) {
    const raws = queue.slice(i, i + 8).map((size) => ({ RawTransaction: {
      TransactionType: 'Payment', Account: funder.address, Destination: p.account, DestinationTag: INVOICE_TAG,
      Amount: amountOf(assetOf(p), BigInt(size)),
      InvoiceID: invoiceIdOf(deriveCommitment(createNoteSecret(), scopeOf(xrplDeployment.network.networkId, p.account, size))),
      Flags: GlobalFlags.tfInnerBatchTxn,
    } as Payment }));
    // A Batch holds at least two: one alone goes as itself.
    const tx = raws.length === 1
      ? { ...raws[0]!.RawTransaction, Flags: 0 }
      : { TransactionType: 'Batch', Account: funder.address, Flags: BatchFlags.tfAllOrNothing, RawTransactions: raws } as Batch;
    const r = await client.submitAndWait(tx as never, { autofill: true, wallet: funder });
    const result = typeof r.result.meta === 'object' ? (r.result.meta as { TransactionResult: string }).TransactionResult : '?';
    if (result !== 'tesSUCCESS') throw new Error(`${p.symbol} decoys: ${result}`);
  }
  log(`${p.symbol}: seeded ${todo.map(([s, n]) => `${n}×${s / UNIT}`).join(', ')}`);
}
await client.disconnect();
