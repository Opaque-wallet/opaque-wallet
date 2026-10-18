// Sweeping an ordinary XRPL wallet into Opaque: its pool tokens and its XRP
// paid into fresh deposit tags, so they become private notes. The wallet's
// secret signs in the page and is never stored or sent anywhere. The ledger
// shows that wallet paying the pool once; the notes take it from there.
//
// The XRP goes by AccountDelete when the account can be deleted (nothing it
// owns, and 256 ledgers old), which moves the reserve too; otherwise by a
// Payment of everything above the reserve, which stays with the account.

import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { deriveAddress, deriveKeypair } from 'ripple-keypairs';

import { ProtocolFailure } from '@opaque/protocol-types';

import type { KeyPair } from './keys.ts';
import { baseFee, lastLedger, sequenceOf, signTx, submitAndWait, type Ledger, type Tx } from './site.ts';

const refuse = (message: string): never => { throw new ProtocolFailure('INVALID_INPUT', message); };
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
/** XRPL's own path for a phrase's first account, as Xumm, GemWallet and xrpl.js derive it. */
const XRPL_PATH = "m/44'/144'/0'/0/0";

/** An XRPL wallet's keys from its secret: a family seed (s…), or a 12 or 24 word phrase. */
export function sweepKey(secret: string): KeyPair {
  const text = secret.trim();
  if (/^s[1-9A-HJ-NP-Za-km-z]{24,40}$/.test(text)) {
    let pair: { publicKey: string; privateKey: string };
    try { pair = deriveKeypair(text); } catch { return refuse('that family seed is not valid: check it letter by letter'); }
    return { address: deriveAddress(pair.publicKey), ...pair };
  }
  const words = text.toLowerCase().split(/\s+/).join(' ');
  if (validateMnemonic(words, wordlist)) {
    const node = HDKey.fromMasterSeed(mnemonicToSeedSync(words)).derive(XRPL_PATH);
    const publicKey = hex(node.publicKey!);
    return { address: deriveAddress(publicKey), publicKey, privateKey: `00${hex(node.privateKey!)}` };
  }
  return refuse('that is not an XRPL secret: a family seed starting with s, or a 12 or 24 word phrase');
}

/** A pool the sweep can pay: XRP, or a trust-line token. */
export interface SweepPool {
  readonly symbol: string;
  readonly asset: { readonly kind: 'XRP' } | { readonly kind: 'IOU'; readonly currency: string; readonly issuer: string } | { readonly kind: 'MPT' };
}

export interface SweepPlan {
  readonly address: string;
  /** Drops the XRP step moves. */
  readonly xrp: bigint;
  /** Drops that stay with the account as its reserve; 0 when it is deleted. */
  readonly kept: bigint;
  readonly deletes: boolean;
  readonly tokens: readonly { readonly symbol: string; readonly currency: string; readonly issuer: string; readonly value: string }[];
  /** Tokens no pool takes: they stay where they are. */
  readonly left: readonly string[];
}

/** What a sweep would move, read through `ledger`; nothing is signed. */
export async function planSweep(ledger: Ledger, key: KeyPair, pools: readonly SweepPool[]): Promise<SweepPlan> {
  const info = await ledger.request<{ account_data: { Balance: string; OwnerCount: number; Sequence: number } }>('account_info', { account: key.address, ledger_index: 'validated' })
    .catch(() => refuse(`${key.address} has no account on this ledger: nothing to sweep`));
  const lines = (await ledger.request<{ lines: { account: string; currency: string; balance: string }[] }>('account_lines', { account: key.address, ledger_index: 'validated' })).lines;
  const tokens: SweepPlan['tokens'][number][] = [];
  const left: string[] = [];
  for (const line of lines.filter((l) => Number(l.balance) > 0)) {
    const pool = pools.find((p) => p.asset.kind === 'IOU' && p.asset.currency === line.currency && p.asset.issuer === line.account);
    if (pool === undefined) left.push(`${line.balance} ${line.currency}`);
    else tokens.push({ symbol: pool.symbol, currency: line.currency, issuer: line.account, value: line.balance });
  }
  const state = await ledger.request<{ state: { validated_ledger: { reserve_base: number; reserve_inc: number } } }>('server_state');
  const reserveBase = BigInt(state.state.validated_ledger.reserve_base);
  const reserveInc = BigInt(state.state.validated_ledger.reserve_inc);
  const fee = await baseFee(ledger);
  const balance = BigInt(info.account_data.Balance);
  // Each token payment costs a fee before the XRP goes.
  const afterTokens = balance - fee * BigInt(tokens.length);
  const current = (await ledger.request<{ ledger_current_index: number }>('ledger_current')).ledger_current_index;
  const deletes = info.account_data.OwnerCount === 0 && info.account_data.Sequence + 256 <= current && afterTokens > reserveInc;
  if (deletes) return { address: key.address, xrp: afterTokens - reserveInc, kept: 0n, deletes, tokens, left };
  const kept = reserveBase + reserveInc * BigInt(info.account_data.OwnerCount);
  const xrp = afterTokens - kept - fee;
  return { address: key.address, xrp: xrp > 0n ? xrp : 0n, kept, deletes, tokens, left };
}

/**
 * Moves what `plan` names: each token, then the XRP, to its own fresh tag.
 * `depositTo` makes the tag (and the notes it credits) before anything is paid.
 */
export async function runSweep(
  ledger: Ledger, key: KeyPair, plan: SweepPlan,
  depositTo: (symbol: string, amount: number) => Promise<{ readonly pool: string; readonly tag: number }>,
  onProgress?: (line: string) => void,
): Promise<readonly string[]> {
  const hashes: string[] = [];
  const send = async (tx: Tx, fee: bigint) => {
    const lls = await lastLedger(ledger);
    const signed = signTx({ ...tx, Sequence: await sequenceOf(ledger, key.address), Fee: String(fee), LastLedgerSequence: lls }, key);
    const result = await submitAndWait(ledger, signed, lls);
    if (result !== 'tesSUCCESS') throw new ProtocolFailure('SETTLEMENT_REVERTED', `${tx.TransactionType} ended ${result}`);
    hashes.push(signed.hash);
  };
  for (const t of plan.tokens) {
    const to = await depositTo(t.symbol, Number(t.value));
    onProgress?.(`Paying ${t.value} ${t.symbol} into tag ${to.tag}…`);
    await send({ TransactionType: 'Payment', Account: key.address, Destination: to.pool, DestinationTag: to.tag, Amount: { currency: t.currency, issuer: t.issuer, value: t.value } }, await baseFee(ledger));
  }
  if (plan.xrp > 0n) {
    const to = await depositTo('XRP', Number(plan.xrp) / 1e6);
    if (plan.deletes) {
      onProgress?.(`Closing ${key.address} into tag ${to.tag}: all its XRP, reserve included…`);
      const state = await ledger.request<{ state: { validated_ledger: { reserve_inc: number } } }>('server_state');
      // AccountDelete's fee is the owner reserve, and the rest goes to the destination.
      await send({ TransactionType: 'AccountDelete', Account: key.address, Destination: to.pool, DestinationTag: to.tag }, BigInt(state.state.validated_ledger.reserve_inc));
    } else {
      onProgress?.(`Paying ${Number(plan.xrp) / 1e6} XRP into tag ${to.tag}…`);
      await send({ TransactionType: 'Payment', Account: key.address, Destination: to.pool, DestinationTag: to.tag, Amount: String(plan.xrp) }, await baseFee(ledger));
    }
  }
  return hashes;
}
