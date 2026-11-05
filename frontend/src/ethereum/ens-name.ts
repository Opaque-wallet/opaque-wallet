// A name in Send's "To": ENSv2 on Sepolia answers with the name's address on the
// devnet (ENSIP-11: coin type 0x80000000 | chainId), through ENS's own
// UniversalResolverV2, as any ENS client would ask. A public Sepolia RPC learns
// which name was looked up; never who pays it, nor how much, nor when.
//
// `pq` says the name is held by our PQNameController (deployments/eth-sepolia.json
// `ens`): a name only a FORS+C signature can change, records included.

import { decodeFunctionResult, devnet, encodeFunctionData, labelhash, namehash, parseAbi } from '../../../backend/ethereum/frame.ts';
import sepolia from '../../../deployments/eth-sepolia.json' with { type: 'json' };

const ENS = sepolia.ens as { ethRegistry: `0x${string}`; universalResolverV2: `0x${string}`; controller: `0x${string}` };
const RPCS = [sepolia.network.rpcUrl, ...sepolia.network.rpcFallbacks];
const COIN = 0x80000000n | BigInt(devnet.chainId);
const UR = parseAbi(['function resolve(bytes name, bytes data) view returns (bytes, address)']);
const PROFILE = parseAbi(['function addr(bytes32 node, uint256 coinType) view returns (bytes)']);
const REGISTRY = parseAbi(['function getTokenId(uint256) view returns (uint256)', 'function ownerOf(uint256) view returns (address)']);

/** A .eth name, as Send takes one. */
export const isName = (text: string): boolean => /^([a-z0-9-]+\.)+eth$/i.test(text.trim());

/** DNS wire format: each label length-prefixed, then 0. */
function dnsEncode(name: string): `0x${string}` {
  const bytes = name.split('.').flatMap((label) => { const b = new TextEncoder().encode(label); return [b.length, ...b]; });
  return `0x${[...bytes, 0].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function ethCall(to: `0x${string}`, data: `0x${string}`): Promise<`0x${string}`> {
  let last: unknown;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }), signal: AbortSignal.timeout(10_000) });
      const body = await res.json() as { result?: `0x${string}`; error?: { message: string } };
      if (body.result !== undefined) return body.result;
      last = new Error(body.error?.message ?? 'no answer');
      // A revert is the name's answer, not the RPC's: another RPC would say the same.
      if (/revert/i.test(String(body.error?.message))) break;
    } catch (error) { last = error; }
  }
  throw last instanceof Error ? last : new Error('Sepolia did not answer');
}

/** The name's devnet address, and whether a FORS+C key holds the name. */
export async function resolveName(name: string): Promise<{ address: `0x${string}`; pq: boolean }> {
  const n = name.trim().toLowerCase();
  const out = await ethCall(ENS.universalResolverV2, encodeFunctionData({
    abi: UR, functionName: 'resolve',
    args: [dnsEncode(n), encodeFunctionData({ abi: PROFILE, functionName: 'addr', args: [namehash(n), COIN] })],
  })).catch(() => { throw new Error(`${n} has no ENS records`); });
  const [record] = decodeFunctionResult({ abi: UR, functionName: 'resolve', data: out });
  const bytes = decodeFunctionResult({ abi: PROFILE, functionName: 'addr', data: record });
  if (bytes.length !== 42) throw new Error(`${n} has no address on the devnet`);
  // Held by our controller: a second-level .eth name whose token it owns.
  const labels = n.split('.');
  let pq = false;
  if (labels.length === 2) {
    const id = decodeFunctionResult({ abi: REGISTRY, functionName: 'getTokenId', data: await ethCall(ENS.ethRegistry, encodeFunctionData({ abi: REGISTRY, functionName: 'getTokenId', args: [BigInt(labelhash(labels[0]!))] })) });
    const owner = decodeFunctionResult({ abi: REGISTRY, functionName: 'ownerOf', data: await ethCall(ENS.ethRegistry, encodeFunctionData({ abi: REGISTRY, functionName: 'ownerOf', args: [id] })) });
    pq = owner.toLowerCase() === ENS.controller.toLowerCase();
  }
  return { address: bytes as `0x${string}`, pq };
}
