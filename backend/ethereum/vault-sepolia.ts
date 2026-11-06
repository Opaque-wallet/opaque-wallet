// The Q-Day vault on Sepolia (contracts/src/ethereum/vault/PQVault.sol), deployed and
// shown on chain with the real PQKeyRegistry and real FORS+C signatures. The wallet is
// our deployer: an ordinary ECDSA wallet, like MetaMask's, whose guard key it registered
// for the Uniswap guard (uniswap-sepolia.ts) guards its vault too.
//
//   1. it deposits ETH into the vault;
//   2. its ECDSA key with another key's FORS+C signature: refused (BadSignature);
//   3. the real signature replayed to a front-runner's address: refused;
//   4. the signed withdrawal pays only the recipient it names.
//
//   OPAQUE_NETWORK=sepolia node --use-system-ca ethereum/vault-sepolia.ts

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, formatEther, http, keccak256, parseAbi, parseAbiParameters, parseEther, toHex, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { encodeSignature, forsSchemeId, pqDigest, sign } from '@opaque/pq-wallet';
import type { Bytes32 } from '@opaque/protocol-types';

import { deployment, requireContract } from '../../deployments/index.ts';
import { userActionPayload } from '../../packages/pq-wallet/src/registry.ts';
import { currentKey, masterKey, REGISTRY_ABI } from './ens/ens.ts';

if (deployment.network.chainId !== sepolia.id) throw new Error('run with OPAQUE_NETWORK=sepolia');
const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '.stack', 'eth-sepolia');
const FILE = join(HERE, '..', '..', 'deployments', 'eth-sepolia.json');
const rpc = http(deployment.network.rpcUrl, { retryCount: 4, retryDelay: 1_500 });
const pub = createPublicClient({ chain: sepolia, transport: rpc });
const deployer = privateKeyToAccount(readFileSync(join(DIR, 'deployer.key'), 'utf8').trim() as Hex);
const eoa = createWalletClient({ account: deployer, chain: sepolia, transport: rpc });
const REGISTRY = requireContract('pqKeyRegistry') as Address;
const VAULT_ABI = parseAbi([
  'function deposit(address token, uint256 amount) payable',
  'function withdraw(address owner, address token, uint256 amount, address to, uint256 deadline, bytes signature)',
  'function balanceOf(address owner, address token) view returns (uint256)',
]);
const ETH = '0x0000000000000000000000000000000000000000' as Address;
const tx = (h: Hex) => `https://sepolia.etherscan.io/tx/${h}`;
const log = (s: string) => console.log(s);

async function send(to: Address | undefined, data: Hex, value = 0n): Promise<{ hash: Hex; address?: Address }> {
  const hash = await eoa.sendTransaction({ ...(to ? { to } : {}), data, value } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`reverted: ${tx(hash)}`);
  return { hash, ...(r.contractAddress ? { address: r.contractAddress.toLowerCase() as Address } : {}) };
}
async function until(what: string, test: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 40; i++) { if (await test().catch(() => false)) return; await new Promise((r) => setTimeout(r, 3_000)); }
  throw new Error(`timed out: ${what}`);
}
/**
 * eth_call as the deployer: undefined if it would succeed, else the raw revert data.
 * A load-balanced RPC's node behind a fresh deploy has no code at `to`, and a call to an
 * empty address "succeeds": a success is asked again a few times before it is believed.
 */
async function revertData(to: Address, data: Hex): Promise<Hex | undefined> {
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from: deployer.address, to, data, gas: toHex(3_000_000n) }, 'latest'] };
  for (let i = 0; i < 6; i++) {
    const r = await (await fetch(deployment.network.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as { error?: { data?: Hex } };
    if (r.error !== undefined) return r.error.data ?? '0x';
    await new Promise((res) => setTimeout(res, 3_000));
  }
  return undefined;
}
const carries = (data: Hex, signature: string) => data.includes(keccak256(new TextEncoder().encode(signature)).slice(2, 10));

// The vault, once.
const d = JSON.parse(readFileSync(FILE, 'utf8'));
let vault = d.vault?.address as Address | undefined;
if (vault === undefined) {
  const a = JSON.parse(readFileSync(join(HERE, '..', '..', 'contracts', 'out', 'PQVault.sol', 'PQVault.json'), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  const hash = await eoa.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args: [REGISTRY] } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`PQVault reverted: ${tx(hash)}`);
  vault = r.contractAddress!.toLowerCase() as Address;
  await until('the vault\'s code', async () => ((await pub.getCode({ address: vault! })) ?? '0x') !== '0x');
  d.vault = { $comment: 'The Q-Day vault (contracts/src/ethereum/vault/PQVault.sol): any wallet keeps ETH or tokens here that only its FORS+C key in PQKeyRegistry can take out.', address: vault, deployedAtBlock: Number(r.blockNumber) };
  writeFileSync(FILE, `${JSON.stringify(d, null, 2)}\n`);
  log(`PQVault ${vault}: ${tx(hash)}`);
}

// Its guard key: the one this ECDSA wallet registered for the Uniswap guard.
const keyFile = join(DIR, 'uniswap-guard.master');
if (!existsSync(keyFile)) throw new Error('run uniswap-sepolia.ts first: it registers this wallet\'s guard key');
const master = Buffer.from(readFileSync(keyFile, 'utf8').trim().slice(2), 'hex');
const stateOf = async () => pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'stateOf', args: [deployer.address] }) as Promise<{ pkCommitment: Hex; useCount: bigint }>;
// The generation in force, handed over first if it has signed 7 times: no key signs a 9th.
const key = await currentKey({ master, label: 'opaque/v1/uniswap/guard', account: deployer.address, chainId: BigInt(sepolia.id), registry: REGISTRY, stateOf, send: (to, data) => send(to, data) });

// 1. Into the vault, with the wallet's ordinary ECDSA transaction.
const amount = parseEther('0.001');
const before = await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: 'balanceOf', args: [deployer.address, ETH] });
if (before < amount) {
  const put = await send(vault, encodeFunctionData({ abi: VAULT_ABI, functionName: 'deposit', args: [ETH, amount] }), amount);
  await until('the deposit', async () => (await pub.readContract({ address: vault!, abi: VAULT_ABI, functionName: 'balanceOf', args: [deployer.address, ETH] })) >= before + amount);
  log(`the ECDSA wallet ${deployer.address} put ${formatEther(amount)} ETH in the vault: ${tx(put.hash)}`);
} else log(`the vault already holds ${formatEther(before)} ETH for the ECDSA wallet ${deployer.address}`);

const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
const recipient = `0x${randomBytes(20).toString('hex')}` as Address;
const payloadOf = (to: Address) => encodeAbiParameters(parseAbiParameters('string, uint256, address, address, address, uint256, address, uint256'),
  ['opaque/v1/vault/withdraw', BigInt(sepolia.id), vault!, deployer.address, ETH, amount, to, deadline]);
const signWith = async (k: ReturnType<typeof masterKey>, to: Address) => {
  const digest = pqDigest({ chainId: BigInt(sepolia.id) as never, walletAddress: deployer.address.toLowerCase() as never, schemeId: forsSchemeId(k.publicKey.params), useCount: (await stateOf()).useCount, payload: userActionPayload(payloadOf(to)) });
  return encodeSignature(k.publicKey, sign(k.secretKey, digest as Bytes32)) as Hex;
};
const withdrawData = (to: Address, signature: Hex) => encodeFunctionData({ abi: VAULT_ABI, functionName: 'withdraw', args: [deployer.address, ETH, amount, to, deadline, signature] });

// 2. Q-Day: the ECDSA key, with a FORS+C signature from a key of the thief's own.
const forged = await signWith(masterKey(randomBytes(32), 'thief', 0), deployer.address);
const a = await revertData(vault, withdrawData(deployer.address, forged));
if (a === undefined || !carries(a, 'BadSignature()')) throw new Error(`the vault paid out without the guard key's signature, or failed otherwise: ${a}`);
log('withdrawing with the cracked ECDSA key and a FORS+C signature of another key: refused by the registry, BadSignature');
// 3. The owner's real signature, replayed by a front-runner to their own address.
const real = await signWith(key, recipient);
const b = await revertData(vault, withdrawData(deployer.address, real));
if (b === undefined || !carries(b, 'BadSignature()')) throw new Error(`a signature paid an address it does not name, or failed otherwise: ${b}`);
log('the owner\'s signature replayed to the front-runner\'s address: refused by the registry, BadSignature');
// 4. The signed withdrawal, to the recipient it names.
const out = await send(vault, withdrawData(recipient, real));
await until('the recipient\'s ETH', async () => (await pub.getBalance({ address: recipient })) === amount);
log(`the signed withdrawal paid ${recipient} exactly ${formatEther(amount)} ETH, the recipient it signed: ${tx(out.hash)}`);
process.exit(0);
