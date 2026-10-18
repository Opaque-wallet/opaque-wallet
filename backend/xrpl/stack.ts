#!/usr/bin/env node
// The whole backend the XRPL wallet needs, on one machine, against the REAL
// XRPL testnet pools in deployments/xrpl-testnet.json.
//
//   cd backend && npm run xrpl:stack            then  cd frontend && npm run dev
//
// Six relays, the mesh exit (executor, ring and XRPL query answers, the CRE
// stand-in), the attester quorum, and a test credential authority. Writes the
// wallet's public config to frontend/public/xrpl-stack.json.
//
//   MOONPAY_API_KEY, MOONPAY_SECRET_KEY   offer Buy (sandbox; MOONPAY_LIVE=1 for live)
//   PORT, PUBLIC_URL                      one public port, as backend/stack.ts does
//   XRPL_MESH_MASTER                      with PUBLIC_URL: the weekly relay directories
//                                         the root in deployments/xrpl-testnet.json pins
//   XRPL_ATTESTER_SEEDS                   first boot of a hosted node (xrpl/node.ts)
//   WALLETCONNECT_PROJECT_ID              with PORT: offer WalletConnect, its relay
//                                         and Verify reached through this service
//
// Hosted: Railway service opaque-xrpl-testnet; the wallet pages are on Vercel
// (frontend: npm run deploy). docs/xrpl.md, Hosted.
//
// ── What this is NOT ─────────────────────────────────────────────────────
//
// One operator: six relays here collude by construction, every attester's seed
// is in one file, and the CRE stand-in holds the intent key in an ordinary
// process. The capabilities the wallet reads say so (SIMULATED), and each is a
// deployment step, not a code change: hosted relays (backend/stack.ts
// MESH_CONFIG), one host per attester, the CRE workflow.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { connect as connectTls } from 'node:tls';
import { fileURLToPath } from 'node:url';

import type { RelaySnapshot, UnixSeconds } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { xrplDeployment, xrplMeshTrustRoot } from '../../deployments/xrpl.ts';
import { evaluatePublicReadiness } from '../../graph/src/privacy-score.ts';
import { issueCredential } from '../cre/credential.ts';
import { createExecutorServer } from '../cre/executor-server.ts';
import { generateIntentKeypair } from '../cre/seal-client.ts';
import { createCreSimulator } from '../cre/simulator.ts';
import type { DirectoryTrustRoot } from '../mesh/contracts.ts';
import { chainTo, verify } from '../mesh/directory.ts';
import { buildLocalMesh, meshRootAt, serveLocalMesh } from '../mesh/local-mesh.ts';
import type { MeshMessageKind } from '../mesh/transport.ts';
import { MOONPAY_LIVE, MOONPAY_SANDBOX } from '../onramp/moonpay.ts';
import { startXrpl, XRPL_STATE, xrplAnswerer, xrplScopes } from './node.ts';
import { accountOf } from './protocol.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'frontend', 'public', 'xrpl-stack.json');
const PORTS = { relays: 18_301, exit: 18_400, credentials: 18_402 } as const;
const LOOPBACK = '127.0.0.1';
const KEY_ID = 'opaque-intent-key-v1';
const POLICY = 'opaque-policy-v1';
const RAILWAY = process.env['RAILWAY_PUBLIC_DOMAIN'];
const PUBLIC_URL = (process.env['PUBLIC_URL'] ?? (RAILWAY && `https://${RAILWAY}`))?.replace(/\/+$/, '');
const PORT = process.env['PORT'];
const log = (s: string) => process.stdout.write(`${s}\n`);
const nowS = (): UnixSeconds => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds;
const bigintReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v);

// The stand-in's intent key and credential MAC, persisted so a sealed intent survives a restart.
mkdirSync(XRPL_STATE, { recursive: true, mode: 0o700 });
const keyFile = join(XRPL_STATE, 'intent-key.json');
const macFile = join(XRPL_STATE, 'credential.mac');
if (!existsSync(keyFile)) {
  const k = generateIntentKeypair();
  writeFileSync(keyFile, JSON.stringify({ publicKey: k.publicKey, secretKey: k.secretKey }), { mode: 0o600 });
}
if (!existsSync(macFile)) writeFileSync(macFile, toHex(crypto.getRandomValues(new Uint8Array(32))), { mode: 0o600 });
const intentKeys = JSON.parse(readFileSync(keyFile, 'utf8')) as { publicKey: `0x${string}`; secretKey: `0x${string}` };
const credentialMac = Uint8Array.from(Buffer.from(readFileSync(macFile, 'utf8').trim().slice(2), 'hex'));

const node = await startXrpl({ log });
for (const pool of node.pools.values()) await pool.source.sync();

// Hosted: every relay key and directory derives from XRPL_MESH_MASTER, week by
// week from the genesis in deployments/xrpl-testnet.json, so the root compiled
// into the built wallet verifies across restarts. Unset (a laptop): a fresh
// random mesh each boot, whose root only a dev server's wallet takes.
const MESH_MASTER = PUBLIC_URL === undefined ? undefined : process.env['XRPL_MESH_MASTER'];
const mesh = buildLocalMesh({
  basePort: PORTS.relays,
  endpointFor: (_id, i, port) => (PUBLIC_URL === undefined ? `http://${LOOPBACK}:${port}/v1/relay` : `${PUBLIC_URL}/r${i + 1}/v1/relay`),
  ...(MESH_MASTER === undefined ? {} : { master: fromHex(MESH_MASTER as `0x${string}`), genesis: BigInt(xrplDeployment.mesh?.genesis ?? 0) }),
});
const pinned = MESH_MASTER === undefined ? undefined : xrplMeshTrustRoot();
if (pinned !== undefined && meshRootAt(fromHex(MESH_MASTER as `0x${string}`), pinned.minVersion).signerCommitment !== pinned.signerCommitment) {
  throw new Error('XRPL_MESH_MASTER does not derive the trust root pinned in deployments/xrpl-testnet.json');
}
// The links a wallet needs, from the pinned root to the directory in force,
// checked at boot: an expired directory or a broken chain stops here.
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

const moonpayKey = process.env['MOONPAY_API_KEY'];
const moonpaySecret = process.env['MOONPAY_SECRET_KEY'];
const exit = createExecutorServer({
  graph: {
    getRingSnapshot: (s) => node.ringSnapshot(s),
    getRelaySnapshot: async () => relaySnapshot(),
    getPrivacyConditions: async (s) => evaluatePublicReadiness(await node.ringSnapshot(s), relaySnapshot()),
  },
  xrpl: xrplAnswerer(node, moonpayKey === undefined || moonpaySecret === undefined ? undefined : {
    baseUrl: process.env['MOONPAY_LIVE'] === '1' ? MOONPAY_LIVE : MOONPAY_SANDBOX, apiKey: moonpayKey, secretKey: moonpaySecret,
  }),
});
await exit.listen(PORTS.exit, LOOPBACK);

const simulator = createCreSimulator({
  executor: exit.executor, intentSecretKey: intentKeys.secretKey, encryptionKeyId: KEY_ID,
  credentialMac, policyVersion: POLICY, releaseTtlSeconds: 900n,
  deliver: node.settlement.deliver, evidence: node.settlement.evidence, nullifierSpent: node.settlement.nullifierSpent,
  async readFreshScore(scope) {
    const c = evaluatePublicReadiness(await node.ringSnapshot(scope), relaySnapshot());
    return { score: c.privacyScore, observedAt: c.observedAt };
  },
  onError: (id, error) => log(`  ! intent ${String(id).slice(0, 8)}… ${(error as Error).message}`),
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
      if (typeof recipient !== 'string' || !/^0x[0-9a-f]{40}$/.test(recipient)) throw new Error('recipient must be a lower-case address');
      const credential = issueCredential({ recipient: recipient as never, policyVersion: POLICY, expiresAt: (nowS() + 86_400n) as UnixSeconds }, credentialMac);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(credential, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: (e as Error).message }));
    }
  });
};
const credentials = createServer(credentialHandler);
await new Promise<void>((r) => credentials.listen(PORTS.credentials, LOOPBACK, r));

// ── WalletConnect, through this service (frontend/src/lib/walletconnect.ts) ──
// The wallet's relay socket is tunnelled byte for byte to Reown's relay, so the
// page talks to Opaque's servers only and Reown sees this server, never the user.
// Messages are end-to-end encrypted between the dapp and the wallet: the relay,
// and this tunnel, carry topics and ciphertext. Verify's two reads (is the dapp
// the site it claims?) go the same way. Needs the one public port (PORT).
const WC_PROJECT = PORT === undefined ? undefined : process.env['WALLETCONNECT_PROJECT_ID'];
const WC_RELAY = 'relay.walletconnect.org';
const WC_VERIFY = 'https://verify.walletconnect.org';
const SELF = PUBLIC_URL ?? `http://${LOOPBACK}:${PORT}`;

function tunnelRelay(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const query = (req.url ?? '').slice('/v1/walletconnect'.length);
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !/^(\?\S*)?$/.test(query)) { socket.destroy(); return; }
  const upstream = connectTls({ host: WC_RELAY, port: 443, servername: WC_RELAY }, () => {
    // Only what the handshake needs: none of the user's origin, cookies, agent or address.
    upstream.write(`GET /${query} HTTP/1.1\r\nHost: ${WC_RELAY}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const close = () => { socket.destroy(); upstream.destroy(); };
  upstream.on('error', close).on('close', close);
  socket.on('error', close).on('close', close);
}

/** GET /v1/wc-verify/attestation/<hash> and /v1/wc-verify/v3/public-key, and nothing else. */
async function proxyVerify(url: string, res: ServerResponse): Promise<void> {
  const rest = url.slice('/v1/wc-verify'.length);
  if (!/^\/attestation\/[0-9a-f]{64}(\?v2Supported=true)?$|^\/v3\/public-key$/.test(rest)) { res.writeHead(404); res.end(); return; }
  try {
    const upstream = await fetch(`${WC_VERIFY}${rest}`, { signal: AbortSignal.timeout(10_000) });
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.writeHead(502); res.end();
  }
}

// ── what the wallet reads ────────────────────────────────────────────────
const walletConfig = JSON.stringify({
  $comment: 'Written by backend/xrpl/stack.ts, every start.',
  directoryChain,
  signedDirectory: mesh.signed,
  trustRoot: mesh.root,
  cre: { publicKey: intentKeys.publicKey, encryptionKeyId: KEY_ID, policyVersion: POLICY },
  credentialUrl: `${PUBLIC_URL ?? `http://${LOOPBACK}:${PORTS.credentials}`}/v1/credential`,
  buy: moonpayKey !== undefined && moonpaySecret !== undefined,
  walletConnect: WC_PROJECT === undefined ? null : {
    projectId: WC_PROJECT, relayUrl: `${SELF.replace(/^http/, 'ws')}/v1/walletconnect`, verifyUrl: `${SELF}/v1/wc-verify`,
  },
  // The ring is the pool's own ledger history (LIVE). XRPL has no FORS account
  // to report (single-use keys instead), and the stand-in is not an enclave.
  capabilities: { pqWallet: 'MOCK', graph: 'LIVE', confidentialExecution: 'SIMULATED', policyScope: 'CRE_WORKFLOW_ONLY' },
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
  if (WC_PROJECT !== undefined && req.method === 'GET' && url.startsWith('/v1/wc-verify/')) { void proxyVerify(url, res); return; }
  if (url === '/xrpl-stack.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(walletConfig);
    return;
  }
  res.writeHead(404); res.end();
});
router?.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  if (WC_PROJECT !== undefined && (req.url ?? '').startsWith('/v1/walletconnect')) tunnelRelay(req, socket, head);
  else socket.destroy();
});
if (router) await new Promise<void>((r) => router.listen(Number(PORT), '0.0.0.0', r));

// A week's directory generation is over: exit, and the next boot derives the
// next one. Railway restarts a service that exits non-zero.
if (mesh.generationEndsAt !== undefined) {
  setTimeout(() => { log('  directory generation over: exiting so the next boot serves the next one'); process.exit(75); },
    Math.max(Number(mesh.generationEndsAt - nowS()) * 1000, 0)).unref();
}

log(`opaque XRPL stack — ${xrplDeployment.network.displayName}`);
for (const scope of xrplScopes()) {
  const ring = await node.ringSnapshot(scope);
  const p = xrplDeployment.pools.find((x) => x.account === accountOf(scope.pool))!;
  log(`  ${p.symbol.padEnd(6)} ${String(scope.denomination / 1e6).padStart(4)}  ${p.account}  ${ring.candidates.length} notes`);
}
log(`  relays     ${mesh.signed.directory.entries.map((e) => e.endpoint.replace('/v1/relay', '')).join('  ')}`);
log(`  exit       http://127.0.0.1:${PORTS.exit}   credentials :${PORTS.credentials}   buy ${moonpayKey ? 'on' : 'off (no MOONPAY_API_KEY)'}`);
log(`  wallet cfg ${OUT}`);
log('  THIS IS ONE OPERATOR: six relays and three attesters here are not independent.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    simulator.stop();
    void Promise.all([...relays.map((r) => r.close()), exit.close(), node.close(), new Promise((r) => credentials.close(r)), new Promise((r) => (router ? router.close(r) : r(undefined)))])
      .then(() => process.exit(0));
  });
}
