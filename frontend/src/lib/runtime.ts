// The wallet's composition root: every port the payment application needs,
// built from the running stack's config. The page imports this and the barrel.
//
// Where each piece comes from — and the one rule that matters most:
//
//   relay keys   the SIGNED directory, walked from a root compiled into this
//                build (deployments/arc-testnet.json) before a single relay
//                is contacted. Never a root from the network.
//   ring         a mesh query, answered at the exit: members from the pool's
//                own events, their §8.1 weights from the subgraph.
//   relay health a mesh query too (the subgraph, via the exit), clamped.
//   proof        built HERE, in a Web Worker of this page: the note secret
//                never leaves the origin, and the tab does not freeze.
//   account and  WALLET_RPC through the mesh: the account's registry state,
//   note reads   balances, nonce, a note's nullifier, the pool's capabilities.
//                No RPC or bundler learns which wallet asked.
//   intent       sealed here to the CRE key, then chunked across the mesh.
//   status       a mesh query. The page never opens a connection to the exit.
//   account      LIVE on Arc: FORS keys in IndexedDB, the account deployed by
//                PQAccountFactory. No browser wallet (MetaMask or any other)
//                is read or asked: Opaque is a wallet of its own.
//   deposit      from the account: one UserOperation its PQ key signs, for
//                any number of notes. The first deploys the account too, from
//                USDC sent to its address from anywhere. Attributable.
//   pools        one RING_8 pool per configured denomination, compiled
//                in from deployments/ like the relay root: a server that
//                could name the pools could take the deposits.

import type {
  Address,
  CredentialHandle,
  Hex,
  IntentRef,
  IntentStatus,
  MeshQuery,
  PoolScope,
  PrivacyConditions,
  RelayPath,
  RelaySnapshot,
  RingSnapshot,
  StatusHandle,
  TxHash,
} from '@opaque/protocol-types';

import { createMeshBootstrap } from '../../../backend/mesh/bootstrap.ts';
import type { BackupTransport } from './passkey-backup.ts';
import { chainTo } from '../../../backend/mesh/directory.ts';
import { createGraphHealth } from '../../../backend/mesh/graph-health.ts';
import type { DirectoryTrustRoot, SignedDirectory } from '../../../backend/mesh/contracts.ts';
import { createIntentSealer } from '../../../backend/cre/seal-client.ts';
import { ARC_AUTHORITY, checkSwapCall, createPqAccountOps, livePqWalletOptions, pendingDeployment } from '../../../backend/chain/pq-wallet-chain.ts';
import { browserPayer, createBrowserPool, createMeshChainObserver, type DepositMany } from '../../../backend/chain/wallet-chain.ts';
import { capabilitiesOf } from '../../../backend/chain/pool.ts';
import { createWalletRpcAnswerer, ethBalance, readOne, readState, swapQuote, tokenBalances, type SwapQuote, type WalletRpcSend } from '../../../backend/chain/wallet-rpc.ts';
import { extsloadCall } from '../../../backend/chain/uniswap-v4.ts';
import { exitClient } from '../../../backend/chain/ring-exit.ts';
import { anonFetch, anonReadsOn } from './anon-rpc.ts';
import { MarkovPathPolicy } from '../../../graph/src/path-policy.ts';
import { createNoteVault, createRingClient } from '../../../packages/ring-client/src/index.ts';
import type { RingProver } from '../../../packages/ring-client/src/ring-client.ts';
import type { RestorableSignerStore } from '../../../packages/pq-wallet/src/signer-state.ts';
import type { WalletStateStore } from '../../../packages/pq-wallet/src/wallet-state.ts';
import { SealedSignerStore } from './lock.ts';
import { adoptWallet, createPqWallet } from '../../../packages/pq-wallet/src/wallet.ts';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';
import { deployment, meshTrustRoot, NETWORK, requireService, type SwapToken } from '../../../deployments/index.ts';
import { exportBackup, keyStoreName, NOTES_KEY, restoreBackup, WALLET_ID } from './backup.ts';
import { arcState, arcStorageOf, findNotes, forsSeed, noteCounters, noteSecret, saveArcState } from './arc-keys.ts';
import type { AccountKeys } from './wallet-keys.ts';
import { createWorkerProver } from './prover.ts';
import { createPaymentApplication, type AdapterPorts } from './protocol/index.ts';
import { localNoteStorage } from './note-storage.ts';
import { scoped } from './storage-name.ts';
import { createStealth, type Stealth } from './stealth.ts';

export interface StackConfig {
  /** From the pinned root to the directory in force. Older stacks sent only signedDirectory. */
  readonly directoryChain?: readonly SignedDirectory[];
  readonly signedDirectory: SignedDirectory;
  /** A dev server's root, for its random mesh. A built wallet never reads it. */
  readonly trustRoot: DirectoryTrustRoot;
  readonly cre: { readonly publicKey: `0x${string}`; readonly encryptionKeyId: string; readonly policyVersion: string };
  readonly capabilities: { readonly pqWallet: 'MOCK' | 'LIVE'; readonly graph: 'LIVE' | 'FIXTURE'; readonly confidentialExecution: 'ATTESTED' | 'SIMULATED'; readonly policyScope: 'CRE_WORKFLOW_ONLY' };
}

const reviver = (_k: string, v: unknown) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

const ROOT_KEY = scoped('opaque:mesh-root:v1');
/** The compiled-in root, or a later one this browser has already walked to. */
function pinnedRoot(): DirectoryTrustRoot {
  const compiled = meshTrustRoot() as DirectoryTrustRoot;
  try {
    const stored = JSON.parse(localStorage.getItem(ROOT_KEY) ?? 'null', reviver) as { root: DirectoryTrustRoot; from: string } | null;
    // Honoured only if walked from THIS build's root, and only forward of it:
    // a floor, never a way around the pin. A build with a new root starts over.
    if (stored !== null && stored.from === compiled.signerCommitment && typeof stored.root.minVersion === 'bigint'
      && stored.root.minVersion > compiled.minVersion && /^0x[0-9a-f]{64}$/.test(stored.root.signerCommitment)) return stored.root;
  } catch { /* unreadable storage falls back to the compiled root */ }
  return compiled;
}
function savePinnedRoot(root: DirectoryTrustRoot): void {
  const entry = { root, from: meshTrustRoot().signerCommitment };
  try { localStorage.setItem(ROOT_KEY, JSON.stringify(entry, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))); } catch { /* best effort */ }
}

// A dev server reads the local stack's stack.json; a production build reads its
// network's hosted stack (services.meshExitUrl in deployments/). VITE_STACK_URL
// overrides either, e.g. for the extension. docs/hosting.md.
const defaultStackUrl = (): string =>
  import.meta.env?.DEV ? 'stack.json' : `${new URL(requireService('meshExitUrl')).origin}/stack.json`;
export async function loadStack(url: string = import.meta.env?.['VITE_STACK_URL'] ?? defaultStackUrl()): Promise<StackConfig> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`no stack config at ${url} — is backend/stack.ts running?`);
    return JSON.parse(await response.text(), reviver) as StackConfig;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') {
      throw new Error(`stack config timed out after 15s at ${url} — is the privacy backend reachable?`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export interface WalletRuntime {
  readonly app: ReturnType<typeof createPaymentApplication>;
  /** Every ring pool, largest denomination first. */
  readonly scopes: readonly PoolScope[];
  readonly config: StackConfig;
  /** A fresh 3-hop path, drawn from the verified directory. */
  pathFor(): Promise<RelayPath>;
  /** Asks the policy authority for a credential ONCE, before paying. */
  obtainCredential(recipient: `0x${string}`): Promise<CredentialHandle>;
  readRing(scope: PoolScope): Promise<RingSnapshot>;
  readPrivacy(scope: PoolScope): Promise<PrivacyConditions>;
  readStatus(handle: StatusHandle): Promise<IntentStatus>;
  /** The account's USDC, and the gas it has prepaid to the EntryPoint. */
  accountFunds(address: `0x${string}`): Promise<{ readonly usdc: number; readonly prepaidGas: number }>;
  /** Everything the account holds, less this operation's gas, to `to`. */
  withdraw(address: `0x${string}`, to: `0x${string}`): Promise<TxHash>;
  /** Calls the account makes in one operation its PQ key signs, gas from its USDC: a contract deploy, or a call to one. */
  execute(address: `0x${string}`, calls: readonly { readonly to: `0x${string}`; readonly data: `0x${string}`; readonly value?: bigint }[]): Promise<TxHash>;
  /** The account's ETH, where gas is ETH (Sepolia). */
  ethBalance(address: `0x${string}`): Promise<bigint>;
  /** One word of Uniswap v4's PoolManager storage, read across the mesh: a pool's price and liquidity. */
  v4Slot(slot: `0x${string}`): Promise<bigint>;
  /** Post-quantum stealth payments (lib/stealth.ts), where the network has them, for a phrase's account. */
  readonly stealth?: Stealth;
  /** Notes made as a deposit makes them, paid for by `depositMany` instead of this account: a stealth sweep. */
  depositFrom(depositMany: DepositMany, parts: readonly { readonly scope: PoolScope; readonly count: number }[]): Promise<unknown>;
  /** The account open: one of the recovery phrase's, or this browser's own from before phrases. */
  readonly account: AccountKeys | 'browser';
  /** Where this account's sent payments are kept. */
  readonly sentKey: string;
  /** Makes the account ready to sign: its keys from the chain (a phrase's), or new ones the first time. */
  open(): Promise<void>;
  /**
   * A phrase account's notes, found on chain: from the first index (`full`),
   * or from where this browser is, which catches deposits another device made.
   * Returns how many were new here.
   */
  recover(full: boolean, progress?: (line: string) => void): Promise<number>;
  /** Whether an address holds an account or USDC: how an imported phrase's other accounts are found. */
  inUse(address: `0x${string}`): Promise<boolean>;
  /** Drops this browser's copy of a phrase account's keys; the next open rebuilds them from the chain. */
  forgetKeys(): void;
  /** Each swap token at an address, in its smallest units, by symbol. */
  tokenBalances(address: `0x${string}`): Promise<Record<string, bigint>>;
  /** LI.FI's best route for `amount` of `from` into `to`, asked through the mesh and checked here. */
  swapQuote(address: `0x${string}`, from: SwapToken, to: SwapToken, amount: bigint): Promise<SwapQuote>;
  /** The quoted swap, as one operation the account's PQ key signs: approve LI.FI exactly `amount`, then its call. */
  swap(address: `0x${string}`, from: SwapToken, to: SwapToken, amount: bigint, quote: SwapQuote): Promise<TxHash>;
  exportBackup(passphrase: string): Promise<Blob>;
  /** Into a new key store; reload the page to open it. Returns the notes it added. */
  restoreBackup(file: Blob, passphrase: string): Promise<number>;
  /** Stops what this runtime started: the relays' poll and the prover's thread. */
  close(): Promise<void>;
}

/** Whether this browser holds an Arc account from before recovery phrases: keys in IndexedDB, or notes. */
export async function hasBrowserAccount(): Promise<boolean> {
  try { if (Object.keys(JSON.parse(localStorage.getItem(NOTES_KEY) ?? '{}') as object).length > 0) return true; } catch { return true; }
  const store = new SealedSignerStore(keyStoreName());
  try { return (await store.readWallet(WALLET_ID)) !== undefined; } catch { return false; } finally { await store.close(); }
}

/**
 * This page's mesh: the directory checked against the pinned root first, then
 * every query through three relays. One per page, shared by the wallet and the
 * passkey backup, which may need it before any account opens.
 */
function meshOf(cfg: StackConfig) {
  // §8.2 health from the Graph, asked through the mesh (the exit queries the
  // subgraph) and clamped: it weighs the directory's relays, never adds one.
  const relayHealth = createGraphHealth({
    fetchSnapshot: async () => (await query<RelaySnapshot>({ kind: 'RELAY_SNAPSHOT' })).value,
  });

  // VERIFY FIRST: throws before any relay is contacted if the directory does
  // not chain to the pinned root. The root is compiled in; this browser then
  // remembers the furthest root it has accepted, so a server cannot roll it
  // back to an older directory. Only a dev server's wallet takes the root the
  // server sends, for the random mesh a local stack makes.
  const devRoot = import.meta.env?.DEV ? cfg.trustRoot : undefined;
  const { signed, root } = chainTo(cfg.directoryChain ?? [cfg.signedDirectory], devRoot ?? pinnedRoot());
  if (devRoot === undefined) savePinnedRoot(root);
  const bootstrap = createMeshBootstrap({
    root,
    signed,
    pathPolicy: new MarkovPathPolicy(),
    health: relayHealth.health,
    // Big uploads (a ring intent is ~35 chunks) outlast the default poll.
    client: { pollIntervalMs: 250, pollTimeoutMs: 120_000 },
  });
  const query = async <T>(request: Parameters<typeof bootstrap.transport.query>[0]) =>
    (await bootstrap.transport.query(request, await bootstrap.pathFor())) as unknown as { value: T };
  // Until the first answer, every relay weighs the same. The polls double as
  // cover traffic (§7.5).
  void relayHealth.refresh();
  const poll = setInterval(() => void relayHealth.refresh(), 120_000);
  // Never what keeps a Node process (packages/sdk) running.
  (poll as { unref?: () => void }).unref?.();
  return { bootstrap, query, stop: () => clearInterval(poll) };
}
let pageQuery: (<T>(request: MeshQuery) => Promise<{ value: T }>) | undefined;
let pageMesh: Promise<<T>(request: MeshQuery) => Promise<{ value: T }>> | undefined;
/** The passkey backup's way to its store (lib/passkey-backup.ts): through this page's mesh, an account open or not. */
export const backupTransport = (): BackupTransport => async (operation, encodedRequest) => {
  const query = pageQuery ?? await (pageMesh ??= loadStack().then((cfg) => meshOf(cfg).query));
  return (await query<Hex>({ kind: 'BACKUP', operation, encodedRequest })).value;
};

/**
 * What a host other than a page supplies (packages/sdk, in Node): where the
 * account's keys are kept, and the prover. A page leaves both out: IndexedDB
 * under the lock, and a Web Worker.
 */
export interface RuntimeHost {
  readonly keys?: (name: string) => RestorableSignerStore & WalletStateStore;
  readonly prover?: () => RingProver;
}

export async function startWallet(config?: StackConfig, account: AccountKeys | 'browser' = 'browser', host: RuntimeHost = {}): Promise<WalletRuntime> {
  const cfg = config ?? (await loadStack());
  const scopes: readonly PoolScope[] = deployment.pools
    .filter((p) => p.proofMode === 'RING_8')
    .sort((a, b) => b.denomination - a.denomination)
    .map((p) => ({
      chainId: BigInt(deployment.network.chainId) as PoolScope['chainId'],
      pool: p.address as PoolScope['pool'],
      denomination: p.denomination as PoolScope['denomination'],
    }));

  const prover = (host.prover ?? createWorkerProver)();
  let mesh: ReturnType<typeof meshOf>;
  try { mesh = meshOf(cfg); } catch (error) { await prover.close?.(); throw error; }
  const { bootstrap, query } = mesh;
  pageQuery = query;

  // Opaque is a wallet of its own: it never reads or asks a browser wallet
  // such as MetaMask. Reads cross the mesh; the account's PQ key signs.
  const browserPool = createBrowserPool(undefined, cfg.capabilities);
  // Every read that names this wallet's account or notes, and every
  // UserOperation, crosses the mesh (§7.5): see backend/chain/wallet-rpc.ts.
  const viaMesh: WalletRpcSend = async (operation, encodedRequest) =>
    (await query<Hex>({ kind: 'WALLET_RPC', operation, encodedRequest })).value;
  // With the Privacy view's switch on, the account's reads and UserOperations leave
  // this browser through EF's anon-rpc (Nox) for a public RPC and the public bundler,
  // answered by the same code our exit runs, here. Only what our exit pays for or
  // asks on the wallet's behalf (a relayed rotation, a stealth announcement or its
  // gas, a LI.FI quote) still crosses the mesh, beside the payments themselves.
  const viaAnon = NETWORK === 'sepolia' && anonReadsOn() ? (() => {
    const fetchFn = anonFetch();
    return createWalletRpcAnswerer({
      publicClient: exitClient(fetchFn), bundlerUrl: ARC_AUTHORITY.bundlerUrl, entryPoint: ARC_AUTHORITY.entryPoint,
      accountImplementation: ARC_AUTHORITY.accountImplementation, factory: ARC_AUTHORITY.factory, fetch: fetchFn, bundlerTimeoutMs: 90_000,
    });
  })() : undefined;
  const ANON_OPERATIONS = new Set(['STATE', 'ESTIMATE', 'SUBMIT_USER_OPERATION', 'USER_OPERATION_RECEIPT']);
  const walletRpc: WalletRpcSend = async (operation, encodedRequest) => {
    if (viaAnon === undefined || !ANON_OPERATIONS.has(operation)) return viaMesh(operation, encodedRequest);
    const answer = await viaAnon(operation, encodedRequest);
    // Counted where the page can show it: the Privacy view says how many calls anon-rpc answered.
    if (typeof dispatchEvent === 'function') dispatchEvent(new Event('opaque:anon-read'));
    return answer;
  };
  // The account's FORS keys, encrypted under a non-extractable key, in this
  // browser and nowhere else. Back them up (exportBackup), or clearing site
  // data loses the account.
  // A phrase account's keys are drawn from the phrase, so this store is only
  // their copy and signing log here; the browser account's exist nowhere else.
  const names = arcStorageOf(account, keyStoreName());
  const keys = host.keys?.(names.keys) ?? new SealedSignerStore(names.keys);
  const walletOptions = livePqWalletOptions({
    signerStore: keys, walletStore: keys, publicClient: browserPool.publicClient, payer: browserPayer(undefined), walletRpc,
    ...(account === 'browser' ? {} : { seedFor: (epoch: bigint) => forsSeed(account, epoch) }),
  });
  const wallet = createPqWallet(walletOptions);
  // Until the account exists, its operations carry the factory call that
  // deploys it, so the first deposit is also the activation.
  const opsFor = (account: `0x${string}`) => createPqAccountOps({
    wallet, account: account.toLowerCase() as never, authority: ARC_AUTHORITY, walletRpc,
    deployment: () => pendingDeployment(wallet, keys),
  });
  // Deposits come from the account: one UserOperation its PQ key signs,
  // however many notes, and no wallet popup. The first also deploys it.
  const depositMany: DepositMany = async (groups) =>
    opsFor((await wallet.getState()).accountAddress as `0x${string}`).deposit(groups);
  const pool: AdapterPorts['pool'] = {
    ...browserPool,
    depositMany,
    deposit: async ({ scope, commitment }) => depositMany([{ scope, commitments: [commitment] }]),
    isNullifierSpent: (s, nullifier) => chain.isNullifierSpent(s, nullifier),
    capabilities: async (p) => capabilitiesOf((await readOne(walletRpc, p, 'capabilities', [])).value as never, cfg.capabilities),
  };
  const chain = createMeshChainObserver({
    walletRpc,
    ringSnapshot: async (s) => (await query<RingSnapshot>({ kind: 'RING_SNAPSHOT', scope: s })).value,
  });
  const storage = localNoteStorage(names.notes);
  const counters = noteCounters(names.counters);
  const vault = createNoteVault({
    storage, chain,
    // A phrase account's notes are drawn from it, one index per note per pool.
    ...(account === 'browser' ? {} : {
      secretFor: (scope: PoolScope) => {
        const i = counters.next(scope);
        counters.raise(scope, i + 1);
        return noteSecret(account, scope, i);
      },
    }),
  });
  const ring = createRingClient(vault, prover);

  const credentials = new Map<string, string>();
  const sealIntent = createIntentSealer({
    crePublicKey: cfg.cre.publicKey,
    encryptionKeyId: cfg.cre.encryptionKeyId,
    resolveCredential: async (handle) => {
      const credential = credentials.get(handle as string);
      if (credential === undefined) throw new Error('no credential for this recipient — obtain one before paying');
      return credential;
    },
  });


  const ports: AdapterPorts = {
    wallet,
    ring,
    pool,
    // Keys from the verified directory — the rule on AdapterPorts.graph.
    graph: {
      getRelaySnapshot: async () => bootstrap.snapshot(),
      getRingSnapshot: async (scope) => (await query<RingSnapshot>({ kind: 'RING_SNAPSHOT', scope })).value,
      getPrivacyConditions: async (scope) => (await query<PrivacyConditions>({ kind: 'PRIVACY_CONDITIONS', scope })).value,
    },
    transport: bootstrap.transport,
    executor: {
      // Chunked automatically when the sealed intent is too big for one message.
      // A relay that drops the ~1 MB upload is tried again, on a fresh path, with
      // the SAME sealed intent: its idempotency key and spend hash let the
      // executor answer with the intent it already has if the first got through.
      submit: async (intent): Promise<IntentRef> => {
        for (let attempt = 1; ; attempt++) {
          try { return await bootstrap.transport.submitIntent(intent, await bootstrap.pathFor()); }
          catch (error) {
            const e = error as { code?: string; retryable?: boolean };
            if (attempt >= 3 || e.code !== 'MESH_UNAVAILABLE' || e.retryable === false) throw error;
            await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
          }
        }
      },
      getStatus: async (handle) => (await query<IntentStatus>({ kind: 'INTENT_STATUS', handle })).value,
    },
    pathPolicy: new MarkovPathPolicy(),
    sealIntent,
    resolveNoteScope: async (noteId) => {
      const note = (await vault.list()).find((n) => n.id === noteId);
      if (note === undefined) throw new Error('unknown note');
      return note.scope;
    },
  };

  // A phrase account's notes, found among each pool's deposits (lib/arc-keys.ts).
  let looking: Promise<number> = Promise.resolve(0);
  async function recover(full: boolean, progress?: (line: string) => void): Promise<number> {
    if (account === 'browser') return 0;
    let added = 0;
    for (const scope of scopes) {
      progress?.(`Looking for your ${Number(scope.denomination) / 1e6} USDC notes…`);
      const deposits = new Set((await query<RingSnapshot>({ kind: 'RING_SNAPSHOT', scope })).value.candidates.map((c) => c.commitment.toLowerCase()));
      const known = counters.next(scope);
      const { found, next } = await findNotes(account, scope, deposits, full ? 0 : known, known);
      // What this browser holds now, not when the look began: a deposit may have landed meanwhile.
      const mine = new Set((await storage.all()).map((n) => n.commitment.toLowerCase()));
      for (const note of found) {
        if (mine.has(note.commitment.toLowerCase())) continue;
        // CREATED, so listing reconciles it: AVAILABLE, or SPENT if its nullifier is.
        await storage.write({ id: crypto.randomUUID() as never, scope, commitment: note.commitment, secret: toHex(note.secret),
          state: 'CREATED', depositTx: null, createdAtBlock: null, reservation: null });
        added++;
      }
      counters.raise(scope, next);
    }
    saveArcState({ scanned: { ...arcState().scanned, [account.id]: true } });
    return added;
  }

  return {
    app: createPaymentApplication(ports),
    scopes,
    config: cfg,
    pathFor: () => bootstrap.pathFor(),
    async obtainCredential(recipient) {
      // Across the mesh like every read: the authority learns a recipient, never who asked.
      const to = recipient.toLowerCase() as Address;
      const value = (await query<Hex>({ kind: 'CREDENTIAL', recipient: to })).value;
      credentials.set(to, new TextDecoder().decode(fromHex(value)));
      return to as unknown as CredentialHandle;
    },
    readRing: async (scope) => (await query<RingSnapshot>({ kind: 'RING_SNAPSHOT', scope })).value,
    readPrivacy: async (scope) => (await query<PrivacyConditions>({ kind: 'PRIVACY_CONDITIONS', scope })).value,
    readStatus: async (handle) => (await query<IntentStatus>({ kind: 'INTENT_STATUS', handle })).value,
    async accountFunds(address) {
      const f = await opsFor(address).funds();
      return { usdc: Number(f.usdc6) / 1e6, prepaidGas: Number(f.prepaidGas) / 1e18 };
    },
    withdraw: (address, to) => opsFor(address).withdraw(to.toLowerCase() as never),
    execute: (address, calls) => opsFor(address).execute(calls.map((c) => ({ to: c.to.toLowerCase() as never, data: c.data, ...(c.value === undefined ? {} : { value: c.value }) }))),
    ethBalance: (address) => ethBalance(walletRpc, address as never),
    v4Slot: async (slot) => BigInt((await readState(walletRpc, [extsloadCall(slot) as never])).results[0]!),
    // ponytail: phrase accounts only; this browser's own pre-phrase account has no key to draw it from.
    ...(account === 'browser' || deployment.stealth === undefined ? {} : {
      stealth: createStealth({ account, walletRpc, keys, publicClient: browserPool.publicClient as never, storageKey: `${names.notes}:stealth` }),
    }),
    async depositFrom(depositMany, parts) {
      // Notes drawn from the phrase: catch up with any another device made first, so no index is used twice.
      if (account !== 'browser') await recover(false);
      const from = { ...pool, depositMany, deposit: async ({ scope, commitment }: { scope: PoolScope; commitment: never }) => depositMany([{ scope, commitments: [commitment] }]) };
      return createPaymentApplication({ ...ports, pool: from as never }).depositNotes(parts);
    },
    account,
    sentKey: names.sent,
    async open() {
      if (account !== 'browser') await adoptWallet({ ...walletOptions, signerStore: keys });
      if ((await keys.readWallet(WALLET_ID)) === undefined) await wallet.create();
    },
    // One look at a time: two at once (the first open's, a deposit's) would each store what they found.
    recover: (full, progress) => (looking = looking.then(() => recover(full, progress), () => recover(full, progress))),
    async inUse(address) {
      const [registered, funds] = await Promise.all([
        readOne(walletRpc, ARC_AUTHORITY.registry, 'stateOf', [address]).then((r) => BigInt((r.value as { pkCommitment: Hex }).pkCommitment) !== 0n),
        opsFor(address).funds(),
      ]);
      return registered || funds.usdc6 > 0n;
    },
    forgetKeys() {
      if (account === 'browser') return;
      const { generations } = arcState();
      saveArcState({ generations: { ...generations, [account.id]: (generations[account.id] ?? 0) + 1 } });
    },
    async tokenBalances(address) {
      if (deployment.swap.tokens.length === 0) return {}; // Sepolia: no swap tokens, and an empty STATE read is refused
      const amounts = await tokenBalances(walletRpc, address as never, deployment.swap.tokens.map((t) => t.address as never));
      return Object.fromEntries(deployment.swap.tokens.map((t, i) => [t.symbol, amounts[i]!]));
    },
    async swapQuote(address, from, to, amount) {
      const quote = await swapQuote(walletRpc, { from: from.address as never, to: to.address as never, amount, account: address as never });
      // The exit relayed this; the account signs it. So it is checked here: only
      // LI.FI's pinned contract, nothing paid in gas currency, and its call
      // decoded: this account receives at least the least it shows, of `to`,
      // for exactly `amount` of `from`. The signer checks the call again.
      if (deployment.swap.router === null) throw new Error(`no swaps on ${deployment.network.displayName} yet`);
      const router = deployment.swap.router.toLowerCase();
      if (quote.to !== router || quote.approvalAddress !== router) throw new Error('the quote calls a contract other than LI.FI\'s');
      if (BigInt(quote.value) !== 0n) throw new Error('the quote asks for USDC on top of the swap');
      checkSwapCall(quote.data, { account: address as never, from: from.address as never, to: to.address as never, amount, minOut: BigInt(quote.toAmountMin) });
      return quote;
    },
    swap: (address, from, to, amount, quote) => opsFor(address).swap(from.address as never, amount, quote, to.address as never),
    exportBackup: (passphrase) => exportBackup(keys, passphrase),
    restoreBackup,
    async close() {
      mesh.stop();
      if (pageQuery === query) pageQuery = undefined;
      await prover.close?.();
    },
  };
}
