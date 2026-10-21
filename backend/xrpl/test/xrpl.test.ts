import { createHash } from 'node:crypto';
// The XRPL layer's rules, offline: crediting, the recipient binding, amounts,
// and what an attester refuses to sign. The ledger itself is exercised by
// spike.ts and e2e-payment.ts on testnet.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Batch, Client, SignerListSet } from 'xrpl';

import type { NoteCommitment, Nullifier } from '@opaque/protocol-types';

import { buildRingSpend, createNoteSecret, deriveCommitment, verifierId } from '../../zk/index.ts';
import { createAttester, attesterChain, nextSignersOf, type Attester, type XrplSpend } from '../attester.ts';
import { checkProposal, payoutBatch, rotationOf, signerListOf, type Payout } from '../batch.ts';
import { keyChain } from '../keys.ts';
import { createPoolSource, creditDeposits, incomingOf, type IncomingPayment } from '../pool.ts';
import { amountOf, recipientFor, scopeOf, splitAmount, unitsDelivered, unitsOfDecimal, type XrplAsset } from '../protocol.ts';
import { createXrplAnswerer } from '../queries.ts';
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
