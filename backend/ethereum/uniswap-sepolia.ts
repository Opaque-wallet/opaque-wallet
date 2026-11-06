// Uniswap v4 on Sepolia, post-quantum: deploys our two hooks at Uniswap's own v4,
// opens their ETH/tUSDC pools, and shows each rule on chain. Resumable: every step
// looks at the chain first, and what it made goes into deployments/eth-sepolia.json.
//
//   1. PQAccountPoolHook and PQGuardHook, each through the CREATE2 deployer at a
//      salt mined for its permission bits, and their pools initialized.
//   2. The post-quantum pool's liquidity, from a PQ account (keys from
//      .stack/eth-sepolia/uniswap-lp.master): its first UserOperation deploys it
//      and mints the position, signed with FORS+C. Then an ECDSA wallet's swap is
//      refused (NotPostQuantum), and the PQ account's goes through.
//   3. The guarded pool: an ordinary ECDSA wallet (the deployer) registers a FORS+C
//      key (.stack/eth-sepolia/uniswap-guard.master) and opens a position. Taking
//      it out without that key's signature is refused; a front-runner reusing the
//      signature with their own recipient is refused; the signed removal pays only
//      the recipient it names.
//
//   OPAQUE_NETWORK=sepolia node --use-system-ca ethereum/uniswap-sepolia.ts

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { concat, createPublicClient, createWalletClient, encodeAbiParameters, encodeDeployData, encodeFunctionData, formatEther, getContractAddress, http, keccak256, parseAbi, parseAbiParameters, parseEther, toHex, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { encodeSignature, forsSchemeId, pqDigest, sign } from '@opaque/pq-wallet';
import type { Bytes32 } from '@opaque/protocol-types';

import { deployment, requireContract } from '../../deployments/index.ts';
import { MemorySignerStore } from '../../packages/pq-wallet/src/signer-state.ts';
import { MemoryWalletStateStore } from '../../packages/pq-wallet/src/wallet-state.ts';
import { adoptWallet, createPqWallet } from '../../packages/pq-wallet/src/wallet.ts';
import { userActionPayload } from '../../packages/pq-wallet/src/registry.ts';
import { ARC_AUTHORITY, createPqAccountOps, livePqWalletOptions, pendingDeployment } from '../chain/pq-wallet-chain.ts';
import { decreaseCall, ERC20_ABI, keyOf, mintCalls, PM_ABI, POSM_ABI, quote, sqrtPriceOf, swapCalls, V4, type V4Pool } from '../chain/uniswap-v4.ts';
import { createWalletRpcAnswerer } from '../chain/wallet-rpc.ts';
import { commitmentOf, masterKey, REGISTRY_ABI } from './ens.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '.stack', 'eth-sepolia');
const FILE = join(HERE, '..', '..', 'deployments', 'eth-sepolia.json');
const artifact = (name: string) => JSON.parse(readFileSync(join(HERE, '..', '..', 'contracts', 'out', `${name}.sol`, `${name}.json`), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
const secret = (name: string): Uint8Array => {
  const file = join(DIR, name);
  if (!existsSync(file)) writeFileSync(file, toHex(randomBytes(32)), { mode: 0o600, flag: 'wx' });
  return Buffer.from(readFileSync(file, 'utf8').trim().slice(2), 'hex');
};
const log = (s: string) => console.log(s);

const rpc = http(deployment.network.rpcUrl, { retryCount: 4, retryDelay: 1_500 });
const pub = createPublicClient({ chain: sepolia, transport: rpc });
const deployer = privateKeyToAccount(readFileSync(join(DIR, 'deployer.key'), 'utf8').trim() as Hex);
const eoa = createWalletClient({ account: deployer, chain: sepolia, transport: rpc });
const CREATE2 = '0x4e59b44847b379578588920ca78fbf26c0b4956c' as Address;
const REGISTRY = requireContract('pqKeyRegistry') as Address;
const PRICE = 2000n; // tUSDC per ETH
if (deployment.network.chainId !== sepolia.id || V4 === undefined) throw new Error('run with OPAQUE_NETWORK=sepolia');
const v4 = V4;

/** Sent from the deployer, waited for, and refused loudly if it reverted. */
async function send(to: Address, data: Hex, value = 0n, gas?: bigint): Promise<Hex> {
  const hash = await eoa.sendTransaction({ to, data, value, ...(gas ? { gas } : {}) });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`reverted: https://sepolia.etherscan.io/tx/${hash}`);
  return hash;
}
/** A load-balanced RPC answers from behind: wait until `test` holds. */
async function until(what: string, test: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 40; i++) { if (await test().catch(() => false)) return; await new Promise((r) => setTimeout(r, 3_000)); }
  throw new Error(`timed out: ${what}`);
}
const save = (change: (u: Record<string, unknown>) => void) => {
  const d = JSON.parse(readFileSync(FILE, 'utf8'));
  change(d.uniswap);
  writeFileSync(FILE, `${JSON.stringify(d, null, 2)}\n`);
};
/** eth_call as the deployer: undefined if it would succeed, else the raw revert data. */
async function revertData(to: Address, data: Hex, value = 0n): Promise<Hex | undefined> {
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from: deployer.address, to, data, value: toHex(value), gas: toHex(5_000_000n) }, 'latest'] };
  const r = await (await fetch(deployment.network.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as { result?: Hex; error?: { data?: Hex; message?: string } };
  return r.error === undefined ? undefined : (r.error.data ?? '0x');
}
/** Whether `data` carries `signature`'s error selector anywhere (v4 wraps a hook's revert in WrappedError). */
const carries = (data: Hex, signature: string): boolean => data.includes(keccak256(new TextEncoder().encode(signature)).slice(2, 10));

// ── 1. the hooks and their pools ─────────────────────────────────────────
async function hook(name: 'PQAccountPoolHook' | 'PQGuardHook', flags: bigint, args: readonly unknown[], existing?: V4Pool): Promise<V4Pool> {
  if (existing !== undefined) return existing;
  const a = artifact(name);
  const initCode = encodeDeployData({ abi: a.abi, bytecode: a.bytecode.object, args } as never);
  const bytecodeHash = keccak256(initCode);
  let salt: Hex = '0x';
  let address: Address = CREATE2;
  for (let i = 0n; ; i++) {
    salt = toHex(i, { size: 32 });
    address = getContractAddress({ opcode: 'CREATE2', from: CREATE2, salt, bytecodeHash });
    if ((BigInt(address) & 0x3fffn) === flags) break;
  }
  if (((await pub.getCode({ address })) ?? '0x') === '0x') {
    const hash = await send(CREATE2, concat([salt, initCode]), 0n, 8_000_000n); // code is dear on Sepolia: ~5.8M for the guard
    await until(`${name}'s code`, async () => ((await pub.getCode({ address })) ?? '0x') !== '0x');
    log(`${name} ${address} (salt mined for bits 0x${flags.toString(16)}): https://sepolia.etherscan.io/tx/${hash}`);
  }
  const pool = { hook: address.toLowerCase() as Address, fee: 3000, tickSpacing: 60 };
  const key = keyOf(pool);
  // Initialize: not a hooked call for either hook, so the deployer may make it.
  const slot = BigInt(keccak256(encodeAbiParameters(parseAbiParameters('bytes32, uint256'), [keccak256(encodeAbiParameters(parseAbiParameters('(address,address,uint24,int24,address)'), [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]])), 6n])));
  const slot0 = BigInt(await pub.readContract({ address: v4.poolManager, abi: PM_ABI, functionName: 'extsload', args: [toHex(slot, { size: 32 })] }));
  if (slot0 === 0n) {
    const hash = await send(v4.poolManager, encodeFunctionData({ abi: PM_ABI, functionName: 'initialize', args: [key, sqrtPriceOf(PRICE)] }));
    log(`  its pool, ETH/tUSDC at ${PRICE} tUSDC per ETH, initialized: https://sepolia.etherscan.io/tx/${hash}`);
  }
  return pool;
}

// ── 2. the post-quantum pool, from a PQ account ───────────────────────────
async function pqAccount() {
  const walletRpc = createWalletRpcAnswerer({
    publicClient: pub as never, bundlerUrl: ARC_AUTHORITY.bundlerUrl, entryPoint: ARC_AUTHORITY.entryPoint,
    accountImplementation: ARC_AUTHORITY.accountImplementation, factory: ARC_AUTHORITY.factory, bundlerTimeoutMs: 90_000,
  });
  const master = secret('uniswap-lp.master');
  const store = new MemorySignerStore(), walletStore = new MemoryWalletStateStore();
  const options = livePqWalletOptions({
    signerStore: store as never, walletStore, publicClient: pub as never, payer: async () => eoa as never, walletRpc,
    seedFor: (epoch) => Buffer.from(keccak256(concat([toHex(master), toHex(epoch, { size: 8 })])).slice(2), 'hex'),
  });
  const wallet = createPqWallet(options);
  // Its keys from the chain if an earlier run made it; otherwise the same keys, new.
  await adoptWallet({ ...options, signerStore: store as never });
  const account = (await wallet.create()).accountAddress.toLowerCase() as Address;
  const ops = createPqAccountOps({ wallet, account: account as never, authority: ARC_AUTHORITY, walletRpc, deployment: () => pendingDeployment(wallet, walletStore) });
  return { account, ops };
}

async function pqPool(pool: V4Pool): Promise<void> {
  const key = keyOf(pool);
  const { account, ops } = await pqAccount();
  const read = async (slot: Hex) => BigInt(await pub.readContract({ address: v4.poolManager, abi: PM_ABI, functionName: 'extsload', args: [slot] }));
  const funded = await quote(read, key, 10n ** 15n, true).then(() => true, () => false);
  if (!funded) {
    const eth = parseEther('0.01');
    // The account's ETH pays the position's ETH and its own gas; tUSDC for the other side.
    if ((await pub.getBalance({ address: account })) < parseEther('0.03')) await send(account, '0x', parseEther('0.03'));
    await send(deployment.tokens.usdc.address as Address, encodeFunctionData({ abi: parseAbi(['function transfer(address to, uint256 value) returns (bool)']), functionName: 'transfer', args: [account, 100_000_000n] }));
    await until('the account\'s ETH and tUSDC', async () => (await pub.getBalance({ address: account })) >= parseEther('0.03'));
    const tx = await ops.execute(mintCalls(key, account, eth, sqrtPriceOf(PRICE)) as never);
    log(`post-quantum pool funded by PQ account ${account}, its first UserOperation (deploy + mint) signed with FORS+C: https://sepolia.etherscan.io/tx/${tx}`);
    await until('the pool\'s liquidity', async () => quote(read, key, 10n ** 15n, true).then(() => true, () => false));
  }
  // An ECDSA wallet asks the router for a swap: the hook refuses it.
  const out = await quote(read, key, 10n ** 15n, true);
  const [ecdsaSwap] = swapCalls(key, 10n ** 15n, 0n, true);
  const refused = await revertData(ecdsaSwap!.to, ecdsaSwap!.data, ecdsaSwap!.value);
  if (refused === undefined || !carries(refused, 'NotPostQuantum(address)') || !refused.toLowerCase().includes(deployer.address.slice(2).toLowerCase())) throw new Error(`an ECDSA wallet's swap was not refused by the hook: ${refused}`);
  log(`an ECDSA wallet's swap (${deployer.address}): refused by the hook, NotPostQuantum(${deployer.address})`);
  // The PQ account's swap, through the same router, as a UserOperation its FORS+C key signs.
  const before = BigInt(await pub.readContract({ address: key.currency1, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] }));
  const tx = await ops.execute(swapCalls(key, 10n ** 15n, (out * 99n) / 100n, true) as never);
  await until('the swap\'s tUSDC', async () => BigInt(await pub.readContract({ address: key.currency1, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] })) > before);
  const got = BigInt(await pub.readContract({ address: key.currency1, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] })) - before;
  log(`the PQ account swapped 0.001 ETH for ${Number(got) / 1e6} tUSDC (quoted ${Number(out) / 1e6}): https://sepolia.etherscan.io/tx/${tx}`);
}

// ── 3. the guarded pool, for an ECDSA wallet ──────────────────────────────
async function guarded(pool: V4Pool): Promise<void> {
  const key = keyOf(pool);
  const master = secret('uniswap-guard.master');
  const stateOf = async () => pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'stateOf', args: [deployer.address] }) as Promise<{ pkCommitment: Hex; useCount: bigint }>;
  // The ECDSA wallet's FORS+C key, registered once, with an ordinary transaction.
  let state = await stateOf();
  const keyAt = (g: number) => masterKey(master, 'opaque/v1/uniswap/guard', g);
  if (BigInt(state.pkCommitment) === 0n) {
    const register = parseAbi(['function register(bytes32 pkCommitment, bytes32 nextCommitment, uint64 maxUses, uint64 rotationDeadline)']);
    const hash = await send(REGISTRY, encodeFunctionData({ abi: register, functionName: 'register', args: [commitmentOf(keyAt(0)) as Bytes32, commitmentOf(keyAt(1)) as Bytes32, 32n, 4_102_444_800n] }));
    await until('the guard key', async () => BigInt((await stateOf()).pkCommitment) !== 0n);
    state = await stateOf();
    log(`the ECDSA wallet ${deployer.address} registered a FORS+C guard key in PQKeyRegistry: https://sepolia.etherscan.io/tx/${hash}`);
  }
  if (state.pkCommitment.toLowerCase() !== commitmentOf(keyAt(0)).toLowerCase()) throw new Error('the guard key in force is not generation 0: rotate support not written here');

  // Its position: opened with an ordinary ECDSA transaction; the hook binds it to the guard key.
  // One a run before left open is used again.
  const POSITION_ABI = parseAbi(['function ownerOf(uint256) view returns (address)', 'function getPositionLiquidity(uint256) view returns (uint128)']);
  const saved = (v4 as { guardPosition?: { tokenId: string } }).guardPosition;
  const open = saved === undefined ? 0n : await pub.readContract({ address: v4.positionManager, abi: POSITION_ABI, functionName: 'getPositionLiquidity', args: [BigInt(saved.tokenId)] });
  let tokenId: bigint, liquidity: bigint;
  if (saved !== undefined && open > 0n) {
    tokenId = BigInt(saved.tokenId); liquidity = open;
    log(`the ECDSA wallet's guarded position #${tokenId}, still open from before`);
  } else {
    tokenId = BigInt(await pub.readContract({ address: v4.positionManager, abi: POSM_ABI, functionName: 'nextTokenId' }));
    const eth = parseEther('0.002');
    const sqrtP = sqrtPriceOf(PRICE);
    liquidity = (eth * sqrtP) >> 96n;
    for (const c of mintCalls(key, deployer.address, eth, sqrtP)) await send(c.to, c.data, c.value ?? 0n);
    await until('the new position', async () => (await pub.readContract({ address: v4.positionManager, abi: POSITION_ABI, functionName: 'ownerOf', args: [tokenId] })).toLowerCase() === deployer.address.toLowerCase());
    log(`the ECDSA wallet opened guarded position #${tokenId} (${formatEther(eth)} ETH and its tUSDC)`);
    save((u) => { u['guardPosition'] = { owner: deployer.address.toLowerCase(), tokenId: tokenId.toString() }; });
  }

  const position = keccak256(encodeAbiParameters(parseAbiParameters('bytes32, address, int24, int24, bytes32'),
    [keccak256(encodeAbiParameters(parseAbiParameters('(address,address,uint24,int24,address)'), [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]])), v4.positionManager, -887220, 887220, toHex(tokenId, { size: 32 })]));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const recipient = `0x${randomBytes(20).toString('hex')}` as Address;
  const payloadOf = (to: Address) => encodeAbiParameters(parseAbiParameters('string, uint256, address, bytes32, int256, address, uint256'),
    ['opaque/v1/uniswap/remove', BigInt(sepolia.id), key.hooks, position, -liquidity, to, deadline]);
  const k = keyAt(0);
  const digest = pqDigest({ chainId: BigInt(sepolia.id) as never, walletAddress: deployer.address.toLowerCase() as never, schemeId: forsSchemeId(k.publicKey.params), useCount: (await stateOf()).useCount, payload: userActionPayload(payloadOf(recipient)) });
  const signature = encodeSignature(k.publicKey, sign(k.secretKey, digest as Bytes32)) as Hex;
  const hookData = (to: Address, sig: Hex) => encodeAbiParameters(parseAbiParameters('address, uint256, bytes'), [to, deadline, sig]);

  // a. Whoever cracked the owner's ECDSA key, with a well-formed FORS+C signature of their own key:
  //    PQKeyRegistry refuses it (BadSignature), and v4 hands back the hook's revert wrapped.
  const thief = masterKey(randomBytes(32), 'thief', 0);
  const forged = encodeSignature(thief.publicKey, sign(thief.secretKey, digest as Bytes32)) as Hex;
  const plain = decreaseCall(key, tokenId, liquidity, deployer.address, hookData(deployer.address, forged));
  const a = await revertData(plain.to, plain.data);
  if (a === undefined || !carries(a, 'BadSignature()')) throw new Error(`liquidity came out without the guard key's signature, or failed for another reason: ${a}`);
  log('taking it out with the cracked ECDSA key and a FORS+C signature of another key: refused by the registry, BadSignature');
  // b. A front-runner replaying the signature with their own recipient: refused.
  const stolen = decreaseCall(key, tokenId, liquidity, deployer.address, hookData(deployer.address, signature));
  const b = await revertData(stolen.to, stolen.data);
  if (b === undefined || !carries(b, 'BadSignature()')) throw new Error(`a signature paid a recipient it does not name, or failed for another reason: ${b}`);
  log('the signature replayed with the front-runner\'s own recipient: refused by the registry, BadSignature');
  // c. The signed removal: the hook pays the recipient it names, and the caller nothing.
  const callerBefore = BigInt(await pub.readContract({ address: key.currency1, abi: ERC20_ABI, functionName: 'balanceOf', args: [deployer.address] }));
  const signed = decreaseCall(key, tokenId, liquidity, deployer.address, hookData(recipient, signature));
  const hash = await send(signed.to, signed.data);
  await until('the recipient\'s tokens', async () => (await pub.getBalance({ address: recipient })) > 0n);
  const [toEth, toUsdc, callerAfter] = await Promise.all([
    pub.getBalance({ address: recipient }),
    pub.readContract({ address: key.currency1, abi: ERC20_ABI, functionName: 'balanceOf', args: [recipient] }),
    pub.readContract({ address: key.currency1, abi: ERC20_ABI, functionName: 'balanceOf', args: [deployer.address] }),
  ]);
  log(`the signed removal paid ${recipient}, the recipient it signed: ${formatEther(toEth)} ETH and ${Number(toUsdc) / 1e6} tUSDC; the caller got ${Number(BigInt(callerAfter) - callerBefore) / 1e6} tUSDC: https://sepolia.etherscan.io/tx/${hash}`);
}

const pq = await hook('PQAccountPoolHook', (1n << 11n) | (1n << 9n) | (1n << 7n) | (1n << 5n),
  [v4.poolManager, v4.positionManager, v4.universalRouter, ARC_AUTHORITY.accountImplementation], v4.pq);
save((u) => { u['pq'] = pq; });
const guard = await hook('PQGuardHook', (1n << 11n) | (1n << 9n) | (1n << 8n) | 1n, [v4.poolManager, v4.positionManager, REGISTRY], v4.guard);
save((u) => { u['guard'] = guard; });
log('written to deployments/eth-sepolia.json');
if (process.argv[2] !== 'guard') await pqPool(pq);
if (process.argv[2] !== 'pq') await guarded(guard);
process.exit(0);
