// Typed, validated access to deployments/xrpl-<network>.json: the XRPL pool
// accounts a wallet compiles in. Same rules as ./index.ts — the network is
// chosen at build/boot time (OPAQUE_NETWORK, VITE_NETWORK), never by a server,
// because a server that could name the pools could take the deposits. And
// dependency-free, so the wallet, the backend and the tests all import it.

import testnet from './testnet.json' with { type: 'json' };
import mainnet from './mainnet.json' with { type: 'json' };

const NETWORKS = { testnet, mainnet } as const;
const selected =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env['OPAQUE_NETWORK'] ??
  (import.meta as { env?: Record<string, string | undefined> }).env?.['VITE_NETWORK'] ??
  'testnet';
if (!(selected in NETWORKS)) throw new Error(`unknown network "${selected}": use testnet or mainnet`);
const FILE = `deployments/xrpl/${selected}.json`;

export type XrplAssetConfig =
  | { readonly kind: 'XRP' }
  | { readonly kind: 'IOU'; readonly currency: string; readonly issuer: string }
  | { readonly kind: 'MPT'; readonly issuanceId: string; readonly scale: number };

export interface XrplPoolDeployment {
  readonly symbol: string;
  readonly asset: XrplAssetConfig;
  /** The pool account: master key disabled, the attesters as its signer list. */
  readonly account: string;
  /** Note sizes in 6-decimal units (drops for XRP). */
  readonly sizes: readonly number[];
  /** Kept per note spent, in the same units: the nullifier credential's reserve and the fee. */
  readonly spendFee: string;
  /** Where the deposit log starts reading. */
  readonly deployedAtLedger: number;
  /** MoonPay's currency code for this coin on XRPL, or null when Buy is not offered for it. */
  readonly moonpay?: string | null;
}

export interface XrplDeployment {
  readonly network: {
    readonly name: string;
    readonly displayName: string;
    readonly networkId: number;
    readonly wss: string;
    readonly explorer: string;
  };
  readonly attesters: { readonly count: number; readonly quorum: number };
  /** The hosted service's relay directory root. Absent: no hosted service yet, so only a dev server's wallet runs. */
  readonly mesh?: { readonly genesis: number; readonly trustRoot: { readonly signerCommitment: `0x${string}`; readonly minVersion: number } };
  readonly pools: readonly XrplPoolDeployment[];
}

// XRPL's base58 alphabet; the checksum is checked where xrpl.js is loaded.
const CLASSIC = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const CURRENCY = /^([A-Za-z0-9]{3}|[0-9A-F]{40})$/;
// The protocol's DENOMINATIONS (packages/protocol-types), repeated: this file imports only JSON.
const SIZES = new Set([
  1_000_000, 2_000_000, 5_000_000, 10_000_000, 20_000_000, 50_000_000, 100_000_000,
  200_000_000, 500_000_000, 1_000_000_000, 2_000_000_000, 5_000_000_000, 10_000_000_000,
  20_000_000_000, 50_000_000_000, 100_000_000_000, 200_000_000_000, 500_000_000_000, 1_000_000_000_000,
]);

const bad = (path: string, why: string): never => { throw new Error(`${FILE}: ${path} ${why}`); };

function validate(d: (typeof NETWORKS)[keyof typeof NETWORKS]): XrplDeployment {
  if (!Number.isSafeInteger(d.network.networkId) || d.network.networkId < 0) bad('network.networkId', 'must be an XRPL network id');
  if (!/^wss:\/\//.test(d.network.wss)) bad('network.wss', 'must be a wss:// URL');
  const { count, quorum } = d.attesters;
  if (!Number.isSafeInteger(quorum) || quorum < 1 || quorum > count) bad('attesters', 'needs 1 <= quorum <= count');
  const mesh = (d as { mesh?: XrplDeployment['mesh'] }).mesh;
  if (mesh !== undefined) {
    if (!Number.isSafeInteger(mesh.genesis) || mesh.genesis <= 0) bad('mesh.genesis', 'must be unix seconds');
    if (!/^0x[0-9a-f]{64}$/.test(mesh.trustRoot.signerCommitment)) bad('mesh.trustRoot.signerCommitment', 'must be 32 lower-case hex bytes');
    if (!Number.isSafeInteger(mesh.trustRoot.minVersion) || mesh.trustRoot.minVersion < 0) bad('mesh.trustRoot.minVersion', 'must be a version');
  }
  (d.pools as readonly XrplPoolDeployment[]).forEach((p, i) => {
    if (!CLASSIC.test(p.account)) bad(`pools[${i}].account`, 'must be a classic address');
    if (p.asset.kind === 'IOU' && (!CLASSIC.test(p.asset.issuer) || !CURRENCY.test(p.asset.currency))) bad(`pools[${i}].asset`, 'needs a currency code and a classic issuer');
    if (p.asset.kind === 'MPT' && (!/^[0-9A-F]{48}$/.test(p.asset.issuanceId) || !Number.isInteger(p.asset.scale) || p.asset.scale < 0 || p.asset.scale > 6)) {
      bad(`pools[${i}].asset`, 'needs a 48-hex issuance id and an AssetScale of 0 to 6');
    }
    if (p.sizes.length === 0 || p.sizes.some((s) => !SIZES.has(s))) bad(`pools[${i}].sizes`, 'must be frozen denominations');
    if (!/^\d+$/.test(p.spendFee) || BigInt(p.spendFee) >= BigInt(Math.min(...p.sizes))) bad(`pools[${i}].spendFee`, 'must be units below the smallest note');
    if (!Number.isSafeInteger(p.deployedAtLedger) || p.deployedAtLedger <= 0) bad(`pools[${i}].deployedAtLedger`, 'must be a ledger index');
  });
  return d as XrplDeployment;
}

export const xrplDeployment: XrplDeployment = validate(NETWORKS[selected as keyof typeof NETWORKS]);

/** The relay directory root a built wallet pins: from this file, never from a server. */
export function xrplMeshTrustRoot(): { readonly signerCommitment: `0x${string}`; readonly minVersion: bigint } {
  const mesh = xrplDeployment.mesh ?? bad('mesh', 'is not set: this network has no hosted XRPL service yet');
  return { signerCommitment: mesh.trustRoot.signerCommitment, minVersion: BigInt(mesh.trustRoot.minVersion) };
}

/** The pool for an asset, by its symbol. */
export function xrplPool(symbol: string): XrplPoolDeployment {
  const pool = xrplDeployment.pools.find((p) => p.symbol === symbol);
  if (pool === undefined) throw new Error(`no ${symbol} pool on ${xrplDeployment.network.name}: run backend/xrpl/setup-pools.ts`);
  return pool;
}
