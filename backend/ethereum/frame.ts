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
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, stringToHex, type Address, type Hex } from 'viem';

import devnet from '../../deployments/eth-devnet.json' with { type: 'json' };

export { devnet };
// For the wallet's page, which has no viem of its own.
export { formatEther, isAddress, parseEther } from 'viem';
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

export const ACCOUNT_ABI = parseAbi(['function verify()', 'function rotate(bytes32 next)', 'function key() view returns (bytes32)']);
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

export interface FrameReceipt { status: Hex; blockNumber: Hex; payer?: Address; frameReceipts?: { status: Hex; gasUsed: Hex }[] }
export async function mined(hash: Hex, wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms))): Promise<FrameReceipt> {
  for (let i = 0; i < 60; i++) {
    const r = await call('eth_getTransactionReceipt', [hash]);
    if (r) return r;
    await wait(2000);
  }
  throw new Error(`${hash} was not mined in 2 minutes`);
}
/** The receipt, or an error naming the first frame that did not succeed. */
export async function settled(hash: Hex): Promise<FrameReceipt> {
  const r = await mined(hash);
  const failed = (r.frameReceipts ?? []).findIndex((f) => f.status !== '0x1');
  if (failed >= 0) throw new Error(`frame ${failed} of ${hash} failed: ${txUrl(hash)}`);
  return r;
}

/**
 * Devnet ETH for `to`: the devnet's own faucet (1 ETH, once an hour per
 * address), or, when that one is dry, Opaque's (contracts/frame/DevnetFaucet:
 * 0.05 ETH, once an hour), which pays for its own transaction, so nothing signs.
 */
export async function faucet(to: Address): Promise<Hex> {
  let hash: Hex;
  try {
    hash = (await call('skandha_explorer_faucet', [to])).txHash;
  } catch (e) {
    const ours = (devnet.contracts as { faucet?: Address | null }).faucet;
    if (!/empty/i.test((e as Error).message) || !ours) throw e;
    hash = await send(newTx({
      chainId: devnet.chainId,
      sender: ours,
      nonceSeq: await nonceOf(ours),
      frames: [
        frame(profile, 'VERIFY', { scope: 'EXECUTION_AND_PAYMENT', target: null, execution: 60_000n, data: encodeFunctionData({ abi: FAUCET_ABI, functionName: 'verify' }) }),
        // Its record of `to` is a new storage slot, and `to` may be a new account: state gas.
        frame(profile, 'SENDER', { target: ours, execution: 300_000n, state: 400_000n, data: encodeFunctionData({ abi: FAUCET_ABI, functionName: 'drip', args: [to] }) }),
      ],
      signatures: [],
      fees: { maxFeePerGas: MAX_FEE },
    }));
    await settled(hash);
    return hash;
  }
  const r = await mined(hash);
  if (r.status !== '0x1') throw new Error(`the faucet's transfer ${hash} reverted`);
  return hash;
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
async function send(tx: FrameTx): Promise<Hex> {
  const wire = toWire(tx);
  const [gateway, miner] = await Promise.allSettled([
    call('eth_sendFrameTransaction', [wire]),
    rpc(`${devnet.miner}/rpc`, 'eth_sendFrameTransaction', [wire]),
  ]);
  if (gateway.status === 'fulfilled') return gateway.value;
  if (miner.status === 'fulfilled') return miner.value;
  // A retry of a send that did arrive: both nodes know it already.
  if (/already known/i.test(String((gateway.reason as Error)?.message))) return txHash(profile, tx);
  // The gateway runs the admission rules, so its reason is the one worth showing.
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
    fees: { maxFeePerGas: MAX_FEE },
  }));
}

/** What a SENDER frame of the account does: a call, with value if any. */
export interface Call { to: Address; data?: Hex; value?: bigint; gas?: bigint; state?: bigint }

/**
 * The account's next transaction: its VERIFY frame, then one SENDER frame per
 * call, signed by `key` alone. `atomic` runs the calls as one batch, all or none.
 */
export async function accountTx(account: Address, key: ForsKey, calls: readonly Call[], atomic = false): Promise<FrameTx> {
  const nonce = await nonceOf(account);
  if (nonce - FIRST_NONCE >= MAX_USES) throw new Error(`this key has signed ${MAX_USES} times: rotate it`);
  const tx = newTx({
    chainId: devnet.chainId,
    sender: account,
    nonceSeq: nonce,
    frames: [
      frame(profile, 'VERIFY', { scope: 'EXECUTION_AND_PAYMENT', target: null, execution: VERIFY_GAS, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'verify' }) }),
      ...calls.map((c, i): Frame => frame(profile, 'SENDER', {
        target: c.to, execution: c.gas ?? 200_000n, state: c.state ?? 0n, value: c.value ?? 0n, data: c.data ?? '0x',
        // Every frame of the batch but its last carries the flag.
        flags: atomic && i < calls.length - 1 ? profile.flagBits['ATOMIC_BATCH']! : 0,
      })),
    ],
    // ARBITRARY, empty msg: the protocol elides these bytes from the signature hash.
    signatures: [{ scheme: profile.sigSchemes['ARBITRARY']!, signer: '0x', msg: '0x', signature: '0x' }],
    fees: { maxFeePerGas: MAX_FEE },
  });
  const digest = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [DOMAIN, sigHash(profile, tx)]));
  const signature = encodeSignature(key.publicKey, sign(key.secretKey, digest as Bytes32)) as Hex;
  return { ...tx, signatures: [{ ...tx.signatures[0]!, signature }] };
}

/** Signs and sends the account's next transaction; resolves to its hash. */
export const sendCalls = async (account: Address, key: ForsKey, calls: readonly Call[], atomic = false): Promise<Hex> =>
  send(await accountTx(account, key, calls, atomic));
