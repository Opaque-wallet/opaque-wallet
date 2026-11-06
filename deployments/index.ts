// Typed, validated access to deployments/<network>.json: Arc's and Ethereum's.
//
// The network is chosen at BUILD/BOOT time, never by a server: OPAQUE_NETWORK
// in Node, VITE_NETWORK in the Vite build, `testnet` when neither is set.
//
// Dependency-free on purpose: no package owns this, and the frontend, backend
// and graph all import it by relative path. Validation runs once, at import —
// a malformed address fails every consumer immediately instead of reaching a
// transaction.
//
//   import { deployment, requireContract } from '../../deployments/index.ts';
//   const registry = requireContract('pqKeyRegistry');   // throws if null

import testnet from './arc-testnet.json' with { type: 'json' };
import mainnet from './arc-mainnet.json' with { type: 'json' };
import sepolia from './eth-sepolia.json' with { type: 'json' };

const NETWORKS = { testnet, mainnet: mainnet as unknown as typeof testnet, sepolia: sepolia as unknown as typeof testnet } as const;
const selected =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env['OPAQUE_NETWORK'] ??
  (import.meta as { env?: Record<string, string | undefined> }).env?.['VITE_NETWORK'] ??
  'testnet';
if (!(selected in NETWORKS)) throw new Error(`unknown network "${selected}": use ${Object.keys(NETWORKS).join(', ')}`);
export type NetworkId = keyof typeof NETWORKS;
export const NETWORK = selected as NetworkId;
const raw = NETWORKS[NETWORK];
/** Every network this build knows, for the wallet's network picker. */
export const networks = (['mainnet', 'testnet'] as const).map((id) => ({
  id, displayName: NETWORKS[id].network.displayName, sitePath: NETWORKS[id].network.sitePath,
}));
/** The file the addresses came from, for error messages. */
const FILE = `deployments/${raw.network.name}.json`;

export type Address = `0x${string}`;

export type ContractName =
  | 'pqKeyRegistry'
  | 'create2Factory'
  | 'singleNotePqVerifier'
  | 'attestedRingVerifier'
  | 'attestedRingVerifier2'
  | 'attestedRingVerifier5'
  | 'attestedRingVerifier10'
  | 'attestedRingVerifier20'
  | 'attestedRingVerifier50'
  | 'attestedRingVerifier100'
  | 'relayDirectory'
  | 'crePolicyGate'
  | 'creBatchSettlement'
  | 'pqAccountFactory'
  | 'pqAccountValidator'
  | 'pqAccountImplementation';

export type ServiceName = 'graphUrl' | 'meshExitUrl' | 'releaseEgressUrl' | 'creTriggerUrl' | 'relayDirectoryUrl';

export interface DeployedContract {
  readonly address: Address;
  readonly deployedAtBlock: number;
}

export interface PoolDeployment {
  readonly address: Address;
  readonly denomination: number;
  readonly proofMode: 'RING_8' | 'SINGLE_NOTE_PQ' | 'ATTESTED_OFFCHAIN';
  readonly verifier: ContractName;
  readonly deployedAtBlock: number;
}

export interface Deployment {
  readonly network: {
    readonly name: string;
    /** What a wallet's network picker shows. */
    readonly displayName: string;
    readonly chainId: number;
    /** Tried after rpcUrl when it refuses: each public RPC limits per IP. */
    readonly rpcFallbacks: readonly string[];
    readonly rpcUrl: string;
    readonly explorer: string;
    /** Where this network's wallet page sits, relative to the site (and extension) root: '' or 'testnet/'. */
    readonly sitePath: string;
    readonly nativeCurrency: { readonly name: string; readonly symbol: string; readonly decimals: number };
  };
  readonly tokens: { readonly usdc: { readonly address: Address; readonly decimals: number } };
  readonly contracts: Readonly<Record<ContractName, DeployedContract | null>>;
  readonly accounts: { readonly attester: Address | null };
  readonly pools: readonly PoolDeployment[];
  readonly erc4337: {
    readonly entryPoints: Readonly<Record<'v0.6' | 'v0.7' | 'v0.8', Address>>;
    readonly preferredEntryPoint: 'v0.6' | 'v0.7' | 'v0.8';
    readonly bundlerUrl: string;
    readonly bundlerApiKeyEnv: string;
  };
  readonly mesh: {
    readonly genesis: number;
    readonly trustRoot: { readonly signerCommitment: `0x${string}`; readonly minVersion: number };
  };
  readonly services: Readonly<Record<ServiceName, string | null>>;
  /** Swaps at the account's address through LI.FI: its contract here, and the tokens offered. */
  readonly swap: { readonly router: Address | null; readonly tokens: readonly SwapToken[] };
  /** Post-quantum stealth payments (backend/chain/stealth.ts), where the network has them. */
  readonly stealth?: { readonly fromBlock: number };
}

export interface SwapToken { readonly symbol: string; readonly address: Address; readonly decimals: number }

// Lower-case, like every other address in this repo: codecs.ts treats
// upper-case as a different value for hashing, so the config must not
// introduce a second spelling of one address.
const ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO = `0x${'0'.repeat(40)}`;

function bad(path: string, why: string): never {
  throw new Error(`${FILE}: ${path} ${why}`);
}

function address(value: unknown, path: string): Address {
  if (typeof value !== 'string' || !ADDRESS.test(value)) bad(path, 'must be a lower-case 0x address');
  // The trap this file exists to remove: a zero address looks configured and
  // then fails on chain. "Not deployed" is spelled null, and nothing else.
  if (value === ZERO) bad(path, 'is the zero address — write null for "not deployed"');
  return value as Address;
}

function validate(d: typeof raw): Deployment {
  address(d.tokens.usdc.address, 'tokens.usdc.address');
  for (const [name, c] of Object.entries(d.contracts)) {
    if (c !== null) address((c as DeployedContract).address, `contracts.${name}.address`);
  }
  d.pools.forEach((p, i) => {
    address(p.address, `pools[${i}].address`);
    if (!(p.verifier in d.contracts)) bad(`pools[${i}].verifier`, `names no known contract (${p.verifier})`);
  });
  for (const [v, a] of Object.entries(d.erc4337.entryPoints)) address(a, `erc4337.entryPoints.${v}`);
  // null until deployed, like the contracts: Sepolia has no attester or swap router yet.
  const attester: unknown = d.accounts.attester, router: unknown = d.swap.router;
  if (attester !== null) address(attester, 'accounts.attester');
  if (router !== null) address(router, 'swap.router');
  d.swap.tokens.forEach((t, i) => address(t.address, `swap.tokens[${i}].address`));
  if (!Number.isSafeInteger(d.mesh.genesis) || d.mesh.genesis <= 0) bad('mesh.genesis', 'must be unix seconds');
  if (!/^0x[0-9a-f]{64}$/.test(d.mesh.trustRoot.signerCommitment)) bad('mesh.trustRoot.signerCommitment', 'must be 32 lower-case hex bytes');
  if (!Number.isSafeInteger(d.mesh.trustRoot.minVersion) || d.mesh.trustRoot.minVersion < 0) bad('mesh.trustRoot.minVersion', 'must be a version');
  return d as unknown as Deployment;
}

export const deployment: Deployment = validate(raw);

/** The address of a contract that must be deployed for the caller to work. */
export function requireContract(name: ContractName): Address {
  const c = deployment.contracts[name];
  if (c === null) {
    throw new Error(`${name} is not deployed on ${deployment.network.name}: set its address in ${FILE}`);
  }
  return c.address;
}

/** The attester, for callers that cannot run before one is registered. */
export function requireAttester(): Address {
  if (deployment.accounts.attester === null) {
    throw new Error(`no attester on ${deployment.network.name} yet: set accounts.attester in ${FILE}`);
  }
  return deployment.accounts.attester;
}

/**
 * The relay directory's trust root, as the wallet compiles it in. A root that
 * arrived over the network would be a root whoever answered chose.
 */
export const meshTrustRoot = (): { readonly signerCommitment: `0x${string}`; readonly minVersion: bigint } => ({
  signerCommitment: deployment.mesh.trustRoot.signerCommitment,
  minVersion: BigInt(deployment.mesh.trustRoot.minVersion),
});

/** An endpoint the caller cannot run without. */
export function requireService(name: ServiceName): string {
  const url = deployment.services[name];
  if (url === null) {
    throw new Error(`${name} is not configured for ${deployment.network.name}: set it in ${FILE}`);
  }
  return url;
}

/**
 * The pool for a denomination AND proof mode. Both are required: there can be
 * two pools at one denomination, and they are not interchangeable — a note
 * made for one can never be spent in the other. A RING_8 note has an AES
 * commitment; a SINGLE_NOTE_PQ verifier recomputes a keccak one and will never
 * match it, so a deposit into the wrong pool is USDC locked for good. Asking
 * by denomination alone would pick one silently.
 */
export function poolFor(denomination: number, proofMode: PoolDeployment['proofMode']): PoolDeployment {
  const pool = deployment.pools.find((p) => p.denomination === denomination && p.proofMode === proofMode);
  if (pool === undefined) {
    throw new Error(`no ${proofMode} pool at ${denomination} is deployed on ${deployment.network.name}`);
  }
  return pool;
}

/** The ERC-4337 EntryPoint the wallet should target. */
export const entryPoint = (): Address => deployment.erc4337.entryPoints[deployment.erc4337.preferredEntryPoint];
