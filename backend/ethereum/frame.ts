// FramePQAccount's frame transactions on the EIP-8141 alt-mempool devnet,
// for Node (ethereum/frame-tx.ts) and the browser (the wallet's devnet page)
// alike: no node: imports, keys passed in, never stored here.
//
// Every transaction an account sends is VERIFY + SENDER frames, and its one
// signature is FORS+C: an ARBITRARY entry whose bytes the protocol elides from
// the signature hash, so it can sign the whole transaction, frames included.
// An account comes into being through its factory, which pays for that
// transaction itself, so no step anywhere needs an ECDSA key.

import { getProfile } from '@forshtat/hegota-support/profiles';
import { rpc, toWire } from '@forshtat/hegota-support/rpc';
import { frame, newTx, sigHash, txHash, type Frame, type FrameTx } from '@forshtat/hegota-support/tx';
import { encodeSignature, keyGen, pkCommitment, sign } from '@opaque/pq-wallet';
import type { Bytes32 } from '@opaque/protocol-types';
import { concat, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, parseAbi, stringToHex, type Address, type Hex } from 'viem';

import devnet from '../../deployments/eth-devnet.json' with { type: 'json' };

export { devnet };
// For the wallet's page, which has no viem of its own.
export { encodeFunctionData, formatEther, isAddress, parseAbi, parseEther } from 'viem';
export const profile = getProfile('ethrex-eip8141-tracer');
/** FramePQAccount's parameter set: 8 uses at 128 bits, and inside MAX_VERIFY_GAS (contracts/test/LeanFors.t.sol). */
export const PARAMS = { k: 13, a: 13 } as const;
export const MAX_USES = 8n;
/** An account's nonce after its constructor: 1, plus HegotaSupport's seven helpers. */
export const FIRST_NONCE = 8n;
/** MAX_VERIFY_GAS is 100,000 for VERIFY frames and signature costs together; an ARBITRARY entry costs 100. */
const VERIFY_GAS = 99_000n;
const DOMAIN = keccak256(stringToHex('opaque/v1/eip8141/sighash'));
// The devnet's base fee is 7 wei; this clears it by a wide margin.
export const MAX_FEE = 2_000_000_000n;
/**
 * The tip: 0.1 gwei. Left unset, it would equal MAX_FEE, and every transaction
 * would pay 2 gwei a gas: a swap's ~1.8M gas (a FORS+C signature is ~4 KB of
 * calldata) came to 0.0014 ETH, and creating an account to 0.015. At 0.1 gwei
 * an account is created in seconds for 0.00075; at 0.001 gwei the nodes dropped
 * the transaction.
 */
const TIP = 100_000_000n;
const FEES = { maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: TIP };

export const ACCOUNT_ABI = parseAbi(['function verify()', 'function rotate(bytes32 next)', 'function key() view returns (bytes32)', 'function keyFirstNonce() view returns (uint64)']);
export const FACTORY_ABI = parseAbi(['function verify()', 'function create(bytes32 key) returns (address)', 'function accountOf(bytes32 key) view returns (address)']);
const FAUCET_ABI = parseAbi(['function verify()', 'function drip(address to)']);

export type ForsKey = ReturnType<typeof keyGen>;
/** The account's key from a 32-byte seed. About a second in a browser: it builds 13 trees of 2^13 leaves. */
export const forsKey = (seed: Uint8Array): ForsKey => keyGen(seed, PARAMS);
export const keyOf = (key: ForsKey): Hex => pkCommitment(key.publicKey) as Hex;

/**
 * One JSON-RPC call to the gateway, tried up to 3 times when the network, not
 * the node, fails: a flaky connection should not end a step. Resending a signed
 * transaction is safe, since the node then answers "already known".
 */
export async function call(method: string, params: unknown[] = []): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rpc(devnet.gateway, method, params);
    } catch (e) {
      if ((e as { code?: string }).code !== 'RPC_UNREACHABLE' || attempt === 3) throw e;
      await new Promise((ok) => setTimeout(ok, 1500 * attempt));
    }
  }
}
export const nonceOf = async (a: Address): Promise<bigint> => BigInt(await call('eth_getTransactionCount', [a, 'latest']));
export const balanceOf = async (a: Address): Promise<bigint> => BigInt(await call('eth_getBalance', [a, 'latest']));
export const hasCode = async (a: Address): Promise<boolean> => (await call('eth_getCode', [a, 'latest'])) !== '0x';
export const txUrl = (hash: Hex): string => `${devnet.explorer}/tx/${hash}`;
const view = async (a: Address, functionName: 'key' | 'keyFirstNonce'): Promise<Hex> =>
  call('eth_call', [{ to: a, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName }) }, 'latest']);
/** The key that signs for the account now, and the first nonce it signs. */
export const keyNow = async (a: Address): Promise<{ key: Hex; first: bigint }> => {
  const [key, first] = await Promise.all([view(a, 'key'), view(a, 'keyFirstNonce')]);
  return { key, first: BigInt(first) };
};

/** The i-th key a server draws from its master secret, under `label`: the devnet stack's own account. */
export const seededKey = (master: Hex, label: string, i: number): ForsKey =>
  forsKey(keccak256(concat([stringToHex(`opaque/v1/devnet/${label}`), master, numberToHex(i, { size: 4 })]), 'bytes'));

/**
 * Which of an account's keys, `keyAt(0)`, `keyAt(1)`…, it answers to now. Each
 * key's last signature hands over to the next (accountTx's `next`), so the
 * first nonce names the key; `known` keys are checked before any is drawn,
 * since drawing one takes about a second.
 */
export async function keyFor(account: Address, keyAt: (i: number) => ForsKey, known: readonly { key: ForsKey; i: number }[] = []): Promise<{ key: ForsKey; i: number; first: bigint }> {
  const now = await keyNow(account);
  const is = (k: ForsKey) => keyOf(k).toLowerCase() === now.key.toLowerCase();
  const hit = known.find((k) => is(k.key));
  if (hit !== undefined) return { ...hit, first: now.first };
  const guess = (now.first - FIRST_NONCE) % MAX_USES === 0n ? Number((now.first - FIRST_NONCE) / MAX_USES) : 0;
  for (const i of [guess, ...Array.from({ length: 16 }, (_, j) => j).filter((j) => j !== guess)]) {
    const key = keyAt(i);
    if (is(key)) return { key, i, first: now.first };
  }
  throw new Error(`${account} answers to none of the first 16 keys`);
}

export interface FrameReceipt {
  status: Hex; blockNumber: Hex; gasUsed: Hex; effectiveGasPrice: Hex; payer?: Address;
  logs: { address: Address; topics: [Hex, ...Hex[]]; data: Hex }[];
  frameReceipts?: { status: Hex; gasUsed: Hex }[];
}
/**
 * The receipt. The devnet's mempool has dropped transactions it accepted (one
 * of ten frames, then one of six, on 6 November: gone from both nodes, nonce
 * unused), so one this process sent goes out again, the same bytes, every 20 s
 * until it is mined. The same bytes: signing anew would spend another of a
 * few-time key's signatures on the same nonce.
 */
export async function mined(hash: Hex, wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms))): Promise<FrameReceipt> {
  for (let i = 0; i < 90; i++) {
    const r = await call('eth_getTransactionReceipt', [hash]);
    if (r) { broadcast.delete(hash); return r; }
    const wire = broadcast.get(hash);
    if (wire !== undefined && i % 10 === 9) await rebroadcast(wire);
    await wait(2000);
  }
  throw new Error(`${hash} was not mined in 3 minutes`);
}
/** The receipt, or an error naming the first frame that did not succeed. */
export async function settled(hash: Hex): Promise<FrameReceipt> {
  const r = await mined(hash);
  const failed = (r.frameReceipts ?? []).findIndex((f) => f.status !== '0x1');
  if (failed >= 0) throw new Error(`frame ${failed} of ${hash} failed: ${txUrl(hash)}`);
  return r;
}

/**
 * A drip from one of Opaque's devnet faucets (contracts/frame/DevnetFaucet,
 * TokenFaucet): the faucet is the transaction's sender and pays for it, so
 * nothing signs. Once an hour per address.
 */
async function drip(faucet: Address, to: Address): Promise<Hex> {
  const hash = await send(newTx({
    chainId: devnet.chainId,
    sender: faucet,
    nonceSeq: await nonceOf(faucet),
    frames: [
      frame(profile, 'VERIFY', { scope: 'EXECUTION_AND_PAYMENT', target: null, execution: 60_000n, data: encodeFunctionData({ abi: FAUCET_ABI, functionName: 'verify' }) }),
      // Its record of `to` is a new storage slot, and `to` may be a new account: state gas.
      frame(profile, 'SENDER', { target: faucet, execution: 300_000n, state: 400_000n, data: encodeFunctionData({ abi: FAUCET_ABI, functionName: 'drip', args: [to] }) }),
    ],
    signatures: [],
    fees: FEES,
  }));
  await settled(hash);
  return hash;
}

/**
 * Devnet ETH for `to`: the devnet's own faucet (1 ETH, once an hour per
 * address), or, when that one is dry, Opaque's (0.05 ETH).
 */
export async function faucet(to: Address): Promise<Hex> {
  let hash: Hex;
  try {
    hash = (await call('skandha_explorer_faucet', [to])).txHash;
  } catch (e) {
    const ours = (devnet.contracts as { faucet?: Address | null }).faucet;
    if (!/empty/i.test((e as Error).message) || !ours) throw e;
    return drip(ours, to);
  }
  const r = await mined(hash);
  if (r.status !== '0x1') throw new Error(`the faucet's transfer ${hash} reverted`);
  return hash;
}

/** 100 test pqUSDC for `to`, for the privacy pools (contracts/frame/TokenFaucet). */
export function pqUSDCFaucet(to: Address): Promise<Hex> {
  const f = (devnet as unknown as { privacy?: { faucet?: Address } }).privacy?.faucet;
  if (f === undefined) throw new Error('no pqUSDC faucet on the devnet yet: node ethereum/frame-tx.ts privacy');
  return drip(f, to);
}

const factoryAddress = (): Address => {
  const factory = (devnet.contracts as { factory: Address | null }).factory;
  if (factory === null) throw new Error('no account factory on the devnet yet: node ethereum/frame-tx.ts factory');
  return factory;
};

/** Where the factory creates (or created) the account for `key`. */
export async function accountOf(key: Hex): Promise<Address> {
  const data = encodeFunctionData({ abi: FACTORY_ABI, functionName: 'accountOf', args: [key] });
  const out: Hex = await call('eth_call', [{ to: factoryAddress(), data }, 'latest']);
  return decodeFunctionResult({ abi: FACTORY_ABI, functionName: 'accountOf', data: out });
}

/**
 * Into the alt mempool. The gateway is its front door and relays to the miner
 * over p2p; when that relay dropped (6 November) a transaction sat in the
 * gateway unmined while the miner, given it directly, mined it at once. So it
 * goes to both: whichever hears first, the other answers "already known".
 */
/** What this process sent and has not seen mined, by hash: mined() sends it again. */
const broadcast = new Map<Hex, unknown>();
const rebroadcast = (wire: unknown) => Promise.allSettled([
  call('eth_sendFrameTransaction', [wire]),
  rpc(`${devnet.miner}/rpc`, 'eth_sendFrameTransaction', [wire]),
]);

async function send(tx: FrameTx): Promise<Hex> {
  const wire = toWire(tx);
  broadcast.set(txHash(profile, tx), wire);
  const [gateway, miner] = await rebroadcast(wire);
  if (gateway.status === 'fulfilled') return gateway.value;
  if (miner.status === 'fulfilled') return miner.value;
  // A retry of a send that did arrive: both nodes know it already.
  if (/already known/i.test(String((gateway.reason as Error)?.message))) return txHash(profile, tx);
  // The gateway runs the admission rules, so its reason is the one worth showing.
  broadcast.delete(txHash(profile, tx));
  throw gateway.reason;
}

/** Creates the account for `key`, in a transaction the factory pays for. Nothing signs it. */
export async function createAccount(key: Hex): Promise<Hex> {
  const factory = factoryAddress();
  return send(newTx({
    chainId: devnet.chainId,
    sender: factory,
    nonceSeq: await nonceOf(factory),
    frames: [
      frame(profile, 'VERIFY', { scope: 'EXECUTION_AND_PAYMENT', target: null, execution: 60_000n, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: 'verify' }) }),
      // The account's code and HegotaSupport's helpers cost state gas (EIP-8037), about 9M.
      frame(profile, 'SENDER', { target: factory, execution: 3_000_000n, state: 12_000_000n, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: 'create', args: [key] }) }),
    ],
    signatures: [],
    fees: FEES,
  }));
}

/** What a SENDER frame of the account does: a call, with value if any. */
export interface Call { to: Address; data?: Hex; value?: bigint; gas?: bigint; state?: bigint }

/**
 * The account's next transaction: its VERIFY frame, then one SENDER frame per
 * call, signed by `key` alone. `atomic` runs the calls as one batch, all or none.
 * `next` hands the account to that key from the next nonce on (rotate), in a
 * frame of its own ahead of the calls: a call that reverts cannot undo it, so
 * a key's last signature always leaves the account a key that can sign.
 */
export async function accountTx(account: Address, key: ForsKey, calls: readonly Call[], atomic = false, next?: Hex): Promise<FrameTx> {
  const [nonce, { first }] = await Promise.all([nonceOf(account), keyNow(account)]);
  if (nonce - first >= MAX_USES) throw new Error(`this key has signed ${MAX_USES} times`);
  const tx = newTx({
    chainId: devnet.chainId,
    sender: account,
    nonceSeq: nonce,
    frames: [
      frame(profile, 'VERIFY', { scope: 'EXECUTION_AND_PAYMENT', target: null, execution: VERIFY_GAS, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'verify' }) }),
      ...(next === undefined ? [] : [frame(profile, 'SENDER', { target: null, execution: 100_000n, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'rotate', args: [next] }) })]),
      ...calls.map((c, i): Frame => frame(profile, 'SENDER', {
        target: c.to, execution: c.gas ?? 200_000n, state: c.state ?? 0n, value: c.value ?? 0n, data: c.data ?? '0x',
        // Every frame of the batch but its last carries the flag.
        flags: atomic && i < calls.length - 1 ? profile.flagBits['ATOMIC_BATCH']! : 0,
      })),
    ],
    // ARBITRARY, empty msg: the protocol elides these bytes from the signature hash.
    signatures: [{ scheme: profile.sigSchemes['ARBITRARY']!, signer: '0x', msg: '0x', signature: '0x' }],
    fees: FEES,
  });
  const digest = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [DOMAIN, sigHash(profile, tx)]));
  const signature = encodeSignature(key.publicKey, sign(key.secretKey, digest as Bytes32)) as Hex;
  return { ...tx, signatures: [{ ...tx.signatures[0]!, signature }] };
}

/** Signs and sends the account's next transaction; resolves to its hash. */
export const sendCalls = async (account: Address, key: ForsKey, calls: readonly Call[], atomic = false, next?: Hex): Promise<Hex> =>
  send(await accountTx(account, key, calls, atomic, next));
