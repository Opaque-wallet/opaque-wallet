#!/usr/bin/env node
// Creates Opaque's XRPL TESTNET pools and writes deployments/xrpl/testnet.json.
//
//   cd backend && npm run xrpl:setup [-- --force]      XRP and RLUSD, afresh
//   cd backend && npm run xrpl:setup -- --add USDC     one more pool: a trust-line
//   cd backend && npm run xrpl:setup -- --add MPT      token, or a Multi-Purpose Token
//
// For each pool, from a faucet-funded account and its master key:
//   TrustSet (tokens, NoRipple on the pool's side) or MPTokenAuthorize (MPTs)
//   SignerListSet   each attester's first key in its chain for this pool
//   AccountSet      asfRequireDest: a payment without a tag is refused
//   AccountSet      asfDisableMaster, last: from here only the quorum signs
//
// Testnet RLUSD and USDC come from web faucets, so these pools trust test
// issuers of ours, set up like the real ones: RLUSD with clawback, USDC able to
// freeze but not claw back, the MPT able to transfer. The issuers' seeds stay
// in .stack/xrpl/, to mint test tokens. Every issuer is checked first: one
// that charges a transfer fee, or must authorize holders, cannot back a pool.
//
// Testnet only, and never with a key that has signed on mainnet.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AccountSetAsfFlags, Client, MPTokenIssuanceCreateFlags, TrustSetFlags, Wallet, type SubmittableTransaction } from 'xrpl';

import { fromHex } from '@opaque/protocol-types/codecs.js';

import { xrplDeployment, type XrplPoolDeployment } from '../../deployments/xrpl/index.ts';
import { attesterChain, signerListOf } from './attester.ts';
import { attesterFile, XRPL_STATE } from './node.ts';
import type { XrplAsset } from './protocol.ts';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deployments', 'xrpl', 'testnet.json');
const SIZES = [1_000_000, 10_000_000, 100_000_000];
const hexCode = (code: string) => Buffer.from(code, 'ascii').toString('hex').toUpperCase().padEnd(40, '0');
const log = (s: string) => process.stdout.write(`${s}\n`);
const ADD = process.argv.includes('--add') ? process.argv[process.argv.indexOf('--add') + 1] : undefined;

if (xrplDeployment.network.name !== 'xrpl-testnet') throw new Error('setup-pools creates testnet pools only');
if (ADD === undefined && xrplDeployment.pools.length > 0 && !process.argv.includes('--force')) {
  throw new Error('deployments/xrpl/testnet.json already names pools; --force makes new ones (notes in the old pools stay there), --add adds one');
}
if (ADD !== undefined && !['USDC', 'MPT'].includes(ADD)) throw new Error('--add USDC or --add MPT');
if (ADD !== undefined && xrplDeployment.pools.some((p) => p.symbol === (ADD === 'MPT' ? 'tMPT' : ADD))) throw new Error(`a ${ADD} pool exists already`);

const client = new Client(xrplDeployment.network.wss);
await client.connect();
const send = async (tx: SubmittableTransaction, wallet: Wallet) => {
  const r = await client.submitAndWait(tx, { autofill: true, wallet });
  const result = typeof r.result.meta === 'object' ? r.result.meta.TransactionResult : '?';
  if (result !== 'tesSUCCESS') throw new Error(`${tx.TransactionType} from ${wallet.address}: ${result}`);
  return r.result;
};
const saveIssuer = (name: string, wallet: Wallet) => writeFileSync(join(XRPL_STATE, name), JSON.stringify({ seed: wallet.seed }), { mode: 0o600 });

/**
 * Whether an issuer can back a pool. Refused: a transfer fee (a payout would
 * deliver less than the note, or need more than the pool holds) and required
 * authorization (the issuer could lock the pool out). Clawback and freeze are
 * allowed and reported: they are the issuer's power over every note at once.
 */
async function checkIssuer(asset: XrplAsset): Promise<string> {
  if (asset.kind === 'XRP') return 'no issuer';
  if (asset.kind === 'IOU') {
    const a = (await client.request({ command: 'account_info', account: asset.issuer, ledger_index: 'validated' })).result.account_data;
    if (a.TransferRate !== undefined && a.TransferRate !== 0 && a.TransferRate !== 1_000_000_000) throw new Error(`${asset.issuer} charges a transfer fee`);
    if ((a.Flags & 0x0004_0000) !== 0) throw new Error(`${asset.issuer} requires authorization`);
    return [(a.Flags & 0x8000_0000) !== 0 ? 'can claw back' : 'no clawback', (a.Flags & 0x0020_0000) !== 0 ? 'cannot freeze' : 'can freeze'].join(', ');
  }
  const issuance = (await (client.request as (r: unknown) => Promise<{ result: unknown }>)({ command: 'ledger_entry', mpt_issuance: asset.issuanceId, ledger_index: 'validated' })).result as { node: { Flags: number; TransferFee?: number } };
  if ((issuance.node.TransferFee ?? 0) !== 0) throw new Error('the MPT charges a transfer fee');
  if ((issuance.node.Flags & 0x04) !== 0) throw new Error('the MPT requires authorization');
  if ((issuance.node.Flags & 0x20) === 0) throw new Error('the MPT cannot be transferred between holders');
  return [(issuance.node.Flags & 0x40) !== 0 ? 'can claw back' : 'no clawback', (issuance.node.Flags & 0x02) !== 0 ? 'can lock' : 'cannot lock'].join(', ');
}

async function createPool(spec: { symbol: string; asset: XrplAsset; spendFee: string; moonpay: string | null }, deployedAtLedger: number): Promise<XrplPoolDeployment> {
  const controls = await checkIssuer(spec.asset);
  const seeds = attesterFile().seeds.map((s) => fromHex(s as `0x${string}`));
  const { wallet: pool } = await client.fundWallet();
  if (spec.asset.kind === 'IOU') {
    await send({
      TransactionType: 'TrustSet', Account: pool.address, Flags: TrustSetFlags.tfSetNoRipple,
      LimitAmount: { currency: spec.asset.currency, issuer: spec.asset.issuer, value: '1000000000' },
    }, pool);
  }
  if (spec.asset.kind === 'MPT') await send({ TransactionType: 'MPTokenAuthorize', Account: pool.address, MPTokenIssuanceID: spec.asset.issuanceId }, pool);
  const first = seeds.map((seed) => attesterChain(seed, pool.address).addressAt(0)).sort();
  await send({
    TransactionType: 'SignerListSet', Account: pool.address, SignerQuorum: xrplDeployment.attesters.quorum,
    SignerEntries: first.map((Account) => ({ SignerEntry: { Account, SignerWeight: 1 } })),
  }, pool);
  await send({ TransactionType: 'AccountSet', Account: pool.address, SetFlag: AccountSetAsfFlags.asfRequireDest }, pool);
  await send({ TransactionType: 'AccountSet', Account: pool.address, SetFlag: AccountSetAsfFlags.asfDisableMaster }, pool);
  const list = await signerListOf(client, pool.address);
  log(`${spec.symbol.padEnd(6)} pool ${pool.address}  signers ${list.quorum}-of-${list.signers.length}, master disabled; issuer: ${controls}`);
  return { ...spec, asset: spec.asset as XrplPoolDeployment['asset'], account: pool.address, sizes: SIZES, deployedAtLedger };
}

/** A test token issuer: clawback must be allowed before it has any trust line. */
async function tokenIssuer(file: string, clawback: boolean): Promise<Wallet> {
  const { wallet } = await client.fundWallet();
  if (clawback) await send({ TransactionType: 'AccountSet', Account: wallet.address, SetFlag: AccountSetAsfFlags.asfAllowTrustLineClawback }, wallet);
  await send({ TransactionType: 'AccountSet', Account: wallet.address, SetFlag: AccountSetAsfFlags.asfDefaultRipple }, wallet);
  saveIssuer(file, wallet);
  return wallet;
}

try {
  const deployedAtLedger = await client.getLedgerIndex();
  const json = JSON.parse(readFileSync(FILE, 'utf8')) as { pools: XrplPoolDeployment[] } & Record<string, unknown>;
  let pools: XrplPoolDeployment[];
  if (ADD === undefined) {
    const rlusdIssuer = await tokenIssuer('issuer.json', true);
    log(`test RLUSD issuer ${rlusdIssuer.address}`);
    // MoonPay's RLUSD-on-XRPL code is unconfirmed, and it could not deliver this test issuer's token anyway.
    pools = [
      await createPool({ symbol: 'XRP', asset: { kind: 'XRP' }, spendFee: '200100', moonpay: 'xrp' }, deployedAtLedger),
      await createPool({ symbol: 'RLUSD', asset: { kind: 'IOU', currency: hexCode('RLUSD'), issuer: rlusdIssuer.address }, spendFee: '500000', moonpay: null }, deployedAtLedger),
    ];
  } else if (ADD === 'USDC') {
    const usdcIssuer = await tokenIssuer('issuer-usdc.json', false);
    log(`test USDC issuer ${usdcIssuer.address}`);
    pools = [...json.pools, await createPool({ symbol: 'USDC', asset: { kind: 'IOU', currency: 'USD', issuer: usdcIssuer.address }, spendFee: '500000', moonpay: null }, deployedAtLedger)];
  } else {
    // An MPT at AssetScale 2: one note of 1 is 100 base units.
    const { wallet: mptIssuer } = await client.fundWallet();
    const created = await send({
      TransactionType: 'MPTokenIssuanceCreate', Account: mptIssuer.address, AssetScale: 2, MaximumAmount: '100000000000',
      Flags: MPTokenIssuanceCreateFlags.tfMPTCanTransfer | MPTokenIssuanceCreateFlags.tfMPTCanClawback,
    }, mptIssuer);
    const issuanceId = String((created.meta as { mpt_issuance_id?: string }).mpt_issuance_id).toUpperCase();
    saveIssuer('issuer-mpt.json', mptIssuer);
    log(`test MPT ${issuanceId} from ${mptIssuer.address}`);
    pools = [...json.pools, await createPool({ symbol: 'tMPT', asset: { kind: 'MPT', issuanceId, scale: 2 }, spendFee: '500000', moonpay: null }, deployedAtLedger)];
  }
  writeFileSync(FILE, `${JSON.stringify({ ...json, pools }, null, 2)}\n`);
  log(`wrote ${FILE}${existsSync(FILE) ? '' : ' (new)'}`);
} finally {
  await client.disconnect();
}
