// Opaque as MCP tools, served over stdio to the agent's client on this
// machine. The wallet stays in this process: the agent sees amounts,
// addresses and handles, never a key, a note or the phrase.
//
// The agent is not trusted: it may be acting on instructions a web page
// planted. So every payment out of the account passes policy.ts first (a limit
// per payment and per day, an optional list of recipients, and above
// `askAbove` a question to you in the client, MCP elicitation, which the agent
// can't answer for you), account operations have a daily cap, and a call to a
// contract the agent didn't deploy, or one that hands tokens over, asks you.
// A client that can't ask gets a refusal.

import { execFileSync } from 'node:child_process';
import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { OpaqueWallet, SwapToken } from '@opaque/sdk';
import { z } from 'zod';

import { asPolicy, DAY_MS, DEFAULT_POLICY, judge, spentToday, type Policy, type Spend } from './policy.ts';

export const POLICY = 'mcp:policy';
const SPENT = 'mcp:spent';
const OPS = 'mcp:operations';
/** Contracts this account deployed: calls to them that hand nothing over don't ask. */
const DEPLOYED = 'mcp:deployed';
/** Deployers whose key was written out: paying them is paying whoever can read the file. */
const EXPORTED = 'mcp:exported-deployers';
/** The latest a payment that waits for privacy may be held. */
const MAX_WAIT_MS = 7 * DAY_MS;

const INSTRUCTIONS = `Opaque is a private, post-quantum wallet. These tools act for one Opaque account kept on this machine: its keys never reach you.
- Arc: USDC at the account's public address (arc_balance "public") is turned into private notes with arc_deposit; arc_send pays from notes, privately, in whole USDC. A payment is submitted, then settles within seconds to minutes: check payment_status.
- Deployers are fresh Arc addresses for forge or hardhat, funded privately with fund_deployer. One per project. get_deployer_key writes a key into a .env file, never into this conversation.
- XRPL (testnet): xrpl_deposit_address is where XRP or tokens become notes; xrpl_send pays from them.
- Payments out are limited per payment and per day, account operations per day, and larger or unusual ones ask the person first. A refusal says why: don't try to split a payment to get under a limit.`;

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2) }] });
const failed = (error: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] });
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'an Arc address: 0x and 40 hex digits');
const whole = z.number().int().min(1);

/** Hex as the agent sent it, only if it is nothing but hex: what the person is shown is then exactly what is signed. */
export function hexOf(value: string, what: string): `0x${string}` {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error(`the ${what} must be 0x and hex digits, two per byte, and nothing else`);
  return value.toLowerCase() as `0x${string}`;
}

/** A decimal amount of a token, in its smallest units. */
export function unitsOf(amount: string, token: SwapToken): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (m === null || (m[2] ?? '').length > token.decimals) throw new Error(`"${amount}" isn't an amount of ${token.symbol} (up to ${token.decimals} decimals)`);
  return BigInt(m[1]!) * 10n ** BigInt(token.decimals) + BigInt((m[2] ?? '').padEnd(token.decimals, '0') || '0');
}

/** git, without the config an agent could plant in a repo running anything, and without this process's secrets. */
const git = (dir: string, args: readonly string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args],
  { stdio: 'ignore', env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' } });

/**
 * Where a deployer's key may go: an env file (.env, .env.local…), in a real
 * folder, that git would not commit. Returns its full path, links resolved, to
 * show the person before anything is written.
 */
export function keyFilePath(path: string): string {
  const name = basename(path);
  if (!/^\.env(?:\.[A-Za-z0-9_-]+)?$/.test(name)) throw new Error(`a key goes only in an env file (.env, .env.local…), not ${name}`);
  const full = join(realpathSync(dirname(resolve(path))), name);
  const inRepo = (() => { try { git(dirname(full), ['rev-parse', '--git-dir']); return true; } catch { return false; } })();
  if (inRepo) {
    try { git(dirname(full), ['check-ignore', '-q', full]); } catch { throw new Error(`${full} isn't in .gitignore: git would commit the key. Add it there first`); }
  }
  return full;
}

/**
 * Puts PRIVATE_KEY in the env file at `full` (from keyFilePath), readable only
 * by you, the rest of the file as it was. Never through a link: a symlink, or
 * a second name for another file, is refused.
 */
export function writeKeyFile(full: string, key: string): void {
  const fd = openSync(full, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`${full} isn't a plain file of its own`);
    fchmodSync(fd, 0o600);
    const lines = readFileSync(fd, 'utf8').split('\n').filter((l) => !/^PRIVATE_KEY=/.test(l));
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    ftruncateSync(fd, 0);
    writeSync(fd, `${[...lines, `PRIVATE_KEY=${key}`].join('\n')}\n`, 0);
  } finally {
    closeSync(fd);
  }
}

export function createOpaqueServer(wallet: OpaqueWallet): McpServer {
  const server = new McpServer({ name: 'opaque', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const policy = (): Policy => asPolicy(JSON.parse(wallet.data.get(POLICY) ?? 'null') ?? DEFAULT_POLICY);
  const list = <T>(name: string): T[] => JSON.parse(wallet.data.get(name) ?? '[]') as T[];
  const add = <T>(name: string, value: T) => wallet.data.set(name, JSON.stringify([...list<T>(name), value]));
  const spends = (): Spend[] => list<Spend>(SPENT);

  /** Asks the person, in the client. False when they decline, or the client can't ask. */
  async function ask(message: string): Promise<boolean> {
    if (server.server.getClientCapabilities()?.elicitation === undefined) return false;
    const answer = await server.server.elicitInput({
      message,
      requestedSchema: { type: 'object', properties: { approve: { type: 'boolean', title: 'Approve', description: message } }, required: ['approve'] },
    });
    return answer.action === 'accept' && answer.content?.['approve'] === true;
  }
  const askOrRefuse = async (message: string, why: string) => {
    if (!(await ask(message))) throw new Error(`Not done: ${why} needs the person's approval, and they declined or this client can't ask them.`);
  };

  /**
   * A payment out, within the policy: its limits first, then whether the notes
   * can make it (`payable`: nothing is asked or counted for one that can't be
   * sent), then the person if it is over askAbove. Judged again after both,
   * with nothing awaited between that and the count: others may have been
   * paid while the notes were checked or the person was asked (F-35, F-46).
   * Counted before it is sent, and kept counted if it fails: one that left
   * despite an error must count.
   */
  async function pay<T>(spend: { readonly asset: string; readonly amount: number; readonly to: string; readonly own?: boolean }, what: string, payable: () => Promise<boolean>, go: () => Promise<T>): Promise<T> {
    const verdict = judge(policy(), spends(), spend, Date.now());
    if (!verdict.ok) throw new Error(`Not paid: ${verdict.why}.`);
    if (!(await payable())) throw new Error(`Not paid: the spendable notes can't make exactly ${spend.amount} (each is sent whole). Check the balance.`);
    if (verdict.ask) await askOrRefuse(`Opaque: ${what}?`, `${spend.amount} ${spend.asset}, over the ${policy().limits[spend.asset]!.askAbove} it may pay alone,`);
    const now = Date.now();
    const again = judge(policy(), spends(), spend, now);
    if (!again.ok) throw new Error(`Not paid: ${again.why}.`);
    wallet.data.set(SPENT, JSON.stringify([...spends().filter((s) => now - s.at < DAY_MS), { at: now, asset: spend.asset, amount: spend.amount, to: spend.to }]));
    return go();
  }

  /** An account operation (it signs with the few-time key and pays gas), within the day's count. */
  async function operate<T>(go: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const recent = list<number>(OPS).filter((at) => now - at < DAY_MS);
    const most = policy().operationsPerDay ?? DEFAULT_POLICY.operationsPerDay!;
    if (recent.length >= most) throw new Error(`Not done: ${recent.length} account operations in the last 24 hours, the most this agent may make (operationsPerDay).`);
    wallet.data.set(OPS, JSON.stringify([...recent, now]));
    return go();
  }

  type Shape = z.ZodRawShape;
  /** `kind`: read (changes nothing), write (changes only this wallet's own records), pay (moves money or signs). */
  const tool = <S extends Shape>(name: string, description: string, shape: S, kind: 'read' | 'write' | 'pay', run: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>) =>
    server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: kind === 'read', destructiveHint: kind === 'pay', openWorldHint: true } },
      (async (args: z.objectOutputType<S, z.ZodTypeAny>) => { try { return text(await run(args)); } catch (error) { return failed(error); } }) as never);

  // ── the account ──────────────────────────────────────────────────────────
  tool('wallet_info', 'The account: its network, Arc address, its key\'s signatures left, and what it may still pay and do today under its limits.', {}, 'read', async () => {
    const arc = await wallet.arc();
    const p = policy();
    const now = Date.now();
    return {
      network: wallet.network, accountId: wallet.accountId, arcAddress: arc.address, key: await arc.keyStatus(),
      limits: Object.fromEntries(Object.entries(p.limits).map(([asset, l]) => [asset, { ...l, paidToday: spentToday(spends(), asset, now) }])),
      recipients: p.recipients.length === 0 ? 'anyone' : p.recipients,
      operationsToday: `${list<number>(OPS).filter((at) => now - at < DAY_MS).length} of ${p.operationsPerDay ?? DEFAULT_POLICY.operationsPerDay}`,
    };
  });

  // ── Arc ──────────────────────────────────────────────────────────────────
  tool('arc_balance', 'USDC on Arc: in private notes (and of those, waiting for their pool to fill), and public at the account\'s address.', {}, 'read',
    async () => (await wallet.arc()).balance());
  tool('arc_deposit', 'Turns whole USDC at the account\'s public address into private notes. Moves money within the account; an account operation.', { usdc: whole }, 'pay',
    async ({ usdc }) => { const arc = await wallet.arc(); return operate(() => arc.deposit(usdc)); });
  tool('arc_send', 'Pays whole USDC privately from notes to an Arc address. Returns a handle per note: check payment_status.',
    { to: address, usdc: whole, waitForPrivacy: z.boolean().optional().describe('Hold until the pool\'s privacy is high (settles by `deadline`, within 7 days). Default: settle on arrival.'), deadline: z.string().datetime().optional() }, 'pay',
    async ({ to, usdc, waitForPrivacy, deadline }) => {
      const arc = await wallet.arc();
      if (deadline !== undefined && Date.parse(deadline) > Date.now() + MAX_WAIT_MS) throw new Error('Not paid: a payment waits for privacy 7 days at most.');
      return pay({ asset: 'arc:USDC', amount: usdc, to }, `pay ${usdc} USDC on Arc to ${to}`, () => arc.canPay(usdc), () =>
        arc.send(to, usdc, { ...(waitForPrivacy === undefined ? {} : { waitForPrivacy }), ...(deadline === undefined ? {} : { deadline: new Date(deadline) }) }));
    });
  tool('payment_status', 'Where an Arc payment is: WAITING_FOR_PRIVACY, …, SETTLED or FAILED.', { handle: z.string() }, 'read',
    async ({ handle }) => (await wallet.arc()).status(handle));
  tool('arc_activity', 'Arc payments this account sent, newest first: handle, recipient, USDC, when.', {}, 'read',
    async () => (await wallet.arc()).activity());
  tool('arc_withdraw', 'Sends everything at the account\'s public address (not the notes) to an Arc address. Public, and always asks the person.', { to: address }, 'pay',
    async ({ to }) => {
      const arc = await wallet.arc();
      const p = policy();
      if (p.recipients.length > 0 && !p.recipients.some((r) => r.toLowerCase() === to.toLowerCase())) throw new Error(`Not done: ${to} isn't among the recipients this agent may pay.`);
      await askOrRefuse(`Opaque: send everything at ${arc.address} (${(await arc.balance()).public} USDC) to ${to}?`, 'a withdrawal');
      return operate(async () => ({ tx: await arc.withdraw(to as `0x${string}`) }));
    });

  // ── deployers and contracts ──────────────────────────────────────────────
  tool('get_deployer', 'A deployer: a plain Arc address for forge or hardhat, unlinked to this account. No index: a fresh one nothing has used.', { index: z.number().int().min(0).optional() }, 'write',
    async ({ index }) => {
      const arc = await wallet.arc();
      const d = index === undefined ? await arc.nextDeployer() : arc.deployer(index);
      return { index: d.index, address: d.address, usdc: await arc.fundsAt(d.address) };
    });
  tool('fund_deployer', 'Pays whole USDC privately from notes to one of the account\'s deployers, for its gas.', { index: z.number().int().min(0), usdc: whole }, 'pay',
    async ({ index, usdc }) => {
      const arc = await wallet.arc();
      const d = arc.deployer(index);
      // A deployer whose key was written out is paid like anyone else: whoever reads the file holds it.
      const own = !list<number>(EXPORTED).includes(index);
      return pay({ asset: 'arc:USDC', amount: usdc, to: d.address, own }, `fund deployer ${index} (${d.address}) with ${usdc} USDC`, () => arc.canPay(usdc), () => arc.fundDeployer(index, usdc));
    });
  tool('get_deployer_key', 'Writes a deployer\'s key as PRIVATE_KEY into an env file (.env, .env.local…; created readable only by you), for forge or hardhat. Never returns the key. The file must be git-ignored. Always asks the person.',
    { index: z.number().int().min(0), path: z.string().describe('The env file, e.g. ./contracts/.env') }, 'pay',
    async ({ index, path }) => {
      const d = (await wallet.arc()).deployer(index);
      const full = keyFilePath(path);
      await askOrRefuse(`Opaque: write deployer ${index}'s key (${d.address}) into ${full}? Whoever can read that file can spend what the deployer holds.`, 'writing a key to a file');
      writeKeyFile(full, d.key);
      if (!list<number>(EXPORTED).includes(index)) add(EXPORTED, index);
      return { path: full, index, address: d.address };
    });
  tool('arc_deploy', 'Deploys contract initcode from the account through the CREATE2 factory, signed by its post-quantum key, gas from its public USDC. Returns where it landed.',
    { initcode: z.string().describe('0x… creation bytecode, constructor arguments appended'), salt: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional() }, 'pay',
    async ({ initcode, salt }) => {
      const arc = await wallet.arc();
      const made = await operate(() => arc.deploy(hexOf(initcode, 'initcode'), salt as `0x${string}` | undefined));
      add(DEPLOYED, made.address.toLowerCase());
      return made;
    });
  tool('contract_risk', 'What a contract call would do with the account\'s tokens, in words; null if it hands nothing over.', { to: address, data: z.string() }, 'read',
    async ({ to, data }) => ({ risk: (await wallet.arc()).riskOf(to as `0x${string}`, hexOf(data, 'calldata')) }));
  tool('arc_call', 'Calls a contract from the account, signed by its post-quantum key. A call that hands the account\'s tokens over, or any call to a contract this account didn\'t deploy, asks the person first.',
    { to: address, data: z.string().describe('0x… calldata, e.g. from `cast calldata`') }, 'pay',
    async ({ to, data }) => {
      const arc = await wallet.arc();
      const calldata = hexOf(data, 'calldata');
      // Read from exactly the bytes that are signed.
      const risk = arc.riskOf(to as `0x${string}`, calldata);
      const ours = list<string>(DEPLOYED).includes(to.toLowerCase());
      if (risk !== null) await askOrRefuse(`Opaque: ${risk} Sign it?`, 'a call that hands over the account\'s tokens');
      else if (!ours) await askOrRefuse(`Opaque: call ${calldata.slice(0, 10)} on ${to}, a contract this agent didn't deploy?`, 'a call to a contract this agent didn\'t deploy');
      return operate(async () => ({ tx: await arc.call(to as `0x${string}`, calldata, { allowRisk: risk !== null }) }));
    });

  // ── swaps (within the account) ───────────────────────────────────────────
  const tokenOf = async (symbol: string) => {
    const t = (await wallet.arc()).swapTokens.find((s) => s.symbol.toLowerCase() === symbol.toLowerCase());
    if (t === undefined) throw new Error(`no swap token ${symbol}`);
    return t;
  };
  tool('arc_swap_quote', 'What swapping a public token amount at the address would bring, through LI.FI (asked across the mesh).', { from: z.string(), to: z.string(), amount: z.string().describe('In whole tokens, e.g. "2.5"') }, 'read',
    async ({ from, to, amount }) => {
      const [a, b] = [await tokenOf(from), await tokenOf(to)];
      const q = await (await wallet.arc()).swapQuote(a.symbol, b.symbol, unitsOf(amount, a));
      return { from: a.symbol, to: b.symbol, amount, atLeast: Number(q.toAmountMin) / 10 ** b.decimals, expected: Number(q.toAmount) / 10 ** b.decimals };
    });
  tool('arc_swap', 'Swaps a public token amount at the address, through LI.FI, quoted and checked again before the PQ key signs. Within the account; above the token\'s askAbove (or for a token with no limit) it asks the person.',
    { from: z.string(), to: z.string(), amount: z.string() }, 'pay',
    async ({ from, to, amount }) => {
      const arc = await wallet.arc();
      const [a, b] = [await tokenOf(from), await tokenOf(to)];
      const units = unitsOf(amount, a);
      const limit = policy().limits[`arc:${a.symbol}`];
      if (limit === undefined || Number(amount) > limit.askAbove) await askOrRefuse(`Opaque: swap ${amount} ${a.symbol} into ${b.symbol} at ${arc.address}?`, `a swap of ${amount} ${a.symbol}`);
      return operate(async () => ({ tx: await arc.swap(a.symbol, b.symbol, units, await arc.swapQuote(a.symbol, b.symbol, units)) }));
    });

  // ── XRPL ─────────────────────────────────────────────────────────────────
  const symbol = z.string().default('XRP');
  tool('xrpl_balance', 'An asset held privately on XRPL (testnet), in whole units, and in how many notes.', { symbol }, 'read',
    async ({ symbol: s }) => (await wallet.xrpl()).balance(s));
  tool('xrpl_deposit_address', 'The account\'s reusable XRPL deposit address for an asset: payments to it become private notes. Call xrpl_balance after they land.', { symbol }, 'write',
    async ({ symbol: s }) => (await wallet.xrpl()).address(s));
  tool('xrpl_send', 'Pays a whole amount of an asset privately from XRPL notes to a classic address (r…), with an optional destination tag.',
    { symbol, amount: whole, to: z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, 'a classic XRPL address, r…'), tag: z.number().int().min(0).max(0xffff_ffff).optional() }, 'pay',
    async ({ symbol: s, amount, to, tag }) => {
      const xrpl = await wallet.xrpl();
      const sent = await pay({ asset: `xrpl:${s.toUpperCase()}`, amount, to }, `pay ${amount} ${s} on XRPL to ${to}${tag === undefined ? '' : ` (tag ${tag})`}`, () => xrpl.canPay(s, amount), () =>
        xrpl.send(s, amount, to, tag === undefined ? {} : { tag }));
      return { id: sent.id, notes: sent.notes.map((n) => ({ size: n.size, state: n.state })) };
    });
  tool('xrpl_activity', 'XRPL payments this account sent, newest first, each note\'s state read again.', {}, 'read',
    async () => (await (await wallet.xrpl()).activity()).map((s) => ({ id: s.id, symbol: s.symbol, amount: s.amount, to: s.destination, at: new Date(s.createdAt).toISOString(), notes: s.notes.map((n) => n.state) })));

  return server;
}

export async function serve(wallet: OpaqueWallet): Promise<void> {
  // stdout is the protocol: anything the wallet code logs goes to stderr.
  console.log = console.info = (...args: unknown[]) => console.error(...args);
  await createOpaqueServer(wallet).connect(new StdioServerTransport());
}
