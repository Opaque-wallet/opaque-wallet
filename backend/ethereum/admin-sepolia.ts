// Quantum-proof a protocol's admin keys on Sepolia (contracts/src/ethereum/admin/), with the real
// PQKeyRegistry and real FORS+C signatures. A protocol team's ECDSA wallet, like MetaMask's, makes
// a demo protocol: an OpenZeppelin TransparentUpgradeableProxy whose ProxyAdmin (upgrades) and
// owner (the fee) are both that wallet. Then:
//
//   1. it registers a guard key and hands both admin keys to its PQAdmin;
//   2. its ECDSA key alone, cracked on Q-Day: the upgrade and the fee change are refused;
//   3. another FORS+C key's signature: refused (BadSignature);
//   4. the real signature for one fee, replayed for another: refused;
//   5. the signed fee change and the signed upgrade go through, sent by a different wallet;
//   6. the guard key rotates, and the next signed change still goes through: the admin names
//      the guardian, not a key.
//
//   OPAQUE_NETWORK=sepolia node --use-system-ca ethereum/admin-sepolia.ts

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPublicClient, createWalletClient, encodeFunctionData, fallback, http, keccak256, parseAbi, parseEther, toHex, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { deployment, requireContract } from '../../deployments/index.ts';
import { commitmentOf, currentKey, masterKey, REGISTRY_ABI, signAction, signRotation } from './ens/ens.ts';
import { SIGNATURES_PER_KEY } from '@opaque/pq-wallet';

if (deployment.network.chainId !== sepolia.id) throw new Error('run with OPAQUE_NETWORK=sepolia');
const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '.stack', 'eth-sepolia');
const FILE = join(HERE, '..', '..', 'deployments', 'eth-sepolia.json');
// This office's TLS proxy resets connections now and then, so a second RPC takes over. Not the
// deployments file's fallback: 1rpc.io refuses Sepolia on its free plan.
const rpc = fallback([deployment.network.rpcUrl, 'https://sepolia.gateway.tenderly.co'].map((u) => http(u, { retryCount: 4, retryDelay: 1_500 })));
const pub = createPublicClient({ chain: sepolia, transport: rpc });
const deployer = privateKeyToAccount(readFileSync(join(DIR, 'deployer.key'), 'utf8').trim() as Hex);
const REGISTRY = requireContract('pqKeyRegistry') as Address;
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'; // EIP-1967
// Every new guard key: the registry then refuses a 9th signature.
const MAX_USES = SIGNATURES_PER_KEY;
const ADMIN_ABI = parseAbi([
  'function create(address guardian) returns (address)',
  'function adminOf(address guardian) view returns (address)',
  'function payload(address target, bytes data, uint256 deadline) view returns (bytes)',
  'function execute(address target, bytes data, uint256 deadline, bytes signature) returns (bytes)',
]);
const DEMO_ABI = parseAbi([
  'function create() returns (address)',
  'event Created(address indexed owner, address protocol)',
  'function owner() view returns (address)',
  'function transferOwnership(address newOwner)',
  'function setFee(uint256 fee)',
  'function fee() view returns (uint256)',
  'function version() view returns (uint256)',
  'function upgradeAndCall(address proxy, address implementation, bytes data) payable',
]);
const REGISTER = parseAbi(['function register(bytes32 pkCommitment, bytes32 nextCommitment, uint64 maxUses, uint64 rotationDeadline)']);
const tx = (h: Hex) => `https://sepolia.etherscan.io/tx/${h}`;
// Sepolia's base fee is a few wei, and viem's 2-wei tip left a deploy unmined for minutes: 0.01 gwei costs nothing and is picked up.
const FEES = { maxPriorityFeePerGas: 10_000_000n, maxFeePerGas: 50_000_000n };
const mined = (hash: Hex) => pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
const log = (s: string) => console.log(s);

async function send(from: PrivateKeyAccount, to: Address | undefined, data: Hex, value = 0n): Promise<{ hash: Hex; logs: readonly { topics: readonly Hex[]; data: Hex }[]; address?: Address }> {
  const wallet = createWalletClient({ account: from, chain: sepolia, transport: rpc });
  let hash: Hex;
  // A load-balanced node behind the last transaction sees too little ETH, or the call reverting: asked again.
  for (let i = 0; ; i++) {
    try { hash = await wallet.sendTransaction({ ...(to ? { to } : {}), data, value, ...FEES } as never); break; }
    catch (e) { if (i >= 6 || !/insufficient funds|exceeds allowance|reverted/i.test((e as Error).message)) throw e; await new Promise((r) => setTimeout(r, 5_000)); }
  }
  const r = await mined(hash);
  if (r.status !== 'success') throw new Error(`reverted: ${tx(hash)}`);
  return { hash, logs: r.logs as never, ...(r.contractAddress ? { address: r.contractAddress.toLowerCase() as Address } : {}) };
}
async function until(what: string, test: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 40; i++) { if (await test().catch(() => false)) return; await new Promise((r) => setTimeout(r, 3_000)); }
  throw new Error(`timed out: ${what}`);
}
/** eth_call from `from`: undefined if it would succeed, else the raw revert data (asked again, as in vault-sepolia.ts). */
async function revertData(from: Address, to: Address, data: Hex): Promise<Hex | undefined> {
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from, to, data, gas: toHex(3_000_000n) }, 'latest'] };
  for (let i = 0; i < 6; i++) {
    const r = await (await fetch(deployment.network.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as { error?: { data?: Hex } };
    if (r.error !== undefined) return r.error.data ?? '0x';
    await new Promise((res) => setTimeout(res, 3_000));
  }
  return undefined;
}
const carries = (data: Hex | undefined, error: string) => data !== undefined && data.includes(keccak256(new TextEncoder().encode(error)).slice(2, 10));
const read = <T>(address: Address, functionName: string, args: readonly unknown[] = []) => pub.readContract({ address, abi: [...DEMO_ABI, ...ADMIN_ABI] as Abi, functionName, args } as never) as Promise<T>;
const artifact = (file: string, name: string) => JSON.parse(readFileSync(join(HERE, '..', '..', 'contracts', 'out', file, `${name}.json`), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
async function deploy(file: string, name: string, args: readonly unknown[]): Promise<Address> {
  const a = artifact(file, name);
  const hash = await createWalletClient({ account: deployer, chain: sepolia, transport: rpc }).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, ...FEES } as never);
  const r = await mined(hash);
  if (r.status !== 'success') throw new Error(`${name} reverted: ${tx(hash)}`);
  const at = r.contractAddress!.toLowerCase() as Address;
  await until(`${name}'s code`, async () => ((await pub.getCode({ address: at })) ?? '0x') !== '0x');
  log(`${name} ${at}: ${tx(hash)}`);
  return at;
}

// The contracts, once each, recorded as each lands so a run that stops resumes.
const d = JSON.parse(readFileSync(FILE, 'utf8'));
d.admin ??= {
  $comment: 'Quantum-proof any protocol\'s admin keys (contracts/src/ethereum/admin/): PQAdminFactory makes each guardian a PQAdmin that calls out only on its FORS+C key in PQKeyRegistry. The demo is an OpenZeppelin TransparentUpgradeableProxy to try it on.',
  demo: {},
};
const save = () => writeFileSync(FILE, `${JSON.stringify(d, null, 2)}\n`);
d.admin.factory ??= await deploy('PQAdmin.sol', 'PQAdminFactory', [REGISTRY]); save();
d.admin.demo.v1 ??= await deploy('DemoProtocol.sol', 'DemoProtocolV1', []); save();
d.admin.demo.v2 ??= await deploy('DemoProtocol.sol', 'DemoProtocolV2', []); save();
d.admin.demo.factory ??= await deploy('DemoProtocol.sol', 'DemoProtocolFactory', [d.admin.demo.v1]); save();
// The second demo: a beacon-proxied protocol with AccessControl roles (DemoRolesProtocol.sol).
d.admin.rolesDemo ??= {};
d.admin.rolesDemo.v1 ??= await deploy('DemoRolesProtocol.sol', 'DemoRolesV1', []); save();
d.admin.rolesDemo.v2 ??= await deploy('DemoRolesProtocol.sol', 'DemoRolesV2', []); save();
d.admin.rolesDemo.factory ??= await deploy('DemoRolesProtocol.sol', 'DemoRolesFactory', [d.admin.rolesDemo.v1]); save();
d.admin.deployedAtBlock ??= Number(await pub.getBlockNumber()); save();
const FACTORY = d.admin.factory as Address;
const DEMO = d.admin.demo as { factory: Address; v1: Address; v2: Address };

// The protocol team: an ECDSA wallet of its own, and a guard key from a secret of its own (both 0600, demo only).
const teamFile = join(DIR, 'admin-team.key');
if (!existsSync(teamFile)) writeFileSync(teamFile, `${generatePrivateKey()}\n`, { mode: 0o600 });
const team = privateKeyToAccount(readFileSync(teamFile, 'utf8').trim() as Hex);
const masterFile = join(DIR, 'admin-team.master');
if (!existsSync(masterFile)) writeFileSync(masterFile, `0x${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
const master = Buffer.from(readFileSync(masterFile, 'utf8').trim().slice(2), 'hex');
const keyAt = (g: number) => masterKey(master, 'opaque/v1/admin/guard', g);
const stateOf = () => pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'stateOf', args: [team.address] }) as Promise<{ pkCommitment: Hex; useCount: bigint }>;
if ((await pub.getBalance({ address: team.address })) < parseEther('0.0015')) {
  await send(deployer, team.address, '0x', parseEther('0.002'));
  await until('the team wallet\'s ETH', async () => (await pub.getBalance({ address: team.address })) > 0n);
}
log(`the protocol team's ECDSA wallet: ${team.address}`);

// 1. Its guard key, its demo protocol, its PQAdmin, and the handover.
if (BigInt((await stateOf()).pkCommitment) === 0n) {
  const r = await send(team, REGISTRY, encodeFunctionData({ abi: REGISTER, functionName: 'register', args: [commitmentOf(keyAt(0)), commitmentOf(keyAt(1)), MAX_USES, 4_102_444_800n] }));
  await until('the guard key', async () => BigInt((await stateOf()).pkCommitment) !== 0n);
  log(`registered its FORS+C guard key with an ordinary transaction: ${tx(r.hash)}`);
}
const generation = async () => {
  const pk = (await stateOf()).pkCommitment.toLowerCase();
  const g = Array.from({ length: 64 }, (_, i) => i).find((i) => commitmentOf(keyAt(i)).toLowerCase() === pk);
  if (g === undefined) throw new Error('the registry holds a guard key this master never made');
  return g;
};
let protocol = d.admin.example?.protocol as Address | undefined;
if (protocol === undefined) {
  const r = await send(team, DEMO.factory, encodeFunctionData({ abi: DEMO_ABI, functionName: 'create' }));
  const created = keccak256(new TextEncoder().encode('Created(address,address)'));
  protocol = `0x${r.logs.find((l) => l.topics[0] === created)!.data.slice(26)}`.toLowerCase() as Address;
  log(`a demo protocol (OpenZeppelin TransparentUpgradeableProxy) owned twice by the ECDSA wallet: ${protocol}, ${tx(r.hash)}`);
}
await until('the protocol\'s code', async () => ((await pub.getCode({ address: protocol! })) ?? '0x') !== '0x');
const proxyAdmin = `0x${(await pub.getStorageAt({ address: protocol, slot: ADMIN_SLOT }))!.slice(26)}` as Address;
const pqAdmin = (await read<Address>(FACTORY, 'adminOf', [team.address])).toLowerCase() as Address;
if (((await pub.getCode({ address: pqAdmin })) ?? '0x') === '0x') {
  const r = await send(team, FACTORY, encodeFunctionData({ abi: ADMIN_ABI, functionName: 'create', args: [team.address] }));
  await until('the PQAdmin\'s code', async () => ((await pub.getCode({ address: pqAdmin })) ?? '0x') !== '0x');
  log(`its PQAdmin ${pqAdmin}, at the address known before it existed: ${tx(r.hash)}`);
}
for (const [what, at] of [['upgrades (ProxyAdmin)', proxyAdmin], ['the fee (owner)', protocol]] as const) {
  if ((await read<Address>(at, 'owner')).toLowerCase() === team.address.toLowerCase()) {
    const r = await send(team, at, encodeFunctionData({ abi: DEMO_ABI, functionName: 'transferOwnership', args: [pqAdmin] }));
    await until(`${what} handed over`, async () => (await read<Address>(at, 'owner')).toLowerCase() === pqAdmin);
    log(`handed ${what} to the PQAdmin: ${tx(r.hash)}`);
  }
  if ((await read<Address>(at, 'owner')).toLowerCase() !== pqAdmin) throw new Error(`${what} is held by neither the team nor its PQAdmin`);
}
d.admin.example = { $comment: 'The team wallet\'s demo protocol, both of whose admin keys its PQAdmin holds.', protocol, proxyAdmin, pqAdmin, guardian: team.address.toLowerCase() };
save();

// 2. Q-Day: the team's ECDSA key, cracked, tries both admin powers alone.
const v = await read<bigint>(protocol, 'version');
const upgradeTo = v === 1n ? DEMO.v2 : DEMO.v1;
const upgrade = encodeFunctionData({ abi: DEMO_ABI, functionName: 'upgradeAndCall', args: [protocol, upgradeTo, '0x'] });
if (!carries(await revertData(team.address, proxyAdmin, upgrade), 'OwnableUnauthorizedAccount(address)')) throw new Error('the ECDSA key alone could upgrade, or failed otherwise');
if (!carries(await revertData(team.address, protocol, encodeFunctionData({ abi: DEMO_ABI, functionName: 'setFee', args: [666n] })), 'OwnableUnauthorizedAccount(address)')) throw new Error('the ECDSA key alone could set the fee, or failed otherwise');
log('the ECDSA key alone, cracked: the upgrade and the fee change both refused, OwnableUnauthorizedAccount');

const signed = async (key: ReturnType<typeof keyAt>, target: Address, data: Hex) => {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const payload = await read<Hex>(pqAdmin, 'payload', [target, data, deadline]);
  const sig = signAction(key, BigInt(sepolia.id), team.address, (await stateOf()).useCount, payload);
  return (call: Hex = data) => encodeFunctionData({ abi: ADMIN_ABI, functionName: 'execute', args: [target, call, deadline, sig] });
};
const feeCall = (n: bigint) => encodeFunctionData({ abi: DEMO_ABI, functionName: 'setFee', args: [n] });

// 3. Another FORS+C key's signature.
const thief = await signed(masterKey(randomBytes(32), 'thief', 0), protocol, feeCall(666n));
if (!carries(await revertData(deployer.address, pqAdmin, thief()), 'BadSignature()')) throw new Error('the admin acted on another key\'s signature, or failed otherwise');
log('a FORS+C signature from another key: refused by the registry, BadSignature');

// The key in force, handed over first if it has signed 7 times: no key signs a 9th.
await currentKey({ master, label: 'opaque/v1/admin/guard', account: team.address, chainId: BigInt(sepolia.id), registry: REGISTRY, stateOf, send: (to, data) => send(deployer, to, data) });

// 4. The real signature for one fee, replayed for another.
const fee = (await read<bigint>(protocol, 'fee')) + 1n;
const real = await signed(keyAt(await generation()), protocol, feeCall(fee));
if (!carries(await revertData(deployer.address, pqAdmin, real(feeCall(fee + 100n))), 'BadSignature()')) throw new Error('a signature ran a call it does not name, or failed otherwise');
log(`the guardian's signature for fee ${fee}, replayed for fee ${fee + 100n}: refused, BadSignature`);

// 5. The signed changes, sent by a wallet that is no admin of anything: paying authorises nothing.
const r1 = await send(deployer, pqAdmin, real());
await until('the new fee', async () => (await read<bigint>(protocol!, 'fee')) === fee);
log(`the signed fee change, sent by ${deployer.address}: fee is ${fee}, ${tx(r1.hash)}`);
const up = await signed(keyAt(await generation()), proxyAdmin, upgrade);
const r2 = await send(deployer, pqAdmin, up());
await until('the upgrade', async () => (await read<bigint>(protocol!, 'version')) === (v === 1n ? 2n : 1n));
log(`the signed upgrade: version ${v} → ${v === 1n ? 2n : 1n}, ${tx(r2.hash)}`);

// 6. The guard key rotates; the admin never notices.
const g = await generation();
const rot = signRotation(keyAt(g), BigInt(sepolia.id), team.address, (await stateOf()).useCount, commitmentOf(keyAt(g + 2)), MAX_USES, 4_102_444_800n);
const r3 = await send(deployer, REGISTRY, encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'rotate', args: [team.address, commitmentOf(keyAt(g + 2)), MAX_USES, 4_102_444_800n, rot] }));
await until('the rotation', async () => (await generation()) === g + 1);
log(`the guard key rotated, generation ${g} → ${g + 1}: ${tx(r3.hash)}`);
const after = await signed(keyAt(g + 1), protocol, feeCall(fee + 1n));
const r4 = await send(deployer, pqAdmin, after());
await until('the fee after rotation', async () => (await read<bigint>(protocol!, 'fee')) === fee + 1n);
log(`signed by the new key, through the same PQAdmin: fee is ${fee + 1n}, ${tx(r4.hash)}`);
process.exit(0);
