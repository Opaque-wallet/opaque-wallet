// What the testnet end-to-end scripts share: the XRPL node, the exit, six local
// relays, a CRE stand-in, and a wallet's-eye view of all of it — every read and
// every payment goes through the mesh, as the wallet page's do.

import type { AddressInfo } from 'node:net';

import type { Client, SubmittableTransaction, Wallet } from 'xrpl';

import type { CredentialHandle, Hex, IdempotencyKey, IntentStatus, NoteId, PoolScope, PrivacyScore, RelayPath, RelaySnapshot, RingSnapshot, UnixSeconds, XrplOperation } from '@opaque/protocol-types';
import { spendHash } from '@opaque/protocol-types/codecs.js';

import { evaluatePublicReadiness } from '../../graph/src/privacy-score.ts';
import { selectDecoys } from '../../packages/ring-client/src/selection.ts';
import { MOONPAY_SANDBOX } from '../onramp/moonpay.ts';
import { issueCredential } from '../cre/credential.ts';
import { createExecutorServer } from '../cre/executor-server.ts';
import { createIntentSealer, generateIntentKeypair } from '../cre/seal-client.ts';
import { createCreSimulator } from '../cre/simulator.ts';
import { createMeshTransport } from '../mesh/client.ts';
import { buildLocalMesh, serveLocalMesh } from '../mesh/local-mesh.ts';
import type { MeshMessageKind } from '../mesh/transport.ts';
import { buildRingSpend, deriveCommitment } from '../zk/index.ts';
import { startXrpl, xrplAnswerer, type XrplNode } from './node.ts';
import { recipientFor, type XrplDestination } from './protocol.ts';
import type { XrplSend } from './queries.ts';

export const log = (s: string) => process.stdout.write(`${s}\n`);
const nowS = (): UnixSeconds => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds;

export interface Harness {
  readonly node: XrplNode;
  readonly client: Client;
  /** The XRPL mesh query, as the wallet sends it. */
  readonly xrpl: XrplSend;
  ring(scope: PoolScope): Promise<RingSnapshot>;
  /** Proof, credential, seal, mesh, CRE stand-in, attesters. The status comes back through the mesh. */
  pay(scope: PoolScope, noteSecret: Uint8Array, destination: XrplDestination): Promise<IntentStatus>;
  check(name: string, ok: boolean, detail: string): void;
  /** A transaction that must succeed. */
  send(tx: SubmittableTransaction, wallet: Wallet): Promise<void>;
  balance(account: string): Promise<bigint>;
  /** Prints the verdict, sets the exit code, closes everything. */
  finish(label: string): Promise<void>;
}

export async function startHarness(basePort: number): Promise<Harness> {
  const node = await startXrpl({ log });
  const { client } = node;
  let failures = 0;

  const intentKeys = generateIntentKeypair();
  const credentialMac = crypto.getRandomValues(new Uint8Array(32));
  const KEY_ID = 'opaque-intent-key-v1';
  const POLICY = 'opaque-policy-v1';

  const exitServer = createExecutorServer({
    graph: {
      getRingSnapshot: (s) => node.ringSnapshot(s),
      getRelaySnapshot: async () => relaySnapshot(),
      getPrivacyConditions: async (s) => evaluatePublicReadiness(await node.ringSnapshot(s), relaySnapshot()),
    },
    // Test keys: the URL is checked, never opened.
    xrpl: xrplAnswerer(node, { baseUrl: MOONPAY_SANDBOX, apiKey: 'pk_test_opaque', secretKey: 'sk_test_opaque' }),
  });
  const exitPort = ((await exitServer.listen(0, '127.0.0.1')).address() as AddressInfo).port;
  const mesh = buildLocalMesh(basePort);
  const relays = await serveLocalMesh(mesh, new Map<MeshMessageKind, string>([
    ['PAYMENT', `http://127.0.0.1:${exitPort}/v1/mesh/payment`],
    ['QUERY', `http://127.0.0.1:${exitPort}/v1/mesh/query`],
  ]));
  const nodes = mesh.signed.directory.entries.map((e) => ({
    id: e.id, endpoint: e.endpoint, kemPublicKey: e.kemPublicKey, keyEpoch: e.keyEpoch, operatorId: e.operatorId,
    reliabilityScore: 9_000 as PrivacyScore, batchOccupancy: 1, recentSelectionCount: 0, lastSeenAt: nowS(),
  }));
  const relaySnapshot = (): RelaySnapshot => ({ nodes, directoryVersion: 'local', observedAt: nowS() });
  const pathFor = async () => [...nodes].sort(() => Math.random() - 0.5).slice(0, 3) as unknown as RelayPath;
  const transport = createMeshTransport({ pollIntervalMs: 150, pollTimeoutMs: 120_000, pathFor });

  const simulator = createCreSimulator({
    executor: exitServer.executor, intentSecretKey: intentKeys.secretKey, encryptionKeyId: KEY_ID,
    credentialMac, policyVersion: POLICY, releaseTtlSeconds: 900n,
    deliver: node.settlement.deliver, evidence: node.settlement.evidence, nullifierSpent: node.settlement.nullifierSpent,
    onError: (_id, error) => log(`  · settlement refused: ${(error as Error).message}`),
  });

  const xrpl: XrplSend = async (operation: XrplOperation, encodedRequest: Hex) =>
    (await transport.query({ kind: 'XRPL', operation, encodedRequest }, await pathFor())).value as Hex;
  const ring = async (scope: PoolScope) => (await transport.query({ kind: 'RING_SNAPSHOT', scope }, await pathFor())).value as RingSnapshot;

  return {
    node, client, xrpl, ring,
    async pay(scope, noteSecret, destination) {
      const snapshot = await ring(scope);
      const decoys = selectDecoys({ scope, snapshot, exclude: deriveCommitment(noteSecret, scope) });
      const recipient = recipientFor(destination);
      const t0 = Date.now();
      const spend = buildRingSpend({ scope, recipient, noteSecret, decoys });
      log(`  proof built in ${Date.now() - t0} ms; ring of 8 from ${snapshot.candidates.length} deposits`);
      const credential = issueCredential({ recipient, policyVersion: POLICY, expiresAt: (nowS() + 3600n) as UnixSeconds }, credentialMac);
      const seal = createIntentSealer({
        crePublicKey: intentKeys.publicKey, encryptionKeyId: KEY_ID,
        resolveCredential: async () => JSON.stringify(credential, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)),
      });
      const intent = await seal({
        scope, spendHash: spendHash(spend), spend: { ...spend, destination },
        request: {
          noteId: 'e2e' as NoteId, recipient, minPrivacyScore: 0 as PrivacyScore, deadline: (nowS() + 120n) as UnixSeconds,
          credentialHandle: 'local' as CredentialHandle, idempotencyKey: `xrpl-e2e-${Date.now()}-${Math.random()}` as IdempotencyKey,
        },
      });
      const t1 = Date.now();
      const ref = await transport.submitIntent(intent, await pathFor());
      log(`  sealed intent across the mesh in ${Date.now() - t1} ms`);
      const t2 = Date.now();
      await simulator.tick();
      log(`  decided and settled in ${Date.now() - t2} ms`);
      return (await transport.query({ kind: 'INTENT_STATUS', handle: ref.statusHandle }, await pathFor())).value as IntentStatus;
    },
    check(name, ok, detail) {
      if (!ok) failures++;
      log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
    },
    async send(tx, wallet) {
      const r = await client.submitAndWait(tx, { autofill: true, wallet });
      const result = typeof r.result.meta === 'object' ? r.result.meta.TransactionResult : '?';
      if (result !== 'tesSUCCESS') throw new Error(`${tx.TransactionType}: ${result}`);
    },
    async balance(account) {
      return BigInt((await client.request({ command: 'account_info', account, ledger_index: 'validated' })).result.account_data.Balance);
    },
    async finish(label) {
      await Promise.all(relays.map((r) => r.close()));
      await exitServer.close();
      await node.close();
      log(failures === 0 ? `\n${label} passed on testnet` : `\n${label} FAILED: ${failures} check(s)`);
      process.exitCode = failures === 0 ? 0 : 1;
    },
  };
}
