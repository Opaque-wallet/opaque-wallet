// A note leaving an exitable pool alone (contracts/src/opaque/pool/ExitableRingVerifier.sol):
// the reads and the two calls, for a client that holds the note's secret. Nothing here
// talks to Opaque: the caller supplies the public client (frontend/src/lib/without-opaque.ts
// gives one that reads through EF's anon-rpc).
//
//   1. announceExit(nullifier, keccak256(abi.encode(bytes16 secret, pool.paymentContext(to))))
//   2. after the verifier's exitDelay: pool.spend(ring, EXIT_TAG ‖ secret, to, 0)

import { concat, createPublicClient, encodeAbiParameters, encodeFunctionData, http, keccak256, parseAbi, parseAbiItem, stringToHex, type Hex, type PublicClient } from 'viem';

import { deployment } from '../../deployments/index.ts';
import { ARC } from './pool.ts';

export const EXIT_TAG = keccak256(stringToHex('opaque/v1/ring-exit'));
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const VERIFIER = parseAbi([
  'function announceExit(bytes32 nullifier, bytes32 claim)',
  'function announcedAt(bytes32 nullifier, bytes32 claim) view returns (uint256)',
  'function exitDelay() view returns (uint256)',
]);
const POOL = parseAbi([
  'function paymentContext(address recipient) view returns (bytes32)',
  'function isNullifierSpent(bytes32 nullifier) view returns (bool)',
  'function verifier() view returns (address)',
  'function spend(bytes32[] ring, bytes proof, address recipient, bytes32 salt)',
]);
const DEPOSITED = parseAbiItem('event Deposited(bytes32 indexed commitment, uint256 index)');

export interface ExitPool { readonly address: `0x${string}`; readonly denomination: number; readonly deployedAtBlock: number; readonly exit?: { readonly delaySeconds: number } }
/** The pools whose notes can leave alone. */
export const exitablePools = (): readonly ExitPool[] => (deployment.pools as readonly ExitPool[]).filter((p) => p.exit !== undefined);

/** A public client over `fetchFn`, its concurrent reads batched into one Multicall3 call. */
export const exitClient = (fetchFn: typeof globalThis.fetch): PublicClient => createPublicClient({
  chain: { ...ARC, contracts: { multicall3: { address: MULTICALL3 } } },
  batch: { multicall: true },
  transport: http(deployment.network.rpcUrl, { fetchFn, timeout: 60_000, retryCount: 1 }),
}) as PublicClient;

export interface ExitCall { readonly to: `0x${string}`; readonly data: Hex }

/** The exit of `recipient`'s notes, read and built through `client`. */
export function ringExit(client: PublicClient, recipient: `0x${string}`) {
  const verifiers = new Map<string, `0x${string}`>();
  const verifierOf = async (pool: `0x${string}`) => {
    let v = verifiers.get(pool);
    if (v === undefined) verifiers.set(pool, (v = await client.readContract({ address: pool, abi: POOL, functionName: 'verifier' })));
    return v;
  };
  const claimOf = async (pool: `0x${string}`, secret: Hex) => {
    const context = await client.readContract({ address: pool, abi: POOL, functionName: 'paymentContext', args: [recipient] });
    return keccak256(encodeAbiParameters([{ type: 'bytes16' }, { type: 'bytes32' }], [secret, context]));
  };
  return {
    /** Spent, or when it pays (undefined: not announced). */
    async state(pool: `0x${string}`, secret: Hex, nullifier: Hex): Promise<{ readonly spent: boolean; readonly payableAt?: number }> {
      const [spent, verifier, claim] = await Promise.all([
        client.readContract({ address: pool, abi: POOL, functionName: 'isNullifierSpent', args: [nullifier] }),
        verifierOf(pool), claimOf(pool, secret),
      ]);
      const [at, delay] = await Promise.all([
        client.readContract({ address: verifier, abi: VERIFIER, functionName: 'announcedAt', args: [nullifier, claim] }),
        client.readContract({ address: verifier, abi: VERIFIER, functionName: 'exitDelay' }),
      ]);
      return at === 0n ? { spent } : { spent, payableAt: Number(at + delay) };
    },
    async announceCall(pool: `0x${string}`, secret: Hex, nullifier: Hex): Promise<ExitCall> {
      return { to: await verifierOf(pool), data: encodeFunctionData({ abi: VERIFIER, functionName: 'announceExit', args: [nullifier, await claimOf(pool, secret)] }) };
    },
    /** Any seven other deposits make the ring: the exit names its note anyway. */
    async withdrawCall(pool: ExitPool, commitment: Hex, secret: Hex): Promise<ExitCall> {
      const logs = await client.getLogs({ address: pool.address, event: DEPOSITED, fromBlock: BigInt(pool.deployedAtBlock) });
      const others = [...new Set(logs.map((l) => (l.args.commitment as Hex).toLowerCase() as Hex))].filter((c) => c !== commitment.toLowerCase()).slice(0, 7);
      if (others.length < 7) throw new Error('the pool holds fewer than eight deposits');
      return {
        to: pool.address,
        data: encodeFunctionData({ abi: POOL, functionName: 'spend', args: [[commitment, ...others], concat([EXIT_TAG, secret]), recipient, `0x${'00'.repeat(32)}`] }),
      };
    },
  };
}
