// opaque.eth on Sepolia (ENSv2), held by a FORS+C key: PQNameController
// (contracts/src/ethereum/ens/) owns the name and is the only admin of its
// resolver, and acts only on a signature from its key in our PQKeyRegistry.
//
//   node --use-system-ca ethereum/ens-sepolia.ts deploy         PQKeyRegistry, the controller (its key registered),
//                                                               and a PermissionedResolver whose one admin it is
//   (you)  transfer opaque.eth to the controller from the wallet that owns it: its owner roles go with it
//   node --use-system-ca ethereum/ens-sepolia.ts adopt          FORS-signed: the name's resolver becomes the controller's
//   node --use-system-ca ethereum/ens-sepolia.ts records <0x devnet account>   FORS-signed, one signature: addr (Ethereum and
//                                                               the EIP-8141 devnet, ENSIP-11), text pq-key and url
//   node --use-system-ca ethereum/ens-sepolia.ts status         owner, resolver, records, and an ECDSA write refused
//
// The deployer (.stack/eth-sepolia/deployer.key, 0600, never printed) only pays:
// it holds no role over the name. The controller's key comes from
// .stack/eth-sepolia/ens.master, made here on first use, never printed.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonical, keyGen, pkCommitment, utf8 } from '@opaque/pq-wallet';
import { concat, createPublicClient, createWalletClient, decodeFunctionResult, encodeFunctionData, http, keccak256, namehash, parseAbi, stringToBytes, toHex, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { signExecute, type RegistryKey } from './ens.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '.stack', 'eth-sepolia');
const DEPLOYMENTS = join(HERE, '..', '..', 'deployments', 'eth-sepolia.json');
const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const NAME = 'opaque.eth';
const NODE = namehash(NAME);
/** DNS wire format, as the deployed resolver's setters and resolve() take a name: length-prefixed labels, then 0. */
const DNS_NAME: Hex = concat([...NAME.split('.').flatMap((l) => [toHex(stringToBytes(l).length, { size: 1 }), toHex(stringToBytes(l))]), '0x00']);
// ENSv2 on Sepolia, as docs.ens.domains lists it (code read on chain; the ENS app's set). Its
// PermissionedResolver is the verified 0.8.25 build (Blockscout), older than contracts-v2 main:
// initialize takes grants, setters take the DNS-encoded name, and reads go through resolve().
const ETH_REGISTRY: Address = '0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4';
const VERIFIABLE_FACTORY: Address = '0xda70306c98e97ece36f997a21368e53298572991';
const RESOLVER_IMPL: Address = '0x115eb53f0c60696633855f90b138178fb40b2b2c';
/** ENSIP-11: an EVM chain's coin type is 0x80000000 | chainId. The devnet is 1337. */
const DEVNET_COIN = 0x80000000n | 1337n;
/** Every role and its admin, at the resolver's root: what the ENS app grants a resolver's owner. */
const ALL_ROLES = BigInt(`0x${'1'.repeat(64)}`);

const secret = (name: string, make: () => Hex): Hex => {
  const file = join(DIR, name);
  if (!existsSync(file)) { mkdirSync(DIR, { recursive: true, mode: 0o700 }); writeFileSync(file, make(), { mode: 0o600, flag: 'wx' }); }
  return readFileSync(file, 'utf8').trim() as Hex;
};
const deployer = privateKeyToAccount(secret('deployer.key', () => { throw new Error('no Sepolia deployer key'); }));
const master = () => secret('ens.master', () => toHex(randomBytes(32)));
/** The controller's registry key of generation g: one master, a key per rotation. */
const keyOf = (g: number): RegistryKey => keyGen(keccak256(canonical([utf8('opaque/v1/ens/controller'), Buffer.from(master().slice(2), 'hex'), utf8(String(g))]), 'bytes'));
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account: deployer, chain: sepolia, transport: http(RPC) });
const artifact = (name: string): { abi: Abi; bytecode: { object: Hex } } => JSON.parse(readFileSync(join(HERE, '..', '..', 'contracts', 'out', `${name}.sol`, `${name}.json`), 'utf8'));
const file = () => JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'));
const save = (f: unknown) => writeFileSync(DEPLOYMENTS, `${JSON.stringify(f, null, 2)}\n`);
const ens = (): { pqKeyRegistry: Address; controller: Address; resolver: Address } => {
  const e = file().ens;
  if (e?.resolver === undefined) throw new Error('deploy first');
  return e;
};

const REG = parseAbi(['function getTokenId(uint256) view returns (uint256)', 'function ownerOf(uint256) view returns (address)', 'function getResolver(string) view returns (address)', 'function setResolver(uint256 anyId, address resolver)']);
const RES = parseAbi([
  'function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)',
  'function setAddress(bytes name, uint256 coinType, bytes addressBytes)',
  'function setText(bytes name, string key, string value)',
  'function multicall(bytes[] calls) returns (bytes[])',
  'function resolve(bytes name, bytes data) view returns (bytes)',
]);
/** The record calls resolve() answers. */
const PROFILE = parseAbi(['function addr(bytes32 node, uint256 coinType) view returns (bytes)', 'function text(bytes32 node, string key) view returns (string)']);
const CTL = parseAbi(['function execute(address target, bytes data, uint256 deadline, bytes signature) returns (bytes)', 'function registry() view returns (address)']);
const REGISTRY = parseAbi(['function stateOf(address) view returns ((bytes32 pkCommitment, bytes32 nextCommitment, uint64 useCount, uint64 maxUses, uint64 rotationDeadline, uint64 disableAfter))']);
const FACTORY = parseAbi(['function deployProxy(address implementation, uint256 salt, bytes data) returns (address)']);
const tokenId = () => pub.readContract({ address: ETH_REGISTRY, abi: REG, functionName: 'getTokenId', args: [BigInt(keccak256(toHex('opaque')))] });

async function sent(hash: Hex, what: string): Promise<void> {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${what} reverted: https://sepolia.etherscan.io/tx/${hash}`);
  console.log(`${what}: https://sepolia.etherscan.io/tx/${hash}`);
}

async function deploy(): Promise<void> {
  const f = file();
  f.ens ??= {};
  if (f.ens.pqKeyRegistry === undefined) {
    const a = artifact('PQKeyRegistry');
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object });
    const r = await pub.waitForTransactionReceipt({ hash });
    f.ens.pqKeyRegistry = r.contractAddress!.toLowerCase();
    save(f);
    console.log(`PQKeyRegistry ${f.ens.pqKeyRegistry}: https://sepolia.etherscan.io/tx/${hash}`);
  }
  if (f.ens.controller === undefined) {
    const a = artifact('PQNameController');
    const now = (await pub.getBlock()).timestamp;
    // 32 signatures a key, rotation within 30 days: the attester's budget (contracts/script/DeployRingPool.s.sol).
    const args = [f.ens.pqKeyRegistry, pkCommitment(keyOf(0).publicKey), pkCommitment(keyOf(1).publicKey), 32n, now + 30n * 86_400n] as const;
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    f.ens.controller = r.contractAddress!.toLowerCase();
    save(f);
    console.log(`PQNameController ${f.ens.controller}, its key registered: https://sepolia.etherscan.io/tx/${hash}`);
  }
  if (f.ens.resolver === undefined) {
    // The ENS app's way to a resolver of one's own, with the controller its only admin and no records yet.
    const data = encodeFunctionData({ abi: RES, functionName: 'initialize', args: [[{ account: f.ens.controller, roleBitmap: ALL_ROLES }], []] });
    const salt = BigInt(keccak256(toHex(`opaque/v1/ens/resolver/${f.ens.controller}`)));
    const { result, request } = await pub.simulateContract({ account: deployer, address: VERIFIABLE_FACTORY, abi: FACTORY, functionName: 'deployProxy', args: [RESOLVER_IMPL, salt, data] });
    await sent(await wallet.writeContract(request), 'PermissionedResolver for the controller');
    f.ens.resolver = (result as Address).toLowerCase();
    save(f);
    console.log(`resolver ${f.ens.resolver}`);
  }
  console.log(`\nnow transfer ${NAME} to the controller ${f.ens.controller} from the wallet that owns it`);
}

/** Signs `data` for `target` with the controller's key in force, and submits it from the deployer, which only pays. */
async function execute(target: Address, data: Hex, what: string): Promise<void> {
  const { controller, pqKeyRegistry } = ens();
  const state = await pub.readContract({ address: pqKeyRegistry, abi: REGISTRY, functionName: 'stateOf', args: [controller] });
  const g = [0, 1, 2, 3, 4, 5, 6, 7].find((i) => pkCommitment(keyOf(i).publicKey) === state.pkCommitment.toLowerCase());
  if (g === undefined) throw new Error('the controller answers to none of the master\'s first keys');
  const deadline = (await pub.getBlock()).timestamp + 3600n;
  const signature = signExecute(keyOf(g), BigInt(sepolia.id), controller, state.useCount, target, data, deadline);
  const { request } = await pub.simulateContract({ account: deployer, address: controller, abi: CTL, functionName: 'execute', args: [target, data, deadline, signature] });
  await sent(await wallet.writeContract(request), `${what} (FORS+C, key ${g}, use ${state.useCount})`);
}

async function adopt(): Promise<void> {
  const { controller, resolver } = ens();
  const id = await tokenId();
  const owner = await pub.readContract({ address: ETH_REGISTRY, abi: REG, functionName: 'ownerOf', args: [id] });
  if (owner.toLowerCase() !== controller) throw new Error(`${NAME} belongs to ${owner}: transfer it to the controller ${controller} first`);
  await execute(ETH_REGISTRY, encodeFunctionData({ abi: REG, functionName: 'setResolver', args: [id, resolver] }), `${NAME}'s resolver is now the controller's`);
}

async function records(): Promise<void> {
  const devnetAccount = process.argv[3] as Address | undefined;
  if (devnetAccount === undefined || !/^0x[0-9a-fA-F]{40}$/.test(devnetAccount)) throw new Error('usage: records <0x devnet account>');
  const { controller, resolver } = ens();
  const calls = [
    encodeFunctionData({ abi: RES, functionName: 'setAddress', args: [DNS_NAME, 60n, controller] }),
    encodeFunctionData({ abi: RES, functionName: 'setAddress', args: [DNS_NAME, DEVNET_COIN, devnetAccount] }),
    encodeFunctionData({ abi: RES, functionName: 'setText', args: [DNS_NAME, 'pq-key', pkCommitment(keyOf(0).publicKey)] }),
    encodeFunctionData({ abi: RES, functionName: 'setText', args: [DNS_NAME, 'url', 'https://opaque.credit'] }),
  ];
  await execute(resolver, encodeFunctionData({ abi: RES, functionName: 'multicall', args: [calls] }), `${NAME}'s records, in one signature`);
}

async function status(): Promise<void> {
  const e = file().ens ?? {};
  const id = await tokenId();
  console.log(`${NAME}  owner ${await pub.readContract({ address: ETH_REGISTRY, abi: REG, functionName: 'ownerOf', args: [id] })}  resolver ${await pub.readContract({ address: ETH_REGISTRY, abi: REG, functionName: 'getResolver', args: ['opaque'] })}`);
  console.log(`controller ${e.controller ?? '—'}  its resolver ${e.resolver ?? '—'}`);
  if (e.resolver === undefined) return;
  const read = async (functionName: 'addr' | 'text', args: readonly unknown[]) => {
    const data = encodeFunctionData({ abi: PROFILE, functionName, args } as never);
    const out = await pub.readContract({ address: e.resolver, abi: RES, functionName: 'resolve', args: [DNS_NAME, data] }).catch(() => undefined);
    return out === undefined ? '—' : decodeFunctionResult({ abi: PROFILE, functionName, data: out } as never);
  };
  console.log(`addr(ETH) ${await read('addr', [NODE, 60n])}  addr(devnet) ${await read('addr', [NODE, DEVNET_COIN])}  pq-key ${await read('text', [NODE, 'pq-key'])}`);
  // An ECDSA account writing a record directly: refused, whoever it is.
  await pub.simulateContract({ account: deployer, address: e.resolver, abi: RES, functionName: 'setText', args: [DNS_NAME, 'url', 'https://evil.example'] })
    .then(() => console.log('!! an ECDSA write went through'), (err: Error & { shortMessage?: string }) => console.log(`an ECDSA write is refused: ${(err.shortMessage ?? err.message).split('\n')[0]}`));
}

const commands: Record<string, () => Promise<void>> = { deploy, adopt, records, status };
const run = commands[process.argv[2] ?? ''];
if (run === undefined) throw new Error(`usage: node ethereum/ens-sepolia.ts ${Object.keys(commands).join(' | ')}`);
await run();
