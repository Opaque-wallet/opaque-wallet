// The XRPL wallet's composition root (runtime.ts is Arc's). Same rules:
//
//   relay keys   the SIGNED directory, verified before any relay is contacted.
//   ring         a mesh query: the pool's deposit log, from its own ledger history.
//   proof        built HERE, in a Web Worker: the note secret never leaves the page.
//   intent       sealed here to the CRE key, then chunked across the mesh, with
//                the XRPL destination (account and tag) inside the seal. The
//                proof binds both, so nobody downstream can change either.
//   receiving    a fresh destination tag per receive, registered with the
//                attesters through the mesh with notes made in this browser.
//                The tag is all a payer sees, and it names no one.
//   buying       a MoonPay checkout URL signed at the exit, opened in a NEW tab:
//                this page never contacts MoonPay.
//   pools        compiled in (deployments/xrpl-*.json), never named by a server.
//   secrets      an account of a recovery phrase draws every note and every app
//                account from the phrase (lib/xrpl-keys.ts), so importing the
//                phrase elsewhere finds them again; the browser wallet from
//                before phrases keeps random ones, backed up by file.
//
// The page talks to its own origin and Opaque's stack, and nothing else.

import type { Address, CredentialHandle, Hex, IdempotencyKey, IntentRef, IntentStatus, MeshQuery, NoteSummary, PaymentRequest, PoolScope, PrivacyScore, RelaySnapshot, RingSnapshot, StatusHandle, UnixSeconds } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';
import { createNoteSecret, deriveCommitment } from '@opaque/zk';

import { createMeshBootstrap } from '../../../backend/mesh/bootstrap.ts';
import type { BackupTransport } from './passkey-backup.ts';
import { chainTo } from '../../../backend/mesh/directory.ts';
import { createGraphHealth } from '../../../backend/mesh/graph-health.ts';
import type { DirectoryTrustRoot, SignedDirectory } from '../../../backend/mesh/contracts.ts';
import { createIntentSealer } from '../../../backend/cre/seal-client.ts';
import { accountOf, recipientFor, scopeOf, xAddressOf, type XrplDestination } from '../../../backend/xrpl/protocol.ts';
import { faucetDeposit, meshLedger, nullifierSpent, onrampUrl, registerTag, tagStatus, type XrplSend } from '../../../backend/xrpl/queries.ts';
import { closeSite, newSite, resultOf, rotate, setupSite, signAndSubmit, signMessage, signOnly, syncIndex, type Site } from '../../../backend/xrpl/site.ts';
import { planSweep, runSweep, sweepKey, type SweepPlan } from '../../../backend/xrpl/sweep.ts';
import { deliverMinOf, notesForPayments, quoteNotes, xrpPriceIn } from '../../../backend/xrpl/swap.ts';
import { MarkovPathPolicy } from '../../../graph/src/path-policy.ts';
import { createNoteVault, createRingClient, type NoteVault } from '../../../packages/ring-client/src/index.ts';
import type { RingProver } from '../../../packages/ring-client/src/ring-client.ts';
import { xrplDeployment, xrplMeshTrustRoot, type XrplPoolDeployment } from '../../../deployments/xrpl.ts';
import { keyFrom } from './backup.ts';
import { createWorkerProver } from './prover.ts';
import { createPaymentFlow, makeAmount, type AdapterPorts } from './protocol/index.ts';
import { localNoteStorage } from './note-storage.ts';
import { runPaymentLanes } from './payment-lanes.ts';
import type { WalletConnectConfig } from './walletconnect.ts';
import { scoped } from './storage-name.ts';
import { sha256 } from '@noble/hashes/sha256';

import { stream, type AccountKeys } from './xrpl-keys.ts';

export interface XrplStackConfig {
  readonly directoryChain?: readonly SignedDirectory[];
  readonly signedDirectory: SignedDirectory;
  /** A dev server's root, for its random mesh. A built wallet never reads it. */
  readonly trustRoot: DirectoryTrustRoot;
  readonly cre: { readonly publicKey: `0x${string}`; readonly encryptionKeyId: string; readonly policyVersion: string };
  readonly buy: boolean;
  /** The service splits payably when asked (backend/xrpl/stack.ts); absent on one from before. */
  readonly payableSplit?: boolean;
  /** Set when the stack offers WalletConnect (lib/walletconnect.ts): its relay and Verify, through the stack. */
  readonly walletConnect?: WalletConnectConfig | null;
}

const reviver = (_k: string, v: unknown) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v);
const UNIT = 1_000_000;
/**
 * Where an account keeps its records. The browser wallet keeps the names it
 * always had; each phrase account has its own, under its public id. Sites hold
 * per-site accounts' keys: secrets, like the notes, and backed up with them.
 */
const storageOf = (account: AccountKeys | null) => {
  const name = (part: string) => scoped(account === null ? `opaque:xrpl-${part}:v1` : `opaque:xrpl:${account.id}:${part}:v1`);
  return { notes: name('notes'), tags: name('tags'), activity: name('activity'), sites: name('sites'), counters: name('note-counters'), addresses: name('addresses'), swapTags: name('swap-tags') };
};
/** Whether the browser wallet from before recovery phrases holds anything. */
export const hasBrowserWallet = (): boolean => {
  const { notes, sites } = storageOf(null);
  return [notes, sites].some((key) => Object.keys(load<Record<string, unknown>>(key, {})).length > 0);
};
/**
 * How far past the last note found a scan keeps deriving, per pool and size.
 * A deposit tag makes up to 46 notes of one size, and most of the smaller ones
 * are never filled, so a run of unfilled numbers can be long.
 */
const SCAN_GAP = 250;
/** A used account has a note among the first numbers of some size; an unused one is told by this much. */
const PROBE_GAP = 64;
/**
 * A reusable address's hash chain: one link per top-up, 64 notes each, so
 * about 260,000 notes for one address. Revealing a link is the only way to add
 * notes to it (backend/xrpl/pool.ts): SHA-256, nothing a quantum computer breaks.
 */
const CHAIN = 4096;
/** A size tops up when fewer of its notes than this are left: one payment can take 9 of a smaller size. */
const LOW = 9;
/** A ring's members: the note spent and seven others of its size. */
const RING = 8;
/** Where an address is kept: which of its candidate tags it took, and how far its notes are synced. */
interface AddressRecord { readonly i: number; readonly tag: number; readonly synced: Readonly<Record<string, number>> }
/** An account's reusable address for one asset: the pool's address and a tag only this account can top up. */
export interface ReusableAddress { readonly symbol: string; readonly pool: string; readonly tag: number; readonly xAddress: string }
const isTestnet = () => xrplDeployment.network.name !== 'xrpl-mainnet';
/** Another account's address for an asset, if this browser has made or found it: for the account list. */
export function cachedAddress(accountId: string, symbol: string): ReusableAddress | null {
  const p = poolBySymbol(symbol);
  const rec = load<Record<string, AddressRecord>>(storageOf({ id: accountId } as AccountKeys).addresses, {})[p.account];
  return rec === undefined ? null : { symbol, pool: p.account, tag: rec.tag, xAddress: xAddressOf(p.account, rec.tag, isTestnet()) };
}
/** At most this many notes travel at once: each is a 1.1 MiB proof upload. */
const LANES = 2;
/** What a payment that chose to wait asks of the pool's privacy score. */
const WAIT_SCORE = 5_000;

export async function loadXrplStack(url: string = import.meta.env?.['VITE_XRPL_STACK_URL'] ?? 'xrpl-stack.json'): Promise<XrplStackConfig> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`no XRPL stack config at ${url} — is backend/xrpl/stack.ts running?`);
    return JSON.parse(await response.text(), reviver) as XrplStackConfig;
  } finally {
    clearTimeout(timeout);
  }
}

// ── small local records ──────────────────────────────────────────────────

export interface ReceiveTag {
  readonly symbol: string;
  readonly pool: string;
  readonly tag: number;
  readonly createdAt: number;
}

export interface SwapQuote {
  /** In `to`'s units: settled one by one, and the least, together. */
  readonly out: bigint;
  readonly least: bigint;
  /** The pool's fee on the notes spent, in `from`'s units. */
  readonly fees: bigint;
  readonly notes: number;
  /** Each note's quote, as if it settled last, and the notes a tag needs to take them all. */
  readonly each: readonly bigint[];
  readonly tagNotes: ReadonlyMap<number, number>;
}

export interface Sent {
  readonly id: string;
  readonly symbol: string;
  /** Whole units, before fees. */
  readonly amount: number;
  readonly destination: XrplDestination;
  readonly createdAt: number;
  /** A private swap: the asset the notes became, in the other pool. */
  readonly swapTo?: string;
  /** Into the account's swap tag, carrying leftovers forward, rather than a fresh one. */
  readonly swapCarry?: boolean;
  readonly notes: { readonly noteId: string; readonly size: number; readonly reservation: string; handle?: string; state: string; txHash?: string; error?: string }[];
}

const load = <T>(key: string, fallback: T): T => {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null', reviver) as T ?? fallback; } catch { return fallback; }
};
const save = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value, replacer));

/** A uniformly random tag in 1..2^32-1; 0 is for InvoiceID deposits. */
const freshTag = (): number => {
  for (;;) {
    const t = crypto.getRandomValues(new Uint32Array(1))[0]!;
    if (t !== 0) return t;
  }
};

export const poolBySymbol = (symbol: string): XrplPoolDeployment => {
  const p = xrplDeployment.pools.find((x) => x.symbol === symbol);
  if (p === undefined) throw new Error(`no ${symbol} pool on ${xrplDeployment.network.displayName}`);
  return p;
};
const scopeFor = (p: XrplPoolDeployment, size: number): PoolScope => scopeOf(xrplDeployment.network.networkId, p.account, size);
const symbolOf = (scope: PoolScope): string => xrplDeployment.pools.find((p) => p.account === accountOf(scope.pool))?.symbol ?? '?';

export interface XrplWallet {
  readonly config: XrplStackConfig;
  readonly pools: readonly XrplPoolDeployment[];
  /** Notes by state, re-checked against the ledger. `deep` also re-checks every spendable note. */
  refresh(deep?: boolean): Promise<readonly NoteSummary[]>;
  notes(): Promise<readonly NoteSummary[]>;
  balance(symbol: string): Promise<{ readonly units: number; readonly notes: number }>;
  /** A fresh tag and its notes, registered with the attesters. */
  receive(symbol: string, expected?: number, counts?: ReadonlyMap<number, number>): Promise<ReceiveTag>;
  tags(): readonly ReceiveTag[];
  tagStatus(t: ReceiveTag): Promise<{ readonly notes: number; readonly carried: bigint }>;
  /** A signed MoonPay checkout for the tag; the caller opens it in a new tab. */
  buyUrl(t: ReceiveTag, fiat: number): Promise<string>;
  /** Testnet: the faucet pays this XRP tag, asked through the mesh. */
  faucet(t: ReceiveTag): Promise<{ xrp: number; hash: string }>;
  /** Which notes `amount` would spend, or undefined when the notes held cannot make it exactly. */
  plan(symbol: string, amount: number): Promise<Map<number, number> | undefined>;
  send(input: {
    readonly symbol: string; readonly amount: number; readonly destination: XrplDestination;
    readonly waitForPrivacy: boolean; readonly deadline: UnixSeconds; readonly onProgress?: (line: string) => void;
    /** A swap: each note's DeliverMin, from the notes' values after fees, sealed beside its spend. */
    readonly deliverMin?: (nets: readonly bigint[]) => Promise<readonly bigint[]>;
    readonly swapTo?: string;
    readonly swapCarry?: boolean;
  }): Promise<Sent>;
  /**
   * What swapping `amount` of `from` into `to` would bring now, through the
   * ledger's AMMs, or undefined when the notes held cannot make it exactly.
   */
  swapQuote(from: string, to: string, amount: number): Promise<SwapQuote | undefined>;
  /**
   * A private swap: the notes are spent through rings into a fresh tag of
   * `to`'s pool, each delivering at least its quote less 2%. Nothing links
   * the notes spent to the notes that arrive.
   */
  swap(input: {
    readonly from: string; readonly to: string; readonly amount: number; readonly deadline: UnixSeconds; readonly onProgress?: (line: string) => void;
    /** Into this account's swap tag for `to`, where leftovers under one note carry into the next swap's; a fresh one-time tag otherwise. */
    readonly carry?: boolean;
  }): Promise<{ readonly sent: Sent; readonly tag: number }>;
  /** What this account's swap tag for `symbol` carries: under one note, waiting for the next swap. 0 without one. */
  swapCarried(symbol: string): Promise<bigint>;
  /**
   * Each asset in US dollars, as the ledger prices it: USDC and RLUSD at 1,
   * XRP at the ledger's XRP/USDC price, null where there is none (MPTs).
   * Read through the relays, at most once a minute.
   */
  usdPrices(): Promise<Readonly<Record<string, number | null>>>;
  activity(): readonly Sent[];
  /** Polls each unfinished note of each payment through the mesh. */
  pollActivity(): Promise<readonly Sent[]>;
  ring(scope: PoolScope): Promise<RingSnapshot>;
  pathFor(): ReturnType<ReturnType<typeof createMeshBootstrap>['pathFor']>;
  exportBackup(passphrase: string): Promise<Blob>;
  restoreBackup(file: Blob, passphrase: string): Promise<number>;

  // ── per-site accounts (backend/xrpl/site.ts) ──
  readonly network: { readonly id: string; readonly name: string; readonly wss: string };
  sites(): readonly Site[];
  site(origin: string): Site | undefined;
  /** A fresh account for `origin`, funded privately from XRP notes, its master key then disabled. */
  openSite(origin: string, xrp: number, holdTokens: boolean, onProgress?: (line: string) => void): Promise<Site>;
  /** sign, signAndSubmit or signMessage for the site at `origin`. */
  siteRequest(origin: string, method: 'sign' | 'signAndSubmit' | 'signMessage', params: Record<string, unknown>): Promise<unknown>;
  /** Its tokens back into their pools, then AccountDelete into the XRP pool: all of it as notes. */
  closeSite(origin: string, onProgress?: (line: string) => void): Promise<string>;
  /** Waits until every note of a payment has an outcome. */
  settled(sent: Sent, timeoutMs?: number): Promise<Sent>;

  // ── recovery (phrase accounts only) ──
  /** Finds this account's notes in the pools' logs and keeps them: what an imported phrase holds. */
  recover(onProgress?: (line: string) => void): Promise<number>;
  /**
   * This account's reusable address for an asset, made the first time it is
   * asked for; null for the browser wallet, which has no phrase to find it again.
   */
  address(symbol: string): Promise<ReusableAddress | null>;
  /** Whether another account of the phrase has notes in the pools' logs (1) or not (0), keeping none. */
  probe(account: AccountKeys): Promise<number>;

  // ── an ordinary XRPL wallet, swept in (backend/xrpl/sweep.ts) ──
  /** What sweeping the wallet this secret opens would move into this account. Nothing is signed. */
  sweepPlan(secret: string): Promise<SweepPlan>;
  /** Moves it, each asset into a fresh deposit tag of this account, to become notes. The transactions' hashes. */
  sweep(secret: string, plan: SweepPlan, onProgress?: (line: string) => void): Promise<readonly string[]>;
}

/**
 * This page's mesh: the directory checked against the pinned root first, then
 * every query through three relays. One per page, shared by the wallet and the
 * passkey backup, which may need it before any account opens.
 */
function meshOf(cfg: XrplStackConfig) {
  const relayHealth = createGraphHealth({ fetchSnapshot: async () => (await query<RelaySnapshot>({ kind: 'RELAY_SNAPSHOT' })).value });
  // VERIFY FIRST: throws before any relay is contacted if the directory does
  // not chain to the root. Only a dev server's wallet takes the stack's root.
  const devRoot = import.meta.env?.DEV ? cfg.trustRoot : undefined;
  const { signed, root } = chainTo(cfg.directoryChain ?? [cfg.signedDirectory], devRoot ?? xrplMeshTrustRoot() as DirectoryTrustRoot);
  const bootstrap = createMeshBootstrap({
    root, signed, pathPolicy: new MarkovPathPolicy(), health: relayHealth.health,
    client: { pollIntervalMs: 250, pollTimeoutMs: 120_000 },
  });
  const query = async <T>(request: Parameters<typeof bootstrap.transport.query>[0]) =>
    (await bootstrap.transport.query(request, await bootstrap.pathFor())) as unknown as { value: T };
  void relayHealth.refresh();
  // Never what keeps a Node process (packages/sdk) running.
  (setInterval(() => void relayHealth.refresh(), 120_000) as { unref?: () => void }).unref?.();
  return { bootstrap, query };
}
let pageQuery: (<T>(request: MeshQuery) => Promise<{ value: T }>) | undefined;
let pageMesh: Promise<<T>(request: MeshQuery) => Promise<{ value: T }>> | undefined;
/** The passkey backup's way to its store (lib/passkey-backup.ts): through this page's mesh, an account open or not. */
export const backupTransport = (): BackupTransport => async (operation, encodedRequest) => {
  const query = pageQuery ?? await (pageMesh ??= loadXrplStack().then((cfg) => meshOf(cfg).query));
  return (await query<Hex>({ kind: 'BACKUP', operation, encodedRequest })).value;
};

export async function startXrplWallet(config?: XrplStackConfig, account: AccountKeys | null = null, host: { readonly prover?: () => RingProver } = {}): Promise<XrplWallet> {
  const cfg = config ?? (await loadXrplStack());
  const K = storageOf(account);

  const { bootstrap, query } = meshOf(cfg);
  pageQuery = query;

  const xrpl: XrplSend = async (operation, encodedRequest) => (await query<Hex>({ kind: 'XRPL', operation, encodedRequest })).value;
  // A per-site account's reads and transactions, through the mesh like everything else.
  const ledger = meshLedger(xrpl);
  const saveSite = (site: Site) => save(K.sites, { ...load<Record<string, Site>>(K.sites, {}), [site.origin]: site });
  /** Per site, the rotation a sign-only use still owes. */
  const rotations = new Map<string, Promise<void>>();

  // One ring read per pool and size per few seconds, however many notes ask.
  const rings = new Map<string, { at: number; ring: Promise<RingSnapshot> }>();
  const ring = (scope: PoolScope): Promise<RingSnapshot> => {
    const key = `${scope.pool}:${scope.denomination}`;
    const hit = rings.get(key);
    if (hit !== undefined && Date.now() - hit.at < 8_000) return hit.ring;
    const fresh = query<RingSnapshot>({ kind: 'RING_SNAPSHOT', scope }).then((r) => r.value);
    rings.set(key, { at: Date.now(), ring: fresh });
    fresh.catch(() => rings.delete(key));
    return fresh;
  };

  // A phrase account's note is drawn from the phrase: number i of each pool and size.
  let drawing: ((n: number) => Uint8Array) | undefined;
  const vault: NoteVault = createNoteVault({
    storage: localNoteStorage(K.notes),
    ...(account === null ? {} : { randomBytes: (n: number) => {
      if (drawing === undefined) throw new Error('a phrase account\'s note needs its number');
      return drawing(n);
    } }),
    chain: {
      async observeCommitment(scope, commitment) {
        const found = (await ring(scope)).candidates.find((c) => c.commitment === commitment);
        return found === undefined ? null : { blockNumber: found.enrolledAtBlock };
      },
      isNullifierSpent: (scope, nullifier) => nullifierSpent(xrpl, accountOf(scope.pool), nullifier),
    },
  });
  const ringClient = createRingClient(vault, (host.prover ?? createWorkerProver)());

  const counterOf = (scope: PoolScope) => `${accountOf(scope.pool)}/${scope.denomination}`;
  const drawFor = (keys: AccountKeys, scope: PoolScope, i: number) => stream(keys.key, `note/${xrplDeployment.network.name}/${accountOf(scope.pool)}/${scope.denomination}/${i}`);
  /** Note i of a scope, kept in the vault (which computes the same commitment from the same secret). */
  async function keepNote(scope: PoolScope, i: number): Promise<NoteSummary> {
    drawing = drawFor(account!, scope, i);
    try { return await vault.create(scope); } finally { drawing = undefined; }
  }
  /** A fresh note: random in the browser wallet, the next number of the phrase otherwise. */
  async function newNote(scope: PoolScope): Promise<NoteSummary> {
    if (account === null) return vault.create(scope);
    const counters = load<Record<string, number>>(K.counters, {});
    const i = counters[counterOf(scope)] ?? 0;
    // The number is spent before the note exists, so it is never drawn twice here.
    save(K.counters, { ...counters, [counterOf(scope)]: i + 1 });
    return keepNote(scope, i);
  }
  // A scan reads every pool size's log: all at once through the mesh, kept for a minute.
  let logs: { at: number; sets: Promise<Map<string, Set<string>>> } | undefined;
  const logsOf = (): Promise<Map<string, Set<string>>> => {
    if (logs === undefined || Date.now() - logs.at > 60_000) {
      const sets = Promise.all(scopes().map(async ({ scope }) => [counterOf(scope), new Set((await ring(scope)).candidates.map((c) => c.commitment as string))] as const))
        .then((entries) => new Map(entries));
      sets.catch(() => { logs = undefined; });
      logs = { at: Date.now(), sets };
    }
    return logs.sets;
  };
  /**
   * The sizes a deposit may land in: those whose pool holds at least seven
   * other deposits, so a new note has a ring to hide in at once, and the
   * smallest, so a deposit always lands somewhere. A large size with no ring
   * yet takes nothing: a big deposit splits into the largest sizes that have one.
   */
  async function liveSizes(p: XrplPoolDeployment): Promise<number[]> {
    const logs = await logsOf();
    const smallest = Math.min(...p.sizes);
    // A service from before the payable split splits largest first: over powers of ten
    // alone (1, 10, 100…) that still leaves every amount payable, over 1-2-5 it doesn't.
    const usable = cfg.payableSplit === true ? p.sizes : p.sizes.filter((size) => /^10*$/.test(String(size / smallest)));
    return usable.filter((size) => size === smallest || (logs.get(counterOf(scopeFor(p, size)))?.size ?? 0) >= RING - 1);
  }
  /** Sizes whose ring a note can be spent from now: eight deposits, its own among them. */
  async function spendableSizes(p: XrplPoolDeployment): Promise<Set<number>> {
    const logs = await logsOf();
    return new Set(p.sizes.filter((size) => (logs.get(counterOf(scopeFor(p, size)))?.size ?? 0) >= RING));
  }
  /** Which numbers of a scope the pool's log holds, deriving until `gap` in a row are absent. */
  async function scan(keys: AccountKeys, scope: PoolScope, from: number, gap = SCAN_GAP): Promise<number[]> {
    const listed = (await logsOf()).get(counterOf(scope)) ?? new Set<string>();
    const found: number[] = [];
    // An empty log holds nobody's notes.
    if (listed.size === 0) return found;
    for (let i = 0, last = from - 1; i <= last + gap; i++) {
      if (listed.has(deriveCommitment(createNoteSecret(drawFor(keys, scope, i)), scope))) { found.push(i); last = Math.max(last, i); }
      // About 4 ms a note: let the page breathe.
      if (i % 25 === 24) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return found;
  }
  const scopes = () => xrplDeployment.pools.flatMap((p) => p.sizes.map((size) => ({ p, scope: scopeFor(p, size) })));

  // ── owned tags: the reusable address, and the swap tag ──────────────────
  // One of each per pool, found again from the phrase. Everything is drawn
  // from the account key: candidate tag i, its hash chain, and note j of each
  // size, which is the j-th note that size credits on the tag. So any browser
  // with the phrase knows which notes a payment made, without a scan, and the
  // pool learns nothing it did not already hold.
  //
  //   address  the address this account shares (labels pinned: never change them)
  //   swaps    where swaps land when leftovers carry forward: what is under one
  //            note stays carried on the tag and joins the next swap's. Its own
  //            labels, so it is never the shared address.
  type TagKind = 'address' | 'swaps';
  const labelOf = (kind: TagKind, p: XrplPoolDeployment, i: number) => `${kind}/${xrplDeployment.network.name}/${p.account}/${i}`;
  const tagAt = (keys: AccountKeys, p: XrplPoolDeployment, i: number, kind: TagKind = 'address') => {
    const b = stream(keys.key, `${labelOf(kind, p, i)}/tag`)(4);
    return 1 + ((((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0) % 0xffff_fffe);
  };
  /** Link n of candidate i's chain: SHA-256 applied n times to its seed. The anchor is link CHAIN. */
  const linkAt = (keys: AccountKeys, p: XrplPoolDeployment, i: number, n: number, kind: TagKind = 'address') => {
    let h = stream(keys.key, `${labelOf(kind, p, i)}/owner`)(32);
    for (let k = 0; k < n; k++) h = sha256(h);
    return toHex(h) as string;
  };
  const addressDraw = (keys: AccountKeys, p: XrplPoolDeployment, i: number, size: number, j: number, kind: TagKind = 'address') => stream(keys.key, `${labelOf(kind, p, i)}/note/${size}/${j}`);
  const addressCommitment = (keys: AccountKeys, p: XrplPoolDeployment, i: number, size: number, j: number, kind: TagKind = 'address') =>
    deriveCommitment(createNoteSecret(addressDraw(keys, p, i, size, j, kind)), scopeFor(p, size));
  /** The next notes for the tag: per size, from position `from[size]`, `counts[size]` of them or an even share of 64. */
  const addressBatch = (keys: AccountKeys, p: XrplPoolDeployment, i: number, from: Record<string, number>, kind: TagKind = 'address', counts?: Record<string, number>) => {
    const per = Math.min(20, Math.floor(64 / Object.keys(from).length));
    return Object.fromEntries(Object.entries(from).map(([size, start]) =>
      [size, Array.from({ length: counts?.[size] ?? per }, (_, k) => addressCommitment(keys, p, i, Number(size), start + k, kind))]));
  };
  const recordsOf = (kind: TagKind) => load<Record<string, AddressRecord>>(kind === 'address' ? K.addresses : K.swapTags, {});
  const saveRecord = (kind: TagKind, pool: string, rec: AddressRecord) => save(kind === 'address' ? K.addresses : K.swapTags, { ...recordsOf(kind), [pool]: rec });
  const addresses = () => recordsOf('address');
  const saveAddress = (pool: string, rec: AddressRecord) => saveRecord('address', pool, rec);
  /**
   * This account's owned tag of a kind on a pool: the first candidate whose
   * chain is its own, or, with `make`, the first free one, registered with
   * its anchor.
   * ponytail: without `make` it stops at the first free candidate, so a tag
   * that skipped one someone had paid unregistered is found only by asking
   * for it; scan all eight if that ever matters.
   */
  const claiming = new Map<string, Promise<AddressRecord>>();
  /** Dollar stablecoins, counted at $1. ponytail: testnet's own tokens; a price feed when mainnet needs one. */
  const STABLE = new Set(['USDC', 'RLUSD']);
  let priced: { readonly at: number; readonly value: Readonly<Record<string, number | null>> } | undefined;
  async function claimAddress(keys: AccountKeys, p: XrplPoolDeployment, make: boolean, kind: TagKind = 'address'): Promise<AddressRecord | null> {
    for (let i = 0; i < 8; i++) {
      const tag = tagAt(keys, p, i, kind);
      const s = await tagStatus(xrpl, p.account, tag);
      if (s.owner !== null) {
        if (linkAt(keys, p, i, CHAIN - s.owner.depth, kind) === s.owner.anchor) return { i, tag, synced: {} };
        continue;
      }
      if (s.registered || s.notes > 0) continue;
      if (!make) return null;
      try {
        await registerTag(xrpl, p.account, tag, addressBatch(keys, p, i, Object.fromEntries((await liveSizes(p)).map((size) => [String(size), 0])), kind), { owner: linkAt(keys, p, i, CHAIN, kind) }, true);
        return { i, tag, synced: {} };
      } catch (error) {
        // Paid before anyone registered it: the next candidate.
        if (!/already in use/.test((error as Error).message)) throw error;
      }
    }
    throw new Error('no free tag for this account yet: try again');
  }
  /**
   * Keeps the notes payments have credited to an owned tag, and tops it up
   * when a size runs low, revealing the next link. Returns the notes it kept.
   */
  async function syncAddress(keys: AccountKeys, p: XrplPoolDeployment, rec: AddressRecord, kind: TagKind = 'address', again = true): Promise<number> {
    const s = await tagStatus(xrpl, p.account, rec.tag);
    const have = new Set((await vault.list()).map((n) => n.commitment as string));
    const synced = { ...rec.synced };
    let kept = 0;
    for (const size of p.sizes) {
      const credited = s.sizes[String(size)]?.credited ?? 0;
      for (let j = synced[String(size)] ?? 0; j < credited; j++) {
        if (have.has(addressCommitment(keys, p, rec.i, size, j, kind))) continue;
        drawing = addressDraw(keys, p, rec.i, size, j, kind);
        try { await vault.create(scopeFor(p, size)); } finally { drawing = undefined; }
        kept++;
      }
      synced[String(size)] = Math.max(synced[String(size)] ?? 0, credited);
    }
    saveRecord(kind, p.account, { ...rec, synced });
    if (s.owner === null) return kept;
    const live = await liveSizes(p);
    const left = (size: number) => { const z = s.sizes[String(size)]; return (z?.registered ?? 0) - (z?.credited ?? 0); };
    // What it carries (a payment larger than its notes) needs notes of its own; so does a size running low.
    const forCarry = s.carried > 0n ? notesForPayments([s.carried], live, 0n) : new Map<number, number>();
    const counts = Object.fromEntries(live.flatMap((size) => {
      const want = Math.max((forCarry.get(size) ?? 0) - left(size), left(size) < LOW ? Math.min(20, Math.floor(64 / live.length)) : 0);
      return want > 0 ? [[String(size), want]] : [];
    }));
    // All of it now, 64 a registration and one link each, largest sizes first: a big deposit is credited in one sync.
    const registered = Object.fromEntries(live.map((size) => [String(size), s.sizes[String(size)]?.registered ?? 0]));
    const queue = Object.entries(counts).sort((a, b) => Number(b[0]) - Number(a[0]));
    let added = false;
    for (let depth = s.owner.depth; queue.length > 0 && depth < CHAIN - 1; depth++) {
      let room = 64;
      const batch: Record<string, number> = {};
      while (room > 0 && queue.length > 0) {
        const [size, n] = queue[0]!;
        const k = Math.min(n, room);
        batch[size] = k;
        room -= k;
        if (k === n) queue.shift(); else queue[0] = [size, n - k];
      }
      const from = Object.fromEntries(Object.keys(batch).map((size) => [size, registered[size]!]));
      // Another browser of the phrase may top it up first: its link is then spent, and the next sync carries on.
      const ok = await registerTag(xrpl, p.account, rec.tag, addressBatch(keys, p, rec.i, from, kind, batch), { reveal: linkAt(keys, p, rec.i, CHAIN - depth - 1, kind) }, true).then(() => true, () => false);
      if (!ok) break;
      added = true;
      for (const [size, k] of Object.entries(batch)) registered[size] = registered[size]! + k;
    }
    // What the new notes credited from what it carried, kept now rather than at the next sync.
    return added && again ? kept + await syncAddress(keys, p, { ...rec, synced }, kind, false) : kept;
  }
  /**
   * The swap tag on `p`, made the first time, with at least `need[size]`
   * notes of each size not yet credited: a swap's payments must all find one.
   * Topped up as many times as it takes, 64 notes a registration.
   */
  async function swapTagReady(keys: AccountKeys, p: XrplPoolDeployment, need: ReadonlyMap<number, number>): Promise<AddressRecord> {
    const rec = recordsOf('swaps')[p.account] ?? await claimAddress(keys, p, true, 'swaps');
    if (recordsOf('swaps')[p.account] === undefined) saveRecord('swaps', p.account, rec!);
    for (let round = 0; round < 8; round++) {
      const s = await tagStatus(xrpl, p.account, rec!.tag);
      const short = Object.fromEntries(p.sizes.flatMap((size) => {
        const z = s.sizes[String(size)];
        const missing = (need.get(size) ?? 0) - ((z?.registered ?? 0) - (z?.credited ?? 0));
        return missing > 0 ? [[String(size), missing]] : [];
      }));
      if (Object.keys(short).length === 0) return rec!;
      if (s.owner === null) throw new Error('the swap tag is not this account\'s');
      // At most 64 a registration: the rest next round, with the next link.
      let room = 64;
      const counts = Object.fromEntries(Object.entries(short).map(([size, n]) => { const k = Math.min(n, room); room -= k; return [size, k]; }).filter(([, k]) => (k as number) > 0));
      const from = Object.fromEntries(Object.keys(counts).map((size) => [size, s.sizes[size]?.registered ?? 0]));
      await registerTag(xrpl, p.account, rec!.tag, addressBatch(keys, p, rec!.i, from, 'swaps', counts), { reveal: linkAt(keys, p, rec!.i, CHAIN - s.owner.depth - 1, 'swaps') }, true);
    }
    throw new Error('could not make room on the swap tag: try again');
  }
  const poolOf = (account: string) => xrplDeployment.pools.find((p) => p.account === account);
  const seal = createIntentSealer({
    crePublicKey: cfg.cre.publicKey, encryptionKeyId: cfg.cre.encryptionKeyId,
    resolveCredential: async (handle) => {
      const c = credentials.get(handle as string);
      if (c === undefined) throw new Error('no credential for this recipient — obtain one before paying');
      return c;
    },
  });
  const credentials = new Map<string, string>();
  async function credentialFor(recipient: `0x${string}`): Promise<CredentialHandle> {
    if (!credentials.has(recipient)) {
      // Across the mesh like every read: the authority learns a recipient, never who asked.
      const value = (await query<Hex>({ kind: 'CREDENTIAL', recipient: recipient as Address })).value;
      credentials.set(recipient, new TextDecoder().decode(fromHex(value)));
    }
    return recipient as unknown as CredentialHandle;
  }

  async function refresh(deep = false): Promise<readonly NoteSummary[]> {
    // What paid this account's addresses since, first: their notes are kept here, then reconciled below.
    if (account !== null) {
      const keys = account;
      await Promise.all((['address', 'swaps'] as const).flatMap((kind) => Object.entries(recordsOf(kind)).map(([pool, rec]) => {
        const p = poolOf(pool);
        return p === undefined ? 0 : syncAddress(keys, p, rec, kind).catch(() => 0);
      })));
    }
    const notes = await vault.list();
    for (const n of notes) {
      // A tag's notes are only worth asking about once the log names them.
      const listed = n.state === 'CREATED' || n.state === 'DEPOSIT_PENDING'
        ? (await ring(n.scope)).candidates.some((c) => c.commitment === n.commitment)
        : n.state === 'RESERVED' || n.state === 'RECONCILIATION_REQUIRED' || (deep && n.state === 'AVAILABLE');
      if (listed) await vault.reconcile(n.id).catch(() => undefined);
    }
    return vault.list();
  }

  async function payNote(note: NoteSummary, reservation: string, destination: XrplDestination, minScore: number, deadline: UnixSeconds, deliverMin?: bigint): Promise<IntentRef> {
    const recipient = recipientFor(destination);
    const request: PaymentRequest = {
      noteId: note.id, recipient, minPrivacyScore: minScore as PrivacyScore, deadline,
      credentialHandle: await credentialFor(recipient), idempotencyKey: reservation as IdempotencyKey,
    };
    // Only the ports the payment sequence uses; the seal carries the destination beside the spend.
    const ports = {
      ring: ringClient,
      graph: { getRelaySnapshot: async () => bootstrap.snapshot(), getRingSnapshot: ring, getPrivacyConditions: async () => { throw new Error('unused'); } },
      pathPolicy: new MarkovPathPolicy(),
      transport: bootstrap.transport,
      executor: {
        submit: async (intent) => bootstrap.transport.submitIntent(intent, await bootstrap.pathFor()),
        getStatus: async (handle: StatusHandle) => (await query<IntentStatus>({ kind: 'INTENT_STATUS', handle })).value,
      },
      sealIntent: (input) => seal({ ...input, spend: { ...(input.spend as object), destination, ...(deliverMin === undefined ? {} : { deliverMin: deliverMin.toString(10) }) } }),
      resolveNoteScope: async () => note.scope,
    } as Pick<AdapterPorts, 'ring' | 'graph' | 'pathPolicy' | 'transport' | 'executor' | 'sealIntent' | 'resolveNoteScope'>;
    return createPaymentFlow(ports as AdapterPorts, request, note.scope, recipient);
  }

  const wallet: XrplWallet = {
    config: cfg,
    pools: xrplDeployment.pools,
    refresh,
    notes: () => vault.list(),
    async balance(symbol) {
      const p = poolBySymbol(symbol);
      const held = (await vault.list()).filter((n) => n.state === 'AVAILABLE' && accountOf(n.scope.pool) === p.account);
      return { units: held.reduce((s, n) => s + n.scope.denomination / UNIT, 0), notes: held.length };
    },

    async receive(symbol, expected = 0, wanted) {
      const p = poolBySymbol(symbol);
      const live = (await liveSizes(p)).sort((a, b) => b - a);
      // What is expected, in live sizes, and one spare of each for a payment a
      // little different; with nothing expected, an even share. 64 at most per
      // registration. A swap says what it needs instead: its payments arrive one per note.
      const forExpected = expected > 0 ? notesForPayments([BigInt(Math.round(expected * UNIT))], live, 0n) : undefined;
      const share = Math.max(1, Math.floor(64 / live.length));
      const counts = wanted ?? new Map(live.map((s) => [s, forExpected === undefined ? share : (forExpected.get(s) ?? 0) + 1]));
      if ([...counts.values()].reduce((n, c) => n + c, 0) > 64) throw new Error(`that is more notes than one deposit tag holds: use your address instead, which takes any amount`);
      const mint = async () => {
        const commitments: Record<string, NoteSummary['commitment'][]> = {};
        for (const [size, n] of counts) {
          commitments[String(size)] = [];
          // Persisted before the tag is shown to anyone: a payment to it must find its notes here.
          for (let i = 0; i < n; i++) commitments[String(size)]!.push((await newNote(scopeFor(p, size))).commitment);
        }
        return commitments;
      };
      let commitments = await mint();
      for (let attempt = 0; ; attempt++) {
        const tag = freshTag();
        try {
          await registerTag(xrpl, p.account, tag, commitments, undefined, true);
          const record: ReceiveTag = { symbol, pool: p.account, tag, createdAt: Date.now() };
          save(K.tags, [record, ...load<ReceiveTag[]>(K.tags, [])]);
          return record;
        } catch (error) {
          const message = (error as Error).message;
          // A random 32-bit tag already in use is rare; another draw settles it.
          // A note already registered was drawn by this phrase somewhere else:
          // it stays here (it is this wallet's), and the next numbers are fresh.
          if (attempt >= 3 || !/already in use|registered (twice|to another tag)/.test(message)) throw error;
          if (/registered/.test(message)) commitments = await mint();
        }
      }
    },
    tags: () => load<ReceiveTag[]>(K.tags, []),
    async address(symbol) {
      if (account === null) return null;
      const p = poolBySymbol(symbol);
      // One claim per pool at a time: a second, alongside, would find the
      // first's tag taken and register the next candidate as well.
      let claim = claiming.get(p.account);
      if (claim === undefined) {
        claim = (async () => {
          const rec = addresses()[p.account] ?? await claimAddress(account, p, true);
          if (addresses()[p.account] === undefined) saveAddress(p.account, rec!);
          return addresses()[p.account]!;
        })().finally(() => claiming.delete(p.account));
        claiming.set(p.account, claim);
      }
      const rec = await claim;
      return { symbol, pool: p.account, tag: rec.tag, xAddress: xAddressOf(p.account, rec.tag, isTestnet()) };
    },
    tagStatus: (t) => tagStatus(xrpl, t.pool, t.tag),
    buyUrl: (t, fiat) => onrampUrl(xrpl, t.pool, t.tag, fiat),
    faucet: (t) => faucetDeposit(xrpl, t.pool, t.tag),

    async plan(symbol, amount) {
      const p = poolBySymbol(symbol);
      const have = new Map<number, number>();
      // A note in a size with no full ring yet waits: no proof could hide it.
      const ready = await spendableSizes(p);
      for (const n of await vault.list()) {
        if (n.state === 'AVAILABLE' && accountOf(n.scope.pool) === p.account && ready.has(n.scope.denomination)) have.set(n.scope.denomination / UNIT, (have.get(n.scope.denomination / UNIT) ?? 0) + 1);
      }
      return makeAmount(amount, p.sizes.map((s) => s / UNIT), have);
    },

    async send({ symbol, amount, destination, waitForPrivacy, deadline, onProgress, deliverMin, swapTo, swapCarry }) {
      const p = poolBySymbol(symbol);
      const plan = await wallet.plan(symbol, amount);
      if (plan === undefined) throw new Error(`the notes held cannot make ${amount} ${symbol} exactly`);
      const available = (await vault.list()).filter((n) => n.state === 'AVAILABLE' && accountOf(n.scope.pool) === p.account);
      const picked: NoteSummary[] = [];
      for (const [size, count] of plan) picked.push(...available.filter((n) => n.scope.denomination === size * UNIT).slice(0, count));
      const mins = deliverMin === undefined ? undefined : await deliverMin(picked.map((n) => BigInt(n.scope.denomination) - BigInt(p.spendFee)));
      const id = toHex(crypto.getRandomValues(new Uint8Array(8)));
      const sent: Sent = {
        id, symbol, amount, destination, createdAt: Date.now(), ...(swapTo === undefined ? {} : { swapTo }), ...(swapCarry ? { swapCarry } : {}),
        notes: picked.map((n, i) => ({ noteId: n.id, size: n.scope.denomination / UNIT, reservation: `xrpl:${id}:${i}`, state: 'PROVING' })),
      };
      save(K.activity, [sent, ...load<Sent[]>(K.activity, [])]);
      const store = () => save(K.activity, load<Sent[]>(K.activity, []).map((s) => (s.id === id ? sent : s)));
      await runPaymentLanes(picked, LANES, async (note, i) => {
        const entry = sent.notes[i]!;
        onProgress?.(`note ${i + 1}/${picked.length} (${entry.size} ${symbol}): proving in this browser…`);
        try {
          // A dropped connection is tried again, twice: the note's reservation is
          // the same, so a payment the first try did get through cannot spend it twice
          // (one nullifier), and the user is not left with half a swap for a blip.
          let ref: IntentRef;
          for (let attempt = 0; ; attempt++) {
            try { ref = await payNote(note, entry.reservation, destination, waitForPrivacy ? WAIT_SCORE : 0, deadline, mins?.[i]); break; } catch (error) {
              if (attempt >= 2 || !/failed to fetch|networkerror|load failed|network connection/i.test((error as Error).message)) throw error;
              onProgress?.(`note ${i + 1}/${picked.length}: the connection dropped, trying again…`);
              await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
            }
          }
          entry.handle = ref.statusHandle as string;
          entry.state = 'SUBMITTED';
          onProgress?.(`note ${i + 1}/${picked.length}: sealed and sent through the mesh`);
        } catch (error) {
          entry.state = 'FAILED';
          entry.error = (error as Error).message;
          await vault.release({ noteId: note.id, reservation: entry.reservation as IdempotencyKey, terminalIntent: 'not-submitted' as never }).catch(() => undefined);
          onProgress?.(`note ${i + 1}/${picked.length}: ${entry.error}`);
        }
        store();
      });
      return sent;
    },
    async swapQuote(from, to, amount) {
      const [a, b] = [poolBySymbol(from), poolBySymbol(to)];
      const plan = await wallet.plan(from, amount);
      if (plan === undefined) return undefined;
      const nets = [...plan].flatMap(([size, count]) => Array.from({ length: count }, () => BigInt(size * UNIT) - BigInt(a.spendFee)));
      const read = <T,>(command: string, params: Record<string, unknown>) => meshLedger(xrpl).request<T>(command, params);
      const { each, total } = await quoteNotes(read, a.asset, b.asset, nets);
      const tagNotes = notesForPayments(each, await liveSizes(b));
      if ([...tagNotes.values()].reduce((n, c) => n + c, 0) > 64) throw new Error(`that swap would arrive as more notes than one tag holds: swap it in two parts`);
      return { out: total, least: each.reduce((sum, e) => sum + deliverMinOf(e), 0n), fees: BigInt(a.spendFee) * BigInt(nets.length), notes: nets.length, each, tagNotes };
    },
    async usdPrices() {
      if (priced !== undefined && Date.now() - priced.at < 60_000) return priced.value;
      const usdc = xrplDeployment.pools.find((p) => p.symbol === 'USDC');
      const read = <T,>(command: string, params: Record<string, unknown>) => meshLedger(xrpl).request<T>(command, params);
      const xrp = usdc === undefined ? null : await xrpPriceIn(read, usdc.asset).catch(() => null);
      const value = Object.fromEntries(xrplDeployment.pools.map((p) => [p.symbol, p.asset.kind === 'XRP' ? xrp : STABLE.has(p.symbol) ? 1 : null]));
      if (xrp !== null) priced = { at: Date.now(), value };
      return value;
    },
    async swapCarried(symbol) {
      const rec = recordsOf('swaps')[poolBySymbol(symbol).account];
      return rec === undefined ? 0n : (await tagStatus(xrpl, poolBySymbol(symbol).account, rec.tag)).carried;
    },
    async swap({ from, to, amount, deadline, onProgress, carry }) {
      const [a, b] = [poolBySymbol(from), poolBySymbol(to)];
      const quote = await wallet.swapQuote(from, to, amount);
      if (quote === undefined) throw new Error(`the notes held cannot make ${amount} ${from} exactly`);
      // Carrying needs the phrase (the tag is drawn from it); the browser account always takes a fresh tag.
      const carrying = carry === true && account !== null;
      onProgress?.(carrying ? `readying your ${to} swap tag, where leftovers carry forward…` : `making a fresh ${to} tag for what the swap brings…`);
      // A one-time tag: nothing ties what arrives to this wallet's other deposits. The swap
      // tag ties this swap to the others into this asset, and nothing else.
      const tag = carrying ? (await swapTagReady(account!, b, quote.tagNotes)).tag : (await wallet.receive(to, Number(quote.out) / Number(UNIT), quote.tagNotes)).tag;
      const read = <T,>(command: string, params: Record<string, unknown>) => meshLedger(xrpl).request<T>(command, params);
      const sent = await wallet.send({
        symbol: from, amount, destination: { account: b.account, tag }, waitForPrivacy: false, deadline, swapTo: to, swapCarry: carrying,
        ...(onProgress ? { onProgress } : {}),
        // Asked again as the notes go: the least each must bring, if it settles last.
        deliverMin: async (nets) => (await quoteNotes(read, a.asset, b.asset, nets)).each.map(deliverMinOf),
      });
      return { sent, tag };
    },
    activity: () => load<Sent[]>(K.activity, []),
    async pollActivity() {
      // What each polled note's status says, kept apart and laid onto storage
      // at the end: a send still under way writes its notes meanwhile, and a
      // copy read before it would undo them.
      const changes = new Map<string, { state: string; txHash?: string; error?: string }>();
      for (const sent of load<Sent[]>(K.activity, [])) {
        for (const entry of sent.notes) {
          if (entry.handle === undefined || entry.state === 'SETTLED' || entry.state === 'FAILED') continue;
          const status = (await query<IntentStatus>({ kind: 'INTENT_STATUS', handle: entry.handle as StatusHandle }).catch(() => null))?.value;
          if (status === undefined) continue;
          changes.set(`${sent.id}:${entry.reservation}`, {
            state: status.state,
            ...(status.txHash === undefined ? {} : { txHash: status.txHash.slice(2).toUpperCase() }),
            ...(status.error === undefined ? {} : { error: status.error.publicMessage }),
          });
          if (status.state === 'FAILED') {
            // Back to spendable unless the ledger says the note is gone.
            await vault.release({ noteId: entry.noteId as never, reservation: entry.reservation as IdempotencyKey, terminalIntent: entry.handle as never }).catch(() => undefined);
            await vault.reconcile(entry.noteId as never).catch(() => undefined);
          }
          if (status.state === 'SETTLED') await vault.reconcile(entry.noteId as never).catch(() => undefined);
        }
      }
      const latest = load<Sent[]>(K.activity, []);
      for (const sent of latest) for (const entry of sent.notes) Object.assign(entry, changes.get(`${sent.id}:${entry.reservation}`) ?? {});
      save(K.activity, latest);
      return latest;
    },
    ring,
    pathFor: () => bootstrap.pathFor(),

    network: {
      id: xrplDeployment.network.networkId === 0 ? 'mainnet' : xrplDeployment.network.networkId === 1 ? 'testnet' : 'devnet',
      name: xrplDeployment.network.displayName,
      wss: xrplDeployment.network.wss,
    },
    sites: () => Object.values(load<Record<string, Site>>(K.sites, {})),
    site: (origin) => load<Record<string, Site>>(K.sites, {})[origin],

    async openSite(origin, xrp, holdTokens, onProgress) {
      const unfinished = wallet.site(origin);
      if (unfinished !== undefined && unfinished.index >= 0) throw new Error(`${origin} already has an account`);
      // Keys first: whatever lands on this address must find its keys here. A
      // site whose funding or setup was interrupted picks up where it stopped.
      // A phrase account's app account is drawn from the phrase: the same app finds the same address anywhere.
      const site = unfinished ?? (account === null ? newSite(origin) : newSite(origin, stream(account.key, `site/${origin}`)));
      saveSite(site);
      const exists = await ledger.request('account_info', { account: site.address, ledger_index: 'validated' }).then(() => true, () => false);
      // Already made and set up from this phrase elsewhere: find its current key, and that is all.
      if (exists && await syncIndex(ledger, site)) {
        onProgress?.(`${site.address} is this wallet's already: its key found on the ledger`);
        saveSite(site);
        return site;
      }
      if (!exists) {
        const plan = await wallet.plan('XRP', xrp);
        if (plan === undefined) throw new Error(`your XRP notes cannot make ${xrp} exactly`);
        const largest = Math.max(...plan.keys());
        if (largest * UNIT - Number(poolBySymbol('XRP').spendFee) < 1_000_000) throw new Error('the first note must create the account: fund it with a 10 XRP note or larger');
        const destination = { account: site.address, tag: null };
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 600) as UnixSeconds;
        // The ledger refuses to create an account with less than its reserve,
        // so the largest note goes alone, first; the rest follow it.
        onProgress?.(`funding ${site.address} privately: ${largest} XRP first`);
        const first = await wallet.settled(await wallet.send({ symbol: 'XRP', amount: largest, destination, waitForPrivacy: false, deadline, ...(onProgress ? { onProgress } : {}) }));
        if (first.notes.some((n) => n.state !== 'SETTLED')) throw new Error('the first funding note did not settle; nothing else was sent');
        if (xrp > largest) {
          onProgress?.(`then ${xrp - largest} XRP more`);
          await wallet.settled(await wallet.send({ symbol: 'XRP', amount: xrp - largest, destination, waitForPrivacy: false, deadline, ...(onProgress ? { onProgress } : {}) }));
        }
      }
      onProgress?.('setting up: a single-use regular key, then the master key off');
      const tokens = holdTokens ? xrplDeployment.pools.filter((p) => p.asset.kind === 'IOU').map((p) => p.asset as { currency: string; issuer: string }) : [];
      await setupSite(ledger, site, tokens);
      saveSite(site);
      return site;
    },

    async siteRequest(origin, method, params) {
      // A sign-only use's rotation first: until it lands, the listed key is about to change.
      await rotations.get(origin);
      const site = wallet.site(origin);
      if (site === undefined) throw new Error(`${origin} has no account: connect first`);
      try {
        if (method === 'signMessage') {
          const hex = params['hex'];
          return signMessage(site, typeof hex === 'string' ? fromHex(`0x${hex.toLowerCase()}`) : String(params['message'] ?? ''));
        }
        if (method === 'signAndSubmit') {
          const r = await signAndSubmit(ledger, site, params['transaction']);
          return { hash: r.hash, tx_json: r.tx_json, engine_result: r.result, batch: r.batch };
        }
        const r = await signOnly(ledger, site, params['transaction']);
        // The key that signed is retired once the ledger is done with it, whatever the dapp does.
        rotations.set(origin, resultOf(ledger, r.hash, r.lastLedger).then(() => rotate(ledger, site)).then(() => saveSite(site)).catch(() => undefined));
        return { hash: r.hash, tx_blob: r.tx_blob, tx_json: r.tx_json, signerAddress: site.address };
      } finally {
        saveSite(site);
      }
    },

    async closeSite(origin, onProgress) {
      const site = wallet.site(origin);
      if (site === undefined) throw new Error(`${origin} has no account`);
      await syncIndex(ledger, site);
      let hash: string;
      try {
        // Tokens of a pool go back into it under a fresh tag; the empty line is then removed.
        const lines = (await ledger.request<{ lines: { account: string; currency: string; balance: string }[] }>('account_lines', { account: site.address })).lines;
        for (const line of lines) {
          const pool = xrplDeployment.pools.find((p) => p.asset.kind === 'IOU' && p.asset.issuer === line.account && p.asset.currency === line.currency);
          if (pool === undefined && Number(line.balance) !== 0) throw new Error(`move or sell the ${line.currency} first: no Opaque pool takes it`);
          if (pool !== undefined && Number(line.balance) > 0) {
            const t = await wallet.receive(pool.symbol, Number(line.balance));
            onProgress?.(`${line.balance} ${pool.symbol} back into its pool, tag ${t.tag}`);
            await signAndSubmit(ledger, site, { TransactionType: 'Payment', Account: site.address, Destination: pool.account, DestinationTag: t.tag, Amount: { currency: line.currency, issuer: line.account, value: line.balance } });
          }
          await signAndSubmit(ledger, site, { TransactionType: 'TrustSet', Account: site.address, LimitAmount: { currency: line.currency, issuer: line.account, value: '0' } });
        }
        const info = await ledger.request<{ account_data: { Balance: string } }>('account_info', { account: site.address, ledger_index: 'validated' });
        const t = await wallet.receive('XRP', Number(info.account_data.Balance) / UNIT);
        onProgress?.(`closing into the XRP pool, tag ${t.tag}: the reserve and the rest become notes`);
        hash = await closeSite(ledger, site, { pool: t.pool, tag: t.tag });
      } catch (error) {
        // Not closed: its key may have moved on the way (token payments, a retired key), so keep where it is.
        saveSite(site);
        throw error;
      }
      const all = load<Record<string, Site>>(K.sites, {});
      delete all[origin];
      save(K.sites, all);
      return hash;
    },

    async settled(sent, timeoutMs = 300_000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const now = (await wallet.pollActivity()).find((s) => s.id === sent.id) ?? sent;
        if (now.notes.every((n) => n.state === 'SETTLED' || n.state === 'FAILED') || Date.now() > until) return now;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    },

    async recover(onProgress) {
      if (account === null) return 0;
      const have = new Set((await vault.list()).map((n) => n.commitment));
      let kept = 0;
      const counters = load<Record<string, number>>(K.counters, {});
      for (const { p, scope } of scopes()) {
        onProgress?.(`Looking for your ${p.symbol} ${scope.denomination / UNIT} notes on the ledger…`);
        const from = counters[counterOf(scope)] ?? 0;
        const found = await scan(account, scope, from);
        for (const i of found) {
          const commitment = deriveCommitment(createNoteSecret(drawFor(account, scope, i)), scope);
          if (!have.has(commitment)) { await keepNote(scope, i); kept++; }
        }
        // New notes start past everything found, and past what this browser already drew.
        counters[counterOf(scope)] = Math.max(from, (found.at(-1) ?? -1) + 1);
        save(K.counters, counters);
      }
      // The account's reusable addresses, wherever another browser made them.
      for (const p of xrplDeployment.pools) {
        for (const kind of ['address', 'swaps'] as const) {
          if (recordsOf(kind)[p.account] !== undefined) continue;
          onProgress?.(kind === 'address' ? `Looking for your ${p.symbol} address…` : `Looking for your ${p.symbol} swaps…`);
          const rec = await claimAddress(account, p, false, kind).catch(() => null);
          if (rec !== null) { saveRecord(kind, p.account, rec); kept += await syncAddress(account, p, rec, kind).catch(() => 0); }
        }
      }
      onProgress?.('Checking which of them are still yours to spend…');
      await refresh(true);
      return kept;
    },
    async probe(other) {
      // Whether an account was ever used: its reusable address (made the first time it opens), a
      // swap tag, or notes of a one-time tag among its first numbers.
      for (const kind of ['address', 'swaps'] as const) {
        for (const p of xrplDeployment.pools) if (await claimAddress(other, p, false, kind).catch(() => null) !== null) return 1;
      }
      for (const { scope } of scopes()) if ((await scan(other, scope, 0, PROBE_GAP)).length > 0) return 1;
      return 0;
    },

    sweepPlan: async (secret) => planSweep(ledger, sweepKey(secret), xrplDeployment.pools),
    async sweep(secret, plan, onProgress) {
      const key = sweepKey(secret);
      if (key.address !== plan.address) throw new Error('that secret opens another wallet than the one checked');
      return runSweep(ledger, key, plan, async (symbol, amount) => {
        const t = await wallet.receive(symbol, amount);
        return { pool: t.pool, tag: t.tag };
      }, onProgress);
    },

    async exportBackup(passphrase) {
      const contents = JSON.stringify({ version: 1, network: xrplDeployment.network.name, notes: localStorage.getItem(K.notes) ?? '{}', tags: wallet.tags(), sites: load<Record<string, Site>>(K.sites, {}) });
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(passphrase, salt), new TextEncoder().encode(contents)));
      return new Blob([JSON.stringify({ format: 'opaque-xrpl-backup-v1', salt: toHex(salt), iv: toHex(iv), ciphertext: toHex(ciphertext) })], { type: 'application/json' });
    },
    async restoreBackup(file, passphrase) {
      const outer = JSON.parse(await file.text()) as { format?: string; salt?: Hex; iv?: Hex; ciphertext?: Hex };
      if (outer.format !== 'opaque-xrpl-backup-v1') throw new Error('this is not an Opaque XRPL backup');
      let inner: { network: string; notes: string; tags: ReceiveTag[]; sites?: Record<string, Site> };
      try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(fromHex(outer.iv!)) },
          await keyFrom(passphrase, new Uint8Array(fromHex(outer.salt!))), new Uint8Array(fromHex(outer.ciphertext!)));
        inner = JSON.parse(new TextDecoder().decode(plain)) as typeof inner;
      } catch {
        throw new Error('wrong passphrase, or the file is damaged');
      }
      if (inner.network !== xrplDeployment.network.name) throw new Error(`this backup is for ${inner.network}`);
      // Notes this browser lacks are added; the ones it has keep their state.
      const here = JSON.parse(localStorage.getItem(K.notes) ?? '{}') as Record<string, unknown>;
      let added = 0;
      for (const [id, note] of Object.entries(JSON.parse(inner.notes) as Record<string, unknown>)) if (!(id in here)) { here[id] = note; added++; }
      localStorage.setItem(K.notes, JSON.stringify(here));
      const tags = wallet.tags();
      save(K.tags, [...tags, ...inner.tags.filter((t) => !tags.some((x) => x.pool === t.pool && x.tag === t.tag))]);
      // Sites this browser lacks; a site it has keeps its own (newer) key position.
      save(K.sites, { ...(inner.sites ?? {}), ...load<Record<string, Site>>(K.sites, {}) });
      return added;
    },
  };
  return wallet;
}

export { symbolOf, UNIT };
