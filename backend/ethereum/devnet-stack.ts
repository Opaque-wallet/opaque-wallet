#!/usr/bin/env node
// The backend the wallet's devnet page needs for private payments: Opaque's
// privacy layer on the EIP-8141 devnet (deployments/eth-devnet.json `privacy`,
// put there by `node ethereum/frame-tx.ts privacy`).
//
//   cd backend && node --use-system-ca ethereum/devnet-stack.ts     then the page at /testnet/devnet
//
// Six relays, the mesh exit (executor and ring answers, the CRE stand-in), the
// attester and the settler, and a test credential authority. Writes the page's
// public config to frontend/public/devnet-stack.json.
//
// Every signature here is FORS. The stack's own account is a FramePQAccount:
// its frame keys pay for every spend, each key's last signature handing the
// account to the next; and it is the attester, by its registry key, which
// signs each spend's attestation once the ZKBoo proof checks out.
//
//   PORT, PUBLIC_URL               one public port, as backend/stack.ts does
//   DEVNET_MESH_MASTER             with PUBLIC_URL: the weekly relay directories
//                                  the root in deployments/eth-devnet.json pins
//   DEVNET_STACK_MASTER            the stack account's frame keys     } a laptop reads
//   ATTESTER_FORS_MASTER           its registry (attester) key        } .stack/eth-devnet/
//   ATTESTER_LOG                   where the attester's signatures are counted:
//                                  on a volume when hosted (cre/attester-keys.ts)
//
// ── What this is NOT ─────────────────────────────────────────────────────
//
// One operator, as the XRPL stack: six relays here collude by construction, and
// the CRE stand-in holds the intent key in an ordinary process. The
// capabilities the page reads say so (SIMULATED).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPublicClient, defineChain, encodeFunctionData, http, parseAbi, parseEventLogs, toFunctionSelector, toHex as hexOf, type Address, type Hex } from 'viem';

import { ProtocolFailure, type PoolScope, type RelaySnapshot, type TxHash, type UnixSeconds } from '@opaque/protocol-types';
import { asBytes32, asChainId, fromHex, spendHash, toHex } from '@opaque/protocol-types/codecs.js';

import { evaluatePublicReadiness } from '../../graph/src/privacy-score.ts';
import { assertSpendable } from '../chain/pool.ts';
import { createChainRingSource } from '../chain/ring-source.ts';
import { createWalletRpcAnswerer } from '../chain/wallet-rpc.ts';
import { createAttesterKeys } from '../cre/attester-keys.ts';
import { credentialJson } from '../cre/credential.ts';
import { createExecutorServer } from '../cre/executor-server.ts';
import { generateIntentKeypair } from '../cre/seal-client.ts';
import type { SettlerOptions } from '../cre/settler.ts';
import { createCreSimulator } from '../cre/simulator.ts';
import type { DirectoryTrustRoot } from '../mesh/contracts.ts';
import { chainTo, verify } from '../mesh/directory.ts';
import { buildLocalMesh, meshRootAt, serveLocalMesh } from '../mesh/local-mesh.ts';
import type { MeshMessageKind } from '../mesh/transport.ts';
import { accountOf, devnet, keyFor, keyOf, MAX_USES, mined, nonceOf, seededKey, sendCalls, type Call, type ForsKey } from './frame.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, '..', '.stack', 'eth-devnet');
const OUT = join(HERE, '..', '..', 'frontend', 'public', 'devnet-stack.json');
const PORTS = { relays: 18_501, exit: 18_600, credentials: 18_602 } as const;
const LOOPBACK = '127.0.0.1';
const KEY_ID = 'opaque-intent-key-v1';
const POLICY = 'opaque-policy-v1';
const RAILWAY = process.env['RAILWAY_PUBLIC_DOMAIN'];
const PUBLIC_URL = (process.env['PUBLIC_URL'] ?? (RAILWAY && `https://${RAILWAY}`))?.replace(/\/+$/, '');
const PORT = process.env['PORT'];
const log = (s: string) => process.stdout.write(`${s}\n`);
const nowS = (): UnixSeconds => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds;
const bigintReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v);

interface DevnetPool { readonly denomination: number; readonly address: Address; readonly verifier: Address; readonly deployedAtBlock: number }
const privacy = (devnet as unknown as { privacy?: { pqKeyRegistry: { address: Address }; token: { address: Address }; attester: Address; pools: DevnetPool[] } }).privacy;
if (privacy?.attester === undefined) throw new Error('no privacy layer on the devnet yet: node ethereum/frame-tx.ts privacy');
const mesh0 = (devnet as unknown as { mesh?: { genesis: number; trustRoot: { signerCommitment: Hex; minVersion: number } } }).mesh;

// ── the stack's account: its frame keys pay, its registry key attests ────
const master = (env: string, file: string): Hex => (process.env[env] ?? readFileSync(join(STATE, file), 'utf8')).trim() as Hex;
const stackMaster = master('DEVNET_STACK_MASTER', 'stack.master');
const keyAt = (i: number): ForsKey => seededKey(stackMaster, 'stack/fors', i);
const account = privacy.attester;
if ((await accountOf(keyOf(keyAt(0)))).toLowerCase() !== account.toLowerCase()) throw new Error('DEVNET_STACK_MASTER does not draw the attester account in deployments/eth-devnet.json');

let known: { key: ForsKey; i: number }[] = [];
let queue: Promise<unknown> = Promise.resolve();
/**
 * One transaction at a time from the stack's account, each waiting for the one
 * before (the nonce). A key's last signature also hands the account to the
 * next key, so the stack never strands itself.
 */
function asStack(calls: readonly Call[]): Promise<Hex> {
  const run = queue.then(async () => {
    const at = await keyFor(account, keyAt, known);
    const last = MAX_USES - ((await nonceOf(account)) - at.first) === 1n;
    const next = last ? { key: keyAt(at.i + 1), i: at.i + 1 } : undefined;
    known = next === undefined ? [at] : [at, next];
    const hash = await sendCalls(account, at.key, calls, false, next === undefined ? undefined : keyOf(next.key));
    await mined(hash);
    return hash;
  });
  queue = run.catch(() => undefined);
  return run;
}

const chain = defineChain({ id: devnet.chainId, name: 'EIP-8141 devnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [devnet.gateway] } } });
const publicClient = createPublicClient({ chain, transport: http(devnet.gateway, { retryCount: 3 }) });
const REGISTRY_ABI = parseAbi([
  'function stateOf(address) view returns ((bytes32,bytes32,uint64,uint64,uint64,uint64))',
  'function rotate(address,bytes32,uint64,uint64,bytes)',
  'function takeover(address,bytes32,uint64,bytes)',
]);
const POOL_ABI = parseAbi([
  'function spend(bytes32[] ring, bytes proof, address recipient, bytes32 salt)',
  'function isNullifierSpent(bytes32 nullifier) view returns (bool)',
  'event Spent(bytes32 indexed nullifier, address indexed recipient, uint256 amount)',
]);
const registry = privacy.pqKeyRegistry.address;
const registryCall = (functionName: 'rotate' | 'takeover', args: readonly unknown[]): Call =>
  ({ to: registry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName, args } as never), gas: 1_000_000n, state: 200_000n });

// Every signature the attester's few-time key makes is counted in this file before it is made.
mkdirSync(STATE, { recursive: true, mode: 0o700 });
const attesterKeys = createAttesterKeys({
  master: fromHex(master('ATTESTER_FORS_MASTER', 'attester.master')),
  attester: account as never,
  chainId: BigInt(devnet.chainId),
  log: process.env['ATTESTER_LOG'] || join(STATE, 'attester-uses.json'),
  async readState() {
    const s = await publicClient.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'stateOf', args: [account] });
    return { pkCommitment: asBytes32(s[0].toLowerCase()), useCount: s[2], maxUses: s[3] };
  },
  rotate: async (next, maxUses, deadline, signature) => void await asStack([registryCall('rotate', [account, next, maxUses, deadline, signature])]),
  takeover: async (next, maxUses, signature) => void await asStack([registryCall('takeover', [account, next, maxUses, signature])]),
});

// ── the stand-in's intent key and credential MAC, kept across restarts ──
const keyFile = join(STATE, 'intent-key.json');
const macFile = join(STATE, 'credential.mac');
if (!existsSync(keyFile)) {
  const k = generateIntentKeypair();
  writeFileSync(keyFile, JSON.stringify({ publicKey: k.publicKey, secretKey: k.secretKey }), { mode: 0o600 });
}
if (!existsSync(macFile)) writeFileSync(macFile, toHex(crypto.getRandomValues(new Uint8Array(32))), { mode: 0o600 });
const intentKeys = JSON.parse(readFileSync(keyFile, 'utf8')) as { publicKey: Hex; secretKey: Hex };
const credentialMac = fromHex(readFileSync(macFile, 'utf8').trim() as Hex);

// ── the mesh ─────────────────────────────────────────────────────────────
const MESH_MASTER = PUBLIC_URL === undefined ? undefined : process.env['DEVNET_MESH_MASTER'];
const mesh = buildLocalMesh({
  basePort: PORTS.relays,
  endpointFor: (_id, i, port) => (PUBLIC_URL === undefined ? `http://${LOOPBACK}:${port}/v1/relay` : `${PUBLIC_URL}/r${i + 1}/v1/relay`),
  ...(MESH_MASTER === undefined ? {} : { master: fromHex(MESH_MASTER as Hex), genesis: BigInt(mesh0?.genesis ?? 0) }),
});
const pinned = MESH_MASTER === undefined ? undefined : { signerCommitment: mesh0!.trustRoot.signerCommitment, minVersion: BigInt(mesh0!.trustRoot.minVersion) };
if (pinned !== undefined && meshRootAt(fromHex(MESH_MASTER as Hex), pinned.minVersion).signerCommitment !== pinned.signerCommitment) {
  throw new Error('DEVNET_MESH_MASTER does not derive the trust root pinned in deployments/eth-devnet.json');
}
const directoryChain = pinned === undefined ? mesh.chain : mesh.chain.filter((l) => l.directory.version > pinned.minVersion);
const inForce = chainTo(directoryChain, (pinned ?? mesh.root) as DirectoryTrustRoot);
verify(inForce.signed, inForce.root, nowS());
const relaySnapshot = (): RelaySnapshot => ({
  nodes: mesh.signed.directory.entries.map((e) => ({
    id: e.id, endpoint: e.endpoint, kemPublicKey: e.kemPublicKey, keyEpoch: e.keyEpoch, operatorId: e.operatorId,
    // ponytail: no health reports for these relays; every one weighs the same.
    reliabilityScore: 9_000 as never, batchOccupancy: 1, recentSelectionCount: 0, lastSeenAt: nowS(),
  })),
  directoryVersion: mesh.signed.directory.version.toString(),
  observedAt: nowS(),
});

// ── the ring: each pool's own Deposited events ───────────────────────────
const scopeOf = (p: DevnetPool): PoolScope => ({ chainId: asChainId(BigInt(devnet.chainId)), pool: p.address, denomination: p.denomination }) as never;
const poolAt = (s: PoolScope): DevnetPool => {
  const pool = privacy.pools.find((p) => p.address === s.pool.toLowerCase());
  if (pool === undefined) throw new ProtocolFailure('INVALID_INPUT', `no devnet pool at ${s.pool}`);
  return pool;
};
const rings = new Map(privacy.pools.map((p) => [p.address, createChainRingSource({ publicClient: publicClient as never, scope: scopeOf(p), deployedAtBlock: BigInt(p.deployedAtBlock), relaySnapshot })]));
for (const r of rings.values()) await r.backfill();
const graph = {
  getRingSnapshot: async (s: PoolScope) => rings.get(poolAt(s).address)!.getRingSnapshot(s),
  getRelaySnapshot: async () => relaySnapshot(),
  getPrivacyConditions: async (s: PoolScope) => rings.get(poolAt(s).address)!.getPrivacyConditions(s),
};

// ── exit, attester, settler ──────────────────────────────────────────────
const selectors = (...signatures: string[]) => new Set(signatures.map((s) => toFunctionSelector(s)));
const exit = createExecutorServer({
  credential: async (recipient) => toHex(new TextEncoder().encode(credentialJson(recipient, POLICY, credentialMac, nowS()))),
  graph,
  // The page's note reads (is it spent? is it in?), asked here so the devnet's RPC never learns which notes one wallet holds.
  walletRpc: createWalletRpcAnswerer({
    publicClient: publicClient as never,
    // Reads only: the devnet has no bundler, and a FramePQAccount sends its own transactions.
    bundlerUrl: 'http://127.0.0.1:9', entryPoint: account as never, accountImplementation: account as never,
    allowlist: new Map([
      ...privacy.pools.map((p) => [p.address, selectors('isNullifierSpent(bytes32)', 'isCommitmentKnown(bytes32)', 'capabilities()')] as const),
      [privacy.token.address, selectors('balanceOf(address)')],
    ]),
  }),
});
await exit.listen(PORTS.exit, LOOPBACK);

// A release delivered before is answered with its transaction, never sent twice.
const sent = new Map<string, Hex>();
const settlement: SettlerOptions = {
  executor: exit.executor,
  credentialMac,
  policyVersion: POLICY,
  releaseTtlSeconds: 900n,
  attester: {
    identity: (scope) => ({ chainId: BigInt(devnet.chainId), registry: registry as never, attester: account as never, pool: poolAt(scope).address as never, denomination: poolAt(scope).denomination }),
    current: attesterKeys.current,
    observe: attesterKeys.observe,
  },
  // Nothing is signed for a spend the pool would refuse.
  spendable: (spend) => assertSpendable(publicClient as never, spend),
  async deliver(release) {
    const id = spendHash(release.spend);
    const before = sent.get(id);
    if (before !== undefined) return before as TxHash;
    const s = release.spend;
    if (s.mode !== 'RING_8') throw new ProtocolFailure('INVALID_INPUT', 'the devnet pools are RING_8 only');
    const salt = hexOf(crypto.getRandomValues(new Uint8Array(32)));
    // The pool checks the attestation with the registry's full FORS verifier: a SENDER frame, so no 100k VERIFY cap.
    const data = encodeFunctionData({ abi: POOL_ABI, functionName: 'spend', args: [s.ring as readonly Hex[], s.proof as Hex, s.recipient as Address, salt] });
    const hash = await asStack([{ to: s.scope.pool as Address, data, gas: 2_000_000n, state: 300_000n }]);
    sent.set(id, hash);
    log(`  settled ${hash}`);
    return hash as TxHash;
  },
  receiptEvidence: true,
  async evidence(txHash, release) {
    const r = await mined(txHash as Hex);
    const ok = r.status === '0x1' && (r.frameReceipts ?? []).every((f) => f.status === '0x1');
    const spent = parseEventLogs({ abi: POOL_ABI, logs: r.logs as never, eventName: 'Spent' }).find(
      (l) => l.address.toLowerCase() === release.spend.scope.pool.toLowerCase()
        && l.args.nullifier.toLowerCase() === String(release.spend.nullifier).toLowerCase()
        && l.args.recipient.toLowerCase() === String(release.spend.recipient).toLowerCase(),
    );
    return { txHash, spendHash: spendHash(release.spend), succeeded: ok && spent !== undefined };
  },
  nullifierSpent: async (s) => publicClient.readContract({ address: s.scope.pool as Address, abi: POOL_ABI, functionName: 'isNullifierSpent', args: [s.nullifier as Hex] }),
  onError: (id, error) => log(`  ! intent ${String(id).slice(0, 8)}… will retry: ${(error as Error).message}`),
};
const simulator = createCreSimulator({
  ...settlement,
  intentSecretKey: intentKeys.secretKey,
  encryptionKeyId: KEY_ID,
  async readFreshScore(scope) {
    const c = evaluatePublicReadiness(await graph.getRingSnapshot(scope), relaySnapshot());
    return { score: c.privacyScore, observedAt: c.observedAt };
  },
});
simulator.start(3_000);

const relays = await serveLocalMesh(mesh, new Map<MeshMessageKind, string>([
  ['PAYMENT', `http://127.0.0.1:${PORTS.exit}/v1/mesh/payment`],
  ['QUERY', `http://127.0.0.1:${PORTS.exit}/v1/mesh/query`],
]), LOOPBACK);

// ── test credential authority: issues for ANY recipient ─────────────────
const credentialHandler: RequestListener = (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => { size += c.length; if (size > 1024) req.destroy(); else chunks.push(c); });
  req.on('end', () => {
    try {
      const { recipient } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { recipient?: string };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(credentialJson(String(recipient), POLICY, credentialMac, nowS()));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: (e as Error).message }));
    }
  });
};
const credentials = createServer(credentialHandler);
await new Promise<void>((r) => credentials.listen(PORTS.credentials, LOOPBACK, r));

// ── what the page reads ──────────────────────────────────────────────────
const walletConfig = JSON.stringify({
  $comment: 'Written by backend/ethereum/devnet-stack.ts, every start.',
  directoryChain,
  signedDirectory: mesh.signed,
  trustRoot: mesh.root,
  cre: { publicKey: intentKeys.publicKey, encryptionKeyId: KEY_ID, policyVersion: POLICY },
  credentialUrl: `${PUBLIC_URL ?? `http://${LOOPBACK}:${PORTS.credentials}`}/v1/credential`,
  // The account and the attester are FORS (LIVE); the ring is the pools' own events; the stand-in is no enclave.
  capabilities: { pqWallet: 'LIVE', graph: 'LIVE', confidentialExecution: 'SIMULATED', policyScope: 'CRE_WORKFLOW_ONLY' },
}, bigintReplacer, 2);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, walletConfig);

// ── the one public port ─────────────────────────────────────────────────
const router = PORT === undefined ? undefined : createServer((req, res) => {
  const url = req.url ?? '/';
  const hop = /^\/r(\d+)(\/.*)$/.exec(url);
  const relay = hop && relays.find((r) => r.relayId === `R${hop[1]}`);
  if (hop && relay) { req.url = hop[2]; relay.handler(req, res); return; }
  if (url.startsWith('/v1/mesh/')) { exit.handler(req, res); return; }
  if (url === '/v1/credential') { credentialHandler(req, res); return; }
  if (url === '/devnet-stack.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(walletConfig);
    return;
  }
  res.writeHead(404); res.end();
});
if (router) await new Promise<void>((r) => router.listen(Number(PORT), '0.0.0.0', r));

// A week's directory generation is over: exit, and the next boot derives the next one.
if (mesh.generationEndsAt !== undefined) {
  setTimeout(() => { log('  directory generation over: exiting so the next boot serves the next one'); process.exit(75); },
    Math.max(Number(mesh.generationEndsAt - nowS()) * 1000, 0)).unref();
}

log('opaque devnet stack — Opaque\'s privacy layer on the EIP-8141 devnet');
for (const p of privacy.pools) {
  const ring = await graph.getRingSnapshot(scopeOf(p));
  log(`  ${String(p.denomination / 1e6).padStart(4)} pqUSDC  ${p.address}  ${ring.candidates.length} notes`);
}
log(`  account    ${account} (pays every spend, attests every proof; FORS only)`);
log(`  relays     ${mesh.signed.directory.entries.map((e) => e.endpoint.replace('/v1/relay', '')).join('  ')}`);
log(`  exit       http://127.0.0.1:${PORTS.exit}   credentials :${PORTS.credentials}`);
log(`  wallet cfg ${OUT}`);
log('  THIS IS ONE OPERATOR: six relays here are not independent.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    simulator.stop();
    void Promise.all([...relays.map((r) => r.close()), exit.close(), new Promise((r) => credentials.close(r)), new Promise((r) => (router ? router.close(r) : r(undefined)))])
      .then(() => process.exit(0));
  });
}
