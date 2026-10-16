#!/usr/bin/env node
// X0: proves the rules the XRPL L1 design rests on, on testnet, before any of
// it is built (HANDOVER.md §9).
//
//   npm run spike
//
// The two parts not proven anywhere else are a multisigned Batch from an
// account with a signer list, and SignerListSet as an inner transaction. A
// payout is one Batch ALLORNOTHING [CredentialCreate(nullifier), Payment,
// SignerListSet(next keys)], so a reused nullifier must fail the whole batch:
// no payment, no rotation.
//
// Every key here is generated per run and never printed. Testnet only.

import { randomBytes } from 'node:crypto';

import {
  AccountSetAsfFlags, BatchFlags, Client, GlobalFlags, Wallet, decode, hashes, multisign, xrpToDrops,
  type Batch, type LedgerEntry, type SubmittableTransaction, type TxResponse,
} from 'xrpl';

const client = new Client('wss://s.altnet.rippletest.net:51233');

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
};

const resultOf = (r: TxResponse) => (typeof r.result.meta === 'object' ? r.result.meta.TransactionResult : 'no meta');
const mustSucceed = (what: string, r: TxResponse) => {
  if (resultOf(r) !== 'tesSUCCESS') throw new Error(`${what}: ${resultOf(r)}`);
};

const signerList = (ws: Wallet[]) => ({
  SignerQuorum: 2,
  SignerEntries: ws.map((w) => ({ SignerEntry: { Account: w.address, SignerWeight: 1 } })),
});

// Outer Fee covers one signature per signer; Wallet.sign(tx, true) blanks SigningPubKey.
const multi = async (tx: SubmittableTransaction, signers: Wallet[]) => {
  const filled = await client.autofill(tx, signers.length);
  return multisign(signers.map((w) => w.sign(filled, true).tx_blob));
};

const balance = async (account: string) =>
  BigInt((await client.request({ command: 'account_info', account, ledger_index: 'validated' })).result.account_data.Balance);

const objects = async (account: string, type: 'credential' | 'signer_list') =>
  (await client.request({ command: 'account_objects', account, type, ledger_index: 'validated' })).result.account_objects;

const signerAccounts = async (account: string) =>
  ((await objects(account, 'signer_list'))[0] as LedgerEntry.SignerList | undefined)?.SignerEntries
    .map((e) => e.SignerEntry.Account).sort().join(',') ?? 'none';

const accounts = (ws: Wallet[]) => ws.map((w) => w.address).sort().join(',');

// Inner transactions carry no signature; their ids are hashes of the inner tx itself.
const innerResults = async (blob: string) =>
  Promise.all((decode(blob) as unknown as Batch).RawTransactions.map(async ({ RawTransaction: tx }) => {
    const hash = hashes.hashSignedTx(tx);
    const r = await client.request({ command: 'tx', transaction: hash }).then(
      (res) => resultOf(res as TxResponse),
      (err: { data?: { error?: string } }) => err.data?.error ?? String(err),
    );
    return `${tx.TransactionType}=${r}`;
  }));

try {
  await client.connect();

  // 1. Fund the pool P and a recipient R.
  const { wallet: P } = await client.fundWallet();
  const { wallet: R } = await client.fundWallet();
  console.log(`pool ${P.address}  recipient ${R.address}`);

  // 2. Three single-use signer sets. Signer keys need no funding.
  const S = Array.from({ length: 9 }, () => Wallet.generate());
  const [set1, set2, set3] = [S.slice(0, 3), S.slice(3, 6), S.slice(6, 9)];

  // 3. Set up P with its master key; disabling the master goes last.
  const asMaster = { autofill: true, wallet: P } as const;
  mustSucceed('SignerListSet', await client.submitAndWait({ TransactionType: 'SignerListSet', Account: P.address, ...signerList(set1) }, asMaster));
  mustSucceed('asfRequireDest', await client.submitAndWait({ TransactionType: 'AccountSet', Account: P.address, SetFlag: AccountSetAsfFlags.asfRequireDest }, asMaster));
  mustSucceed('asfDisableMaster', await client.submitAndWait({ TransactionType: 'AccountSet', Account: P.address, SetFlag: AccountSetAsfFlags.asfDisableMaster }, asMaster));

  const inner = (tx: SubmittableTransaction) => ({ RawTransaction: { ...tx, Flags: GlobalFlags.tfInnerBatchTxn } });
  const payout = (nullifier: string, next: Wallet[]): Batch => ({
    TransactionType: 'Batch',
    Account: P.address,
    Flags: BatchFlags.tfAllOrNothing,
    RawTransactions: [
      // Never an Expiration: an expired credential can be deleted and the note spent again.
      inner({ TransactionType: 'CredentialCreate', Account: P.address, Subject: P.address, CredentialType: nullifier }),
      inner({ TransactionType: 'Payment', Account: P.address, Destination: R.address, Amount: xrpToDrops(1) }),
      inner({ TransactionType: 'SignerListSet', Account: P.address, ...signerList(next) }),
    ],
  });
  const nullifier = randomBytes(16).toString('hex').toUpperCase();
  const credentials = async () =>
    ((await objects(P.address, 'credential')) as LedgerEntry.Credential[]).filter((c) => c.CredentialType === nullifier).length;

  // 4. Batch 1: a fresh nullifier pays R and rotates S1–S3 → S4–S6.
  const r0 = await balance(R.address);
  const blob1 = await multi(payout(nullifier, set2), set1.slice(0, 2));
  const b1 = await client.submitAndWait(blob1);
  console.log(`batch 1 ${b1.result.hash}: outer ${resultOf(b1)}, inner ${(await innerResults(blob1)).join(' ')}`);
  const r1 = await balance(R.address);
  check('batch 1 pays R 1 XRP', r1 - r0 === 1_000_000n, `R +${r1 - r0} drops`);
  check('batch 1 records the nullifier credential', (await credentials()) === 1, `${await credentials()} credential(s)`);
  check('batch 1 rotates the signer list to S4–S6', (await signerAccounts(P.address)) === accounts(set2), 'signer_list');

  // 5. Batch 2: the same nullifier must fail every inner tx, even though the outer succeeds.
  const blob2 = await multi(payout(nullifier, set3), set2.slice(0, 2));
  const b2 = await client.submitAndWait(blob2);
  const inner2 = await innerResults(blob2);
  console.log(`batch 2 ${b2.result.hash}: outer ${resultOf(b2)}, inner ${inner2.join(' ')}`);
  const r2 = await balance(R.address);
  check('reused nullifier: R unpaid', r2 === r1, `R +${r2 - r1} drops`);
  check('reused nullifier: signer list still S4–S6', (await signerAccounts(P.address)) === accounts(set2), 'signer_list');
  check('reused nullifier: still one credential', (await credentials()) === 1, `${await credentials()} credential(s)`);
  check('reused nullifier: no inner tx applied', inner2.every((s) => !s.endsWith('=tesSUCCESS')), inner2.join(' '));
  // A failed ALLORNOTHING batch records no inner tx, so ask rippled why on its own.
  const why = await client.simulate({ TransactionType: 'CredentialCreate', Account: P.address, Subject: P.address, CredentialType: nullifier });
  check('reused nullifier is tecDUPLICATE', why.result.engine_result === 'tecDUPLICATE', why.result.engine_result);

  // 6. Rotated-out keys are refused; the current ones work.
  const touch: SubmittableTransaction = { TransactionType: 'AccountSet', Account: P.address };
  const old = await client.submit(await multi(touch, set1.slice(0, 2)));
  check('old signer keys S1+S2 refused', old.result.engine_result.startsWith('tef'), old.result.engine_result);
  const cur = await client.submitAndWait(await multi(touch, set2.slice(0, 2)));
  check('current signer keys S4+S5 accepted', resultOf(cur) === 'tesSUCCESS', resultOf(cur));

  // 7. The disabled master key is refused.
  const master = await client.submit(touch, asMaster);
  check('disabled master key refused', master.result.engine_result === 'tefMASTER_DISABLED', master.result.engine_result);

  // 8. A deposit without a destination tag is refused.
  const tagless = await client.submitAndWait({ TransactionType: 'Payment', Account: R.address, Destination: P.address, Amount: xrpToDrops(1) }, { autofill: true, wallet: R });
  check('tagless payment to pool refused', resultOf(tagless) === 'tecDST_TAG_NEEDED', resultOf(tagless));
} finally {
  await client.disconnect();
}

// 9. Report.
console.log(failures === 0 ? '\nX0 passed' : `\nX0 FAILED: ${failures} check(s)`);
process.exitCode = failures === 0 ? 0 : 1;
