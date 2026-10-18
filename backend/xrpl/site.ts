// Per-site accounts: private access to any XRPL dapp.
//
// A dapp sees an account and what it signs. Opaque gives each site (each
// origin) an account of its own, funded by a pool, so the ledger's funded-by
// record — which chain analysts rely on — names the pool and never you.
//
//   create   a fresh master key in this browser; a private payment from a pool
//            funds the address.
//   set up   the master key's only two transactions: SetRegularKey to the first
//            single-use regular key (in one Batch with any trust lines), then
//            AccountSet asfDisableMaster. The master key never moves funds again.
//   use      signAndSubmit: Batch (INDEPENDENT) [dapp tx, SetRegularKey(next)],
//            signed by the current regular key, so the key rotates even when
//            the dapp's transaction fails. A Batch that never applied has
//            still shown the key, so a rotation on its own follows it.
//            sign: the dapp's transaction as is, for dapps that submit it
//            themselves, valid for 5 ledgers, then a rotation at the next
//            sequence.
//            signMessage: the disabled master key — it proves the account and
//            cannot move funds. Its public key is on the ledger from setup, so
//            a quantum attacker could forge messages from it (never payments).
//   close    AccountDelete to a pool under a fresh tag: the reserve and what is
//            left come back as notes.
//
// Every regular key signs one ledger's worth of transactions. Browser-safe:
// the ledger is an injected interface (direct in Node, the mesh in the wallet),
// and signing is ripple-keypairs and ripple-binary-codec, not xrpl.js.

import { sha512 } from '@noble/hashes/sha2.js';
import { decode, encode, encodeForSigning } from 'ripple-binary-codec';
import { deriveAddress, deriveKeypair, generateSeed, sign as signHex } from 'ripple-keypairs';

import { ProtocolFailure } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { keyChain, type KeyPair } from './keys.ts';

/** The ledger, as this module needs it. */
export interface Ledger {
  request<T = Record<string, unknown>>(command: string, params?: Record<string, unknown>): Promise<T>;
  submit(txBlob: string): Promise<{ readonly engine_result: string; readonly engine_result_message?: string }>;
}

export interface Site {
  readonly origin: string;
  readonly address: string;
  /** Secret: the master key, which only ever signs the setup and messages. */
  readonly masterSeed: string;
  /** Secret: the seed of the regular-key chain. */
  readonly chainSeed: string;
  /** The regular key the ledger lists now; -1 before setup. */
  index: number;
  readonly createdAt: number;
}

export type Tx = Record<string, unknown> & { readonly TransactionType: string };

const TF_INNER_BATCH = 0x4000_0000;
const TF_ALL_OR_NOTHING = 0x0001_0000;
const TF_INDEPENDENT = 0x0008_0000;
const TF_SET_NO_RIPPLE = 0x0002_0000;
const ASF_DISABLE_MASTER = 4;
const LSF_DISABLE_MASTER = 0x0010_0000;
const LEDGERS_VALID = 20;
/**
 * How long a dapp that submits for itself has to do it: about 20 seconds. Its
 * key stays listed until then, with its public key in the dapp's hands.
 */
const SIGN_ONLY_LEDGERS = 5;

/**
 * What a dapp may ask a per-site account to sign. Absent on purpose: anything
 * that changes who controls the account (SetRegularKey, SignerListSet, an
 * AccountSet that re-enables the master), AccountDelete (only close() does
 * that, to a pool), and transactions whose fee is the owner reserve.
 */
export const DAPP_TRANSACTIONS = new Set([
  'Payment', 'OfferCreate', 'OfferCancel', 'TrustSet',
  'AMMDeposit', 'AMMWithdraw', 'AMMVote', 'AMMBid',
  'NFTokenMint', 'NFTokenBurn', 'NFTokenCreateOffer', 'NFTokenCancelOffer', 'NFTokenAcceptOffer',
  'EscrowCreate', 'EscrowFinish', 'EscrowCancel', 'CheckCreate', 'CheckCash', 'CheckCancel',
  'PaymentChannelCreate', 'PaymentChannelFund', 'PaymentChannelClaim', 'CredentialAccept', 'MPTokenAuthorize',
]);

const refuse = (message: string): never => { throw new ProtocolFailure('INVALID_INPUT', message); };

export const txHash = (blob: string): string =>
  toHex(sha512(fromHex(`0x54584e00${blob.toLowerCase()}`)).subarray(0, 32)).slice(2).toUpperCase();

export function newSite(origin: string, random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): Site {
  const masterSeed = generateSeed({ entropy: random(16), algorithm: 'ed25519' });
  return {
    origin,
    address: deriveAddress(deriveKeypair(masterSeed).publicKey),
    masterSeed,
    chainSeed: toHex(random(32)),
    index: -1,
    createdAt: Date.now(),
  };
}

const master = (site: Site): KeyPair => {
  const { publicKey, privateKey } = deriveKeypair(site.masterSeed);
  return { address: site.address, publicKey, privateKey };
};
export const regularKey = (site: Site, index: number): KeyPair =>
  keyChain(fromHex(site.chainSeed as `0x${string}`), `site/${site.address}`).keyAt(index);

/** A single-signed transaction. */
export function signTx(tx: Tx, key: KeyPair): { readonly blob: string; readonly hash: string; readonly json: Tx } {
  const json = { ...tx, SigningPubKey: key.publicKey } as Tx;
  (json as Record<string, unknown>)['TxnSignature'] = signHex(encodeForSigning(json as never), key.privateKey);
  const blob = encode(json as never);
  return { blob, hash: txHash(blob), json };
}

// ── the ledger's side ────────────────────────────────────────────────────

export async function sequenceOf(ledger: Ledger, account: string): Promise<number> {
  const info = await ledger.request<{ account_data: { Sequence: number } }>('account_info', { account, ledger_index: 'current' });
  return info.account_data.Sequence;
}

/** Drops per transaction, from the open ledger; a Batch pays 2 plus one per inner. */
export async function baseFee(ledger: Ledger): Promise<bigint> {
  const fee = await ledger.request<{ drops: { base_fee: string; open_ledger_fee: string } }>('fee');
  const base = BigInt(fee.drops.base_fee);
  const open = BigInt(fee.drops.open_ledger_fee);
  // ponytail: pays the open-ledger fee under load, capped at 10x base; queueing beyond that is left to retries.
  return open > base ? (open < base * 10n ? open : base * 10n) : base;
}

export const lastLedger = async (ledger: Ledger, ledgers = LEDGERS_VALID): Promise<number> =>
  (await ledger.request<{ ledger_current_index: number }>('ledger_current')).ledger_current_index + ledgers;

/** Submits, then waits until the ledger decides. Returns the validated result, or throws. */
export async function submitAndWait(ledger: Ledger, signed: { blob: string; hash: string }, lls: number): Promise<string> {
  const first = await ledger.submit(signed.blob);
  if (/^te[mfl]/.test(first.engine_result)) throw new ProtocolFailure('SETTLEMENT_REVERTED', `refused before the ledger: ${first.engine_result}`);
  return resultOf(ledger, signed.hash, lls);
}

/** The validated result of a transaction, waiting until its last ledger has passed. */
export async function resultOf(ledger: Ledger, hash: string, lls: number): Promise<string> {
  for (;;) {
    const tx = await ledger.request<{ validated?: boolean; meta?: { TransactionResult?: string } }>('tx', { transaction: hash }).catch(() => null);
    if (tx?.validated === true) return tx.meta?.TransactionResult ?? 'unknown';
    const current = (await ledger.request<{ ledger_current_index: number }>('ledger_current')).ledger_current_index;
    if (current > lls + 1) return 'expired';
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

const inner = (tx: Tx, sequence: number) => ({
  RawTransaction: { ...tx, Flags: (Number(tx['Flags'] ?? 0) | TF_INNER_BATCH) >>> 0, Fee: '0', SigningPubKey: '', Sequence: sequence },
});

/** What the dapp handed over, made into something this account will sign. */
export function dappTx(site: Site, raw: unknown): Tx {
  if (typeof raw !== 'object' || raw === null) refuse('a transaction is an object');
  const tx = { ...(raw as Record<string, unknown>) };
  if (typeof tx['TransactionType'] !== 'string' || !DAPP_TRANSACTIONS.has(tx['TransactionType'])) {
    refuse(`this account does not sign ${String(tx['TransactionType'])} for a site`);
  }
  if (tx['Account'] !== site.address) refuse('the transaction is for another account');
  if (tx['Flags'] !== undefined && typeof tx['Flags'] !== 'number') refuse('Flags must be a number');
  for (const field of ['TxnSignature', 'Signers', 'SigningPubKey', 'TicketSequence', 'Delegate', 'BatchSigners']) {
    if (tx[field] !== undefined && !(field === 'SigningPubKey' && tx[field] === '')) refuse(`a site transaction carries no ${field}`);
  }
  // The wallet fills these: a site cannot pick the sequence or the fee.
  for (const field of ['Sequence', 'Fee', 'LastLedgerSequence', 'NetworkID', 'SigningPubKey']) delete tx[field];
  // A round trip through the codec refuses anything malformed before a key is touched.
  try { decode(encode(tx as never)); } catch (error) { refuse(`not a valid transaction: ${(error as Error).message}`); }
  return tx as Tx;
}

/**
 * The master key's only two transactions: the first regular key (in one Batch
 * with any trust lines), then the master off. Two, not one: disabling the
 * master must be signed BY the master, and an inner Batch transaction carries
 * no signature of its own — rippled answers tecNEED_MASTER_KEY (testnet,
 * spike-sites.ts). The second is signed at the next sequence and sent at once.
 */
export async function setupSite(ledger: Ledger, site: Site, trust: readonly { readonly currency: string; readonly issuer: string }[] = []): Promise<string> {
  if (site.index !== -1) refuse('this account is already set up');
  const sequence = await sequenceOf(ledger, site.address);
  const fee = await baseFee(ledger);
  const lls = await lastLedger(ledger);
  const setKey: Tx = { TransactionType: 'SetRegularKey', Account: site.address, RegularKey: regularKey(site, 0).address };
  const lines: Tx[] = trust.map((t) => ({
    TransactionType: 'TrustSet', Account: site.address, Flags: TF_SET_NO_RIPPLE,
    LimitAmount: { currency: t.currency, issuer: t.issuer, value: '1000000000' },
  }));
  // A Batch holds 2 to 8: with no trust lines the key is set on its own.
  const first = lines.length === 0
    ? signTx({ ...setKey, Sequence: sequence, Fee: String(fee), LastLedgerSequence: lls }, master(site))
    : signTx({
      TransactionType: 'Batch', Account: site.address, Flags: TF_ALL_OR_NOTHING, Sequence: sequence,
      Fee: String(fee * BigInt(2 + 1 + lines.length)), LastLedgerSequence: lls,
      RawTransactions: [setKey, ...lines].map((t, i) => inner(t, sequence + 1 + i)),
    }, master(site));
  const after = lines.length === 0 ? sequence + 1 : sequence + 2 + lines.length;
  const masterOff = signTx({ TransactionType: 'AccountSet', Account: site.address, SetFlag: ASF_DISABLE_MASTER, Sequence: after, Fee: String(fee), LastLedgerSequence: lls }, master(site));
  await ledger.submit(first.blob);
  await submitAndWait(ledger, masterOff, lls);
  // A Batch says tesSUCCESS outside either way: read what the account is now.
  const info = await ledger.request<{ account_data: { RegularKey?: string; Flags: number } }>('account_info', { account: site.address, ledger_index: 'validated' });
  if (info.account_data.RegularKey !== regularKey(site, 0).address || (info.account_data.Flags & LSF_DISABLE_MASTER) === 0) {
    throw new ProtocolFailure('SETTLEMENT_REVERTED', 'the account setup did not apply');
  }
  site.index = 0;
  return masterOff.hash;
}

/** Batch (INDEPENDENT) [dapp tx, SetRegularKey(next)], by the current key. */
export async function signAndSubmit(ledger: Ledger, site: Site, raw: unknown): Promise<{ readonly hash: string; readonly result: string; readonly batch: string; readonly tx_json: Tx }> {
  if (site.index < 0) refuse('set the account up first');
  const tx = dappTx(site, raw);
  const key = regularKey(site, site.index);
  const next = regularKey(site, site.index + 1);
  const sequence = await sequenceOf(ledger, site.address);
  const lls = await lastLedger(ledger);
  const dapp = inner(tx, sequence + 1);
  const signed = signTx({
    TransactionType: 'Batch', Account: site.address, Flags: TF_INDEPENDENT, Sequence: sequence,
    Fee: String((await baseFee(ledger)) * 4n), LastLedgerSequence: lls,
    RawTransactions: [dapp, inner({ TransactionType: 'SetRegularKey', Account: site.address, RegularKey: next.address }, sequence + 2)],
  }, key);
  try {
    await submitAndWait(ledger, signed, lls);
  } catch (error) {
    // Refused before the ledger, but a node has seen the key: retire it anyway.
    await rotate(ledger, site).catch(() => undefined);
    throw error;
  }
  const hash = txHash(encode(dapp.RawTransaction as never));
  const result = await resultOf(ledger, hash, lls);
  // The Batch's own rotation has normally moved the key; if it expired unapplied, this retires it.
  await rotate(ledger, site).catch(() => undefined);
  return { hash, result, batch: signed.hash, tx_json: dapp.RawTransaction as Tx };
}

/**
 * The dapp's transaction signed as is, for the dapp to submit within
 * SIGN_ONLY_LEDGERS, and the rotation that must follow it: pre-signed at the
 * next sequence and sent now, so the ledger applies it right after the dapp's
 * (it waits for it). If the dapp never submits, rotate() later sends a
 * rotation at the unused sequence, as soon as the window has passed.
 */
export async function signOnly(ledger: Ledger, site: Site, raw: unknown): Promise<{ readonly hash: string; readonly tx_blob: string; readonly tx_json: Tx; readonly lastLedger: number }> {
  if (site.index < 0) refuse('set the account up first');
  const tx = dappTx(site, raw);
  const key = regularKey(site, site.index);
  const sequence = await sequenceOf(ledger, site.address);
  const fee = String(await baseFee(ledger));
  // Read last, so the dapp's window starts as late as it can.
  const lls = await lastLedger(ledger, SIGN_ONLY_LEDGERS);
  const signed = signTx({ ...tx, Sequence: sequence, Fee: fee, LastLedgerSequence: lls }, key);
  const rotation = signTx({
    TransactionType: 'SetRegularKey', Account: site.address, RegularKey: regularKey(site, site.index + 1).address,
    Sequence: sequence + 1, Fee: fee, LastLedgerSequence: lls + LEDGERS_VALID,
  }, key);
  // Sent alongside, not awaited: every second spent here comes off the dapp's window.
  void ledger.submit(rotation.blob).catch(() => undefined);
  return { hash: signed.hash, tx_blob: signed.blob, tx_json: signed.json, lastLedger: lls };
}

/** After a sign-only use: make sure the key that signed is retired, whatever the dapp did. */
export async function rotate(ledger: Ledger, site: Site): Promise<void> {
  if (await syncIndex(ledger, site)) return;
  const key = regularKey(site, site.index);
  const lls = await lastLedger(ledger);
  await submitAndWait(ledger, signTx({
    TransactionType: 'SetRegularKey', Account: site.address, RegularKey: regularKey(site, site.index + 1).address,
    Sequence: await sequenceOf(ledger, site.address), Fee: String(await baseFee(ledger)), LastLedgerSequence: lls,
  }, key), lls);
  if (!await syncIndex(ledger, site)) throw new ProtocolFailure('SETTLEMENT_REVERTED', 'the rotation did not apply');
}

/** Moves `site.index` to the key the ledger lists. True when that changed it. */
export async function syncIndex(ledger: Ledger, site: Site): Promise<boolean> {
  const info = await ledger.request<{ account_data: { RegularKey?: string } }>('account_info', { account: site.address, ledger_index: 'validated' });
  const chain = keyChain(fromHex(site.chainSeed as `0x${string}`), `site/${site.address}`);
  const listed = info.account_data.RegularKey === undefined ? undefined : chain.indexOf(info.account_data.RegularKey, Math.max(site.index, 0));
  if (listed === undefined || listed === site.index) return false;
  site.index = listed;
  return true;
}

/** Signed by the disabled master key: proves the account, cannot move its funds. */
export function signMessage(site: Site, message: string | Uint8Array): { readonly message: string; readonly signature: string; readonly publicKey: string; readonly signerAddress: string } {
  const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  const key = master(site);
  return {
    message: typeof message === 'string' ? message : toHex(message).slice(2),
    signature: signHex(toHex(bytes).slice(2).toUpperCase(), key.privateKey),
    publicKey: key.publicKey,
    signerAddress: site.address,
  };
}

/**
 * Closes the account into a pool: AccountDelete, its XRP to `to` under a tag
 * registered for it, so the reserve and what is left become notes. The ledger
 * allows it 256 ledgers after the account was created, with no offers, trust
 * lines, NFTs or other objects left.
 */
export async function closeSite(ledger: Ledger, site: Site, to: { readonly pool: string; readonly tag: number }): Promise<string> {
  if (site.index < 0) refuse('this account was never set up');
  const blockers = await ledger.request<{ account_objects: unknown[] }>('account_objects', { account: site.address, deletion_blockers_only: true, ledger_index: 'validated' });
  if (blockers.account_objects.length > 0) refuse('remove the account\'s offers, trust lines and NFTs first');
  const state = await ledger.request<{ state: { validated_ledger: { reserve_inc: number } } }>('server_state');
  const lls = await lastLedger(ledger);
  const signed = signTx({
    TransactionType: 'AccountDelete', Account: site.address, Destination: to.pool, DestinationTag: to.tag,
    Sequence: await sequenceOf(ledger, site.address), Fee: String(state.state.validated_ledger.reserve_inc), LastLedgerSequence: lls,
  }, regularKey(site, site.index));
  // Not closed means still here, with its key shown: retire the key first.
  const retire = () => rotate(ledger, site).catch(() => undefined);
  const result = await submitAndWait(ledger, signed, lls).catch(async (error: unknown) => { await retire(); throw error; });
  if (result !== 'tesSUCCESS') {
    await retire();
    throw new ProtocolFailure('SETTLEMENT_REVERTED', `AccountDelete: ${result}`);
  }
  return signed.hash;
}
