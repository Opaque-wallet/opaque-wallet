#!/usr/bin/env node
// The whole backend a wallet needs, on one machine, against the REAL Arc pool.
//
//   cd backend && set -a && . ./.env && set +a && node stack.ts
//
// On a public box, behind deploy/Caddyfile (docs/hosting.md):
//
//   PUBLIC_URL=https://mesh.example.com node stack.ts            six relays here
//   PUBLIC_URL=… MESH_CONFIG=mesh/deploy/config node stack.ts    six elsewhere
//
// Six relays, the mesh exit (executor + query answering + the CRE stand-in),
// the release egress, and a test credential authority. The exit reads the
// subgraph (§8); on a public box the relays announce themselves and report
// health to RelayDirectory, which is what the subgraph indexes. Writes the wallet's
// public config to frontend/public/stack.json — the signed relay directory,
// its trust root, the CRE's public key — so `npm run dev` in frontend/ talks to
// this and nothing else.
//
// ── What this is NOT ─────────────────────────────────────────────────────
//
// One machine is one operator: six relays here collude by construction. The
// CRE stand-in holds INTENT_KEY in an ordinary process, so nothing it opens is
// confidential. The credential authority issues for any recipient. Every one of
// those is labelled in the capabilities the wallet reads, and every one is a
// deployment step, not a code change — see docs/deployment-arc-testnet.md.
//
// A built wallet pins the relay directory's trust root at compile time
// (deployments/arc-testnet.json) and walks directoryChain from it: a root
// fetched from a server an attacker controls is a root the attacker chose.
// With MESH_MASTER set, this box derives that chain. Only a dev server's
// wallet takes the root written here, for the random mesh an unset master gives.

import { timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPublicClient, createWalletClient, nonceManager, parseAbi, parseEther, parseEventLogs, WaitForTransactionReceiptTimeoutError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ProtocolFailure, type GraphSelectionClient, type PoolScope, type RelaySnapshot, type RingSnapshot, type UnixSeconds } from '@opaque/protocol-types';
import { asChainId, fromHex, spendHash, toHex } from '@opaque/protocol-types/codecs.js';

import { deployment, meshTrustRoot, poolFor, requireAttester, requireContract, type PoolDeployment } from '../deployments/index.ts';
import { GraphHttpClient } from '../graph/src/client.ts';
import { evaluatePublicReadiness } from '../graph/src/privacy-score.ts';
import { registryAttesterKeys } from './chain/attester-registry.ts';
import { ARC, assertSpendable, createPoolClient, poolSubmitter, rpcTransport, writeInTurn } from './chain/pool.ts';
import { ARC_AUTHORITY } from './chain/pq-wallet-chain.ts';
import { relayDirectoryReporter } from './chain/relay-directory.ts';
import { createChainRingSource } from './chain/ring-source.ts';
import { createWalletRpcAnswerer } from './chain/wallet-rpc.ts';
import { credentialJson } from './cre/credential.ts';
import { createExecutorServer } from './cre/executor-server.ts';
import { generateIntentKeypair } from './cre/seal-client.ts';
import { createSettler, type Settler, type SettlerOptions } from './cre/settler.ts';
import { commitmentOf, CONTROLLER_ABI, masterKey, REGISTRY_ABI as NAME_REGISTRY_ABI, signRotation } from './ethereum/ens.ts';
import { createCreSimulator } from './cre/simulator.ts';
import { createEgress, egressClient } from './mesh/egress.ts';
import { backupFromEnv, backupHttpHandler } from './mesh/backup-store.ts';
import type { DirectoryTrustRoot, SignedDirectory } from './mesh/contracts.ts';
import { chainTo, verify } from './mesh/directory.ts';
import { createGraphHealth } from './mesh/graph-health.ts';
import { buildLocalMesh, meshRootAt, serveLocalMesh } from './mesh/local-mesh.ts';
import type { MeshMessageKind } from './mesh/transport.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, '.stack');
const OUT = join(HERE, '..', 'frontend', 'public', 'stack.json');
const PORTS = { relays: 18_101, exit: 18_200, egress: 18_201, credentials: 18_202 } as const;
// v2 is the Vault key the CRE workflow holds (CRE_MODE below); v1 a stand-in's.
const KEY_ID = process.env['CRE_MODE'] === 'workflow' ? 'opaque-intent-key-v2' : 'opaque-intent-key-v1';
const POLICY = 'opaque-policy-v1';
// Every listener binds loopback. On a public box only the TLS proxy in front
// (deploy/Caddyfile) is reachable, and the egress — which signs — never is.
const LOOPBACK = '127.0.0.1';
// Where the WALLET reaches this box. Unset: loopback, one laptop. Set to e.g.
// https://mesh.example.com and the directory names the proxy's /r1…/r6.
// Railway names its domain in RAILWAY_PUBLIC_DOMAIN, so there it needs no setting.
const RAILWAY = process.env['RAILWAY_PUBLIC_DOMAIN'];
const PUBLIC_URL = (process.env['PUBLIC_URL'] ?? (RAILWAY && `https://${RAILWAY}`))?.replace(/\/+$/, '');
// A PaaS gives a service ONE port and one TLS name, and sets PORT. Everything
// the wallet and remote relays reach is then routed on it — see the bottom.
const PORT = process.env['PORT'];

const env = (name: string): string => {
  const v = process.env[name];
  if (v === undefined) throw new Error(`${name} must be set — run with: set -a && . ./.env && set +a`);
  return v;
};
const nowS = (): UnixSeconds => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds;
const log = (s: string) => process.stdout.write(`${s}\n`);
const bigintReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v);

// ── who decides: the CRE workflow, or a stand-in in this process ─────────
//
// CRE_MODE=workflow (the deployed stack): the Chainlink CRE workflow
// (opaque-cre/confidential-intent) decides every payment, in its enclave,
// reading GET /v1/cre/pending and posting to POST /v1/cre/release. This box
// holds only the CRE key's PUBLIC half (CRE_INTENT_PUBLIC_KEY); the secret
// half exists in Chainlink's Vault DON and nowhere else, so nothing here can
// open a payment before CRE releases it. CREDENTIAL_MAC is shared with CRE:
// it issues and checks recipient credentials and tags CRE's decisions.
//
// Unset (a laptop): a stand-in runs the same decision in this process, with a
// key persisted in .stack so a sealed intent survives a restart.
const CRE_MODE = process.env['CRE_MODE'] === 'workflow' ? 'workflow' : 'standin';
mkdirSync(STATE, { recursive: true, mode: 0o700 });
const intentKeyFile = join(STATE, 'intent-key.json');
const macFile = join(STATE, 'credential.mac');
if (CRE_MODE === 'standin' && !existsSync(intentKeyFile)) {
  const k = generateIntentKeypair();
  writeFileSync(intentKeyFile, JSON.stringify({ publicKey: k.publicKey, secretKey: k.secretKey }), { mode: 0o600 });
}
if (CRE_MODE === 'standin' && !existsSync(macFile)) writeFileSync(macFile, toHex(crypto.getRandomValues(new Uint8Array(32))), { mode: 0o600 });
const intentKeys = CRE_MODE === 'workflow'
  ? { publicKey: env('CRE_INTENT_PUBLIC_KEY') as `0x${string}`, secretKey: undefined }
  : JSON.parse(readFileSync(intentKeyFile, 'utf8')) as { publicKey: `0x${string}`; secretKey: `0x${string}` };
const credentialMac = fromHex((CRE_MODE === 'workflow' ? env('CREDENTIAL_MAC') : readFileSync(macFile, 'utf8')).trim() as `0x${string}`);
if (credentialMac.length !== 32) throw new Error('CREDENTIAL_MAC must be 32 bytes of hex');

// ── chain ────────────────────────────────────────────────────────────────
// Every RING_8 pool, one per denomination; one attester signs for all of them.
// A wallet splits an amount into these notes, so 100 USDC is one payment.
const ringPools = deployment.pools.filter((p) => p.proofMode === 'RING_8');
const ring8 = poolFor(1_000_000, 'RING_8');
const REGISTRY = requireContract('pqKeyRegistry');
const ATTESTER = requireAttester();
const scopeOf = (p: PoolDeployment): PoolScope => ({ chainId: asChainId(BigInt(deployment.network.chainId)), pool: p.address, denomination: p.denomination }) as never;
const poolAt = (s: PoolScope): PoolDeployment => {
  const pool = ringPools.find((p) => p.address === s.pool.toLowerCase());
  if (pool === undefined) throw new ProtocolFailure('INVALID_INPUT', `no RING_8 pool at ${s.pool}`);
  return pool;
};
const publicClient = createPublicClient({ chain: ARC, transport: rpcTransport() });
const poolAbi = parseAbi([
  'function isNullifierSpent(bytes32) view returns (bool)',
  'event Spent(bytes32 indexed nullifier, address indexed recipient, uint256 amount)',
]);

// ── the mesh ─────────────────────────────────────────────────────────────
// Relays on six other hosts: MESH_CONFIG=mesh/deploy/config, the directory and
// root make-config.ts wrote for them. Unset: six relays in this process.
const MESH_CONFIG = process.env['MESH_CONFIG'];
// Set on a public deployment: every relay key and directory derives from this
// one secret, week by week from the genesis in deployments/arc-testnet.json,
// so the root compiled into the wallet verifies across restarts. Unset: a
// fresh random mesh each boot, whose root only a dev server may hand out.
// Public only: a loopback mesh from the same master would put a second
// directory under each few-time signer, with endpoints no wallet can reach.
const MESH_MASTER = PUBLIC_URL === undefined ? undefined : process.env['MESH_MASTER'];
const readConfig = <T>(name: string): T => JSON.parse(readFileSync(join(MESH_CONFIG!, name), 'utf8'),
  (_k, v: unknown) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as T;
const mesh = MESH_CONFIG === undefined
  ? buildLocalMesh({
    basePort: PORTS.relays,
    endpointFor: (_id, i, port) =>
      PUBLIC_URL === undefined ? `http://${LOOPBACK}:${port}/v1/relay` : `${PUBLIC_URL}/r${i + 1}/v1/relay`,
    ...(MESH_MASTER === undefined ? {} : { master: fromHex(MESH_MASTER as `0x${string}`), genesis: BigInt(deployment.mesh.genesis) }),
  })
  : (() => {
    const signed = readConfig<SignedDirectory>('directory.json');
    return { signed, root: readConfig<DirectoryTrustRoot>('trust-root.json'), chain: [signed] };
  })();
const pinned = meshTrustRoot();
if (MESH_MASTER !== undefined) {
  // Refuse to serve a mesh the deployed wallet cannot verify.
  const derived = meshRootAt(fromHex(MESH_MASTER as `0x${string}`), pinned.minVersion);
  if (derived.signerCommitment !== pinned.signerCommitment) {
    throw new Error('MESH_MASTER does not derive the trust root pinned in deployments/arc-testnet.json');
  }
}
// The links a wallet needs: from the pinned root to the directory in force.
const directoryChain = MESH_MASTER === undefined ? mesh.chain : mesh.chain.filter((l) => l.directory.version > pinned.minVersion);
// At boot, not at the first payment: an expired directory stops here, and so
// does a chain the wallet could not walk.
const inForce = chainTo(directoryChain, MESH_MASTER === undefined ? mesh.root : (pinned as DirectoryTrustRoot));
verify(inForce.signed, inForce.root, nowS());

// ── the Graph (§8), asked here at the exit and nowhere else ──────────────
// The subgraph indexes RelayDirectory and the pool. Keys and ring membership
// still come from the signed directory and the chain; the Graph weighs them.
// Relays report every 10 minutes (each report is a transaction), so a health
// observation is fresh for 15: one missed report plus indexing lag.
//
// A network with no subgraph (Sepolia: services.graphUrl null) weighs every
// relay the same and reads its rings from the chain alone, as the XRPL and
// devnet stacks do.
const HEALTH_MAX_AGE = 900n;
const GRAPH_URL = deployment.services.graphUrl;
const graph = GRAPH_URL === null ? undefined : new GraphHttpClient({ endpoint: GRAPH_URL, pinnedRelays: mesh.signed.directory.entries, maxObservationAgeSeconds: HEALTH_MAX_AGE });
// Clamped, so a hostile index can steer load but never exclude a relay.
const relayHealth = graph === undefined ? undefined : createGraphHealth({ fetchSnapshot: () => graph.getRelaySnapshot(), maxAgeSeconds: HEALTH_MAX_AGE });
if (relayHealth !== undefined) {
  void relayHealth.refresh();
  setInterval(() => void relayHealth.refresh(), 90_000).unref();
}
const EVEN_HEALTH = { reliabilityScore: 9_000 as never, batchOccupancy: 1, recentSelectionCount: 0 };
const relaySnapshot = (): RelaySnapshot => ({
  nodes: mesh.signed.directory.entries.map((e) => ({
    id: e.id, endpoint: e.endpoint, kemPublicKey: e.kemPublicKey, keyEpoch: e.keyEpoch, operatorId: e.operatorId,
    ...(relayHealth?.health(e) ?? EVEN_HEALTH), lastSeenAt: nowS(),
  })),
  directoryVersion: mesh.signed.directory.version.toString(),
  observedAt: nowS(),
});
// Studio's query endpoint is rate-limited, and the stand-in asks for a score
// every 3 s per waiting intent: one index read per pool per 30 s.
const indexed = new Map<string, { at: number; ring: Promise<RingSnapshot> }>();
const ringSources = new Map(ringPools.map((p) => [p.address, createChainRingSource({
  publicClient: publicClient as never, scope: scopeOf(p), deployedAtBlock: BigInt(p.deployedAtBlock), relaySnapshot,
  ...(graph === undefined ? {} : { indexed: (s: PoolScope) => {
    const hit = indexed.get(p.address);
    if (hit !== undefined && Date.now() - hit.at < 30_000) return hit.ring;
    const ring = graph.getRingSnapshot(s);
    indexed.set(p.address, { at: Date.now(), ring });
    return ring;
  } }),
})]));
// Each question goes to the source for its pool; each source refuses any other.
const ringSource: GraphSelectionClient = {
  getRingSnapshot: async (s) => ringSources.get(poolAt(s).address)!.getRingSnapshot(s),
  getRelaySnapshot: async () => relaySnapshot(),
  getPrivacyConditions: async (s) => ringSources.get(poolAt(s).address)!.getPrivacyConditions(s),
};

// ── egress, exit, stand-in ───────────────────────────────────────────────
// One account for everything the egress key pays for: settlements, the
// attester's rotations, wallets' rotations. One nonce manager, and one write
// at a time (chain/pool.ts writeInTurn).
const egressAccount = privateKeyToAccount(env('EGRESS_PRIVATE_KEY') as `0x${string}`, { nonceManager });
const egress = createEgress({
  secret: credentialMac,
  submitter: poolSubmitter(createPoolClient({
    account: egressAccount,
    offChain: { pqWallet: 'LIVE', graph: 'LIVE', confidentialExecution: 'SIMULATED', policyScope: 'CRE_WORKFLOW_ONLY' },
  })),
});
await egress.listen(PORTS.egress, LOOPBACK);

// WALLET_RPC (§7.5): the wallet's account and note reads, and its account's
// UserOperations, so the RPC and the bundler see this box and not the wallet.
let settler: Settler | undefined;
// Passkey backups: one store for every chain (mesh/backup-store.ts). The service
// with the backup volume keeps it; the others ask it; a laptop keeps its own.
const backup = backupFromEnv(join(STATE, 'backups'), PUBLIC_URL !== undefined);
const exit = createExecutorServer({
  backup: backup.send,
  // Asked across the mesh, so the authority never sees who asked; the HTTP route stays for old clients.
  credential: async (recipient) => toHex(new TextEncoder().encode(credentialJson(recipient, POLICY, credentialMac, nowS()))),
  graph: ringSource,
  ...(CRE_MODE === 'workflow' ? { cre: { accept: (decisions) => settler!.accept(decisions) }, requireCreEnvelope: true } : {}),
  walletRpc: createWalletRpcAnswerer({
    publicClient: publicClient as never, bundlerUrl: ARC_AUTHORITY.bundlerUrl,
    entryPoint: ARC_AUTHORITY.entryPoint, accountImplementation: ARC_AUTHORITY.accountImplementation, factory: ARC_AUTHORITY.factory,
    // Pays for ROTATE, as it already pays for settlement and the attester's own
    // rotations. An account cannot pay for its own: see chain/wallet-rpc.ts.
    payer: egressAccount,
    ...(process.env['LIFI_API_KEY'] ? { lifiApiKey: process.env['LIFI_API_KEY'] } : {}),
  }),
});
await exit.listen(PORTS.exit, LOOPBACK);

// Settling a decision, whoever made it: attest, release, deliver, reconcile.
// Every signature the attester's few-time key makes is counted in this file
// before it is made (cre/attester-keys.ts). On a hosted service it must be on
// the volume, or a redeploy forgets the signatures that never landed: see
// docs/hosting.md.
const ATTESTER_LOG = process.env['ATTESTER_LOG'] || join(STATE, 'attester-uses.json');
const attesterKeys = registryAttesterKeys({
  publicClient: publicClient as never,
  payer: egressAccount,
  registry: REGISTRY as never,
  attester: ATTESTER as never,
  master: fromHex(env('ATTESTER_FORS_MASTER') as `0x${string}`),
  chainId: BigInt(deployment.network.chainId),
  log: ATTESTER_LOG,
});
const settlement: SettlerOptions = {
  executor: exit.executor,
  credentialMac,
  policyVersion: POLICY,
  releaseTtlSeconds: 900n,
  attester: {
    identity: (scope) => ({ chainId: BigInt(deployment.network.chainId), registry: REGISTRY as never, attester: ATTESTER as never, pool: poolAt(scope).address as never, denomination: poolAt(scope).denomination }),
    // current() rotates itself near the end of each key's budget; observe() only reads.
    current: attesterKeys.current,
    observe: attesterKeys.observe,
  },
  // Nothing is signed for a spend the pool would refuse.
  spendable: (spend) => assertSpendable(publicClient as never, spend),
  deliver: egressClient(`http://127.0.0.1:${PORTS.egress}/v1/release`),
  // A receipt, or a wait that throws: see evidence below.
  receiptEvidence: true,
  // Evidence from the chain: the receipt succeeded and the spend's own pool
  // emitted a Spent for exactly this nullifier and recipient.
  async evidence(txHash, release) {
    // Arc's blocks are a second apart: a minute without a receipt is a
    // transaction that is late or gone, and the settler's retry looks again
    // without holding up the next one. viem's nonce manager would go on
    // counting past a dropped nonce, and every later transaction would queue
    // behind it: start again from what the chain has.
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}`, timeout: 60_000 }).catch(async (error: unknown) => {
      if (error instanceof WaitForTransactionReceiptTimeoutError) {
        await writeInTurn(egressAccount.address, async () => nonceManager.reset({ address: egressAccount.address, chainId: ARC.id }));
      }
      throw error;
    });
    const spent = parseEventLogs({ abi: poolAbi, logs: receipt.logs, eventName: 'Spent' }).find(
      (l) => l.address.toLowerCase() === release.spend.scope.pool.toLowerCase()
        && l.args.nullifier.toLowerCase() === (release.spend.nullifier as string).toLowerCase()
        && l.args.recipient.toLowerCase() === (release.spend.recipient as string).toLowerCase(),
    );
    log(`  settled ${txHash} (${receipt.status})`);
    return { txHash, spendHash: spendHash(release.spend), succeeded: receipt.status === 'success' && spent !== undefined };
  },
  nullifierSpent: async (s) => publicClient.readContract({ address: s.scope.pool, abi: poolAbi, functionName: 'isNullifierSpent', args: [s.nullifier as `0x${string}`] }),
  onError: (id, error) => log(`  ! intent ${String(id).slice(0, 8)}… will retry: ${(error as Error).message}`),
};
const simulator = CRE_MODE === 'workflow' ? undefined : createCreSimulator({
  ...settlement,
  intentSecretKey: intentKeys.secretKey!,
  encryptionKeyId: KEY_ID,
  async readFreshScore(scope) {
    const c = evaluatePublicReadiness(await ringSource.getRingSnapshot(scope), relaySnapshot());
    return { score: c.privacyScore, observedAt: c.observedAt };
  },
});
simulator?.start(3_000);
if (CRE_MODE === 'workflow') {
  settler = createSettler(settlement);
  // CRE decides once; a delivery that failed after authorisation is retried here.
  setInterval(() => void settler!.retry(), 10_000).unref();
}

const relays = !('secretKeys' in mesh) ? [] : await serveLocalMesh(mesh, new Map<MeshMessageKind, string>([
  ['PAYMENT', `http://127.0.0.1:${PORTS.exit}/v1/mesh/payment`],
  ['QUERY', `http://127.0.0.1:${PORTS.exit}/v1/mesh/query`],
]), LOOPBACK);

// ── §8.2: this box's relays, announced and reported on chain ─────────────
// Public deployments only: a loopback endpoint on a public chain would
// overwrite the hosted relays' entries with addresses nobody can reach.
const RELAY_OPERATOR_KEY = process.env['RELAY_OPERATOR_KEY'];
if (PUBLIC_URL !== undefined && RELAY_OPERATOR_KEY !== undefined && relays.length > 0) {
  const reporter = relayDirectoryReporter({
    publicClient: publicClient as never,
    operator: privateKeyToAccount(RELAY_OPERATOR_KEY as `0x${string}`, { nonceManager }),
    directory: requireContract('relayDirectory') as never,
    entries: mesh.signed.directory.entries,
    relays,
  });
  // In the background: the wallet can use the mesh before the Graph sees it.
  // Announce once, then report every 10 minutes (~0.0018 USDC a report, about
  // 0.26 a day). A failure — Arc's RPC rate-limits a boot's burst of reads —
  // retries in 30 s: health unreported for 15 minutes goes stale, and stale
  // health scores under the bar a payment waits for.
  let announced = false;
  const run = (): void => void (async () => {
    if (!announced) {
      const sent = await reporter.announce();
      announced = true;
      log(`  relays ${sent === 0 ? 'already announced' : `announced (${sent})`} in RelayDirectory; reporting health every 10 min`);
    }
    await reporter.report();
  })().then(
    () => { setTimeout(run, 600_000).unref(); },
    (e: { shortMessage?: string; message: string }) => {
      log(`  ! relay ${announced ? 'report' : 'announce'} failed, retrying in 30 s: ${e.shortMessage ?? e.message}`);
      setTimeout(run, 30_000).unref();
    },
  );
  run();
}

// ── test credential authority ────────────────────────────────────────────
// Issues for ANY recipient: a stand-in for a real policy authority, which the
// wallet asks once, out of band, before paying — never during a payment.
const credentialHandler: RequestListener = (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const chunks: Buffer[] = [];
  let size = 0;
  // Public once PUBLIC_URL is set: a body is one address, so anything big is abuse.
  req.on('data', (c: Buffer) => { size += c.length; if (size > 1024) req.destroy(); else chunks.push(c); });
  req.on('end', () => {
    try {
      const { recipient } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { recipient?: string };
      const credential = credentialJson(String(recipient), POLICY, credentialMac, nowS());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(credential);
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: (e as Error).message }));
    }
  });
};
const credentials = createServer(credentialHandler);

// ── a name a FORS+C key holds (Sepolia: deployments ens) ─────────────────
// opaque.eth's PQNameController answers to a key this stack draws from
// ENS_MASTER until a wallet claims it with the one-time ENS_CLAIM_CODE: two
// rotations in PQKeyRegistry hand it to the wallet's key. After that the stack
// only submits calls the wallet's key signed, paying their gas; the controller
// checks every signature itself, so submitting grants nothing.
const ENS = (deployment as unknown as { ens?: { pqKeyRegistry: `0x${string}`; controller: `0x${string}` } }).ens;
const ENS_MASTER = process.env['ENS_MASTER'];
const ENS_CLAIM_CODE = process.env['ENS_CLAIM_CODE'];
const NAMES = ENS !== undefined && ENS_MASTER !== undefined && ENS_CLAIM_CODE !== undefined && ENS_CLAIM_CODE.length >= 8;
const nameWallet = () => createWalletClient({ account: egressAccount, chain: ARC, transport: rpcTransport() });
async function claimName(pk: `0x${string}`, next: `0x${string}`): Promise<`0x${string}`[]> {
  const master = fromHex(ENS_MASTER as `0x${string}`);
  const keyAt = (g: number) => masterKey(master, 'opaque/v1/ens/controller', g);
  const hashes: `0x${string}`[] = [];
  for (let step = 0; step < 3; step++) {
    const s = await publicClient.readContract({ address: ENS!.pqKeyRegistry, abi: NAME_REGISTRY_ABI, functionName: 'stateOf', args: [ENS!.controller] });
    if (s.pkCommitment.toLowerCase() === pk.toLowerCase()) return hashes;
    const g = [0, 1, 2, 3, 4, 5, 6, 7].find((i) => commitmentOf(keyAt(i)) === s.pkCommitment.toLowerCase());
    if (g === undefined) throw new Error('the name answers to a key this stack does not hold: it was claimed already');
    // The key in force commits the wallet's key next; once that is committed, the wallet's own next key.
    const after = s.nextCommitment.toLowerCase() === pk.toLowerCase() ? next : pk;
    const deadline = (await publicClient.getBlock()).timestamp + 30n * 86_400n;
    const signature = signRotation(keyAt(g), BigInt(deployment.network.chainId), ENS!.controller, s.useCount, after, 32n, deadline);
    const hash = await writeInTurn(egressAccount.address, () => nameWallet().writeContract({ address: ENS!.pqKeyRegistry, abi: NAME_REGISTRY_ABI, functionName: 'rotate', args: [ENS!.controller, after, 32n, deadline, signature] }));
    if ((await publicClient.waitForTransactionReceipt({ hash })).status !== 'success') throw new Error(`the rotation reverted: ${hash}`);
    hashes.push(hash);
  }
  throw new Error('the handover did not finish');
}
const namesHandler = (url: string, req: Parameters<RequestListener>[0], res: Parameters<RequestListener>[1]): void => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const chunks: Buffer[] = [];
  let size = 0;
  // A FORS+C signature is about 9 KB, 18 KB as hex.
  req.on('data', (c: Buffer) => { size += c.length; if (size > 64_000) req.destroy(); else chunks.push(c); });
  req.on('end', () => void (async () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, string>;
    const hex32 = (v: unknown): v is `0x${string}` => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v);
    if (url === '/v1/ens/claim') {
      const code = Buffer.from(String(body['code'] ?? ''));
      const want = Buffer.from(ENS_CLAIM_CODE!);
      if (code.length !== want.length || !timingSafeEqual(code, want)) return reply(403, { message: 'that is not the claim code' });
      if (!hex32(body['pk']) || !hex32(body['next'])) return reply(400, { message: 'two key commitments, please' });
      return reply(200, { hashes: await claimName(body['pk'], body['next']) });
    }
    const { target, data, signature } = body;
    const deadline = BigInt(body['deadline'] ?? 0);
    if (!/^0x[0-9a-f]{40}$/i.test(String(target)) || !/^0x([0-9a-f]{2})*$/i.test(String(data)) || !/^0x([0-9a-f]{2})+$/i.test(String(signature))) return reply(400, { message: 'target, data, deadline and signature, please' });
    // Simulated first: a call the controller would refuse costs nothing.
    const { request } = await publicClient.simulateContract({ account: egressAccount, address: ENS!.controller, abi: CONTROLLER_ABI, functionName: 'execute', args: [target as `0x${string}`, data as `0x${string}`, deadline, signature as `0x${string}`] });
    const hash = await writeInTurn(egressAccount.address, () => nameWallet().writeContract(request));
    reply(200, { hash, ok: (await publicClient.waitForTransactionReceipt({ hash })).status === 'success' });
  })().catch((e: Error & { shortMessage?: string }) => reply(400, { message: (e.shortMessage ?? e.message).split('\n')[0] })));
};

// ── a test faucet (FAUCET=1, testnet stacks only) ────────────────────────
// Gas and test dollars for a new wallet, from the egress, which already pays
// for settlements: so a wallet on Sepolia needs no faucet of anyone else's.
// Once an hour per address, and at most 60 an hour in all.
const FAUCET = process.env['FAUCET'] === '1';
const FAUCET_ETH = parseEther(process.env['FAUCET_ETH'] ?? '0.003');
const FAUCET_USDC = 100n * 10n ** BigInt(deployment.tokens.usdc.decimals);
const dripped = new Map<string, number>();
let dripsThisHour: { hour: number; n: number } = { hour: 0, n: 0 };
const faucetHandler: RequestListener = (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => { size += c.length; if (size > 256) req.destroy(); else chunks.push(c); });
  req.on('end', () => void (async () => {
    const address = String((JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { address?: string }).address ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) return reply(400, { message: 'an address, please' });
    const hour = Math.floor(Date.now() / 3_600_000);
    if (dripsThisHour.hour !== hour) dripsThisHour = { hour, n: 0 };
    if (Date.now() - (dripped.get(address) ?? 0) < 3_600_000) return reply(429, { message: 'once an hour per address' });
    if (dripsThisHour.n >= 60) return reply(429, { message: 'the faucet is resting: try again within the hour' });
    dripped.set(address, Date.now());
    dripsThisHour.n++;
    const w = createWalletClient({ account: egressAccount, chain: ARC, transport: rpcTransport() });
    const [eth, usdc] = await writeInTurn(egressAccount.address, async () => [
      await w.sendTransaction({ to: address as `0x${string}`, value: FAUCET_ETH }),
      await w.writeContract({ address: deployment.tokens.usdc.address, abi: parseAbi(['function transfer(address to, uint256 value) returns (bool)']), functionName: 'transfer', args: [address as `0x${string}`, FAUCET_USDC] }),
    ] as const);
    reply(200, { eth, usdc });
  })().catch((e: Error) => reply(500, { message: e.message.split('\n')[0] })));
};
await new Promise<void>((r) => credentials.listen(PORTS.credentials, LOOPBACK, r));

// ── what the wallet reads ────────────────────────────────────────────────
const walletConfig = JSON.stringify({
  $comment: 'Written by backend/stack.ts, every start.',
  // A deployed wallet walks directoryChain from the root it compiled in and
  // ignores trustRoot; only a dev server's wallet takes trustRoot from here.
  directoryChain,
  signedDirectory: mesh.signed,
  trustRoot: mesh.root,
  cre: { publicKey: intentKeys.publicKey, encryptionKeyId: KEY_ID, policyVersion: POLICY },
  credentialUrl: `${PUBLIC_URL ?? `http://${LOOPBACK}:${PORTS.credentials}`}/v1/credential`,
  // Wallets built before several pools read this one. Newer ones take every
  // pool from the deployments compiled into them, never from this file.
  pool: { address: ring8.address, denomination: ring8.denomination, proofMode: ring8.proofMode },
  // ATTESTED only when the deployed workflow runs in an enclave (CRE_TEE=1);
  // a CRE workflow on the DON, or the local stand-in, is SIMULATED.
  capabilities: { pqWallet: 'LIVE', graph: 'LIVE', confidentialExecution: CRE_MODE === 'workflow' && process.env['CRE_TEE'] === '1' ? 'ATTESTED' : 'SIMULATED', policyScope: 'CRE_WORKFLOW_ONLY' },
}, bigintReplacer, 2);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, walletConfig);

// ── one public port ──────────────────────────────────────────────────────
// Only what Caddy would route (deploy/Caddyfile): /rN/* to relay N, the exit,
// the credential authority, the wallet config. The egress is not reachable.
// Relays keep their loopback listeners too: listen() is what runs the batch
// clock, and a handler without it would queue forever.
const router = PORT === undefined ? undefined : createServer((req, res) => {
  const url = req.url ?? '/';
  const hop = /^\/r(\d+)(\/.*)$/.exec(url);
  const relay = hop && relays.find((r) => r.relayId === `R${hop[1]}`);
  if (hop && relay) { req.url = hop[2]; relay.handler(req, res); return; }
  if (url.startsWith('/v1/mesh/') || url.startsWith('/v1/cre/')) { exit.handler(req, res); return; }
  if (url === '/v1/credential') { credentialHandler(req, res); return; }
  if (FAUCET && url === '/v1/faucet') { faucetHandler(req, res); return; }
  if (NAMES && (url === '/v1/ens/claim' || url === '/v1/ens/execute')) { namesHandler(url, req, res); return; }
  if (url === '/v1/backup' && backup.kept) { backupHttpHandler(backup.send)(req, res); return; }
  if (url === '/stack.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(walletConfig);
    return;
  }
  res.writeHead(404); res.end();
});
if (router) await new Promise<void>((r) => router.listen(Number(PORT), '0.0.0.0', r));

// Seed every pool from the windows the subgraph names, then read the full
// histories one pool at a time: seven at once is the burst Arc refuses, and
// starves the wallets' own reads on the same RPC.
for (const [pool, s] of graph === undefined ? [] : ringSources) {
  await s.seed().catch((e: unknown) => log(`  ring seed  ${pool} refused (${String((e as Error).message).split('\n')[0]}); backfill will read it`));
}
void (async () => { for (const s of ringSources.values()) await s.backfill(); })();

log('opaque local stack — against the REAL Arc pools');
for (const p of ringPools) {
  // A banner, not a gate: Arc rate-limits a boot's burst of reads, and a
  // refused scan here crash-looped the service.
  const deposits = await ringSource.getRingSnapshot(scopeOf(p)).then((s) => `${s.candidates.length} deposits`, () => 'deposits unread: RPC busy');
  log(`  pool       ${p.address}  (${p.proofMode}, ${p.denomination / 1e6} USDC, ${deposits})`);
}
log(`  relays     ${mesh.signed.directory.entries.map((e) => e.endpoint.replace('/v1/relay', '')).join('  ')}`);
log(`  exit       http://127.0.0.1:${PORTS.exit}   egress :${PORTS.egress}   credentials :${PORTS.credentials}`);
log(`  wallet cfg ${OUT}${router ? `  and ${PUBLIC_URL ?? ''}/stack.json (all routes on :${PORT})` : ''}`);
log(`  cre        ${CRE_MODE === 'workflow' ? 'the Chainlink CRE workflow decides (GET /v1/cre/pending, POST /v1/cre/release); no CRE secret on this box' : 'SIMULATED by a stand-in in this process'}`);
log('  THIS IS ONE OPERATOR: six relays here are not an anonymity set.');

// A derived mesh turns over weekly. The platform restarts a service that
// exits non-zero, and the next boot derives the next generation, so the
// directory in force never lapses while this runs.
if ('generationEndsAt' in mesh && mesh.generationEndsAt !== undefined) {
  const ms = Number(mesh.generationEndsAt - nowS()) * 1000;
  setTimeout(() => { log('  directory generation over: exiting so the next boot serves the next one'); process.exit(75); }, Math.max(ms, 0)).unref();
  log(`  directory  generation ends ${new Date(Number(mesh.generationEndsAt) * 1000).toISOString()} (${directoryChain.length} link${directoryChain.length === 1 ? '' : 's'} from the pinned root)`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    simulator?.stop();
    void Promise.all([...relays.map((r) => r.close()), exit.close(), egress.close(), new Promise((r) => credentials.close(r)), new Promise((r) => (router ? router.close(r) : r(undefined)))])
      .then(() => process.exit(0));
  });
}
