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

import type { CredentialHandle, Hex, IdempotencyKey, IntentRef, IntentStatus, NoteSummary, PaymentRequest, PoolScope, PrivacyScore, RelaySnapshot, RingSnapshot, StatusHandle, UnixSeconds } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';
import { createNoteSecret, deriveCommitment } from '@opaque/zk';

import { createMeshBootstrap } from '../../../backend/mesh/bootstrap.ts';
import { chainTo } from '../../../backend/mesh/directory.ts';
import { createGraphHealth } from '../../../backend/mesh/graph-health.ts';
import type { DirectoryTrustRoot, SignedDirectory } from '../../../backend/mesh/contracts.ts';
import { createIntentSealer } from '../../../backend/cre/seal-client.ts';
import { accountOf, recipientFor, scopeOf, type XrplDestination } from '../../../backend/xrpl/protocol.ts';
import { faucetDeposit, meshLedger, nullifierSpent, onrampUrl, registerTag, tagStatus, type XrplSend } from '../../../backend/xrpl/queries.ts';
import { closeSite, newSite, resultOf, rotate, setupSite, signAndSubmit, signMessage, signOnly, syncIndex, type Site } from '../../../backend/xrpl/site.ts';
import { MarkovPathPolicy } from '../../../graph/src/path-policy.ts';
import { createNoteVault, createRingClient, type NoteVault } from '../../../packages/ring-client/src/index.ts';
import { xrplDeployment, xrplMeshTrustRoot, type XrplPoolDeployment } from '../../../deployments/xrpl.ts';
import { keyFrom } from './backup.ts';
import { createWorkerProver } from './prover.ts';
import { createPaymentFlow, makeAmount, type AdapterPorts } from './protocol/index.ts';
import { localNoteStorage } from './note-storage.ts';
import { runPaymentLanes } from './payment-lanes.ts';
import type { WalletConnectConfig } from './walletconnect.ts';
import { scoped } from './storage-name.ts';
import { stream, type AccountKeys } from './xrpl-keys.ts';

export interface XrplStackConfig {
  readonly directoryChain?: readonly SignedDirectory[];
  readonly signedDirectory: SignedDirectory;
  /** A dev server's root, for its random mesh. A built wallet never reads it. */
  readonly trustRoot: DirectoryTrustRoot;
  readonly cre: { readonly publicKey: `0x${string}`; readonly encryptionKeyId: string; readonly policyVersion: string };
  readonly credentialUrl: string;
  readonly buy: boolean;
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
  return { notes: name('notes'), tags: name('tags'), activity: name('activity'), sites: name('sites'), counters: name('note-counters') };
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
/** At most this many notes travel at once: each is a 1.1 MiB proof upload. */
const LANES = 2;
/** What a payment that chose to wait asks of the pool's privacy score. */
const WAIT_SCORE = 5_000;

export async function loadXrplStack(url: string = import.meta.env['VITE_XRPL_STACK_URL'] ?? 'xrpl-stack.json'): Promise<XrplStackConfig> {
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

export interface Sent {
  readonly id: string;
  readonly symbol: string;
  /** Whole units, before fees. */
  readonly amount: number;
  readonly destination: XrplDestination;
  readonly createdAt: number;
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
  receive(symbol: string, expected?: number): Promise<ReceiveTag>;
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
  }): Promise<Sent>;
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
  /** Whether another account of the phrase has notes in the pools' logs (1) or not (0), keeping none. */
  probe(account: AccountKeys): Promise<number>;
}

export async function startXrplWallet(config?: XrplStackConfig, account: AccountKeys | null = null): Promise<XrplWallet> {
  const cfg = config ?? (await loadXrplStack());
  const K = storageOf(account);

  const relayHealth = createGraphHealth({ fetchSnapshot: async () => (await query<RelaySnapshot>({ kind: 'RELAY_SNAPSHOT' })).value });
  // VERIFY FIRST: throws before any relay is contacted if the directory does
  // not chain to the root. Only a dev server's wallet takes the stack's root.
  const devRoot = import.meta.env.DEV ? cfg.trustRoot : undefined;
  const { signed, root } = chainTo(cfg.directoryChain ?? [cfg.signedDirectory], devRoot ?? xrplMeshTrustRoot() as DirectoryTrustRoot);
  const bootstrap = createMeshBootstrap({
    root, signed, pathPolicy: new MarkovPathPolicy(), health: relayHealth.health,
    client: { pollIntervalMs: 250, pollTimeoutMs: 120_000 },
  });
  const query = async <T>(request: Parameters<typeof bootstrap.transport.query>[0]) =>
    (await bootstrap.transport.query(request, await bootstrap.pathFor())) as unknown as { value: T };
  void relayHealth.refresh();
  setInterval(() => void relayHealth.refresh(), 120_000);

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
  const ringClient = createRingClient(vault, createWorkerProver());

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
      const response = await fetch(cfg.credentialUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recipient }) });
      if (!response.ok) throw new Error(`the credential authority refused: ${response.status}`);
      credentials.set(recipient, await response.text());
    }
    return recipient as unknown as CredentialHandle;
  }

  async function refresh(deep = false): Promise<readonly NoteSummary[]> {
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

  async function payNote(note: NoteSummary, reservation: string, destination: XrplDestination, minScore: number, deadline: UnixSeconds): Promise<IntentRef> {
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
      sealIntent: (input) => seal({ ...input, spend: { ...(input.spend as object), destination } }),
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

    async receive(symbol, expected = 0) {
      const p = poolBySymbol(symbol);
      const sizes = [...p.sizes].sort((a, b) => b - a);
      // Enough of each smaller size for any remainder (9), and of the largest
      // for what is expected plus one; 64 at most per registration.
      const counts = new Map(sizes.map((s, i) => [s, i === 0 ? Math.min(64 - 9 * (sizes.length - 1), Math.ceil(expected * UNIT / s) + 1) : 9]));
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
          await registerTag(xrpl, p.account, tag, commitments);
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
    tagStatus: (t) => tagStatus(xrpl, t.pool, t.tag),
    buyUrl: (t, fiat) => onrampUrl(xrpl, t.pool, t.tag, fiat),
    faucet: (t) => faucetDeposit(xrpl, t.pool, t.tag),

    async plan(symbol, amount) {
      const p = poolBySymbol(symbol);
      const have = new Map<number, number>();
      for (const n of await vault.list()) {
        if (n.state === 'AVAILABLE' && accountOf(n.scope.pool) === p.account) have.set(n.scope.denomination / UNIT, (have.get(n.scope.denomination / UNIT) ?? 0) + 1);
      }
      return makeAmount(amount, p.sizes.map((s) => s / UNIT), have);
    },

    async send({ symbol, amount, destination, waitForPrivacy, deadline, onProgress }) {
      const p = poolBySymbol(symbol);
      const plan = await wallet.plan(symbol, amount);
      if (plan === undefined) throw new Error(`the notes held cannot make ${amount} ${symbol} exactly`);
      const available = (await vault.list()).filter((n) => n.state === 'AVAILABLE' && accountOf(n.scope.pool) === p.account);
      const picked: NoteSummary[] = [];
      for (const [size, count] of plan) picked.push(...available.filter((n) => n.scope.denomination === size * UNIT).slice(0, count));
      const id = toHex(crypto.getRandomValues(new Uint8Array(8)));
      const sent: Sent = {
        id, symbol, amount, destination, createdAt: Date.now(),
        notes: picked.map((n, i) => ({ noteId: n.id, size: n.scope.denomination / UNIT, reservation: `xrpl:${id}:${i}`, state: 'PROVING' })),
      };
      save(K.activity, [sent, ...load<Sent[]>(K.activity, [])]);
      const store = () => save(K.activity, load<Sent[]>(K.activity, []).map((s) => (s.id === id ? sent : s)));
      await runPaymentLanes(picked, LANES, async (note, i) => {
        const entry = sent.notes[i]!;
        onProgress?.(`note ${i + 1}/${picked.length} (${entry.size} ${symbol}): proving in this browser…`);
        try {
          const ref = await payNote(note, entry.reservation, destination, waitForPrivacy ? WAIT_SCORE : 0, deadline);
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
    activity: () => load<Sent[]>(K.activity, []),
    async pollActivity() {
      const all = load<Sent[]>(K.activity, []);
      for (const sent of all) {
        for (const entry of sent.notes) {
          if (entry.handle === undefined || entry.state === 'SETTLED' || entry.state === 'FAILED') continue;
          const status = (await query<IntentStatus>({ kind: 'INTENT_STATUS', handle: entry.handle as StatusHandle }).catch(() => null))?.value;
          if (status === undefined) continue;
          entry.state = status.state;
          if (status.txHash !== undefined) entry.txHash = status.txHash.slice(2).toUpperCase();
          if (status.error !== undefined) entry.error = status.error.publicMessage;
          if (status.state === 'FAILED') {
            // Back to spendable unless the ledger says the note is gone.
            await vault.release({ noteId: entry.noteId as never, reservation: entry.reservation as IdempotencyKey, terminalIntent: entry.handle as never }).catch(() => undefined);
            await vault.reconcile(entry.noteId as never).catch(() => undefined);
          }
          if (status.state === 'SETTLED') await vault.reconcile(entry.noteId as never).catch(() => undefined);
        }
      }
      save(K.activity, all);
      return all;
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
      onProgress?.('Checking which of them are still yours to spend…');
      await refresh(true);
      return kept;
    },
    async probe(other) {
      // Whether an account was ever used: its first notes of a size are among its first numbers.
      for (const { scope } of scopes()) if ((await scan(other, scope, 0, PROBE_GAP)).length > 0) return 1;
      return 0;
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
