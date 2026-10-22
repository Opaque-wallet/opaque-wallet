// What an agent may pay without you, and what it must ask about. Kept in the
// wallet file, under its password: the agent's tools can read it, never
// change it (`opaque-mcp policy` does, with the password).
//
// Limits are per asset, as `<chain>:<symbol>`: an asset with no limit can't
// be paid at all. Money moved within the account (a deposit, a swap) isn't a
// payment; money that leaves it is, a deployer of the account's own included.

export interface Limit {
  /** The most one payment may be. */
  readonly perPayment: number;
  /** The most all payments may add up to in any 24 hours. */
  readonly perDay: number;
  /** Above this, you are asked first, in the agent's client. */
  readonly askAbove: number;
}
export interface Policy {
  readonly limits: Readonly<Record<string, Limit>>;
  /** Who may be paid, besides the account's own deployers. Empty: anyone. */
  readonly recipients: readonly string[];
  /**
   * Account operations (deposit, deploy, call, swap, withdraw) in any 24
   * hours: each costs gas and one of the key's few signatures. Default 20.
   */
  readonly operationsPerDay?: number;
}
export interface Spend { readonly at: number; readonly asset: string; readonly amount: number; readonly to: string }
export type Verdict = { readonly ok: true; readonly ask: boolean } | { readonly ok: false; readonly why: string };

export const DAY_MS = 86_400_000;

export const DEFAULT_POLICY: Policy = {
  limits: {
    'arc:USDC': { perPayment: 10, perDay: 50, askAbove: 5 },
    'xrpl:XRP': { perPayment: 20, perDay: 100, askAbove: 10 },
    'xrpl:RLUSD': { perPayment: 10, perDay: 50, askAbove: 5 },
    'xrpl:USDC': { perPayment: 10, perDay: 50, askAbove: 5 },
  },
  recipients: [],
  operationsPerDay: 20,
};

export const spentToday = (spends: readonly Spend[], asset: string, now: number): number =>
  spends.filter((s) => s.asset === asset && now - s.at < DAY_MS).reduce((t, s) => t + s.amount, 0);

/** Whether `spend` may go, and whether to ask first. `own`: to one of the account's own deployers. */
export function judge(policy: Policy, spends: readonly Spend[], spend: Omit<Spend, 'at'> & { readonly own?: boolean }, now: number): Verdict {
  const limit = policy.limits[spend.asset];
  if (limit === undefined) return { ok: false, why: `no limit is set for ${spend.asset}, so it can't be paid: set one with \`opaque-mcp policy\`` };
  if (!(spend.amount > 0)) return { ok: false, why: 'pay more than 0' };
  if (spend.amount > limit.perPayment) return { ok: false, why: `${spend.amount} ${spend.asset} is over the ${limit.perPayment} a payment may be` };
  const today = spentToday(spends, spend.asset, now);
  if (today + spend.amount > limit.perDay) return { ok: false, why: `${today} ${spend.asset} paid in the last 24 hours; ${spend.amount} more is over the ${limit.perDay} a day may be` };
  if (spend.own !== true && policy.recipients.length > 0 && !policy.recipients.some((r) => r.toLowerCase() === spend.to.toLowerCase())) {
    return { ok: false, why: `${spend.to} isn't among the recipients this agent may pay` };
  }
  return { ok: true, ask: spend.amount > limit.askAbove };
}

/** A policy as typed back: refuses one that isn't whole. */
export function asPolicy(value: unknown): Policy {
  const p = value as Policy;
  if (typeof p !== 'object' || p === null || typeof p.limits !== 'object' || !Array.isArray(p.recipients)) throw new Error('a policy is { limits: { "arc:USDC": { perPayment, perDay, askAbove } }, recipients: [] }');
  for (const [asset, l] of Object.entries(p.limits)) {
    if (!/^(arc|xrpl):[A-Za-z0-9]+$/.test(asset)) throw new Error(`"${asset}" isn't an asset: arc:USDC, xrpl:XRP…`);
    for (const k of ['perPayment', 'perDay', 'askAbove'] as const) {
      if (typeof l[k] !== 'number' || !Number.isFinite(l[k]) || l[k] < 0) throw new Error(`${asset}.${k} must be a number, 0 or more`);
    }
  }
  if (!p.recipients.every((r) => typeof r === 'string')) throw new Error('recipients are addresses');
  const ops = p.operationsPerDay;
  if (ops !== undefined && (!Number.isInteger(ops) || ops < 0)) throw new Error('operationsPerDay must be a whole number, 0 or more');
  return { limits: p.limits, recipients: p.recipients, ...(ops === undefined ? {} : { operationsPerDay: ops }) };
}
