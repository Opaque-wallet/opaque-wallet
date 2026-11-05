// FramePQAccount on the EIP-8141 alt-mempool devnet (chain 1337), from the
// command line. The transactions themselves are ethereum/frame.ts, which the
// wallet's devnet page uses too.
//
//   (cd ../contracts && FOUNDRY_PROFILE=frame forge build)
//   node --use-system-ca ethereum/frame-tx.ts fund      the faucet pays the deployer (once an hour)
//   node --use-system-ca ethereum/frame-tx.ts factory   deploys the account factory (infrastructure, once)
//   node --use-system-ca ethereum/frame-tx.ts devnet-faucet [eth]   deploys Opaque's devnet faucet, funded (once)
//   node --use-system-ca ethereum/frame-tx.ts create    a new FORS key, its address funded, its account created:
//                                                       the factory pays, and no ECDSA key signs anything
//   node --use-system-ca ethereum/frame-tx.ts send [to] [eth]   VERIFY (FORS+C) + one transfer (default: 1 gwei to the deployer)
//   node --use-system-ca ethereum/frame-tx.ts attack    the same, signed by another FORS key: must be refused
//   node --use-system-ca ethereum/frame-tx.ts pool      one atomic FORS-signed transaction: deploy pqUSD, approve,
//                                                       create the ETH/pqUSD v4 pool, add liquidity (once)
//   node --use-system-ca ethereum/frame-tx.ts swap [eth]  swap ETH for pqUSD on Uniswap v4, signed by FORS+C alone
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
import { encodeDeployData, formatEther, getContractAddress, hexToBytes, parseEther, toHex, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { accountOf, accountTx, balanceOf, call, createAccount, devnet, faucet, FIRST_NONCE, forsKey, keyOf, mined, nonceOf, sendCalls, settled, txUrl } from './frame.ts';
import { pqUSD, poolSetup, swapCall, tokenBalance } from './uniswap.ts';

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

/** The account this script acts as, and its key. */
function current(): { account: Address; key: ReturnType<typeof forsKey> } {
  const { account, seed } = state();
  if (account === undefined || seed === undefined) throw new Error('create an account first');
  return { account, key: forsKey(hexToBytes(secret(seed, () => { throw new Error(`${seed} is missing`); }))) };
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

async function devnetFaucet(): Promise<void> {
  const { abi, bytecode } = JSON.parse(readFileSync(artifactOf('DevnetFaucet'), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  const d = deployer();
  const nonce = await nonceOf(d.address);
  const raw = await d.signTransaction({
    // Its code and HegotaSupport's helpers cost state gas (EIP-8037), as the factory's do.
    chainId: devnet.chainId, nonce: Number(nonce), gas: 16_000_000n, gasPrice: 2_000_000n, type: 'legacy',
    value: parseEther(process.argv[3] ?? '0.4'),
    data: encodeDeployData({ abi, bytecode: bytecode.object }),
  });
  const hash: Hex = await call('eth_sendRawTransaction', [raw]);
  const r = await mined(hash);
  if (r.status !== '0x1') throw new Error(`deployment ${hash} reverted`);
  const address = getContractAddress({ from: d.address, nonce });
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
  const { account, key } = current();
  const to = (process.argv[3] ?? deployer().address) as Address;
  const value = process.argv[4] === undefined ? 1_000_000_000n : parseEther(process.argv[4]);
  // A transfer to an address with no account yet creates one: state gas (EIP-8037).
  const hash = await sendCalls(account, key, [{ to, value, gas: 50_000n, state: 200_000n }]);
  const r = await settled(hash);
  console.log(`sent ${hash}, mined in block ${BigInt(r.blockNumber)}, every frame ok\n${txUrl(hash)}`);
}

/** Someone without the account's key, here a fresh FORS key, must get nothing past VERIFY. */
async function attack(): Promise<void> {
  const { account } = current();
  const tx = await accountTx(account, forsKey(randomBytes(32)), [{ to: deployer().address, value: 1n, gas: 50_000n }]);
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
  const { account, key } = current();
  const { abi, bytecode } = JSON.parse(readFileSync(artifactOf('TestToken'), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
  const initCode = encodeDeployData({ abi, bytecode: bytecode.object, args: ['Post-Quantum Test Dollar', 'pqUSD', account, parseEther('1000000')] });
  const { token, calls } = await poolSetup(account, initCode, parseEther('0.1'), 2000n);
  const hash = await sendCalls(account, key, calls, true);
  await settled(hash);
  console.log(`pqUSD ${token}; ETH/pqUSD pool made and funded, ${calls.length} frames in one atomic batch: ${hash}\n${txUrl(hash)}`);
  const file = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'));
  file.uniswap.pqUSD = token;
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(file, null, 2)}\n`);
  console.log('written to deployments/eth-devnet.json');
}

/** ETH for pqUSD on Uniswap v4, with FORS+C the only signature. */
async function swap(): Promise<void> {
  const { account, key } = current();
  const amount = parseEther(process.argv[3] ?? '0.001');
  const before = await tokenBalance(account);
  const { call: c, expected } = await swapCall(amount);
  const hash = await sendCalls(account, key, [c]);
  await settled(hash);
  const got = (await tokenBalance(account)) - before;
  console.log(`swapped ${formatEther(amount)} ETH for ${formatEther(got)} pqUSD (quoted ${formatEther(expected)}): ${hash}\n${txUrl(hash)}`);
}

const commands: Record<string, () => Promise<void>> = { fund, factory, 'devnet-faucet': devnetFaucet, create, send, attack, pool, swap };
const run = commands[process.argv[2] ?? ''];
if (run === undefined) throw new Error(`usage: node ethereum/frame-tx.ts ${Object.keys(commands).join(' | ')}`);
await run();
