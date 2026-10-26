// XRPL, from Node: the XRPL page's runtime (frontend/src/lib/xrpl-runtime.ts)
// with its proofs on a worker thread. Testnet only, as the pools are.

import type { UnixSeconds } from '@opaque/protocol-types';

import { isAccount } from '../../../backend/xrpl/protocol.ts';
import { xrplDeployment } from '../../../deployments/xrpl.ts';
import { paymentDeadline } from '../../../frontend/src/lib/payment-deadline.ts';
import { loadXrplStack, startXrplWallet, type Sent, type SwapQuote, type XrplWallet } from '../../../frontend/src/lib/xrpl-runtime.ts';
import type { AccountKeys } from '../../../frontend/src/lib/xrpl-keys.ts';
import { nodeProver } from './prover.ts';

/** The hosted XRPL testnet service's config (frontend/package.json's build:site names the same). */
const STACK = 'https://opaque-xrpl-testnet-production.up.railway.app/xrpl-stack.json';
/** The accounts this wallet has looked for on the ledger. */
const SCANNED = 'opaque:sdk:xrpl-scanned';

export type XrplClient = Awaited<ReturnType<typeof openXrpl>>;
export interface XrplSendOptions {
  /** A destination tag, for an exchange or a shared address. */
  readonly tag?: number;
  /** Hold each note until the pool's privacy is high, settling by `deadline`. Default: settle on arrival. */
  readonly waitForPrivacy?: boolean;
  readonly deadline?: Date;
}

/** The XRPL page's runtime, from the hosted service's config, its proofs on a worker thread. */
const start = async (account: AccountKeys): Promise<XrplWallet> =>
  startXrplWallet(await loadXrplStack(process.env['OPAQUE_XRPL_STACK_URL'] ?? STACK), account, { prover: nodeProver });

export async function openXrpl(account: AccountKeys, begin = start) {
  if (xrplDeployment.pools.length === 0) throw new Error(`Opaque has no pools on ${xrplDeployment.network.name} yet: open the wallet on testnet`);
  const wallet = await begin(account);
  // One that fails to open leaves nothing running: opened again, it starts afresh (F-62).
  try { return await clientOf(wallet, account); } catch (error) { await wallet.close(); throw error; }
}

async function clientOf(wallet: XrplWallet, account: AccountKeys) {
  // The first time this wallet opens the account: its notes and addresses, found on the ledger, as Arc does.
  const scanned = JSON.parse(localStorage.getItem(SCANNED) ?? '[]') as string[];
  if (!scanned.includes(account.id)) {
    await wallet.recover();
    localStorage.setItem(SCANNED, JSON.stringify([...scanned, account.id]));
  }
  const deadline = (o: { readonly waitForPrivacy?: boolean; readonly deadline?: Date }) =>
    paymentDeadline({ waitForPrivacy: o.waitForPrivacy === true, nowMs: Date.now(), ...(o.deadline ? { selectedMs: o.deadline.getTime() } : {}) }) as UnixSeconds;
  const symbolOf = (symbol: string): string => {
    const pool = wallet.pools.find((p) => p.symbol.toLowerCase() === symbol.toLowerCase());
    if (pool === undefined) throw new Error(`no ${symbol} pool: ${wallet.pools.map((p) => p.symbol).join(', ')}`);
    return pool.symbol;
  };

  const xrpl = {
    network: xrplDeployment.network.name,
    /** The assets Opaque holds privately here: XRP, RLUSD, USDC… */
    symbols: wallet.pools.map((p) => p.symbol),
    /** Whole units held in notes, re-checked against the ledger. */
    async balance(symbol = 'XRP'): Promise<{ readonly amount: number; readonly notes: number }> {
      await wallet.refresh();
      const b = await wallet.balance(symbolOf(symbol));
      return { amount: b.units, notes: b.notes };
    },
    /**
     * The account's reusable deposit address for an asset: the pool's address
     * and a tag only this account tops up. Payments to it become notes.
     */
    async address(symbol = 'XRP'): Promise<{ readonly xAddress: string; readonly account: string; readonly tag: number }> {
      const a = (await wallet.address(symbolOf(symbol)))!;
      return { xAddress: a.xAddress, account: a.pool, tag: a.tag };
    },
    /** Finds deposits made to the address since the last look, as notes. */
    recover: (): Promise<number> => wallet.recover(),
    /** Whether the spendable notes make exactly `amount` of `symbol`: a payment that can't is refused before anything is spent. */
    canPay: async (symbol: string, amount: number): Promise<boolean> => Number.isInteger(amount) && amount >= 1 && (await wallet.plan(symbolOf(symbol), amount)) !== undefined,
    /** Pays `amount` (whole) of `symbol` to an XRPL account from notes, each through a ring. */
    async send(symbol: string, amount: number, to: string, options: XrplSendOptions = {}): Promise<Sent> {
      if (!isAccount(to)) throw new Error('the destination is a classic XRPL address (r…); put a tag in options.tag');
      const tag = options.tag ?? null;
      if (tag !== null && (!Number.isInteger(tag) || tag < 0 || tag > 0xffff_ffff)) throw new Error('a destination tag is a whole number up to 4294967295');
      if (!Number.isInteger(amount) || amount < 1) throw new Error('send a whole amount, 1 or more');
      return wallet.send({ symbol: symbolOf(symbol), amount, destination: { account: to, tag }, waitForPrivacy: options.waitForPrivacy === true, deadline: deadline(options) });
    },
    /** Waits until every note of a payment has an outcome. */
    settled: (sent: Sent, timeoutMs?: number): Promise<Sent> => wallet.settled(sent, timeoutMs),
    /** Payments this wallet has sent, newest first, each note's state re-read through the mesh. */
    activity: (): Promise<readonly Sent[]> => wallet.pollActivity(),
    /** What swapping `amount` of `from` into `to` privately would bring now, or undefined if the notes can't make it. */
    swapQuote: (from: string, to: string, amount: number): Promise<SwapQuote | undefined> => wallet.swapQuote(symbolOf(from), symbolOf(to), amount),
    /** A private swap: notes spent through rings into a fresh tag of `to`'s pool; nothing links the two sides. */
    swap: (from: string, to: string, amount: number, options: { readonly deadline?: Date } = {}) =>
      wallet.swap({ from: symbolOf(from), to: symbolOf(to), amount, deadline: deadline({ waitForPrivacy: options.deadline !== undefined, ...options }) }),
    /** Stops what this client started: its relays' poll, its waits for payments, its prover's thread. */
    close: (): Promise<void> => wallet.close(),
  };
  return xrpl;
}
