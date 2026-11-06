// Private ETH on Sepolia: the same exitable pools as tUSDC's (sepolia-deploy.ts steps 4
// and 5), holding WETH. PrivatePool takes any ERC-20, so this is a deployment, not new
// code: an AttestedRingVerifier and ExitableRingVerifier per size, bound to the pool
// before it exists, and each ring seeded with eight decoys whose secrets nobody keeps
// (ETH wrapped to WETH first). Pools land in deployments/eth-sepolia.json with
// `asset: "eth"`, so the stack serves them like the rest and the wallet tells them apart.
//
//   node --use-system-ca ethereum/weth-pools.ts         resumable

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { poolId } from '@opaque/protocol-types/codecs.js';
import { createPublicClient, createWalletClient, encodeFunctionData, formatEther, getContractAddress, http, nonceManager, parseAbi, parseEther, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { createNoteSecret, deriveCommitment } from '../zk/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, '..', '..', 'deployments', 'eth-sepolia.json');
const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
/** Sepolia's WETH9 (Uniswap's), the token the ETH pools hold. */
export const WETH: Address = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
/** Note sizes in ETH: small, so a faucet's 0.03 ETH makes a few notes and eight decoys a ring fit. */
const SIZES = ['0.0005', '0.001', '0.005'] as const;
const EXIT_DELAY = 300n;
const nameOf = (size: string) => `attestedRingVerifierEth${size.replace('.', '_')}`;

const deployer = privateKeyToAccount(readFileSync(join(HERE, '..', '.stack', 'eth-sepolia', 'deployer.key'), 'utf8').trim() as Hex, { nonceManager });
const pub = createPublicClient({ chain: sepolia, transport: http(RPC, { retryCount: 4, retryDelay: 1_500 }) });
const wallet = createWalletClient({ account: deployer, chain: sepolia, transport: http(RPC) });
const artifact = (name: string): { abi: Abi; bytecode: { object: Hex } } =>
  JSON.parse(readFileSync(join(HERE, '..', '..', 'contracts', 'out', `${name}.sol`, `${name}.json`), 'utf8'));
const d = JSON.parse(readFileSync(FILE, 'utf8'));
const save = () => writeFileSync(FILE, `${JSON.stringify(d, null, 2)}\n`);
const tx = (hash: Hex) => `https://sepolia.etherscan.io/tx/${hash}`;

async function deploy(name: string, args: readonly unknown[], nonce: number, gas?: bigint): Promise<{ address: Address; block: number }> {
  const a = artifact(name);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, nonce, ...(gas === undefined ? {} : { gas }) } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${name} reverted: ${tx(hash)}`);
  const address = r.contractAddress!.toLowerCase() as Address;
  // A load-balanced RPC a block behind has no code here yet: wait it out.
  for (let i = 0; i < 40 && ((await pub.getCode({ address }).catch(() => undefined)) ?? '0x') === '0x'; i++) await new Promise((res) => setTimeout(res, 3_000));
  return { address, block: Number(r.blockNumber) };
}
async function send(to: Address, data: Hex, what: string, value = 0n): Promise<void> {
  const hash = await wallet.sendTransaction({ to, data, value } as never);
  if ((await pub.waitForTransactionReceipt({ hash })).status !== 'success') throw new Error(`${what} reverted: ${tx(hash)}`);
  console.log(`${what}: ${tx(hash)}`);
}

console.log(`deployer ${deployer.address}: ${formatEther(await pub.getBalance({ address: deployer.address }))} ETH`);
d.tokens.weth = { $comment: "Sepolia's WETH9 (Uniswap's): what the ETH pools hold, so ETH can be private. No value.", address: WETH, decimals: 18 };
save();

for (const size of SIZES) {
  const denomination = Number(parseEther(size));
  if (d.pools.some((p: { asset?: string; denomination: number }) => p.asset === 'eth' && p.denomination === denomination)) continue;
  const nonce = await pub.getTransactionCount({ address: deployer.address, blockTag: 'pending' });
  const predicted = getContractAddress({ from: deployer.address, nonce: BigInt(nonce + 2) }).toLowerCase() as Address;
  const id = poolId({ chainId: BigInt(sepolia.id), pool: predicted, denomination } as never);
  const a = await deploy('AttestedRingVerifier', [d.contracts.pqKeyRegistry.address, d.accounts.attester, id, BigInt(denomination)], nonce);
  const v = await deploy('ExitableRingVerifier', [a.address, predicted, EXIT_DELAY], nonce + 1, 12_000_000n);
  const p = await deploy('PrivatePool', [WETH, BigInt(denomination), v.address], nonce + 2);
  if (p.address !== predicted) throw new Error(`the ${size} ETH pool landed at ${p.address}, not ${predicted}`);
  d.contracts[nameOf(size)] = { address: v.address, deployedAtBlock: v.block };
  d.pools.push({ address: p.address, denomination, proofMode: 'RING_8', verifier: nameOf(size), deployedAtBlock: p.block, decoys: 0, asset: 'eth', token: WETH, exit: { attested: a.address, delaySeconds: Number(EXIT_DELAY) } });
  save();
  console.log(`${size} ETH: pool ${p.address}, exitable verifier ${v.address}`);
}

// Eight decoys a ring, made as real notes are, their secrets dropped: ETH wrapped, approved, deposited.
const WETH_ABI = parseAbi(['function deposit() payable', 'function approve(address spender, uint256 value) returns (bool)']);
const POOL = parseAbi(['function deposit(bytes32 commitment)']);
for (const p of d.pools as { address: Address; denomination: number; decoys?: number; asset?: string }[]) {
  if (p.asset !== 'eth' || p.decoys === 8) continue;
  const total = 8n * BigInt(p.denomination);
  await send(WETH, encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit' }), `wrap ${formatEther(total)} ETH`, total);
  await send(WETH, encodeFunctionData({ abi: WETH_ABI, functionName: 'approve', args: [p.address, total] }), `approve the ${formatEther(BigInt(p.denomination))} ETH pool`);
  const hashes: Hex[] = [];
  for (let i = 0; i < 8; i++) {
    const commitment = deriveCommitment(createNoteSecret(), { chainId: BigInt(sepolia.id), pool: p.address, denomination: p.denomination } as never);
    hashes.push(await wallet.sendTransaction({ to: p.address, data: encodeFunctionData({ abi: POOL, functionName: 'deposit', args: [commitment as Hex] }), gas: 400_000n } as never));
  }
  for (const h of hashes) if ((await pub.waitForTransactionReceipt({ hash: h })).status !== 'success') throw new Error(`a decoy deposit reverted: ${tx(h)}`);
  p.decoys = 8;
  save();
  console.log(`${formatEther(BigInt(p.denomination))} ETH ring seeded`);
}
console.log(`deployer left with ${formatEther(await pub.getBalance({ address: deployer.address }))} ETH; written to deployments/eth-sepolia.json`);
process.exit(0);
