// The XRPL mesh query (protocol-types XrplOperation): both ends.
//
// The exit answers; the wallet asks through three relays, so the exit learns
// the question and never the questioner. Like WALLET_RPC, each operation takes
// one JSON request and does one narrow thing, and an answer carries its own
// error ({ error }) rather than failing the query: a query that fails at the
// exit leaves nothing at the drop, and the wallet would wait out its deadline.
//
// Browser-safe: the wallet imports this file too.

import { ProtocolFailure, type Hex, type NoteCommitment, type Nullifier, type XrplOperation } from '@opaque/protocol-types';
import { asBytes32, fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import type { TagRegistration } from './pool.ts';
import type { Ledger } from './site.ts';

export type XrplSend = (operation: XrplOperation, encodedRequest: Hex) => Promise<Hex>;

const MAX_REQUEST_BYTES = 64 * 1024;
const utf8 = (s: string) => new TextEncoder().encode(s);
const json = (value: unknown): Hex => toHex(utf8(JSON.stringify(value)));
const refuse = (message: string): never => { throw new ProtocolFailure('INVALID_INPUT', message); };
const str = (v: unknown, label: string): string => (typeof v === 'string' ? v : refuse(`${label} must be a string`));
const int = (v: unknown, label: string): number => (typeof v === 'number' && Number.isSafeInteger(v) ? v : refuse(`${label} must be an integer`));

/** What the exit needs from the XRPL node; built in the stack from xrpl/node.ts. */
export interface XrplAnswererDeps {
  registerTag(pool: string, tag: number, registration: TagRegistration): Promise<void>;
  tagStatus(pool: string, tag: number): Promise<{ readonly registered: boolean; readonly notes: number; readonly carried: bigint }>;
  isSpent(pool: string, nullifier: Nullifier): Promise<boolean>;
  /** Absent: Buy is not offered by this exit. */
  onrampUrl?(pool: string, tag: number, fiatAmount: number): Promise<string>;
  /** Absent: not a testnet, so no faucet. */
  faucet?(pool: string, tag: number): Promise<{ readonly xrp: number; readonly hash: string }>;
  /** One allowlisted ledger read (READ_COMMANDS). */
  read?(command: string, params: Record<string, unknown>): Promise<unknown>;
  /** A signed transaction blob, as any public node takes one. */
  submit?(txBlob: string): Promise<unknown>;
}

/**
 * The reads a per-site account needs, and nothing else: public ledger data,
 * asked by an exit that does not know who is asking. No admin command, no
 * subscription, no path finding (it holds a connection open).
 */
export const READ_COMMANDS = new Set([
  'account_info', 'account_lines', 'account_objects', 'account_offers', 'account_nfts', 'book_offers', 'amm_info',
  'nft_sell_offers', 'nft_buy_offers', 'ledger_entry', 'fee', 'ledger_current', 'server_state', 'tx',
]);

export function createXrplAnswerer(deps: XrplAnswererDeps): XrplSend {
  const handlers: Record<XrplOperation, (r: Record<string, unknown>) => Promise<unknown>> = {
    async REGISTER_TAG(r) {
      const pool = str(r['pool'], 'pool');
      const tag = int(r['tag'], 'tag');
      const commitments = r['commitments'];
      if (typeof commitments !== 'object' || commitments === null) refuse('commitments are a list per note size');
      await deps.registerTag(pool, tag, commitments as TagRegistration);
      return { pool, tag };
    },
    async TAG_STATUS(r) {
      const s = await deps.tagStatus(str(r['pool'], 'pool'), int(r['tag'], 'tag'));
      return { registered: s.registered, notes: s.notes, carried: s.carried.toString(10) };
    },
    async NULLIFIER_SPENT(r) {
      return { spent: await deps.isSpent(str(r['pool'], 'pool'), asBytes32(r['nullifier']) as unknown as Nullifier) };
    },
    async ONRAMP_URL(r) {
      if (deps.onrampUrl === undefined) refuse('this exit does not offer Buy');
      return { url: await deps.onrampUrl!(str(r['pool'], 'pool'), int(r['tag'], 'tag'), int(r['fiatAmount'], 'fiatAmount')) };
    },
    async FAUCET(r) {
      if (deps.faucet === undefined) refuse('this exit has no faucet');
      return deps.faucet!(str(r['pool'], 'pool'), int(r['tag'], 'tag'));
    },
    async READ(r) {
      const command = str(r['command'], 'command');
      if (!READ_COMMANDS.has(command)) refuse(`READ does not answer ${command}`);
      const params = r['params'] ?? {};
      if (typeof params !== 'object' || params === null || Array.isArray(params) || 'command' in params) refuse('params is an object');
      if (deps.read === undefined) refuse('this exit does not answer READ');
      return deps.read!(command, params as Record<string, unknown>);
    },
    async SUBMIT(r) {
      const blob = str(r['tx_blob'], 'tx_blob');
      if (!/^[0-9A-Fa-f]{2,65536}$/.test(blob)) refuse('tx_blob is hex');
      if (deps.submit === undefined) refuse('this exit does not answer SUBMIT');
      return deps.submit!(blob);
    },
  };

  return async (operation, encodedRequest) => {
    try {
      const handler = handlers[operation] ?? refuse(`unknown operation ${operation}`);
      const bytes = fromHex(encodedRequest);
      if (bytes.length > MAX_REQUEST_BYTES) refuse('request too large');
      let request: unknown;
      try { request = JSON.parse(new TextDecoder().decode(bytes)); } catch { refuse('a request is JSON'); }
      if (typeof request !== 'object' || request === null) refuse('a request is a JSON object');
      return json({ result: await handler(request as Record<string, unknown>) });
    } catch (error) {
      // Public messages only: nothing here carries a secret.
      const e = error as { publicMessage?: string; message?: string; code?: string; retryable?: boolean };
      return json({ error: { code: e.code ?? 'MESH_UNAVAILABLE', message: e.publicMessage ?? e.message ?? 'failed', retryable: e.retryable ?? true } });
    }
  };
}

// ── the wallet's side ─────────────────────────────────────────────────────

export async function xrplCall<T>(send: XrplSend, operation: XrplOperation, request: unknown): Promise<T> {
  const answer = JSON.parse(new TextDecoder().decode(fromHex(await send(operation, json(request))))) as {
    result?: T; error?: { code: string; message: string; retryable: boolean };
  };
  if (answer.error !== undefined) throw new ProtocolFailure(answer.error.code as never, answer.error.message, answer.error.retryable);
  return answer.result as T;
}

export const registerTag = (send: XrplSend, pool: string, tag: number, commitments: Readonly<Record<string, readonly NoteCommitment[]>>) =>
  xrplCall<{ pool: string; tag: number }>(send, 'REGISTER_TAG', { pool, tag, commitments });

export const tagStatus = async (send: XrplSend, pool: string, tag: number) => {
  const s = await xrplCall<{ registered: boolean; notes: number; carried: string }>(send, 'TAG_STATUS', { pool, tag });
  return { ...s, carried: BigInt(s.carried) };
};

export const nullifierSpent = async (send: XrplSend, pool: string, nullifier: Nullifier) =>
  (await xrplCall<{ spent: boolean }>(send, 'NULLIFIER_SPENT', { pool, nullifier })).spent;

export const onrampUrl = async (send: XrplSend, pool: string, tag: number, fiatAmount: number) =>
  (await xrplCall<{ url: string }>(send, 'ONRAMP_URL', { pool, tag, fiatAmount })).url;

export const faucetDeposit = (send: XrplSend, pool: string, tag: number) =>
  xrplCall<{ xrp: number; hash: string }>(send, 'FAUCET', { pool, tag });

/** site.ts's ledger, through the mesh: what a per-site account reads and sends. */
export const meshLedger = (send: XrplSend): Ledger => ({
  request: <T,>(command: string, params: Record<string, unknown> = {}) => xrplCall<T>(send, 'READ', { command, params }),
  submit: (txBlob: string) => xrplCall(send, 'SUBMIT', { tx_blob: txBlob }),
});
