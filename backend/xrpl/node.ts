// The XRPL side of the backend, built from the compiled-in deployment and the
// attesters' seeds: one ledger connection, each pool's deposit log, the
// attesters, and the coordinator the executor's settler delivers to.
//
// ── What this is NOT ─────────────────────────────────────────────────────
//
// Every attester runs in this one process from seeds in one file, so the
// quorum is one operator. A deployment gives each attester its own host, its
// own seed and its own ledger connection; the code does not change, only where
// each createAttester runs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, xrpToDrops } from 'xrpl';

import { ProtocolFailure, type PoolScope, type RingSnapshot, type UnixSeconds } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { xrplDeployment, type XrplPoolDeployment } from '../../deployments/xrpl.ts';
import { checkoutUrl, type CheckoutConfig } from '../onramp/moonpay.ts';
import { verifierId } from '../zk/index.ts';
import { createAttester, type Attester, type XrplPool } from './attester.ts';
import { createPoolSource, ringSnapshotOf, type TagRegistration } from './pool.ts';
import { accountOf, scopeOf, type XrplAsset } from './protocol.ts';
import { createXrplAnswerer, type XrplSend } from './queries.ts';
import { createXrplSettlement, type XrplSettlement } from './settlement.ts';
import type { Ledger } from './site.ts';

export const XRPL_STATE = join(dirname(fileURLToPath(import.meta.url)), '..', '.stack', 'xrpl');

interface AttesterFile {
  readonly seeds: string[];
  /** attester id → pool → the key index last seen on the ledger. */
  readonly index: Record<string, Record<string, number>>;
}

/**
 * The attesters' seeds, created on first use. Secrets: never printed, file mode 0600.
 * A hosted node brings the seeds that own the pools' signer lists instead, in
 * XRPL_ATTESTER_SEEDS (comma-separated hex); after that first boot the file,
 * on the service's volume, is the record, key positions included.
 */
export function attesterFile(dir = XRPL_STATE, count = xrplDeployment.attesters.count): AttesterFile {
  const file = join(dir, 'attesters.json');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const given = process.env['XRPL_ATTESTER_SEEDS']?.split(',').map((s) => s.trim().toLowerCase());
    if (given !== undefined && given.some((s) => !/^0x[0-9a-f]{64}$/.test(s))) throw new Error('XRPL_ATTESTER_SEEDS must be comma-separated 32-byte hex seeds');
    const fresh: AttesterFile = { seeds: given ?? Array.from({ length: count }, () => toHex(crypto.getRandomValues(new Uint8Array(32)))), index: {} };
    writeFileSync(file, JSON.stringify(fresh), { mode: 0o600 });
  }
  const state = JSON.parse(readFileSync(file, 'utf8')) as AttesterFile;
  if (state.seeds.length !== count) throw new Error(`${file} holds ${state.seeds.length} seeds; the deployment has ${count} attesters`);
  return state;
}

/** site.ts's ledger, straight to a node: for the backend and scripts. The wallet's goes through the mesh. */
export const nodeLedger = (client: Client): Ledger => ({
  request: async <T,>(command: string, params: Record<string, unknown> = {}) =>
    (await (client.request as (r: unknown) => Promise<{ result: unknown }>)({ command, ...params })).result as T,
  submit: async (blob) => (await client.request({ command: 'submit', tx_blob: blob })).result,
});

export const assetOf = (p: XrplPoolDeployment): XrplAsset => ({ ...p.asset }) as XrplAsset;

/** Every (pool, note size) a wallet can hold, largest first. */
export const xrplScopes = (): PoolScope[] =>
  xrplDeployment.pools.flatMap((p) => [...p.sizes].sort((a, b) => b - a).map((s) => scopeOf(xrplDeployment.network.networkId, p.account, s)));

/** The exit's XRPL answers (xrpl/queries.ts), from a running node. MoonPay unset: no Buy. */
export function xrplAnswerer(node: XrplNode, moonpay?: CheckoutConfig): XrplSend {
  const sourceOf = (pool: string) => node.pools.get(pool)?.source ?? (() => { throw new ProtocolFailure('INVALID_INPUT', 'no XRPL pool at that address'); })();
  // ponytail: one faucet call at a time, since the faucet limits by IP; a queue if testnet traffic grows.
  let fauceting = false;
  return createXrplAnswerer({
    registerTag: (pool, tag, registration) => node.registerTag(pool, tag, registration),
    async tagStatus(pool, tag) {
      const source = sourceOf(pool);
      await source.sync();
      const log = source.log();
      return { registered: source.registered(tag), notes: log.deposits.filter((d) => d.tag === tag).length, carried: log.carried.get(tag) ?? 0n };
    },
    isSpent: (pool, nullifier) => sourceOf(pool).isSpent(nullifier),
    read: (command, params) => nodeLedger(node.client).request(command, params),
    submit: (blob) => nodeLedger(node.client).submit(blob),
    ...(moonpay === undefined ? {} : {
      async onrampUrl(pool: string, tag: number, fiatAmount: number) {
        const deployed = xrplDeployment.pools.find((p) => p.account === pool);
        if (deployed?.moonpay == null) throw new ProtocolFailure('INVALID_INPUT', 'Buy is not offered for this pool');
        // Only a registered tag: a purchase must never land where nothing credits it.
        if (!sourceOf(pool).registered(tag)) throw new ProtocolFailure('INVALID_INPUT', 'register the tag before buying to it');
        return checkoutUrl(moonpay, { currencyCode: deployed.moonpay, walletAddress: pool, walletAddressTag: tag, fiatAmount });
      },
    }),
    // Testnet: a fresh faucet account pays the tag, so a visitor with no test XRP can still deposit.
    ...(xrplDeployment.network.name !== 'xrpl-testnet' ? {} : {
      async faucet(pool: string, tag: number) {
        if (xrplDeployment.pools.find((p) => p.account === pool)?.symbol !== 'XRP') throw new ProtocolFailure('INVALID_INPUT', 'the faucet pays XRP only');
        if (!sourceOf(pool).registered(tag)) throw new ProtocolFailure('INVALID_INPUT', 'register the tag before funding it');
        if (fauceting) throw new ProtocolFailure('MESH_UNAVAILABLE', 'the faucet is busy: try again in a minute', true);
        fauceting = true;
        try {
          const { wallet, balance } = await node.client.fundWallet();
          // 95 is nine 10s and five 1s, what a fresh tag holds; the rest stays as the account's reserve.
          const xrp = Math.min(95, Math.floor(balance) - 2);
          const paid = await node.client.submitAndWait(
            { TransactionType: 'Payment', Account: wallet.address, Destination: pool, Amount: xrpToDrops(xrp), DestinationTag: tag },
            { autofill: true, wallet },
          );
          const result = (paid.result.meta as { TransactionResult?: string } | undefined)?.TransactionResult;
          if (result !== 'tesSUCCESS') throw new ProtocolFailure('MESH_UNAVAILABLE', `the faucet's payment failed: ${result}`, true);
          return { xrp, hash: paid.result.hash };
        } finally {
          fauceting = false;
        }
      },
    }),
  });
}

export interface XrplNode {
  readonly client: Client;
  readonly pools: ReadonlyMap<string, XrplPool>;
  readonly attesters: readonly Attester[];
  readonly settlement: XrplSettlement;
  ringSnapshot(scope: PoolScope): Promise<RingSnapshot>;
  registerTag(pool: string, tag: number, registration: TagRegistration): Promise<void>;
  close(): Promise<void>;
}

export async function startXrpl(options: { readonly dir?: string; readonly log?: (line: string) => void } = {}): Promise<XrplNode> {
  const dir = options.dir ?? XRPL_STATE;
  const client = new Client(xrplDeployment.network.wss);
  await client.connect();

  const pools = new Map<string, XrplPool>(xrplDeployment.pools.map((p) => [p.account, {
    source: createPoolSource({
      client,
      config: { account: p.account, asset: assetOf(p), sizes: p.sizes, deployedAtLedger: p.deployedAtLedger },
      tagFile: join(dir, `tags-${p.account}.json`),
    }),
    spendFee: BigInt(p.spendFee),
  }]));

  const state = attesterFile(dir);
  const saveIndex = (id: string, pool: string, i: number) => {
    (state.index[id] ??= {})[pool] = i;
    writeFileSync(join(dir, 'attesters.json'), JSON.stringify(state), { mode: 0o600 });
  };
  const attesters: Attester[] = state.seeds.map((seed, i) => {
    const id = `A${i + 1}`;
    return createAttester({
      id, seed: fromHex(seed as `0x${string}`), client, networkId: xrplDeployment.network.networkId, pools,
      verifierId: verifierId(), peers: () => attesters,
      startIndex: new Map(Object.entries(state.index[id] ?? {})),
      onIndex: (pool, index) => saveIndex(id, pool, index),
    });
  });

  const poolAt = (scope: PoolScope) => {
    const pool = pools.get(accountOf(scope.pool));
    if (pool === undefined) throw new ProtocolFailure('INVALID_INPUT', 'no XRPL pool at that address');
    return pool;
  };

  return {
    client,
    pools,
    attesters,
    settlement: createXrplSettlement({ client, pools, attesters, ...(options.log === undefined ? {} : { log: options.log }) }),
    async ringSnapshot(scope) {
      const { source } = poolAt(scope);
      await source.sync();
      return ringSnapshotOf({
        scope, log: source.log(), indexedThrough: source.indexedThrough(), timesUsed: source.timesUsed,
        now: BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds,
      });
    },
    async registerTag(pool, tag, registration) {
      const source = pools.get(pool)?.source;
      if (source === undefined) throw new ProtocolFailure('INVALID_INPUT', 'no XRPL pool at that address');
      // Current first: a tag that was paid since the last read is refused.
      await source.sync();
      source.registerTag(tag, registration);
    },
    close: () => client.disconnect(),
  };
}
