// FramePQAccount on the EIP-8141 alt-mempool devnet (chain 1337), from the
// command line. The transactions themselves are ethereum/frame.ts, which the
// wallet's devnet page uses too.
//
//   (cd ../contracts && FOUNDRY_PROFILE=frame forge build)
//   node --use-system-ca ethereum/frame-tx.ts fund      the faucet pays the deployer (once an hour)
//   node --use-system-ca ethereum/frame-tx.ts factory   deploys the account factory (infrastructure, once)
//   node --use-system-ca ethereum/frame-tx.ts devnet-faucet [eth] [drip]   a new Opaque devnet faucet from this account, funded
//                                                       (default 0.01, drips 0.001), topped up by the old one first
//   node --use-system-ca ethereum/frame-tx.ts create    a new FORS key, its address funded, its account created:
//                                                       the factory pays, and no ECDSA key signs anything
//   node --use-system-ca ethereum/frame-tx.ts send [to] [eth]   VERIFY (FORS+C) + one transfer (default: 1 gwei to the deployer)
//   node --use-system-ca ethereum/frame-tx.ts attack    the same, signed by another FORS key: must be refused
//   node --use-system-ca ethereum/frame-tx.ts rotate [eth]  hands the account to a new FORS key; with [eth], the same
//                                                       transaction also tops up Opaque's devnet faucet
//   node --use-system-ca ethereum/frame-tx.ts pool      one atomic FORS-signed transaction: deploy pqUSD, approve,
//                                                       create the ETH/pqUSD v4 pool, add liquidity (once)
//   node --use-system-ca ethereum/frame-tx.ts swap [eth]  swap ETH for pqUSD on Uniswap v4, signed by FORS+C alone
//   node --use-system-ca ethereum/frame-tx.ts swap <n> pqusd  swap n pqUSD back for ETH: approvals and swap in one atomic batch
//   node --use-system-ca ethereum/frame-tx.ts privacy   Opaque's privacy layer (T11): pqUSDC, PQKeyRegistry, a verifier
//                                                       and pool per note size, the stack's account registered as the
//                                                       attester, each pool's first ring seeded. Resumes where it stopped.
//
// Each command signs as the account in state.json. A key's last signature also
// hands the account to a fresh key (signed() below), so no command can strand it.
//
// Keys live in .stack/eth-devnet/ (0600) and are never printed: the deployer's
// secp256k1 key, which only deploys the factory, and each account's FORS seed.
// A seed belongs to one account: its few-time budget would not survive two.
// Devnet ETH has no value.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toWire } from '@forshtat/hegota-support/rpc';
import { concat, encodeDeployData, encodeFunctionData, formatEther, getContractAddress, hexToBytes, keccak256, parseAbi, parseEther, stringToHex, toHex, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { poolId } from '@opaque/protocol-types/codecs.js';

import { attesterCommitment } from '../cre/attester-keys.ts';
import { createNoteSecret, deriveCommitment } from '../zk/index.ts';
import { accountOf, accountTx, ATTESTER_FIRST_GENERATION, balanceOf, call, createAccount, devnet, faucet, FIRST_NONCE, forsKey, hasCode, keyNow, keyOf, MAX_USES, mined, nonceOf, seededKey, sendCalls, settled, STACK_FORS, txUrl, type Call } from './frame.ts';
import { pqUSD, poolSetup, swapCalls, tokenBalance } from './uniswap.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '.stack', 'eth-devnet');
const STATE = join(DIR, 'state.json');
const DEPLOYMENTS = join(HERE, '..', '..', 'deployments', 'eth-devnet.json');
const artifactOf = (name: string): string => join(HERE, '..', '..', 'contracts', 'out-frame', `${name}.sol`, `${name}.json`);
const ARTIFACT = artifactOf('FramePQAccountFactory');

/** A secret file, made on first use with `make`, read thereafter. Never printed. */
function secret(name: string, make: () => Hex): Hex {
  const file = join(DIR, name);
  if (!existsSync(file)) {
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    writeFileSync(file, make(), { mode: 0o600, flag: 'wx' });
  }
  return readFileSync(file, 'utf8').trim() as Hex;
}
const state = (): { account?: Address; seed?: string } => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});
const deployer = () => privateKeyToAccount(secret('deployer.key', generatePrivateKey));
const eth = async (a: Address) => `${formatEther(await balanceOf(a))} ETH`;

const keyFrom = (seed: string) => forsKey(hexToBytes(secret(seed, () => { throw new Error(`${seed} is missing`); })));

const me = (): Address => {
  const { account } = state();
  if (account === undefined) throw new Error('create an account first');
  return account;
};

/**
 * Signs and sends `calls` as the script's account. A key's last signature also
 * hands the account to a fresh key (accountTx's `next`): its seed is saved
 * before anything is sent, and becomes the script's once the chain shows the
 * handover, whatever the calls did. `handover` makes one now.
 */
async function signed(calls: readonly Call[], atomic = false, handover = false): Promise<Hex> {
  const { account, seed } = state();
  if (account === undefined || seed === undefined) throw new Error('create an account first');
  const [nonce, { first }] = await Promise.all([nonceOf(account), keyNow(account)]);
  if (!handover && MAX_USES - (nonce - first) > 1n) return sendCalls(account, keyFrom(seed), calls, atomic);
  const nextSeed = `fors-${Date.now()}.seed`;
  secret(nextSeed, () => toHex(randomBytes(32)));
  const next = keyFrom(nextSeed);
  const hash = await sendCalls(account, keyFrom(seed), calls, atomic, keyOf(next));
  await mined(hash);
  if ((await keyNow(account)).key.toLowerCase() !== keyOf(next).toLowerCase()) throw new Error(`${hash} did not hand the account over: ${txUrl(hash)}`);
  writeFileSync(STATE, `${JSON.stringify({ account, seed: nextSeed }, null, 2)}\n`, { mode: 0o600 });
  console.log(`  (a key's last signature: the account now answers to ${keyOf(next).slice(0, 10)}…)`);
  return hash;
}

async function fund(): Promise<void> {
  const d = deployer();
  await faucet(d.address);
  console.log(`deployer ${d.address}: ${await eth(d.address)}`);
}

async function factory(): Promise<void> {
  if (!existsSync(ARTIFACT)) throw new Error('build first: cd contracts && FOUNDRY_PROFILE=frame forge build');
  const { abi, bytecode } = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  const d = deployer();
  const nonce = await nonceOf(d.address);
  const raw = await d.signTransaction({
    // Code costs state gas here (EIP-8037: (120 + bytes) x 1,530): about 10M for the factory, which carries
    // the account's creation code, and 3M for HegotaSupport's helpers. 16M stays under the 2^24 cap.
    chainId: devnet.chainId, nonce: Number(nonce), gas: 16_000_000n, gasPrice: 2_000_000n, type: 'legacy',
    // What it pays creating accounts with.
    value: parseEther('0.5'),
    data: encodeDeployData({ abi, bytecode: bytecode.object }),
  });
  const hash: Hex = await call('eth_sendRawTransaction', [raw]);
  const r = await mined(hash);
  if (r.status !== '0x1') throw new Error(`deployment ${hash} reverted`);
  const address = getContractAddress({ from: d.address, nonce });
  const file = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'));
  file.contracts.factory = address;
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`FramePQAccountFactory ${address}, ${await eth(address)}, deployed in ${hash}; written to deployments/eth-devnet.json`);
}

/**
 * Opaque's devnet faucet, deployed by the script's account through the CREATE2
 * proxy: `drip` ETH an address an hour, funded with `eth`. What the faucet in
 * force can still give goes to the new one's address first.
 */
async function devnetFaucet(): Promise<void> {
  const { abi, bytecode } = JSON.parse(readFileSync(artifactOf('DevnetFaucet'), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  const salt = keccak256(stringToHex('opaque/v1/devnet/faucet'));
  const initCode = encodeDeployData({ abi, bytecode: bytecode.object, args: [parseEther(process.argv[4] ?? '0.001')] });
  const create2Deployer = (devnet.uniswap as { create2Deployer: Address }).create2Deployer;
  const address = getContractAddress({ opcode: 'CREATE2', from: create2Deployer, salt, bytecode: initCode });
  // The devnet's faucet if it has refilled, else ours: one drip, the new faucet's first funds.
  await faucet(address).then((h) => console.log(`the faucet in force dripped into ${address}: ${txUrl(h)}`), (e: Error) => console.log(`no drip from the faucet in force (${e.message.slice(0, 80)})`));
  // Its code and HegotaSupport's helpers cost state gas (EIP-8037); the proxy passes the value to the constructor.
  const hash = await signed([{ to: create2Deployer, data: concat([salt, initCode]), value: parseEther(process.argv[3] ?? '0.01'), gas: 3_000_000n, state: 12_000_000n }]);
  await settled(hash);
  const file = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'));
  file.contracts.faucet = address;
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`DevnetFaucet ${address}, ${await eth(address)}, deployed in ${hash}; written to deployments/eth-devnet.json`);
}

async function create(): Promise<void> {
  const seed = `fors-${Date.now()}.seed`;
  const key = forsKey(hexToBytes(secret(seed, () => toHex(randomBytes(32)))));
  const account = await accountOf(keyOf(key));
  console.log(`key ${keyOf(key)}\naccount ${account} (known before it exists)`);
  await faucet(account);
  console.log(`funded by the faucet: ${await eth(account)}`);
  const hash = await createAccount(keyOf(key));
  await settled(hash);
  const nonce = await nonceOf(account);
  if (nonce !== FIRST_NONCE) throw new Error(`the account starts at nonce ${nonce}, not ${FIRST_NONCE}`);
  writeFileSync(STATE, `${JSON.stringify({ account, seed }, null, 2)}\n`, { mode: 0o600 });
  console.log(`created in ${hash}, paid for by the factory\n${txUrl(hash)}`);
}

async function send(): Promise<void> {
  const to = (process.argv[3] ?? deployer().address) as Address;
  const value = process.argv[4] === undefined ? 1_000_000_000n : parseEther(process.argv[4]);
  // A transfer to an address with no account yet creates one: state gas (EIP-8037).
  const hash = await signed([{ to, value, gas: 50_000n, state: 200_000n }]);
  const r = await settled(hash);
  console.log(`sent ${hash}, mined in block ${BigInt(r.blockNumber)}, every frame ok\n${txUrl(hash)}`);
}

/** Hands the account to a fresh key now; with [eth], the same transaction tops up Opaque's devnet faucet. */
async function rotate(): Promise<void> {
  const faucet = (devnet.contracts as unknown as { faucet: Address }).faucet;
  const topUp = process.argv[3] === undefined ? [] : [{ to: faucet, value: parseEther(process.argv[3]), gas: 50_000n }];
  const hash = await signed(topUp, false, true);
  await settled(hash);
  console.log(`${topUp.length ? `faucet topped up to ${await eth(faucet)}: ` : ''}${hash}\n${txUrl(hash)}`);
}

/** Someone without the account's key, here a fresh FORS key, must get nothing past VERIFY. */
async function attack(): Promise<void> {
  const tx = await accountTx(me(), forsKey(randomBytes(32)), [{ to: deployer().address, value: 1n, gas: 50_000n }]);
  try {
    const hash: Hex = await call('eth_sendFrameTransaction', [toWire(tx)]);
    throw new Error(`the mempool took a transaction signed by another key: ${hash}`);
  } catch (e) {
    if ((e as Error).message.startsWith('the mempool took')) throw e;
    console.log(`refused, as it must be: ${(e as Error).message.slice(0, 300)}`);
  }
}

/** The ETH/pqUSD pool, in one atomic transaction the account signs with FORS+C. */
async function pool(): Promise<void> {
  if ((devnet.uniswap as { pqUSD: string | null }).pqUSD !== null) throw new Error(`the pool exists already: pqUSD ${pqUSD()}`);
  const account = me();
  const { abi, bytecode } = JSON.parse(readFileSync(artifactOf('TestToken'), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  const initCode = encodeDeployData({ abi, bytecode: bytecode.object, args: ['Post-Quantum Test Dollar', 'pqUSD', 18, account, parseEther('1000000')] });
  const { token, calls } = await poolSetup(account, initCode, parseEther('0.1'), 2000n);
  const hash = await signed(calls, true);
  await settled(hash);
  console.log(`pqUSD ${token}; ETH/pqUSD pool made and funded, ${calls.length} frames in one atomic batch: ${hash}\n${txUrl(hash)}`);
  const file = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'));
  file.uniswap.pqUSD = token;
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(file, null, 2)}\n`);
  console.log('written to deployments/eth-devnet.json');
}

/** ETH for pqUSD on Uniswap v4, or pqUSD back for ETH, with FORS+C the only signature. */
async function swap(): Promise<void> {
  const account = me();
  const ethIn = process.argv[4] !== 'pqusd';
  const amount = parseEther(process.argv[3] ?? '0.001');
  const before = await tokenBalance(account);
  const { calls, expected } = await swapCalls(amount, ethIn);
  const hash = await signed(calls, true);
  await settled(hash);
  const usd = (await tokenBalance(account)) - before;
  console.log(ethIn
    ? `swapped ${formatEther(amount)} ETH for ${formatEther(usd)} pqUSD (quoted ${formatEther(expected)}): ${hash}\n${txUrl(hash)}`
    : `swapped ${formatEther(-usd)} pqUSD for ETH (quoted ${formatEther(expected)} ETH), ${calls.length} frames in one atomic batch: ${hash}\n${txUrl(hash)}`);
}

// ── Opaque's privacy layer on the devnet (T11) ───────────────────────────
/** The note sizes in pqUSDC's 6 decimals: Arc's ladder (contracts/src/opaque/pool/Denominations.sol). */
const SIZES = [1n, 2n, 5n, 10n, 20n, 50n, 100n].map((n) => n * 1_000_000n);
type Artifact = { abi: Abi; bytecode: { object: Hex } };
const opaqueArtifact = (name: string): Artifact => JSON.parse(readFileSync(join(HERE, '..', '..', 'contracts', 'out', `${name}.sol`, `${name}.json`), 'utf8'));
const frameArtifact = (name: string): Artifact => JSON.parse(readFileSync(artifactOf(name), 'utf8'));
const deployData = (a: Artifact, args: readonly unknown[] = []): Hex => encodeDeployData({ abi: a.abi, bytecode: a.bytecode.object, args } as never);
/**
 * The masters of the devnet stack's own account (ethereum/devnet-stack.ts):
 * its frame keys pay for every spend, and its registry key, the attester's,
 * signs every attestation. Kept here and given to the stack's host as secrets.
 */
const stackMaster = () => secret('stack.master', () => toHex(randomBytes(32)));
const attesterMaster = () => hexToBytes(secret('attester.master', () => toHex(randomBytes(32))));
const PRIVACY_ABI = parseAbi([
  'function deploy(bytes initCode) returns (address)',
  'function register(bytes32 pkCommitment, bytes32 nextCommitment, uint64 maxUses, uint64 rotationDeadline)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function deposit(bytes32 commitment)',
  'function poolId() view returns (bytes32)',
  'function verifier() view returns (address)',
]);
const read = async (to: Address, functionName: 'poolId' | 'verifier'): Promise<Hex> =>
  call('eth_call', [{ to, data: encodeFunctionData({ abi: PRIVACY_ABI, functionName }) }, 'latest']);
const blockOf = async (hash: Hex): Promise<number> => Number(BigInt((await settled(hash)).blockNumber));

async function privacy(): Promise<void> {
  const account = me();
  const file = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'));
  const p = (file.privacy ??= { pools: [] });
  const save = () => writeFileSync(DEPLOYMENTS, `${JSON.stringify(file, null, 2)}\n`);
  const salt = keccak256(stringToHex('opaque/v1/devnet/privacy'));
  const create2Deployer = (devnet.uniswap as { create2Deployer: Address }).create2Deployer;
  const create2 = (initCode: Hex, gas: bigint, state: bigint) => ({
    address: getContractAddress({ opcode: 'CREATE2', from: create2Deployer, salt, bytecode: initCode }).toLowerCase() as Address,
    call: { to: create2Deployer, data: concat([salt, initCode]), gas, state } as Call,
  });
  const stackKey0 = seededKey(stackMaster(), STACK_FORS, 0);
  const stack = (await accountOf(keyOf(stackKey0))).toLowerCase() as Address;

  // 1. The CREATE helper, and pqUSDC: 6 decimals, as the note sizes assume; its supply to this account.
  if (p.token === undefined) {
    const helper = create2(deployData(frameArtifact('CreateDeployer'), [account]), 300_000n, 1_000_000n);
    const token = create2(deployData(frameArtifact('TestToken'), ['Post-Quantum Test Dollar', 'pqUSDC', 6, account, 10_000_000n * 1_000_000n]), 1_500_000n, 4_000_000n);
    const hash = await signed([helper.call, token.call], true);
    Object.assign(p, { createDeployer: helper.address, token: { address: token.address, symbol: 'pqUSDC', decimals: 6, deployedAtBlock: await blockOf(hash) } });
    save();
    console.log(`CreateDeployer ${helper.address}, pqUSDC ${token.address}: ${txUrl(hash)}`);
  }
  // 2. PQKeyRegistry: its FORS verifier's code alone is ~11M state gas, so a transaction of its own.
  if (p.pqKeyRegistry === undefined) {
    const registry = create2(deployData(opaqueArtifact('PQKeyRegistry')), 2_000_000n, 12_000_000n);
    const hash = await signed([registry.call]);
    p.pqKeyRegistry = { address: registry.address, deployedAtBlock: await blockOf(hash) };
    save();
    console.log(`PQKeyRegistry ${registry.address}: ${txUrl(hash)}`);
  }
  // 3. A verifier and its pool per size, through the helper: the pool's address follows from the
  //    helper's nonce, so the verifier binds the pool's id before the pool exists.
  for (const size of SIZES) {
    if (p.pools.some((q: { denomination: number }) => BigInt(q.denomination) === size)) continue;
    const helper = p.createDeployer as Address;
    const n = await nonceOf(helper);
    const verifier = getContractAddress({ from: helper, nonce: n }).toLowerCase() as Address;
    const pool = getContractAddress({ from: helper, nonce: n + 1n }).toLowerCase() as Address;
    const id = poolId({ chainId: BigInt(devnet.chainId), pool, denomination: Number(size) } as never);
    const deploy = (initCode: Hex, gas: bigint, state: bigint): Call =>
      ({ to: helper, data: encodeFunctionData({ abi: PRIVACY_ABI, functionName: 'deploy', args: [initCode] }), gas, state });
    const hash = await signed([
      deploy(deployData(opaqueArtifact('AttestedRingVerifier'), [p.pqKeyRegistry.address, stack, id, size]), 1_000_000n, 4_500_000n),
      deploy(deployData(opaqueArtifact('PrivatePool'), [p.token.address, size, verifier]), 1_500_000n, 7_500_000n),
    ], true);
    const at = await blockOf(hash);
    // A pool whose verifier binds another pool's id would refuse every spend.
    if ((await read(pool, 'poolId')).toLowerCase() !== id.toLowerCase() || BigInt(await read(pool, 'verifier')) !== BigInt(verifier)) {
      throw new Error(`the ${size} pool at ${pool} does not match its verifier: ${txUrl(hash)}`);
    }
    p.pools.push({ denomination: Number(size), address: pool, verifier, deployedAtBlock: at, decoys: 0 });
    save();
    console.log(`${Number(size) / 1e6} pqUSDC: pool ${pool}, verifier ${verifier}: ${txUrl(hash)}`);
  }
  // 4. The stack's account: created (the factory pays), given gas, and registered as the attester.
  if (p.attester === undefined) {
    if (!(await hasCode(stack))) await settled(await createAccount(keyOf(stackKey0)));
    await settled(await signed([{ to: stack, value: parseEther('0.1'), gas: 50_000n }]));
    const master = attesterMaster();
    const now = BigInt((await call('eth_getBlockByNumber', ['latest', false])).timestamp);
    // As Arc's attester: 32 signatures a key, rotation within 30 days (contracts/script/DeployRingPool.s.sol).
    const args = [attesterCommitment(master, ATTESTER_FIRST_GENERATION), attesterCommitment(master, ATTESTER_FIRST_GENERATION + 1), 32n, now + 30n * 86_400n] as const;
    const hash = await sendCalls(stack, stackKey0, [{ to: p.pqKeyRegistry.address, data: encodeFunctionData({ abi: PRIVACY_ABI, functionName: 'register', args }), gas: 300_000n, state: 500_000n }]);
    await settled(hash);
    p.attester = stack;
    save();
    console.log(`the stack's account ${stack} is the attester: ${txUrl(hash)}`);
  }
  // 5. Each pool's first ring: eight decoys, made as real notes are (deriveCommitment: a ring proves
  //    membership over 128-bit images, and a random bytes32 can never sit in one) from secrets nobody
  //    keeps, so the first real note has seven. Four to a transaction: one of ten frames was dropped.
  //    `decoys` counts them; the first seeding, on 6 November, used random bytes32 and counts none.
  const decoys = (q: { denomination: number; address: Address }): Call[] => Array.from({ length: 4 }, (): Call => {
    const commitment = deriveCommitment(createNoteSecret(), { chainId: BigInt(devnet.chainId), pool: q.address, denomination: q.denomination } as never);
    return { to: q.address, data: encodeFunctionData({ abi: PRIVACY_ABI, functionName: 'deposit', args: [commitment as Hex] }), gas: 150_000n, state: 300_000n };
  });
  for (const q of p.pools as { denomination: number; address: Address; decoys?: number; seeded?: boolean }[]) {
    if (q.decoys === 8) continue;
    const approve: Call = { to: p.token.address, data: encodeFunctionData({ abi: PRIVACY_ABI, functionName: 'approve', args: [q.address, 8n * BigInt(q.denomination)] }), gas: 100_000n, state: 200_000n };
    await settled(await signed([approve, ...decoys(q)], true));
    const hash = await signed(decoys(q), true);
    await settled(hash);
    delete q.seeded;
    q.decoys = 8;
    save();
    console.log(`${q.denomination / 1e6} pqUSDC ring seeded: ${txUrl(hash)}`);
  }
  // 6. A pqUSDC faucet the page asks with no key, paying its own gas: 0.05 ETH and 100,000 pqUSDC to start.
  if (p.faucet === undefined) {
    const faucet = create2(deployData(frameArtifact('TokenFaucet'), [p.token.address, 100n * 1_000_000n]), 3_000_000n, 12_000_000n);
    const hash = await signed([
      // The CREATE2 deployer passes the call's value on to the constructor.
      { ...faucet.call, value: parseEther('0.05') },
      { to: p.token.address, data: encodeFunctionData({ abi: parseAbi(['function transfer(address to, uint256 value) returns (bool)']), functionName: 'transfer', args: [faucet.address, 100_000n * 1_000_000n] }), gas: 100_000n, state: 200_000n },
    ], true);
    await settled(hash);
    p.faucet = faucet.address;
    save();
    console.log(`pqUSDC faucet ${faucet.address}: ${txUrl(hash)}`);
  }
  console.log('privacy layer deployed; written to deployments/eth-devnet.json');
}

const commands: Record<string, () => Promise<void>> = { fund, factory, 'devnet-faucet': devnetFaucet, create, send, attack, rotate, pool, swap, privacy };
const run = commands[process.argv[2] ?? ''];
if (run === undefined) throw new Error(`usage: node ethereum/frame-tx.ts ${Object.keys(commands).join(' | ')}`);
await run();
