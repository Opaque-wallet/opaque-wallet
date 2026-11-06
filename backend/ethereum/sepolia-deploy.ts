// Opaque on Sepolia, end to end, from this machine: what deployments/eth-sepolia.json
// needs for the wallet (frontend, VITE_NETWORK=sepolia) and its stack (stack.ts,
// OPAQUE_NETWORK=sepolia). Resumable: each step is written to the file as it lands.
//
//   node --use-system-ca ethereum/sepolia-deploy.ts
//
//   1. tUSDC: a 6-decimal test dollar of ours, as the note sizes assume. Circle's
//      Sepolia USDC comes a few at a time from its faucet, and the pools' decoys alone
//      take 1,504; the stack's faucet gives tUSDC and ETH to new wallets.
//   2. The PQ account stack (as script/DeployPQStack.s.sol), on the PQKeyRegistry
//      opaque.eth's controller already uses: one registry for the chain.
//   3. The attester: its own ECDSA key registers its FORS key once and then has no
//      power (as script/DeployRingPool.s.sol); its FORS master stays here.
//   4. A verifier and pool per size (1 to 100), each verifier bound to its pool's id.
//   5. Each ring seeded with eight decoys whose secrets nobody keeps.
//   6. The stack's egress (it pays for settlements and the attester's rotations), funded.
//   7. The account factory's EntryPoint stake (1 ETH), once there is ETH for it.
//
// Keys live in .stack/eth-sepolia/ (0600) and are never printed.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { poolId } from '@opaque/protocol-types/codecs.js';
import { createPublicClient, createWalletClient, encodeFunctionData, formatEther, getContractAddress, http, nonceManager, parseAbi, parseEther, toHex, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { attesterCommitment } from '../cre/attester-keys.ts';
import { createNoteSecret, deriveCommitment } from '../zk/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '.stack', 'eth-sepolia');
const FILE = join(HERE, '..', '..', 'deployments', 'eth-sepolia.json');
const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const ENTRY_POINT: Address = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const SIZES = [1, 2, 5, 10, 20, 50, 100];
const verifierName = (size: number) => (size === 1 ? 'attestedRingVerifier' : `attestedRingVerifier${size}`);

const secret = (name: string, make: () => Hex): Hex => {
  const file = join(DIR, name);
  if (!existsSync(file)) { mkdirSync(DIR, { recursive: true, mode: 0o700 }); writeFileSync(file, make(), { mode: 0o600, flag: 'wx' }); }
  return readFileSync(file, 'utf8').trim() as Hex;
};
const deployer = privateKeyToAccount(secret('deployer.key', () => { throw new Error('no Sepolia deployer key'); }), { nonceManager });
const attesterEoa = privateKeyToAccount(secret('attester.key', generatePrivateKey));
const egress = privateKeyToAccount(secret('egress.key', generatePrivateKey));
const attesterMaster = () => Buffer.from(secret('attester.master', () => toHex(randomBytes(32))).slice(2), 'hex');
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account: deployer, chain: sepolia, transport: http(RPC) });
const artifact = (name: string, out = 'out'): { abi: Abi; bytecode: { object: Hex } } =>
  JSON.parse(readFileSync(join(HERE, '..', '..', 'contracts', out, `${name}.sol`, `${name}.json`), 'utf8'));
const d = JSON.parse(readFileSync(FILE, 'utf8'));
const save = () => writeFileSync(FILE, `${JSON.stringify(d, null, 2)}\n`);
const tx = (hash: Hex) => `https://sepolia.etherscan.io/tx/${hash}`;

async function deploy(name: string, args: readonly unknown[] = [], out = 'out', value?: bigint, nonce?: number, gas?: bigint): Promise<{ address: Address; block: number }> {
  const a = artifact(name, out);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, ...(value === undefined ? {} : { value }), ...(nonce === undefined ? {} : { nonce }), ...(gas === undefined ? {} : { gas }) } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${name} reverted: ${tx(hash)}`);
  console.log(`${name} ${r.contractAddress}: ${tx(hash)}`);
  const address = r.contractAddress!.toLowerCase() as Address;
  // The public RPC is load-balanced: a node a block behind has no code here yet, and a
  // constructor that reads this contract would revert in its gas estimate. Wait it out.
  for (let i = 0; i < 40 && ((await pub.getCode({ address }).catch(() => undefined)) ?? '0x') === '0x'; i++) await new Promise((res) => setTimeout(res, 3_000));
  return { address, block: Number(r.blockNumber) };
}
async function send(to: Address, data: Hex, what: string, value?: bigint, gas?: bigint): Promise<void> {
  const hash = await wallet.sendTransaction({ to, data, ...(value === undefined ? {} : { value }), ...(gas === undefined ? {} : { gas }) } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${what} reverted: ${tx(hash)}`);
  console.log(`${what}: ${tx(hash)}`);
}
const contract = (name: string, address: Address, block: number) => { d.contracts[name] = { address, deployedAtBlock: block }; save(); };

console.log(`deployer ${deployer.address}: ${formatEther(await pub.getBalance({ address: deployer.address }))} ETH`);

// 1. tUSDC
if (d.tokens.usdc.address === '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238') {
  const t = await deploy('TestToken', ['Opaque Test USD', 'tUSDC', 6, deployer.address, 1_000_000_000n * 1_000_000n], 'out-frame');
  d.tokens.usdc = {
    $comment: "tUSDC, Opaque's 6-decimal test dollar (contracts/frame/TestToken.sol), in place of Circle's Sepolia USDC: the pools' decoys alone take 1,504, and the stack's faucet gives it to new wallets. No value.",
    address: t.address, decimals: 6,
  };
  save();
}

// 2. The PQ account stack, on opaque.eth's registry.
if (d.contracts.pqKeyRegistry === null) {
  // Where scans of it start: its first event, the controller's key registered right after the
  // registry was deployed (the public RPC keeps no old state to bisect its code against).
  const head = await pub.getBlockNumber();
  let first: bigint | undefined;
  for (let to = head; to > head - 50_000n && first === undefined; to -= 5_000n) {
    const logs = await pub.getLogs({ address: d.ens.pqKeyRegistry, fromBlock: to - 4_999n, toBlock: to });
    if (logs.length > 0) first = logs.reduce((m, l) => (l.blockNumber! < m ? l.blockNumber! : m), logs[0]!.blockNumber!);
  }
  if (first === undefined) throw new Error('opaque.eth\'s registry has no events in the last 50,000 blocks');
  contract('pqKeyRegistry', d.ens.pqKeyRegistry, Number(first));
}
if (d.contracts.pqAccountValidator === null) {
  const v = await deploy('PQValidator', [d.contracts.pqKeyRegistry.address]);
  contract('pqAccountValidator', v.address, v.block);
}
if (d.contracts.pqAccountImplementation === null) {
  const i = await deploy('PQAccount', [ENTRY_POINT, d.contracts.pqAccountValidator.address]);
  contract('pqAccountImplementation', i.address, i.block);
}
if (d.contracts.pqAccountFactory === null) {
  const f = await deploy('PQAccountFactory', [d.contracts.pqAccountImplementation.address]);
  contract('pqAccountFactory', f.address, f.block);
}
if (d.contracts.relayDirectory === null) {
  const r = await deploy('RelayDirectory');
  contract('relayDirectory', r.address, r.block);
}

// 3. The attester registers its FORS key from its own address, once.
if (d.accounts.attester === null) {
  await send(attesterEoa.address, '0x', 'gas for the attester\'s one registration', parseEther('0.005'));
  const master = attesterMaster();
  const now = (await pub.getBlock()).timestamp;
  const attesterWallet = createWalletClient({ account: attesterEoa, chain: sepolia, transport: http(RPC) });
  const hash = await attesterWallet.writeContract({
    address: d.contracts.pqKeyRegistry.address,
    abi: parseAbi(['function register(bytes32 pkCommitment, bytes32 nextCommitment, uint64 maxUses, uint64 rotationDeadline)']),
    functionName: 'register', args: [attesterCommitment(master, 0), attesterCommitment(master, 1), 32n, now + 30n * 86_400n],
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`attester registration reverted: ${tx(hash)}`);
  d.accounts.attester = attesterEoa.address.toLowerCase();
  save();
  console.log(`attester ${d.accounts.attester} registered its FORS key: ${tx(hash)}`);
}

// 4. A verifier and pool per size, each with its own way out: ExitableRingVerifier takes
//    the attester's private path unchanged (an AttestedRingVerifier) and adds an exit any
//    note's owner can take alone, after EXIT_DELAY. The verifiers bind the pool before it
//    exists: its address follows from the deployer's nonce. Pools from before the exit
//    (6 November) move to `retiredPools`; their notes stay spendable through the attester.
const EXIT_DELAY = 300n; // Sepolia: five minutes, so the whole exit fits a demo. A real pool would wait days.
const exitable = (p: { exit?: unknown }) => p.exit !== undefined;
if (!d.pools.every(exitable)) {
  d.retiredPools = [...(d.retiredPools ?? []), ...d.pools.filter((p: { exit?: unknown }) => !exitable(p))];
  d.pools = d.pools.filter(exitable);
  save();
}
for (const size of SIZES) {
  const denomination = size * 1_000_000;
  if (d.pools.some((p: { denomination: number }) => p.denomination === denomination)) continue;
  // Explicit nonces: the pool's address is predicted from them, so no stale read may move it
  // (a nonce a stale node handed out already is refused, which stops here before anything lands).
  const nonce = await pub.getTransactionCount({ address: deployer.address, blockTag: 'pending' });
  const predicted = getContractAddress({ from: deployer.address, nonce: BigInt(nonce + 2) }).toLowerCase() as Address;
  const id = poolId({ chainId: BigInt(sepolia.id), pool: predicted, denomination } as never);
  const a = await deploy('AttestedRingVerifier', [d.contracts.pqKeyRegistry.address, d.accounts.attester, id, BigInt(denomination)], 'out', undefined, nonce);
  const v = await deploy('ExitableRingVerifier', [a.address, predicted, EXIT_DELAY], 'out', undefined, nonce + 1, 12_000_000n); // no estimate (a stale node reverts it); code costs ~7M gas here
  const p = await deploy('PrivatePool', [d.tokens.usdc.address, BigInt(denomination), v.address], 'out', undefined, nonce + 2);
  if (p.address !== predicted) throw new Error(`the ${size} pool landed at ${p.address}, not ${predicted}`);
  contract(verifierName(size), v.address, v.block);
  d.pools.push({ address: p.address, denomination, proofMode: 'RING_8', verifier: verifierName(size), deployedAtBlock: p.block, decoys: 0, exit: { attested: a.address, delaySeconds: Number(EXIT_DELAY) } });
  save();
  console.log(`${size} tUSDC: pool ${p.address}, exitable verifier ${v.address}`);
}

// 5. Eight decoys a ring, made as real notes are (deriveCommitment), their secrets dropped.
const ERC20 = parseAbi(['function approve(address spender, uint256 value) returns (bool)', 'function transfer(address to, uint256 value) returns (bool)']);
const POOL = parseAbi(['function deposit(bytes32 commitment)']);
for (const p of d.pools as { address: Address; denomination: number; decoys?: number }[]) {
  if (p.decoys === 8) continue;
  await send(d.tokens.usdc.address, encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [p.address, 8n * BigInt(p.denomination)] }), `approve ${p.denomination / 1e6} tUSDC pool`);
  const hashes: Hex[] = [];
  for (let i = 0; i < 8; i++) {
    const commitment = deriveCommitment(createNoteSecret(), { chainId: BigInt(sepolia.id), pool: p.address, denomination: p.denomination } as never);
    hashes.push(await wallet.sendTransaction({ to: p.address, data: encodeFunctionData({ abi: POOL, functionName: 'deposit', args: [commitment as Hex] }), gas: 400_000n } as never));
  }
  for (const h of hashes) if ((await pub.waitForTransactionReceipt({ hash: h })).status !== 'success') throw new Error(`a decoy deposit reverted: ${tx(h)}`);
  p.decoys = 8;
  save();
  console.log(`${p.denomination / 1e6} tUSDC ring seeded`);
}

// 6. The stack's egress: settlements, rotations, the faucet's ETH; and tUSDC for the faucet.
const egressEth = await pub.getBalance({ address: egress.address });
if (egressEth < parseEther('0.05')) await send(egress.address, '0x', 'ETH for the stack\'s egress', parseEther('0.1'));
console.log(`egress ${egress.address}: ${formatEther(await pub.getBalance({ address: egress.address }))} ETH`);
const egressUsdc = await pub.readContract({ address: d.tokens.usdc.address, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [egress.address] });
if (egressUsdc === 0n) await send(d.tokens.usdc.address, encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [egress.address, 10_000_000n * 1_000_000n] }), '10M tUSDC for the stack\'s faucet');

// 7. The factory's stake, as on Arc: 1 ETH, a day to unstake, from an ownerless factory.
const STAKE = parseAbi(['function getDepositInfo(address account) view returns ((uint256 deposit, bool staked, uint112 stake, uint32 unstakeDelaySec, uint48 withdrawTime))']);
const info = await pub.readContract({ address: ENTRY_POINT, abi: STAKE, functionName: 'getDepositInfo', args: [d.contracts.pqAccountFactory.address] });
if (!info.staked) {
  const have = await pub.getBalance({ address: deployer.address });
  if (have < parseEther('1.01')) console.log(`the factory is not staked yet: the deployer has ${formatEther(have)} ETH, the stake takes 1`);
  else await send(d.contracts.pqAccountFactory.address, encodeFunctionData({ abi: parseAbi(['function addStake(uint32 unstakeDelaySec) payable']), functionName: 'addStake', args: [86_400] }), 'factory staked 1 ETH in the EntryPoint', parseEther('1'));
} else console.log('the factory is staked');
console.log(`done; deployer has ${formatEther(await pub.getBalance({ address: deployer.address }))} ETH`);
