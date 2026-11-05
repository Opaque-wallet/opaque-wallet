// Opaque's privacy on the devnet page: pqUSDC notes in the devnet's seven
// pools (1 to 100), deposited by the FramePQAccount, which signs with FORS+C,
// and paid out privately. A payment's proof is built in this page's worker,
// sealed to the stack's CRE key, carried by three relays, checked by the
// stack's attester and paid by the pool: the recipient's transfer comes from
// the pool, and nothing on chain names the payer (backend/ethereum/devnet-stack.ts).
//
// The XRPL and Arc runtimes' rules hold here too:
//   relay keys   the signed directory, checked against the root pinned in
//                deployments/eth-devnet.json before any relay is contacted;
//                only a dev server takes its stack's own, random, root.
//   ring, note   through the mesh, so no server learns which notes this
//   reads, and   wallet holds or whom it pays.
//   credentials
//   notes        drawn from the recovery phrase, number i of each pool, so the
//                phrase holds them; a secret never leaves this page.
//   deposits     attributable, as every deposit is: the account's own
//                FORS-signed transaction, an approve and a deposit per note.

import type { Address, CredentialHandle, Hex, IdempotencyKey, IntentRef, IntentStatus, MeshQuery, NoteSummary, PaymentRequest, PoolScope, PrivacyConditions, PrivacyScore, RingSnapshot, StatusHandle, UnixSeconds } from '@opaque/protocol-types';
import { asChainId, fromHex } from '@opaque/protocol-types/codecs.js';
import { createNoteSecret } from '@opaque/zk';
import { devnet, encodeFunctionData, parseAbi, type Call } from '../../../backend/ethereum/frame.ts';
import { readOne, type WalletRpcSend } from '../../../backend/chain/wallet-rpc.ts';
import { createIntentSealer } from '../../../backend/cre/seal-client.ts';
import { createMeshBootstrap } from '../../../backend/mesh/bootstrap.ts';
import type { DirectoryTrustRoot, SignedDirectory } from '../../../backend/mesh/contracts.ts';
import { chainTo } from '../../../backend/mesh/directory.ts';
import { createGraphHealth } from '../../../backend/mesh/graph-health.ts';
import { MarkovPathPolicy } from '../../../graph/src/path-policy.ts';
import { createNoteVault, createRingClient } from '../../../packages/ring-client/src/index.ts';
import { localNoteStorage } from '../lib/note-storage.ts';
import { runPaymentLanes } from '../lib/payment-lanes.ts';
import { createWorkerProver } from '../lib/prover.ts';
import { createPaymentFlow, makeAmount, type AdapterPorts } from '../lib/protocol/index.ts';
import { scoped } from '../lib/storage-name.ts';
import { stream, type AccountKeys } from '../lib/wallet-keys.ts';

export interface DevnetStackConfig {
  readonly directoryChain?: readonly SignedDirectory[];
  readonly signedDirectory: SignedDirectory;
  /** A dev server's root, for its random mesh. A built page never reads it. */
  readonly trustRoot: DirectoryTrustRoot;
  readonly cre: { readonly publicKey: Hex; readonly encryptionKeyId: string; readonly policyVersion: string };
}

interface DevnetPool { readonly denomination: number; readonly address: Address }
const privacy = (devnet as unknown as {
  privacy?: { token: { address: Address }; faucet?: Address; pools: DevnetPool[] };
  mesh?: { trustRoot: { signerCommitment: Hex; minVersion: number } };
}).privacy;
const pinnedRoot = (devnet as unknown as { mesh?: { trustRoot: { signerCommitment: Hex; minVersion: number } } }).mesh?.trustRoot;

/** Whether the devnet has Opaque's pools yet (backend: node ethereum/frame-tx.ts privacy). */
export const hasPrivacy = (): boolean => privacy !== undefined && privacy.pools.length > 0;
export const pqUSDC = (): Address => privacy!.token.address;

const UNIT = 1_000_000;
/** Notes paid two at a time: a proof takes the worker a few seconds. */
const LANES = 2;
const ERC20 = parseAbi(['function approve(address spender, uint256 value) returns (bool)']);
const POOL = parseAbi(['function deposit(bytes32 commitment)']);
const reviver = (_k: string, v: unknown) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v);
const load = <T>(key: string, fallback: T): T => {
  try { const raw = localStorage.getItem(key); return raw === null ? fallback : (JSON.parse(raw, reviver) as T); } catch { return fallback; }
};
const save = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value, replacer));

export async function loadDevnetStack(url: string = import.meta.env?.['VITE_DEVNET_STACK_URL'] ?? 'devnet-stack.json'): Promise<DevnetStackConfig> {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`no devnet stack at ${url}: is backend/ethereum/devnet-stack.ts running?`);
  return JSON.parse(await response.text(), reviver) as DevnetStackConfig;
}

/** A private payment: its notes, each a spend of its own through its own ring. */
export interface PrivateSend {
  readonly id: string;
  readonly amount: number;
  readonly recipient: Address;
  readonly createdAt: number;
  readonly notes: { noteId: string; size: number; reservation: string; state: string; handle?: string; txHash?: string; error?: string }[];
}

export interface DevnetPrivacy {
  /** Every note this account holds here, spendable or not. */
  notes(): Promise<readonly NoteSummary[]>;
  /** New notes for `amount` whole pqUSDC, and the calls that deposit them: one approve per pool, one deposit per note. */
  depositPlan(amount: number): Promise<{ readonly notes: readonly NoteSummary[]; readonly calls: readonly Call[] }>;
  /** After the deposit transaction is mined: its notes are in their rings. */
  deposited(notes: readonly NoteSummary[], txHash: Hex): Promise<void>;
  /** Pays `amount` whole pqUSDC to `recipient`, note by note, through the mesh. */
  send(amount: number, recipient: Address, onProgress?: (line: string) => void): Promise<PrivateSend>;
  activity(): readonly PrivateSend[];
  /** Asks the stack how each note of each payment is doing. */
  pollActivity(): Promise<readonly PrivateSend[]>;
  /** Deposits in each pool, by note size in whole pqUSDC: the rings a note can hide in. */
  poolSizes(): Promise<ReadonlyMap<number, number>>;
  /** The smallest pool's privacy conditions, its score among them. */
  readPrivacy(): Promise<PrivacyConditions>;
  /** A route drawn as a payment draws one: three relays, by id. */
  samplePath(): Promise<readonly string[]>;
}

export async function startDevnetPrivacy(account: AccountKeys, cfg?: DevnetStackConfig): Promise<DevnetPrivacy> {
  if (privacy === undefined) throw new Error('no privacy pools on the devnet yet');
  const config = cfg ?? (await loadDevnetStack());
  const name = (part: string) => scoped(`opaque:eth-devnet:${account.id}:${part}:v1`);
  const K = { notes: name('notes'), activity: name('activity'), counters: name('note-counters') };

  // VERIFY FIRST: nothing is contacted unless the directory chains to the root.
  const devRoot = import.meta.env?.DEV ? config.trustRoot : undefined;
  if (devRoot === undefined && pinnedRoot === undefined) throw new Error('no mesh root pinned for the devnet in deployments/eth-devnet.json');
  const root = devRoot ?? ({ signerCommitment: pinnedRoot!.signerCommitment, minVersion: BigInt(pinnedRoot!.minVersion) } as unknown as DirectoryTrustRoot);
  const { signed, root: verifiedRoot } = chainTo(config.directoryChain ?? [config.signedDirectory], root);
  const relayHealth = createGraphHealth({ fetchSnapshot: async () => (await query<never>({ kind: 'RELAY_SNAPSHOT' })).value });
  const bootstrap = createMeshBootstrap({ root: verifiedRoot, signed, pathPolicy: new MarkovPathPolicy(), health: relayHealth.health, client: { pollIntervalMs: 250, pollTimeoutMs: 120_000 } });
  const query = async <T>(request: MeshQuery) => (await bootstrap.transport.query(request, await bootstrap.pathFor())) as unknown as { value: T };
  void relayHealth.refresh();

  const walletRpc: WalletRpcSend = async (operation, encodedRequest) => (await query<Hex>({ kind: 'WALLET_RPC', operation, encodedRequest })).value;
  const scopeOf = (p: DevnetPool): PoolScope => ({ chainId: asChainId(BigInt(devnet.chainId)), pool: p.address, denomination: p.denomination }) as never;
  const sizes = privacy.pools.map((p) => p.denomination / UNIT);
  const poolOfSize = (size: number) => privacy.pools.find((p) => p.denomination === size * UNIT)!;

  // One ring read per pool per few seconds, however many notes ask.
  const rings = new Map<string, { at: number; ring: Promise<RingSnapshot> }>();
  const ring = (scope: PoolScope): Promise<RingSnapshot> => {
    const hit = rings.get(scope.pool);
    if (hit !== undefined && Date.now() - hit.at < 8_000) return hit.ring;
    const fresh = query<RingSnapshot>({ kind: 'RING_SNAPSHOT', scope }).then((r) => r.value);
    rings.set(scope.pool, { at: Date.now(), ring: fresh });
    fresh.catch(() => rings.delete(scope.pool));
    return fresh;
  };

  const vault = createNoteVault({
    storage: localNoteStorage(K.notes),
    // Note i of each pool, from the phrase. The number is spent before the note exists, so it is never drawn twice.
    secretFor: (scope) => {
      const counters = load<Record<string, number>>(K.counters, {});
      const i = counters[scope.pool] ?? 0;
      save(K.counters, { ...counters, [scope.pool]: i + 1 });
      return createNoteSecret(stream(account.key, `note/eth-devnet/${scope.pool}/${i}`));
    },
    chain: {
      async observeCommitment(scope, commitment) {
        const found = (await ring(scope)).candidates.find((c) => c.commitment === commitment);
        return found === undefined ? null : { blockNumber: found.enrolledAtBlock };
      },
      isNullifierSpent: async (scope, nullifier) => (await readOne(walletRpc, scope.pool, 'isNullifierSpent', [nullifier])).value as boolean,
    },
  });
  const prover = createWorkerProver();
  const ringClient = createRingClient(vault, prover);

  const seal = createIntentSealer({
    crePublicKey: config.cre.publicKey, encryptionKeyId: config.cre.encryptionKeyId,
    resolveCredential: async (handle) => {
      const c = credentials.get(handle as string);
      if (c === undefined) throw new Error('no credential for this recipient: obtain one before paying');
      return c;
    },
  });
  const credentials = new Map<string, string>();
  async function credentialFor(recipient: Address): Promise<CredentialHandle> {
    if (!credentials.has(recipient)) {
      // Across the mesh like every read: the authority learns a recipient, never who asked.
      credentials.set(recipient, new TextDecoder().decode(fromHex((await query<Hex>({ kind: 'CREDENTIAL', recipient })).value)));
    }
    return recipient as unknown as CredentialHandle;
  }

  async function payNote(note: NoteSummary, reservation: string, recipient: Address): Promise<IntentRef> {
    const request: PaymentRequest = {
      noteId: note.id, recipient, minPrivacyScore: 0 as PrivacyScore,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 900) as UnixSeconds,
      credentialHandle: await credentialFor(recipient), idempotencyKey: reservation as IdempotencyKey,
    };
    // Only the ports the payment sequence uses.
    const ports = {
      ring: ringClient,
      graph: { getRelaySnapshot: async () => bootstrap.snapshot(), getRingSnapshot: ring, getPrivacyConditions: async () => { throw new Error('unused'); } },
      pathPolicy: new MarkovPathPolicy(),
      transport: bootstrap.transport,
      executor: {
        submit: async (intent) => bootstrap.transport.submitIntent(intent, await bootstrap.pathFor()),
        getStatus: async (handle: StatusHandle) => (await query<IntentStatus>({ kind: 'INTENT_STATUS', handle })).value,
      },
      sealIntent: seal,
      resolveNoteScope: async () => note.scope,
    } as Pick<AdapterPorts, 'ring' | 'graph' | 'pathPolicy' | 'transport' | 'executor' | 'sealIntent' | 'resolveNoteScope'>;
    return createPaymentFlow(ports as AdapterPorts, request, note.scope, recipient);
  }

  /** Notes a payment under way has taken, so a payment beside it takes others. */
  const spending = new Set<string>();

  const privacyApi: DevnetPrivacy = {
    async notes() {
      // A note deposited but not yet seen in its ring is looked for again.
      for (const n of await vault.list()) {
        if (n.state === 'DEPOSIT_PENDING' || n.state === 'RESERVED' || n.state === 'RECONCILIATION_REQUIRED') await vault.reconcile(n.id).catch(() => undefined);
      }
      return vault.list();
    },
    async depositPlan(amount) {
      if (!Number.isInteger(amount) || amount <= 0) throw new Error('a private deposit is a whole number of pqUSDC');
      const plan = makeAmount(amount, sizes);
      if (plan === undefined) throw new Error(`${amount} pqUSDC does not split into the pools' note sizes`);
      const notes: NoteSummary[] = [];
      const calls: Call[] = [];
      for (const [size, count] of plan) {
        const p = poolOfSize(size);
        calls.push({ to: privacy.token.address, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [p.address, BigInt(count * size * UNIT)] }), gas: 100_000n, state: 200_000n });
        for (let k = 0; k < count; k++) {
          const note = await vault.create(scopeOf(p));
          notes.push(note);
          // The pool's record of the commitment is new storage: state gas.
          calls.push({ to: p.address, data: encodeFunctionData({ abi: POOL, functionName: 'deposit', args: [note.commitment as Hex] }), gas: 150_000n, state: 300_000n });
        }
      }
      return { notes, calls };
    },
    async deposited(notes, txHash) {
      for (const n of notes) {
        await vault.recordDeposit(n.id, txHash as never);
        await vault.reconcile(n.id).catch(() => undefined);
      }
    },
    async send(amount, recipient, onProgress) {
      const free = (await privacyApi.notes()).filter((n) => n.state === 'AVAILABLE' && !spending.has(n.id));
      const have = new Map<number, number>();
      for (const n of free) have.set(n.scope.denomination / UNIT, (have.get(n.scope.denomination / UNIT) ?? 0) + 1);
      const plan = makeAmount(amount, sizes, have);
      if (plan === undefined) throw new Error(`your private notes cannot make ${amount} pqUSDC exactly`);
      const picked: NoteSummary[] = [];
      for (const [size, count] of plan) picked.push(...free.filter((n) => n.scope.denomination === size * UNIT).slice(0, count));
      for (const n of picked) spending.add(n.id);
      const id = crypto.randomUUID().slice(0, 8);
      const sent: PrivateSend = {
        id, amount, recipient, createdAt: Date.now(),
        notes: picked.map((n, i) => ({ noteId: n.id, size: n.scope.denomination / UNIT, reservation: `devnet:${id}:${i}`, state: 'PROVING' })),
      };
      save(K.activity, [sent, ...load<PrivateSend[]>(K.activity, [])]);
      const store = () => save(K.activity, load<PrivateSend[]>(K.activity, []).map((s) => (s.id === id ? sent : s)));
      try {
        await runPaymentLanes(picked, LANES, async (note, i) => {
          const entry = sent.notes[i]!;
          onProgress?.(`note ${i + 1} of ${picked.length} (${entry.size} pqUSDC): proving in this browser…`);
          try {
            entry.handle = (await payNote(note, entry.reservation, recipient)).statusHandle as string;
            entry.state = 'SUBMITTED';
            onProgress?.(`note ${i + 1} of ${picked.length}: sealed and sent through three relays`);
          } catch (error) {
            entry.state = 'FAILED';
            entry.error = (error as Error).message;
            await vault.release({ noteId: note.id, reservation: entry.reservation as IdempotencyKey, terminalIntent: 'not-submitted' as never }).catch(() => undefined);
            onProgress?.(`note ${i + 1} of ${picked.length}: ${entry.error}`);
          }
          store();
        });
      } finally {
        for (const n of picked) spending.delete(n.id);
      }
      return sent;
    },
    activity: () => load<PrivateSend[]>(K.activity, []),
    async poolSizes() {
      const counts = await Promise.all(privacy.pools.map(async (p) => [p.denomination / UNIT, (await ring(scopeOf(p))).candidates.length] as const));
      return new Map(counts);
    },
    readPrivacy: async () => (await query<PrivacyConditions>({ kind: 'PRIVACY_CONDITIONS', scope: scopeOf(privacy.pools[0]!) })).value,
    samplePath: async () => (await bootstrap.pathFor()).map((n) => n.id as string),
    async pollActivity() {
      // Laid onto storage at the end: a send under way writes its notes meanwhile.
      const changes = new Map<string, Partial<PrivateSend['notes'][number]>>();
      for (const sent of load<PrivateSend[]>(K.activity, [])) {
        for (const entry of sent.notes) {
          if (entry.handle === undefined || entry.state === 'SETTLED' || entry.state === 'FAILED') continue;
          const status = (await query<IntentStatus>({ kind: 'INTENT_STATUS', handle: entry.handle as StatusHandle }).catch(() => null))?.value;
          if (status === undefined) continue;
          changes.set(`${sent.id}:${entry.reservation}`, {
            state: status.state,
            ...(status.txHash === undefined ? {} : { txHash: status.txHash }),
            ...(status.error === undefined ? {} : { error: status.error.publicMessage }),
          });
          if (status.state === 'FAILED') {
            await vault.release({ noteId: entry.noteId as never, reservation: entry.reservation as IdempotencyKey, terminalIntent: entry.handle as never }).catch(() => undefined);
            await vault.reconcile(entry.noteId as never).catch(() => undefined);
          }
          if (status.state === 'SETTLED') await vault.reconcile(entry.noteId as never).catch(() => undefined);
        }
      }
      const latest = load<PrivateSend[]>(K.activity, []);
      for (const sent of latest) for (const entry of sent.notes) Object.assign(entry, changes.get(`${sent.id}:${entry.reservation}`) ?? {});
      save(K.activity, latest);
      return latest;
    },
  };
  return privacyApi;
}
