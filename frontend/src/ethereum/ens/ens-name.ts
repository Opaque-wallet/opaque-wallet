// A name in Send's "To": ENSv2 on Sepolia answers with the name's address on the
// devnet (ENSIP-11: coin type 0x80000000 | chainId), through ENS's own
// UniversalResolverV2, as any ENS client would ask. In the browser every lookup
// goes through EF's anon-rpc (lib/anon-rpc.ts, the Nox mixnet): the public RPC
// learns a name was looked up, never by whom. Node (scripts, tests) asks directly.
//
// `pq` says the name is held by our PQNameController (deployments/eth-sepolia.json
// `ens`): a name only a FORS+C signature can change, records included; or that it
// is a name.opaque.eth, which OpaqueNames lets only an Opaque PQ account hold.

import { decodeFunctionResult, devnet, encodeFunctionData, labelhash, namehash, parseAbi } from '../../../../backend/ethereum/frame.ts';
import sepolia from '../../../../deployments/eth-sepolia.json' with { type: 'json' };

export const ENS = sepolia.ens as { ethRegistry: `0x${string}`; universalResolverV2: `0x${string}`; controller: `0x${string}`; resolver: `0x${string}`; pqKeyRegistry: `0x${string}`; names?: `0x${string}` };
const RPCS = [sepolia.network.rpcUrl, ...sepolia.network.rpcFallbacks];
/** ENSIP-11 coin types: the devnet's (0x80000000 | its chain id), and Ethereum's, 60, which ENS's app shows on Sepolia too. */
export const DEVNET_COIN = 0x80000000n | BigInt(devnet.chainId);
export const ETHEREUM_COIN = 60n;
const UR = parseAbi(['function resolve(bytes name, bytes data) view returns (bytes, address)']);
const PROFILE = parseAbi(['function addr(bytes32 node, uint256 coinType) view returns (bytes)']);
const REGISTRY = parseAbi(['function getTokenId(uint256) view returns (uint256)', 'function ownerOf(uint256) view returns (address)']);

/** A .eth name, as Send takes one. */
export const isName = (text: string): boolean => /^([a-z0-9-]+\.)+eth$/i.test(text.trim());

/** DNS wire format: each label length-prefixed, then 0. */
export function dnsEncode(name: string): `0x${string}` {
  const bytes = name.split('.').flatMap((label) => { const b = new TextEncoder().encode(label); return [b.length, ...b]; });
  return `0x${[...bytes, 0].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const IN_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';
/** A call the chain ran and reverted (it carries revert data, or says so), not one that never got an answer. */
const reverted = (error: unknown): boolean => (error as { data?: unknown }).data !== undefined || /revert/i.test(String((error as Error).message));

export async function ethCall(to: `0x${string}`, data: `0x${string}`): Promise<`0x${string}`> {
  if (IN_BROWSER) {
    const { anonRpc } = await import('../../lib/anon-rpc.ts');
    // The mixnet drops a request now and then: tried again, but never a revert, which is the call's answer.
    for (let attempt = 1; ; attempt++) {
      try { return await anonRpc<`0x${string}`>(RPCS[0]!, 'eth_call', [{ to, data }, 'latest']); } catch (error) {
        if (attempt >= 3 || reverted(error)) throw error;
      }
    }
  }
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

/** The name's address for `coin` (the devnet's by default), and whether a FORS+C key holds the name. */
export async function resolveName(name: string, coin = DEVNET_COIN): Promise<{ address: `0x${string}`; pq: boolean }> {
  const n = name.trim().toLowerCase();
  const out = await ethCall(ENS.universalResolverV2, encodeFunctionData({
    abi: UR, functionName: 'resolve',
    args: [dnsEncode(n), encodeFunctionData({ abi: PROFILE, functionName: 'addr', args: [namehash(n), coin] })],
  })).catch((error: unknown) => {
    // A revert is ENS's answer; anything else is the way there failing, and must not read as "no such name".
    throw new Error(reverted(error) ? `${n} has no ENS records` : `could not look ${n} up just now (${(error as Error).message}): try again`);
  });
  const [record] = decodeFunctionResult({ abi: UR, functionName: 'resolve', data: out });
  const bytes = decodeFunctionResult({ abi: PROFILE, functionName: 'addr', data: record });
  if (bytes.length !== 42) throw new Error(`${n} has no address ${coin === DEVNET_COIN ? 'on the devnet' : 'for this chain'}`);
  // Held by our controller: a second-level .eth name whose token it owns.
  const labels = n.split('.');
  let pq = false;
  if (labels.length === 3 && labels[1] === 'opaque' && labels[2] === 'eth') pq = ENS.names !== undefined;
  if (labels.length === 2) {
    const id = decodeFunctionResult({ abi: REGISTRY, functionName: 'getTokenId', data: await ethCall(ENS.ethRegistry, encodeFunctionData({ abi: REGISTRY, functionName: 'getTokenId', args: [BigInt(labelhash(labels[0]!))] })) });
    const owner = decodeFunctionResult({ abi: REGISTRY, functionName: 'ownerOf', data: await ethCall(ENS.ethRegistry, encodeFunctionData({ abi: REGISTRY, functionName: 'ownerOf', args: [id] })) });
    pq = owner.toLowerCase() === ENS.controller.toLowerCase();
  }
  return { address: bytes as `0x${string}`, pq };
}

const NAMES = parseAbi(['function nameOf(address) view returns (string)', 'function holderOf(bytes32) view returns (address)']);
/** The label `account` holds under opaque.eth ('' for none). */
export const opaqueNameOf = async (account: `0x${string}`): Promise<string> =>
  ENS.names === undefined ? '' : decodeFunctionResult({ abi: NAMES, functionName: 'nameOf', data: await ethCall(ENS.names, encodeFunctionData({ abi: NAMES, functionName: 'nameOf', args: [account] })) });
/**
 * The transaction in which `account` claimed its name, and when: OpaqueNames' `Claimed` event,
 * read through anon-rpc like every lookup here. For an Activity that began after the claim.
 */
export async function opaqueClaimOf(account: `0x${string}`): Promise<{ tx: `0x${string}`; at: number } | undefined> {
  if (ENS.names === undefined || !IN_BROWSER) return undefined;
  const { anonRpc } = await import('../../lib/anon-rpc.ts');
  // labelhash is keccak256 of the string, which is what an event's topic 0 is.
  const topics = [labelhash('Claimed(string,address)'), `0x${account.slice(2).toLowerCase().padStart(64, '0')}`];
  const logs = await anonRpc<{ transactionHash: `0x${string}`; blockNumber: `0x${string}` }[]>(RPCS[0]!, 'eth_getLogs', [{ address: ENS.names, topics, fromBlock: '0xb83a00', toBlock: 'latest' }]);
  const last = logs[logs.length - 1];
  if (last === undefined) return undefined;
  const block = await anonRpc<{ timestamp: `0x${string}` }>(RPCS[0]!, 'eth_getBlockByNumber', [last.blockNumber, false]);
  return { tx: last.transactionHash, at: Number(BigInt(block.timestamp)) * 1000 };
}
/** Whether `label`.opaque.eth is free to claim. */
export const opaqueNameFree = async (label: string): Promise<boolean> =>
  /^0x0{64}$/.test(await ethCall(ENS.names!, encodeFunctionData({ abi: NAMES, functionName: 'holderOf', args: [labelhash(label)] })));
