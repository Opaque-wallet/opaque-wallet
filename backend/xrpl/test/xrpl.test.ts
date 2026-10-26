import { createHash } from 'node:crypto';
// The XRPL layer's rules, offline: crediting, the recipient binding, amounts,
// and what an attester refuses to sign. The ledger itself is exercised by
// spike.ts and e2e-payment.ts on testnet.

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { hashes, Wallet, type Batch, type Client, type SignerListSet } from 'xrpl';

import { ProtocolFailure, type ApprovedRelease, type NoteCommitment, type Nullifier } from '@opaque/protocol-types';

import { buildRingSpend, createNoteSecret, deriveCommitment, verifierId } from '../../zk/index.ts';
import { createAttester, attesterChain, nextSignersOf, type Attester, type XrplSpend } from '../attester.ts';
import { checkProposal, payoutBatch, rotationOf, signerListOf, type Payout } from '../batch.ts';
import { keyChain } from '../keys.ts';
import { createPoolSource, creditDeposits, incomingOf, type IncomingPayment } from '../pool.ts';
import { amountOf, recipientFor, scopeOf, splitAmount, unitsDelivered, unitsOfDecimal, type XrplAsset } from '../protocol.ts';
import { createXrplAnswerer } from '../queries.ts';
import { createXrplSettlement, toTxHash } from '../settlement.ts';
import { toHex } from '@opaque/protocol-types/codecs.js';

const POOL = 'rw5r7pX37iAtLEh1VZdciHaFpduftUtjYe';
const ALICE = 'rPNFdbacMgCk6diE8wtyBxh3ggro2QLWK5';
const ISSUER = 'rpEJVjwRVZ8Q2ddgpHVukxgWKz9L9UwFzF';
const RLUSD: XrplAsset = { kind: 'IOU', currency: '524C555344000000000000000000000000000000', issuer: ISSUER };
const XRP = 1_000_000;
const SIZES = [XRP, 10 * XRP, 100 * XRP];

const c = (n: number) => `0x${n.toString(16).padStart(32, '0')}${'0'.repeat(32)}` as NoteCommitment;
const pay = (over: Partial<IncomingPayment>): IncomingPayment =>
  ({ hash: 'H', ledgerIndex: 10, from: ALICE, units: BigInt(XRP), tag: null, invoiceId: null, ...over });

test('the recipient binds the account and the tag, and "no tag" is not tag 0', () => {
  const none = recipientFor({ account: ALICE, tag: null });
  assert.equal(recipientFor({ account: ALICE, tag: null }), none);
  assert.notEqual(recipientFor({ account: ALICE, tag: 0 }), none);
  assert.notEqual(recipientFor({ account: ALICE, tag: 1 }), recipientFor({ account: ALICE, tag: 0 }));
  assert.notEqual(recipientFor({ account: POOL, tag: null }), none);
  assert.match(none, /^0x[0-9a-f]{40}$/);
});

test('ledger decimals become micro-units, rounded down', () => {
  assert.equal(unitsOfDecimal('12.5'), 12_500_000n);
  assert.equal(unitsOfDecimal('0.000001'), 1n);
  assert.equal(unitsOfDecimal('1e-7'), 0n);
  assert.equal(unitsOfDecimal('1.25e3'), 1_250_000_000n);
  assert.equal(unitsOfDecimal('100'), 100_000_000n);
  assert.throws(() => unitsOfDecimal('-1'));
  assert.throws(() => unitsOfDecimal('1,5'));
  const currency = '524C555344000000000000000000000000000000';
  assert.deepEqual(amountOf(RLUSD, 10_500_000n), { currency, issuer: ISSUER, value: '10.5' });
  assert.deepEqual(amountOf(RLUSD, 1_000_000n), { currency, issuer: ISSUER, value: '1' });
  assert.equal(amountOf({ kind: 'XRP' }, 1_000_000n), '1000000');
});

test('a token pool counts only its own currency from its own issuer', () => {
  const v = (currency: string, issuer: string) => ({ currency, issuer, value: '2.5' });
  const currency = RLUSD.kind === 'IOU' ? RLUSD.currency : '';
  assert.equal(unitsDelivered(RLUSD, POOL, v(currency, ISSUER)), 2_500_000n);
  assert.equal(unitsDelivered(RLUSD, POOL, v(currency.toLowerCase(), POOL)), 2_500_000n, 'destination-as-issuer spelling');
  assert.equal(unitsDelivered(RLUSD, POOL, v(currency, ALICE)), null);
  assert.equal(unitsDelivered(RLUSD, POOL, v('USD', ISSUER)), null);
  assert.equal(unitsDelivered(RLUSD, POOL, '1000000'), null, 'XRP into a token pool');
  assert.equal(unitsDelivered({ kind: 'XRP' }, POOL, '1000000'), 1_000_000n);
});

test('a partial payment is credited what it delivered, never its Amount', () => {
  const entry = {
    validated: true, hash: 'AB', ledger_index: 7,
    tx_json: { TransactionType: 'Payment', Account: ALICE, Destination: POOL, Amount: '100000000', DestinationTag: 5, Flags: 131072 },
    meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '1000' },
  };
  assert.equal(incomingOf(POOL, { kind: 'XRP' }, entry)?.units, 1000n);
  assert.equal(incomingOf(POOL, { kind: 'XRP' }, { ...entry, validated: false }), null);
  assert.equal(incomingOf(POOL, { kind: 'XRP' }, { ...entry, meta: { ...entry.meta, TransactionResult: 'tecPATH_DRY' } }), null);
  assert.equal(incomingOf(POOL, { kind: 'XRP' }, { ...entry, tx_json: { ...entry.tx_json, Account: POOL } }), null, 'the pool\'s own payouts');
  const closed = { ...entry, tx_json: { TransactionType: 'AccountDelete', Account: ALICE, Destination: POOL, DestinationTag: 5 }, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '8099680' } };
  assert.equal(incomingOf(POOL, { kind: 'XRP' }, closed)?.units, 8_099_680n, 'a closed app account pays in by AccountDelete');
  assert.equal(incomingOf(POOL, { kind: 'XRP' }, { ...closed, tx_json: { ...closed.tx_json, TransactionType: 'EscrowFinish' } }), null);
});

test('InvoiceID deposits: one exact note, a 128-bit commitment, never twice', () => {
  const invoice = (n: number) => c(n).slice(2).toUpperCase();
  const log = creditDeposits([
    pay({ tag: 0, invoiceId: invoice(1), units: BigInt(XRP) }),
    pay({ tag: 0, invoiceId: invoice(2), units: 1_500_000n }),
    pay({ tag: 0, invoiceId: 'FF'.repeat(32), units: BigInt(XRP) }),
    pay({ tag: 0, invoiceId: invoice(1), units: BigInt(XRP) }),
    pay({ tag: 0, invoiceId: null }),
  ], SIZES, new Map());
  assert.deepEqual(log.deposits.map((d) => [d.commitment, d.denomination]), [[c(1), XRP]]);
  assert.equal(log.unmatched.length, 4);
});

test('a tag is split greedily into its commitments, and the remainder waits on the tag', () => {
  const tags = new Map([[77, { [String(100 * XRP)]: [c(1)], [String(10 * XRP)]: [c(2), c(3)], [String(XRP)]: [c(4), c(5), c(6), c(7)] }]]);
  const first = creditDeposits([pay({ tag: 77, units: 123_500_000n })], SIZES, tags);
  assert.deepEqual(first.deposits.map((d) => [d.commitment, d.denomination]), [
    [c(1), 100 * XRP], [c(2), 10 * XRP], [c(3), 10 * XRP], [c(4), XRP], [c(5), XRP], [c(6), XRP],
  ]);
  assert.equal(first.carried.get(77), 500_000n);
  const second = creditDeposits([pay({ tag: 77, units: 123_500_000n }), pay({ tag: 77, units: 600_000n })], SIZES, tags);
  assert.equal(second.deposits.at(-1)?.commitment, c(7));
  assert.equal(second.carried.get(77), 100_000n);
  // Out of commitments: what is left stays carried rather than inventing notes.
  const third = creditDeposits([pay({ tag: 77, units: 300_000_000n })], SIZES, tags);
  assert.equal(third.deposits.length, 7);
  assert.equal(third.carried.get(77), 300_000_000n - 100_000_000n - 20_000_000n - 4_000_000n);
  assert.equal(creditDeposits([pay({ tag: 78 })], SIZES, tags).unmatched.length, 1, 'an unregistered tag');
});

const fakeLedger = (handlers: Record<string, (req: Record<string, unknown>) => unknown>) => ({
  async request(req: Record<string, unknown>) {
    const h = handlers[String(req['command'])];
    if (h === undefined) throw new Error(`unexpected ${String(req['command'])}`);
    return { result: await h(req) };
  },
  getLedgerIndex: async () => 1000,
}) as unknown as Client;

test('a tag is refused once used, paid, malformed or overlapping', async () => {
  const source = createPoolSource({
    client: fakeLedger({
      account_tx: () => ({ ledger_index_max: 50, transactions: [{
        validated: true, hash: 'AA', ledger_index: 20,
        tx_json: { TransactionType: 'Payment', Account: ALICE, Destination: POOL, DestinationTag: 9 },
        meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '5' },
      }] }),
    }),
    config: { account: POOL, asset: { kind: 'XRP' }, sizes: SIZES, deployedAtLedger: 10 },
  });
  await source.sync();
  const ok = { [String(XRP)]: [c(1)] };
  assert.throws(() => source.registerTag(0, ok), /0 is for InvoiceID/);
  assert.throws(() => source.registerTag(9, ok), /already in use/, 'a tag that was already paid');
  source.registerTag(10, ok);
  assert.throws(() => source.registerTag(10, { [String(XRP)]: [c(2)] }), /already in use/);
  assert.throws(() => source.registerTag(11, ok), /another tag/);
  assert.throws(() => source.registerTag(12, { [String(2 * XRP)]: [c(3)] }), /no 2000000 note/);
  assert.throws(() => source.registerTag(13, { [String(XRP)]: [c(4), c(4)] }), /twice/);
  assert.throws(() => source.registerTag(14, { [String(XRP)]: Array.from({ length: 65 }, (_, i) => c(100 + i)) }), /1 to 64/);
  assert.throws(() => source.registerTag(15, { [String(XRP)]: [`0x${'ab'.repeat(32)}` as NoteCommitment] }), /128-bit/);
});

const PAYOUT: Payout = {
  pool: POOL, asset: { kind: 'XRP' }, nullifiers: [c(9) as unknown as Nullifier],
  destination: { account: ALICE, tag: 4 }, units: 799_900n, nextSigners: [ALICE, ISSUER], quorum: 2,
};
const filled = (b: Batch, seq = 100): Batch => ({
  ...b, Sequence: seq, Fee: '60', LastLedgerSequence: 1010, SigningPubKey: '',
  RawTransactions: b.RawTransactions.map((r, i) => ({ RawTransaction: { ...r.RawTransaction, Sequence: seq + 1 + i, Fee: '0', SigningPubKey: '' } })),
}) as Batch;
const check = (proposed: Batch) => checkProposal({ expected: payoutBatch(PAYOUT), proposed, poolSequence: 100, maxFeeDrops: 2000n, maxLastLedger: 1030, networkId: 1 });

test('an attester signs exactly the payout it verified, and nothing nearby', () => {
  check(filled(payoutBatch(PAYOUT)));
  assert.throws(() => check(filled(payoutBatch({ ...PAYOUT, units: 999_999n }))), /not the payout/);
  assert.throws(() => check(filled(payoutBatch({ ...PAYOUT, destination: { account: ALICE, tag: 5 } }))), /not the payout/);
  assert.throws(() => check(filled(payoutBatch({ ...PAYOUT, nextSigners: [ALICE, POOL] }))), /not the payout/);
  assert.throws(() => check(filled(payoutBatch(PAYOUT), 101)), /next sequence/);
  assert.throws(() => check({ ...filled(payoutBatch(PAYOUT)), Fee: '5000' }), /fee/);
  assert.throws(() => check({ ...filled(payoutBatch(PAYOUT)), LastLedgerSequence: 5000 }), /window/);
  assert.throws(() => check({ ...filled(payoutBatch(PAYOUT)), NetworkID: 21338 }), /another network/);
  const inner = filled(payoutBatch(PAYOUT));
  assert.throws(() => check({ ...inner, RawTransactions: inner.RawTransactions.map((r) => ({ RawTransaction: { ...r.RawTransaction, NetworkID: 0 } })) } as Batch), /another network/);
  const expired = payoutBatch(PAYOUT);
  const withExpiry = { ...expired, RawTransactions: expired.RawTransactions.map((r, i) => (i === 0 ? { RawTransaction: { ...r.RawTransaction, Expiration: 1 } } : r)) } as Batch;
  assert.throws(() => check(filled(withExpiry)), /not the payout/, 'an Expiration would let the credential be deleted');
  assert.throws(() => payoutBatch({ ...PAYOUT, nullifiers: Array.from({ length: 7 }, (_, i) => c(i) as unknown as Nullifier) }), /1 to 6/);
});

test('a rotation alone is signed only as every key to its next one', () => {
  const rotation = rotationOf(POOL, [ALICE, ISSUER], 2);
  // As xrpl.js autofill leaves it: Flags 0 among what it adds (the first testnet run caught this).
  const proposed = { ...rotation, Flags: 0, Sequence: 100, Fee: '40', LastLedgerSequence: 1010, SigningPubKey: '' } as SignerListSet;
  const checkRotation = (p: Batch | SignerListSet) => checkProposal({ expected: rotation, proposed: p, poolSequence: 100, maxFeeDrops: 2000n, maxLastLedger: 1030, networkId: 1 });
  checkRotation(proposed);
  assert.throws(() => checkRotation({ ...proposed, ...signerListOf([ALICE, POOL], 2) }), /not the payout/, 'other keys');
  assert.throws(() => checkRotation({ ...proposed, SignerQuorum: 1 }), /not the payout/, 'a lower quorum');
  assert.throws(() => checkRotation(filled(payoutBatch(PAYOUT))), /not the payout/, 'a payout passed off as a rotation');
  assert.throws(() => checkRotation({ ...proposed, Sequence: 99 }), /next sequence/);
  assert.throws(() => checkRotation({ ...proposed, LastLedgerSequence: 5000 }), /window/);
});

test('key chains are deterministic, per pool, and found again from the ledger', () => {
  const seed = new Uint8Array(32).fill(7);
  const chain = keyChain(seed, 'attester/x');
  assert.equal(chain.addressAt(3), keyChain(seed, 'attester/x').addressAt(3));
  assert.notEqual(attesterChain(seed, POOL).addressAt(0), attesterChain(seed, ALICE).addressAt(0));
  assert.equal(chain.indexOf(chain.addressAt(5)), 5);
  assert.equal(chain.indexOf(chain.addressAt(5), 6), undefined);
});

test('an attester more than a window behind (another operator rotated past it) finds its listed key', () => {
  const seeds = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
  const at = (i: number) => seeds.map((s) => attesterChain(s, POOL).addressAt(i));
  const saved: number[] = [];
  const all: Attester[] = seeds.map((seed, i) => createAttester({
    id: `A${i + 1}`, seed, client: {} as Client, networkId: 1, pools: new Map([[POOL, {} as never]]), verifierId: verifierId(2), peers: () => all,
    startIndex: new Map([[POOL, 25]]), onIndex: (_, index) => saved.push(index),
  }));
  assert.deepEqual(nextSignersOf(POOL, at(146), all), at(147), '121 keys on, past the 64 it searches first');
  assert.deepEqual(saved, [146, 146, 146], 'and the stack saves where it found them');
});

test('an attester refuses a spend before it ever signs', async () => {
  const scope = scopeOf(1, POOL, XRP);
  const secrets = Array.from({ length: 8 }, () => createNoteSecret());
  const ring = secrets.map((s) => deriveCommitment(s, scope));
  const destination = { account: ALICE, tag: null };
  // 2 repetitions: a valid proof at the WRONG verifier, which is the point of one case below.
  const spend = { ...buildRingSpend({ scope, recipient: recipientFor(destination), noteSecret: secrets[0]!, decoys: ring.slice(1), reps: 2 }), destination } as XrplSpend;
  const seeds = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), new Uint8Array(32).fill(3)];
  const signers = seeds.map((s) => attesterChain(s, POOL).addressAt(0));
  const deposits = (members: readonly NoteCommitment[]) => members.map((m, i) => ({
    validated: true, hash: `H${i}`, ledger_index: 20 + i,
    tx_json: { TransactionType: 'Payment', Account: ALICE, Destination: POOL, DestinationTag: 0, InvoiceID: m.slice(2).toUpperCase() },
    meta: { TransactionResult: 'tesSUCCESS', delivered_amount: String(XRP) },
  }));
  const attesterOver = (members: readonly NoteCommitment[], pinned = verifierId(2)) => {
    const client = fakeLedger({
      account_tx: () => ({ ledger_index_max: 50, transactions: deposits(members) }),
      ledger_entry: () => { throw Object.assign(new Error('entryNotFound'), { data: { error: 'entryNotFound' } }); },
      account_objects: () => ({ account_objects: [{ SignerQuorum: 2, SignerEntries: signers.map((Account) => ({ SignerEntry: { Account } })) }] }),
      account_info: () => ({ account_data: { Sequence: 100 } }),
    });
    const pools = new Map([[POOL, { source: createPoolSource({ client, config: { account: POOL, asset: { kind: 'XRP' }, sizes: SIZES, deployedAtLedger: 10 } }), spendFee: 200_100n }]]);
    const all: Attester[] = seeds.map((seed, i) => createAttester({ id: `A${i + 1}`, seed, client, networkId: 1, pools, verifierId: pinned, peers: () => all }));
    return all[0]!;
  };
  const next = seeds.map((s) => attesterChain(s, POOL).addressAt(1));
  const proposed = filled(payoutBatch({ ...PAYOUT, nullifiers: [spend.nullifier], destination, units: BigInt(XRP) - 200_100n, nextSigners: next }));

  const blob = await attesterOver(ring).sign({ spends: [spend], proposed });
  assert.match(blob, /^[0-9A-F]+$/);
  await assert.rejects(attesterOver(ring.slice(1)).sign({ spends: [spend], proposed }), /not a deposit of this size/);
  await assert.rejects(attesterOver(ring, verifierId()).sign({ spends: [spend], proposed }), /does not verify/);
  await assert.rejects(attesterOver(ring).sign({ spends: [{ ...spend, destination: { account: ALICE, tag: 1 } }], proposed }), /binds a different recipient/);
  const rogue = filled(payoutBatch({ ...PAYOUT, nullifiers: [spend.nullifier], destination, units: BigInt(XRP) - 200_100n, nextSigners: [next[0]!, next[1]!, ALICE] }));
  await assert.rejects(attesterOver(ring).sign({ spends: [spend], proposed: rogue }), /not the payout/, 'a coordinator rotating its own key in');
});

test('READ answers the allowlist only, and SUBMIT takes only a hex blob', async () => {
  const answer = createXrplAnswerer({
    registerTag: async () => undefined, tagStatus: async () => ({ registered: false, notes: 0, carried: 0n, sizes: {}, owner: null }), isSpent: async () => false,
    read: async (command) => ({ answered: command }), submit: async () => ({ engine_result: 'tesSUCCESS' }),
  });
  const ask = async (operation: 'READ' | 'SUBMIT', request: unknown) =>
    JSON.parse(Buffer.from((await answer(operation, toHex(new TextEncoder().encode(JSON.stringify(request))))).slice(2), 'hex').toString()) as { result?: unknown; error?: { message: string } };
  assert.deepEqual((await ask('READ', { command: 'account_info', params: { account: ALICE } })).result, { answered: 'account_info' });
  for (const command of ['wallet_propose', 'path_find', 'subscribe', 'sign', 'ledger_accept']) {
    assert.match((await ask('READ', { command })).error!.message, /does not answer/, command);
  }
  assert.match((await ask('READ', { command: 'fee', params: { command: 'stop' } })).error!.message, /params/);
  assert.match((await ask('SUBMIT', { tx_blob: 'not hex' })).error!.message, /hex/);
  assert.equal(((await ask('SUBMIT', { tx_blob: '12000022' })).result as { engine_result: string }).engine_result, 'tesSUCCESS');
});

test('MPT amounts: integers in the token\'s own scale, credited by issuance id', () => {
  const MPT: XrplAsset = { kind: 'MPT', issuanceId: '00'.repeat(4) + 'AB'.repeat(20), scale: 2 };
  assert.deepEqual(amountOf(MPT, 1_000_000n), { mpt_issuance_id: MPT.kind === 'MPT' ? MPT.issuanceId : '', value: '100' });
  assert.throws(() => amountOf(MPT, 1n), /finer than this token/);
  assert.throws(() => amountOf({ ...MPT, scale: 8 } as XrplAsset, 1_000_000n), /AssetScale/);
  assert.equal(unitsDelivered(MPT, POOL, { mpt_issuance_id: (MPT as { issuanceId: string }).issuanceId.toLowerCase(), value: '250' }), 2_500_000n);
  assert.equal(unitsDelivered(MPT, POOL, { mpt_issuance_id: 'FF'.repeat(24), value: '250' }), null, 'another issuance');
  assert.equal(unitsDelivered(MPT, POOL, { currency: 'USD', issuer: ISSUER, value: '2.5' }), null, 'a trust-line token');
  assert.equal(unitsDelivered(MPT, POOL, '1000000'), null, 'XRP');
});

test('a reusable address takes more notes from its owner\'s next link, and from nobody else', async () => {
  const h = (hex: string) => `0x${createHash('sha256').update(Buffer.from(hex.slice(2), 'hex')).digest('hex')}`;
  const seed = `0x${'ab'.repeat(32)}`;
  const chain = [seed];
  for (let i = 0; i < 3; i++) chain.push(h(chain.at(-1)!));
  const source = createPoolSource({
    client: fakeLedger({ account_tx: () => ({ ledger_index_max: 50, transactions: [] }) }),
    config: { account: POOL, asset: { kind: 'XRP' }, sizes: SIZES, deployedAtLedger: 10 },
  });
  await source.sync();
  source.registerTag(500, { [String(XRP)]: [c(1)] }, { owner: chain[3]! });
  assert.deepEqual(source.owner(500), { anchor: chain[3], depth: 0 });
  assert.throws(() => source.registerTag(500, { [String(XRP)]: [c(2)] }), /already in use/, 'no proof, no top-up');
  assert.throws(() => source.registerTag(500, { [String(XRP)]: [c(2)] }, { reveal: chain[1]! }), /next key/, 'a link further down is not the next one');
  assert.throws(() => source.registerTag(500, { [String(XRP)]: [c(2)] }, { reveal: `0x${'cd'.repeat(32)}` }), /next key/);
  source.registerTag(500, { [String(XRP)]: [c(2)] }, { reveal: chain[2]! });
  assert.deepEqual(source.owner(500), { anchor: chain[2], depth: 1 });
  assert.throws(() => source.registerTag(500, { [String(XRP)]: [c(3)] }, { reveal: chain[2]! }), /next key/, 'a used link is spent');
  assert.deepEqual(source.registration(500)?.[String(XRP)], [c(1), c(2)], 'appended, in order');
  source.registerTag(501, { [String(XRP)]: [c(9)] });
  assert.throws(() => source.registerTag(501, { [String(XRP)]: [c(10)] }, { reveal: chain[1]! }), /only a reusable address/);
  assert.throws(() => source.registerTag(500, { [String(XRP)]: [c(9)] }, { reveal: chain[1]! }), /another tag/, 'a top-up names only fresh commitments');
  assert.deepEqual(source.owner(500), { anchor: chain[2], depth: 1 }, 'a refused top-up spends no link');
  assert.throws(() => source.registerTag(502, { [String(XRP)]: [c(11)] }, { owner: 'not a hash' }), /32-byte hash/);
});

test('a note once credited stays credited, whatever a later registration adds', () => {
  // 250 into one 100, nine 10s and nine 1s: 51 carried. A top-up then adds two 100s,
  // five 10s and a 1. Re-split from scratch, the 250 would take three 100s and drop
  // the 10s and 1s a wallet had already kept; with the history it keeps them, and
  // only the 51 it carried is credited.
  const ones = Array.from({ length: 10 }, (_, i) => c(100 + i));
  const tens = Array.from({ length: 14 }, (_, i) => c(200 + i));
  const hundreds = [c(300), c(301), c(302)];
  const first = { [String(100 * XRP)]: hundreds.slice(0, 1), [String(10 * XRP)]: tens.slice(0, 9), [String(XRP)]: ones.slice(0, 9) };
  const topped = { [String(100 * XRP)]: hundreds, [String(10 * XRP)]: tens, [String(XRP)]: ones };
  const payments = [pay({ tag: 9, units: 250n * BigInt(XRP), ledgerIndex: 20 })];
  const before = creditDeposits(payments, SIZES, new Map([[9, first]]), new Map([[9, [{ at: 10, len: { [String(100 * XRP)]: 1, [String(10 * XRP)]: 9, [String(XRP)]: 9 } }]]]));
  assert.equal(before.carried.get(9), 51n * BigInt(XRP));
  const kept = before.deposits.map((d) => d.commitment);

  const history = new Map([[9, [
    { at: 10, len: { [String(100 * XRP)]: 1, [String(10 * XRP)]: 9, [String(XRP)]: 9 } },
    { at: 30, len: { [String(100 * XRP)]: 3, [String(10 * XRP)]: 14, [String(XRP)]: 10 } },
  ]]]);
  const after = creditDeposits(payments, SIZES, new Map([[9, topped]]), history);
  assert.ok(kept.every((k) => after.deposits.some((d) => d.commitment === k)), 'every note credited before is credited still');
  assert.equal(after.deposits.reduce((n, d) => n + BigInt(d.denomination), 0n), 250n * BigInt(XRP));
  assert.equal(after.carried.get(9), 0n);
  // Without the history, the same tags re-split the 250 and drop what was kept: the bug this prevents.
  const resplit = creditDeposits(payments, SIZES, new Map([[9, topped]]));
  assert.ok(kept.some((k) => !resplit.deposits.some((d) => d.commitment === k)));
});

test('a payable split keeps every amount payable, in about four notes a power of ten', () => {
  const ladder = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000].map((u) => u * XRP);
  const notes = (units: number, asLadder: boolean) => {
    const out: number[] = [];
    assert.equal(splitAmount(BigInt(units * XRP), ladder, asLadder, (size) => { out.push(size / XRP); return true; }), 0n);
    return out;
  };
  assert.deepEqual(notes(95, false), [50, 20, 20, 5], 'greedy: the fewest notes, and 10 is not payable from them');
  const ninetyFive = notes(95, true);
  assert.equal(ninetyFive.length, 10);
  // Every whole amount from 1 to 95 is a sum of some of them.
  const payable = new Set([0]);
  for (const n of ninetyFive) for (const x of [...payable]) payable.add(x + n);
  assert.ok(Array.from({ length: 95 }, (_, i) => i + 1).every((a) => payable.has(a)));
  assert.equal(notes(2_400, true).length, 15);
  assert.deepEqual(notes(1_000_000, true), [500_000, 200_000, 100_000, 100_000, 50_000, 20_000, 10_000, 10_000, 5_000, 2_000, 1_000, 1_000, 500, 200, 100, 100, 50, 20, 10, 10, 5, 2, 2, 1]);
  assert.deepEqual(notes(2, true), [1, 1], '2 is 1 + 1, so 1 stays payable');
});

test('a tag registered for a ladder splits its payments as one; one from before, largest first', () => {
  const sizes = [XRP, 2 * XRP, 5 * XRP, 10 * XRP, 20 * XRP, 50 * XRP];
  const list = Object.fromEntries(sizes.map((size, k) => [String(size), Array.from({ length: 6 }, (_, i) => c(1000 * (k + 1) + i))]));
  const len = Object.fromEntries(sizes.map((size) => [String(size), 6]));
  const units = (log: ReturnType<typeof creditDeposits>) => log.deposits.map((d) => d.denomination / XRP).sort((a, b) => b - a);
  const paid = [pay({ tag: 4, units: 95n * BigInt(XRP), ledgerIndex: 20 })];
  assert.deepEqual(units(creditDeposits(paid, sizes, new Map([[4, list]]), new Map([[4, [{ at: 10, len, ladder: true as const }]]]))), [20, 20, 20, 10, 10, 5, 5, 2, 2, 1]);
  assert.deepEqual(units(creditDeposits(paid, sizes, new Map([[4, list]]), new Map([[4, [{ at: 10, len }]]]))), [50, 20, 20, 5]);
});

test('a payment splits only into notes registered before it', () => {
  const list = { [String(100 * XRP)]: [c(1)], [String(10 * XRP)]: Array.from({ length: 10 }, (_, i) => c(10 + i)) };
  const history = new Map([[5, [{ at: 10, len: { [String(10 * XRP)]: 10 } }, { at: 40, len: { [String(100 * XRP)]: 1, [String(10 * XRP)]: 10 } }]]]);
  // Paid at ledger 20, before the 100 was registered at 40: ten 10s, not one 100.
  const log = creditDeposits([pay({ tag: 5, units: 100n * BigInt(XRP), ledgerIndex: 20 })], SIZES, new Map([[5, list]]), history);
  assert.deepEqual(log.deposits.map((d) => d.denomination), Array(10).fill(10 * XRP));
});

test('a top-up credits what a reusable address was carrying', () => {
  const tags = new Map<number, Record<string, NoteCommitment[]>>([[77, { [String(XRP)]: [c(1)] }]]);
  const payments = [pay({ tag: 77, units: 3n * BigInt(XRP) })];
  assert.equal(creditDeposits(payments, SIZES, tags).carried.get(77), 2n * BigInt(XRP));
  tags.set(77, { [String(XRP)]: [c(1), c(2), c(3)] });
  const after = creditDeposits(payments, SIZES, tags);
  assert.deepEqual(after.deposits.map((d) => d.commitment), [c(1), c(2), c(3)]);
  assert.equal(after.carried.get(77), 0n);
});

// F-1 (overlord): a ledger read that fails on a later page must not keep the payments of its
// earlier pages, or the next read adds them again and one payment credits notes twice.
test('a read that fails partway keeps nothing: one payment is credited once (F-1)', async () => {
  // OMEGA's PoC: one 10 XRP payment to a tag holding twenty 1 XRP notes; page 2 throws slowDown once.
  const payment = {
    validated: true, hash: 'P1', ledger_index: 20,
    tx_json: { TransactionType: 'Payment', Account: ALICE, Destination: POOL, DestinationTag: 77 },
    meta: { TransactionResult: 'tesSUCCESS', delivered_amount: String(10 * XRP) },
  };
  let reads = 0;
  let failed = false;
  const source = createPoolSource({
    client: fakeLedger({
      account_tx: (req) => {
        reads++;
        if (reads === 1) return { ledger_index_max: 15, transactions: [] };
        if (req['marker'] === undefined) return { ledger_index_max: 50, transactions: [payment], marker: 'page-2' };
        if (!failed) { failed = true; throw Object.assign(new Error('slowDown'), { data: { error: 'slowDown' } }); }
        return { ledger_index_max: 50, transactions: [] };
      },
    }),
    config: { account: POOL, asset: { kind: 'XRP' }, sizes: SIZES, deployedAtLedger: 10 },
  });
  await source.sync();
  source.registerTag(77, { [String(XRP)]: Array.from({ length: 20 }, (_, i) => c(500 + i)) });
  await assert.rejects(source.sync(), /slowDown/);
  assert.equal(source.log().deposits.length, 0, 'the failed read added nothing');
  await source.sync();
  const credited = source.log().deposits.filter((d) => d.tag === 77);
  assert.equal(credited.length, 10, 'ten 1 XRP notes for 10 XRP, not twenty');
  assert.equal(credited.reduce((n, d) => n + d.denomination, 0), 10 * XRP);
  // And a read that overlaps one already counted (the same hash again) adds nothing.
  await source.sync();
  assert.equal(source.log().deposits.filter((d) => d.tag === 77).length, 10);
});

// F-11 (overlord): a registration from a wallet that sized its notes largest-first
// (one that hasn't reloaded since) is split largest-first: nothing stranded.
test('a tag registered without asking for the payable split is split largest-first (F-11)', async () => {
  const pay95 = { validated: true, hash: 'F11', ledger_index: 20, tx_json: { TransactionType: 'Payment', Account: ALICE, Destination: POOL, DestinationTag: 31 }, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: String(95 * XRP) } };
  for (const payable of [false, true]) {
    let reads = 0;
    const source = createPoolSource({
      client: fakeLedger({ account_tx: () => (++reads === 1 ? { ledger_index_max: 15, transactions: [] } : { ledger_index_max: 50, transactions: [pay95] }) }),
      config: { account: POOL, asset: { kind: 'XRP' }, sizes: SIZES, deployedAtLedger: 10 },
    });
    await source.sync();
    // OMEGA's PoC: an old client's one-time tag, 1×100, 9×10, 9×1, then the faucet's 95 XRP.
    source.registerTag(31, { [String(100 * XRP)]: [c(700)], [String(10 * XRP)]: Array.from({ length: 9 }, (_, i) => c(710 + i)), [String(XRP)]: Array.from({ length: 9 }, (_, i) => c(730 + i)) }, undefined, payable);
    await source.sync();
    const carried = source.log().carried.get(31) ?? 0n;
    if (payable) assert.equal(carried, 6n * BigInt(XRP), 'asked for, with notes sized for largest-first: 6 left over, which is why it must be asked for');
    else assert.equal(carried, 0n, 'not asked for: largest first, all 95 credited');
  }
});

// F-12 / F-13 (overlord): registrations go to an append-only log, on disk before they change
// anything; a restart rebuilds the same table and history, and a torn last line is dropped.
test('the tag table is a log: written first, replayed whole, a torn line dropped (F-12, F-13)', async () => {
  const { mkdtempSync, rmSync, appendFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'opaque-tags-'));
  try {
    const tagFile = join(dir, `tags-${POOL}.json`);
    const pay = (hash: string, ledger: number, units: number) => ({ validated: true, hash, ledger_index: ledger, tx_json: { TransactionType: 'Payment', Account: ALICE, Destination: POOL, DestinationTag: 40 }, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: String(units * XRP) } });
    let ledger: Record<string, unknown>[] = [];
    let max = 15;
    const open = () => createPoolSource({ client: fakeLedger({ account_tx: () => ({ ledger_index_max: max, transactions: ledger }) }), config: { account: POOL, asset: { kind: 'XRP' }, sizes: SIZES, deployedAtLedger: 10 }, tagFile });
    const a = open();
    await a.sync();
    const anchor = `0x${'11'.repeat(32)}`;
    a.registerTag(40, { [String(XRP)]: [c(800), c(801)] }, { owner: anchor });
    const lines = readFileSync(join(dir, `tags-${POOL}.log`), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, 'one line for one registration, written before the call returned');
    ledger = [pay('L1', 20, 2)];
    max = 50;
    await a.sync();
    const before = a.log().deposits.map((d) => d.commitment);
    // A crash mid-write leaves half a line.
    appendFileSync(join(dir, `tags-${POOL}.log`), '{"tag":41,"add":{"1000000":["0x');
    const b = open();
    await b.sync();
    assert.deepEqual(b.log().deposits.map((d) => d.commitment), before, 'the same notes after a restart');
    assert.equal(b.registered(41), false, 'the torn line never took effect');
    assert.equal(b.owner(40)?.anchor, anchor);
    // And the log goes on cleanly after it.
    b.registerTag(42, { [String(XRP)]: [c(810)] });
    const c2 = open();
    await c2.sync();
    assert.equal(c2.registered(42), true);
    assert.throws(() => c2.registerTag(43, { [String(XRP)]: [c(800)] }), /registered|another tag/, 'the commitment index survives the restart');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// F-28 (overlord): a registration's carry is credited at its place in the ledger, so a
// payment made after it, by anyone, cannot move what it credited.
test('carry credited at a registration stays put whatever is paid after (F-28)', () => {
  const list = { [String(XRP)]: [c(900), c(901), c(902)] };
  const history = new Map([[50, [{ at: 10, len: { [String(XRP)]: 0 } }, { at: 30, len: { [String(XRP)]: 3 } }]]]);
  const tagged = pay({ tag: 50, units: 2n * BigInt(XRP), ledgerIndex: 20, hash: 'T' });
  const before = creditDeposits([tagged], SIZES, new Map([[50, list]]), history);
  assert.deepEqual(before.deposits.map((d) => d.commitment), [c(900), c(901)], 'carry credited at the registration (ledger 30)');
  // OMEGA's PoC: an InvoiceID deposit at ledger 40 of a note the registration's carry credited.
  const invoice = pay({ tag: 0, units: BigInt(XRP), ledgerIndex: 40, hash: 'I', invoiceId: (c(900) as string).slice(2).toUpperCase() });
  const after = creditDeposits([tagged, invoice], SIZES, new Map([[50, list]]), history);
  assert.deepEqual(after.deposits.filter((d) => d.tag === 50).map((d) => d.commitment), [c(900), c(901)], 'the tag\'s notes are the same');
  assert.equal(after.unmatched.length, 1, 'the late InvoiceID deposit of an already-credited note credits nothing');
});

// F-54: a submit call that timed out or lost its socket threw out of the payout without
// its hash, though rippled may have the Batch: the settler then sent a fresh one, the
// attesters refused it (the note was spent by the first) and the intent ended FAILED
// while the recipient had been paid.
test('a payout whose submit call failed still answers its hash, for evidence to read (F-54)', async () => {
  const chains = [1, 2, 3].map((n) => attesterChain(new Uint8Array(32).fill(n), POOL));
  const attesters = chains.map((chain, i) => ({
    id: `A${i + 1}`,
    nextAfter: (_pool: string, address: string) => (address === chain.addressAt(0) ? chain.addressAt(1) : undefined),
    currentOn: (_pool: string, signers: readonly string[]) => signers.find((s) => s === chain.addressAt(0)),
    sign: async ({ proposed }: { proposed: Batch }) => { const key = chain.keyAt(0); return new Wallet(key.publicKey, key.privateKey).sign(proposed, true).tx_blob; },
    retire: async () => { throw new Error('not asked'); },
  })) as unknown as Attester[];
  const listAt = (i: number) => ({ account_objects: [{ SignerQuorum: 2, SignerEntries: chains.map((c) => ({ SignerEntry: { Account: c.addressAt(i) } })) }] });
  let lists = 0;
  const sent: string[] = [];
  const client = {
    async request(req: Record<string, unknown>) {
      if (req['command'] === 'account_objects') return { result: listAt(lists++ === 0 ? 0 : 1) };
      if (req['command'] === 'tx') return { result: { validated: true, meta: { TransactionResult: 'tesSUCCESS' } } };
      throw new Error(`unexpected ${String(req['command'])}`);
    },
    simulate: async () => ({ result: { engine_result: 'tesSUCCESS' } }),
    autofill: async (batch: Batch) => filled(batch),
    // OMEGA's PoC: the socket carries the Batch, then drops before rippled's answer.
    submit: async (blob: string) => { sent.push(blob); throw new Error('websocket was closed'); },
    getLedgerIndex: async () => 1000,
  } as unknown as Client;
  const rings: unknown[] = [];
  const settlement = createXrplSettlement({
    client, attesters,
    pools: new Map([[POOL, { source: { config: { asset: { kind: 'XRP' } }, noteRing: (r: unknown) => rings.push(r) } as never, spendFee: 200_100n }]]),
  });
  const spend = { scope: scopeOf(1, POOL, XRP), mode: 'RING_8', ring: [], nullifier: c(9), destination: { account: ALICE, tag: null } };
  const hash = await settlement.deliver({ spend } as unknown as ApprovedRelease);
  assert.equal(sent.length, 1);
  assert.equal(hash, toTxHash(hashes.hashSignedTx(sent[0]!)), 'the hash of what was sent, for evidence() to look up');
});

// F-52: anyone can register through the mesh, at no cost, and every registration was
// kept in memory and replayed at each boot: enough of them ran the process out of memory,
// and then every restart too. What nothing has paid for yet is now bounded per pool;
// a registration is never forgotten, and a credited note makes room again.
test('what registrations hold before anything pays them is bounded per pool, and a payment makes room (F-52)', async () => {
  const { createHash: sha } = await import('node:crypto');
  let ledger: Record<string, unknown>[] = [];
  let max = 15;
  const source = createPoolSource({
    client: fakeLedger({ account_tx: () => ({ ledger_index_max: max, transactions: ledger }) }),
    config: { account: POOL, asset: { kind: 'XRP' }, sizes: SIZES, deployedAtLedger: 10 },
  });
  await source.sync();
  const batch = (n: number) => ({ [String(XRP)]: Array.from({ length: 64 }, (_, i) => c(1_000_000 + n * 64 + i)) });
  const link = `0x${'ef'.repeat(32)}`;
  source.registerTag(1, batch(1), { owner: `0x${sha('sha256').update(Buffer.from(link.slice(2), 'hex')).digest('hex')}` });
  // OMEGA's PoC: registration after registration of 64 fresh commitments, from nobody who pays.
  let n = 1;
  let refused: unknown;
  while (refused === undefined && n < 10_000) {
    try { source.registerTag(n + 1, batch(n + 1)); n += 1; } catch (error) { refused = error; }
  }
  assert.ok(refused instanceof ProtocolFailure && refused.retryable, `refused, retryably, after ${n} registrations`);
  assert.ok(Array.from({ length: n }, (_, i) => i + 1).every((t) => source.registered(t)), 'nothing registered is forgotten');
  const topUp = { [String(XRP)]: Array.from({ length: 64 }, (_, i) => c(9_000_000 + i)) };
  assert.throws(() => source.registerTag(1, topUp, { reveal: link }), (e: unknown) => e instanceof ProtocolFailure && e.retryable, 'a top-up waits too');
  // 64 XRP to tag 2 credits its 64 notes: they are paid for now, and their room is free again.
  ledger = [{ validated: true, hash: 'B2', ledger_index: 20, tx_json: { TransactionType: 'Payment', Account: ALICE, Destination: POOL, DestinationTag: 2 }, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: String(64 * XRP) } }];
  max = 50;
  await source.sync();
  assert.equal(source.log().deposits.filter((d) => d.tag === 2).length, 64);
  source.registerTag(1, topUp, { reveal: link });
  assert.equal(source.registration(1)?.[String(XRP)]?.length, 128);
});

// F-52: every read and every registration re-credited the pool's whole history, even when
// nothing had changed, which an anonymous TAG_STATUS or registration could ask for at will.
test('a read that finds nothing new, and a registration nothing has paid, change no log (F-52)', async () => {
  let ledger: Record<string, unknown>[] = [];
  let max = 15;
  const source = createPoolSource({
    client: fakeLedger({ account_tx: () => ({ ledger_index_max: max, transactions: ledger }) }),
    config: { account: POOL, asset: { kind: 'XRP' }, sizes: SIZES, deployedAtLedger: 10 },
  });
  await source.sync();
  const before = source.log();
  await source.sync();
  assert.equal(source.log(), before, 'nothing new read: the same log, not a recomputed one');
  source.registerTag(5, { [String(XRP)]: [c(1)] });
  assert.equal(source.log(), before, 'a tag nothing has paid credits nothing');
  // A top-up of a tag that carries value still credits it at once.
  const link = `0x${'ab'.repeat(32)}`;
  const { createHash: sha } = await import('node:crypto');
  source.registerTag(6, { [String(XRP)]: [c(2)] }, { owner: `0x${sha('sha256').update(Buffer.from(link.slice(2), 'hex')).digest('hex')}` });
  ledger = [{ validated: true, hash: 'T6', ledger_index: 20, tx_json: { TransactionType: 'Payment', Account: ALICE, Destination: POOL, DestinationTag: 6 }, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: String(3 * XRP) } }];
  max = 50;
  await source.sync();
  assert.equal(source.log().carried.get(6), 2n * BigInt(XRP));
  source.registerTag(6, { [String(XRP)]: [c(3), c(4)] }, { reveal: link });
  assert.deepEqual(source.log().deposits.filter((d) => d.tag === 6).map((d) => d.commitment), [c(2), c(3), c(4)]);
  assert.equal(source.log().carried.get(6), 0n);
});

// F-61: the log's append ignored a short write (what a full disk gives): the registration
// was applied and confirmed with half a line on disk, the next append joined that half,
// and the next boot could not parse the log.
test('a registration the disk did not take whole is refused, and a restart reads past what it left (F-61)', async () => {
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'opaque-tags-'));
  const realWriteSync = fs.writeSync;
  const restore = () => { mock.restoreAll(); syncBuiltinESMExports(); };
  try {
    const tagFile = join(dir, `tags-${POOL}.json`);
    const logFile = join(dir, `tags-${POOL}.log`);
    const lines: string[] = [];
    const open = () => createPoolSource({ client: fakeLedger({ account_tx: () => ({ ledger_index_max: 15, transactions: [] }) }), config: { account: POOL, asset: { kind: 'XRP' }, sizes: SIZES, deployedAtLedger: 10 }, tagFile, log: (l) => lines.push(l) });
    const a = open();
    await a.sync();
    a.registerTag(60, { [String(XRP)]: [c(60)] });
    const whole = readFileSync(logFile, 'utf8');
    // OMEGA's PoC: the volume is full; writeSync takes half the line and says so.
    mock.method(fs, 'writeSync', (fd: number, data: string | Buffer) => { const b = Buffer.from(data); return realWriteSync(fd, b.subarray(0, b.length >> 1)); });
    syncBuiltinESMExports();
    assert.throws(() => a.registerTag(61, { [String(XRP)]: [c(61)] }), (e: unknown) => e instanceof ProtocolFailure && e.retryable, 'refused, retryably');
    assert.equal(a.registered(61), false, 'and not registered');
    assert.equal(readFileSync(logFile, 'utf8'), whole, 'the half line is taken back');
    // Nor can the half be taken back: it stays, and the next line starts a line of its own.
    mock.method(fs, 'ftruncateSync', () => { throw new Error('EIO'); });
    syncBuiltinESMExports();
    assert.throws(() => a.registerTag(62, { [String(XRP)]: [c(62)] }), /try again/);
    restore();
    a.registerTag(63, { [String(XRP)]: [c(63)] });
    const b = open();
    await b.sync();
    assert.deepEqual([60, 61, 62, 63].map((t) => b.registered(t)), [true, false, false, true], 'every confirmed registration, and none that was refused');
    assert.ok(lines.some((l) => /skipped/.test(l)), 'the line it could not read is reported');
    b.registerTag(64, { [String(XRP)]: [c(62)] });
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// F-65: READ's params were spread into the request sent on the stack's one ledger socket,
// so a caller could name its request id and collide with the stack's own requests.
test('READ refuses the request plumbing in its params (F-65)', async () => {
  const asked: Record<string, unknown>[] = [];
  const answer = createXrplAnswerer({
    registerTag: async () => undefined, tagStatus: async () => ({ registered: false, notes: 0, carried: 0n, sizes: {}, owner: null }), isSpent: async () => false,
    read: async (_command, params) => { asked.push(params); return {}; },
  });
  const ask = async (request: unknown) =>
    JSON.parse(Buffer.from((await answer('READ', toHex(new TextEncoder().encode(JSON.stringify(request))))).slice(2), 'hex').toString()) as { result?: unknown; error?: { message: string } };
  for (const params of [{ id: 7 }, { id: 'x' }, { api_version: 1 }]) {
    assert.match((await ask({ command: 'fee', params })).error?.message ?? 'answered', /params/, JSON.stringify(params));
  }
  assert.equal(asked.length, 0, 'none reached the ledger');
  assert.deepEqual((await ask({ command: 'account_info', params: { account: ALICE } })).result, {});
});
