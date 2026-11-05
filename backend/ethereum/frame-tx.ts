// An EIP-8141 frame transaction whose only signature is FORS+C, on the
// alt-mempool devnet (chain 1337). The account is contracts/frame/FramePQAccount.sol.
//
//   (cd ../contracts && FOUNDRY_PROFILE=frame forge build)
//   node --use-system-ca ethereum/frame-tx.ts fund     the faucet pays the deployer (once an hour)
//   node --use-system-ca ethereum/frame-tx.ts deploy   deploys the account, funded at creation
//   node --use-system-ca ethereum/frame-tx.ts send     VERIFY (FORS+C) + one transfer, through the alt mempool
//   node --use-system-ca ethereum/frame-tx.ts attack   the same, signed by another FORS key: must be refused
//
// Keys live in .stack/eth-devnet/ (0600) and are never printed: the deployer's
// secp256k1 key, which only pays for the deployment, and the FORS seed, the
// account's one key. Devnet ETH has no value.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getProfile } from '@forshtat/hegota-support/profiles';
import { rpc, toWire } from '@forshtat/hegota-support/rpc';
import { frame, newTx, sigHash, type FrameTx } from '@forshtat/hegota-support/tx';
import { encodeSignature, keyGen, pkCommitment, sign } from '@opaque/pq-wallet';
import type { Bytes32 } from '@opaque/protocol-types';
import { encodeAbiParameters, encodeDeployData, encodeFunctionData, formatEther, getContractAddress, hexToBytes, keccak256, parseEther, stringToHex, toHex, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const GATEWAY = 'https://altmempoolgateway.forshtat.com/rpc';
const EXPLORER = 'https://altmempoolexplorer.forshtat.com';
const CHAIN_ID = 1337;
const profile = getProfile('ethrex-eip8141-tracer');
/** FramePQAccount's parameter set: 8 uses at 128 bits, and inside MAX_VERIFY_GAS. */
const PARAMS = { k: 13, a: 13 } as const;
const MAX_USES = 8n;
/** HegotaSupport deploys one helper per opcode this devnet has, so the account's nonce starts at 1 + 7. */
const FIRST_NONCE = 8n;
/** MAX_VERIFY_GAS is 100,000 for VERIFY frames and signature costs together; an ARBITRARY entry costs 100. */
const VERIFY_GAS = 99_000n;
const DOMAIN = keccak256(stringToHex('opaque/v1/eip8141/sighash'));
// The devnet's base fee is 7 wei; these clear it by a wide margin.
const LEGACY_GAS_PRICE = 2_000_000n;
const MAX_FEE = 2_000_000_000n;

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '.stack', 'eth-devnet');
const ARTIFACT = join(HERE, '..', '..', 'contracts', 'out-frame', 'FramePQAccount.sol', 'FramePQAccount.json');

/** A secret file, made on first use with `make`, read thereafter. Never printed. */
function secret(name: string, make: () => Hex): Hex {
  const file = join(DIR, name);
  if (!existsSync(file)) {
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    writeFileSync(file, make(), { mode: 0o600, flag: 'wx' });
  }
  return readFileSync(file, 'utf8').trim() as Hex;
}
const STATE = join(DIR, 'state.json');
const state = (): { account?: Address } => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});

const deployer = privateKeyToAccount(secret('deployer.key', generatePrivateKey));
const forsKey = () => keyGen(hexToBytes(secret('fors.seed', () => toHex(randomBytes(32)))), PARAMS);
const artifact = (): { abi: Abi; bytecode: { object: Hex } } => {
  if (!existsSync(ARTIFACT)) throw new Error('build the account first: cd contracts && FOUNDRY_PROFILE=frame forge build');
  return JSON.parse(readFileSync(ARTIFACT, 'utf8'));
};

async function mined(hash: Hex): Promise<{ status: Hex; blockNumber: Hex; frameReceipts?: { status: Hex }[] }> {
  for (let i = 0; i < 60; i++) {
    const r = await rpc(GATEWAY, 'eth_getTransactionReceipt', [hash]);
    if (r) return r;
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  throw new Error(`${hash} was not mined in 2 minutes`);
}
const balance = async (a: Address) => formatEther(BigInt(await rpc(GATEWAY, 'eth_getBalance', [a, 'latest'])));
const nonceOf = async (a: Address, tag = 'latest') => BigInt(await rpc(GATEWAY, 'eth_getTransactionCount', [a, tag]));

async function fund(): Promise<void> {
  const { txHash } = await rpc(GATEWAY, 'skandha_explorer_faucet', [deployer.address]);
  const r = await mined(txHash);
  if (r.status !== '0x1') throw new Error(`the faucet's transfer ${txHash} reverted`);
  console.log(`deployer ${deployer.address}: ${await balance(deployer.address)} ETH`);
}

async function deploy(): Promise<void> {
  const { abi, bytecode } = artifact();
  const key = pkCommitment(forsKey().publicKey);
  const nonce = await nonceOf(deployer.address, 'pending');
  // Code costs state gas here (EIP-8037: (120 + bytes) x 1,530): about 5.7M for the account and 3M for
  // HegotaSupport's seven helpers, so 6M runs out. 16M stays under the 2^24 per-transaction cap.
  const raw = await deployer.signTransaction({
    chainId: CHAIN_ID, nonce: Number(nonce), gas: 16_000_000n, gasPrice: LEGACY_GAS_PRICE, type: 'legacy',
    // Funded through its creation: a later plain transfer would also work (receive()), but this is one transaction.
    value: parseEther('0.05'),
    data: encodeDeployData({ abi, bytecode: bytecode.object, args: [key, FIRST_NONCE] }),
  });
  const hash: Hex = await rpc(GATEWAY, 'eth_sendRawTransaction', [raw]);
  const r = await mined(hash);
  if (r.status !== '0x1') throw new Error(`deployment ${hash} reverted`);
  const account = getContractAddress({ from: deployer.address, nonce });
  // The key's uses are counted from FIRST_NONCE; a different start would shift them all.
  const start = await nonceOf(account);
  if (start !== FIRST_NONCE) throw new Error(`the account starts at nonce ${start}, not ${FIRST_NONCE}: fix FIRST_NONCE and redeploy`);
  writeFileSync(STATE, `${JSON.stringify({ account }, null, 2)}\n`, { mode: 0o600 });
  console.log(`FramePQAccount ${account} (key ${key}), ${await balance(account)} ETH, deployed in ${hash}`);
}

/** The account's next transaction, VERIFY and one transfer, signed by `key`. */
async function signedTx(key: ReturnType<typeof keyGen>): Promise<{ tx: FrameTx; nonce: bigint; bytes: number }> {
  const { account } = state();
  if (account === undefined) throw new Error('deploy the account first');
  const { abi } = artifact();
  const nonce = await nonceOf(account);
  if (nonce - FIRST_NONCE >= MAX_USES) throw new Error(`the key has signed ${MAX_USES} times: rotate it`);

  let tx: FrameTx = newTx({
    chainId: CHAIN_ID,
    sender: account,
    nonceSeq: nonce,
    frames: [
      frame(profile, 'VERIFY', { scope: 'EXECUTION_AND_PAYMENT', target: null, execution: VERIFY_GAS, data: encodeFunctionData({ abi, functionName: 'verify' }) }),
      frame(profile, 'SENDER', { target: deployer.address, execution: 50_000n, value: 1_000_000_000n }),
    ],
    // ARBITRARY, empty msg: the protocol elides these bytes from the signature hash, so FORS can sign it.
    signatures: [{ scheme: profile.sigSchemes['ARBITRARY']!, signer: '0x', msg: '0x', signature: '0x' }],
    fees: { maxFeePerGas: MAX_FEE },
  });
  const digest = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [DOMAIN, sigHash(profile, tx)]));
  const signature = encodeSignature(key.publicKey, sign(key.secretKey, digest as Bytes32)) as Hex;
  return { tx: { ...tx, signatures: [{ ...tx.signatures[0]!, signature }] }, nonce, bytes: (signature.length - 2) / 2 };
}

async function send(): Promise<void> {
  const { tx, nonce, bytes } = await signedTx(forsKey());
  const hash: Hex = await rpc(GATEWAY, 'eth_sendFrameTransaction', [toWire(tx)]);
  console.log(`sent ${hash} (nonce ${nonce}, FORS+C signature ${bytes} bytes)`);
  const r = await mined(hash);
  const frames = (r.frameReceipts ?? []).map((f, i) => `frame ${i}: ${f.status === '0x1' ? 'ok' : `status ${f.status}`}`);
  console.log(`mined in block ${BigInt(r.blockNumber)}; ${frames.join(', ')}`);
  console.log(`${EXPLORER}/tx/${hash}`);
}

/** Someone without the account's key, here a fresh FORS key, must get nothing past VERIFY. */
async function attack(): Promise<void> {
  const { tx } = await signedTx(keyGen(randomBytes(32), PARAMS));
  try {
    const hash: Hex = await rpc(GATEWAY, 'eth_sendFrameTransaction', [toWire(tx)]);
    throw new Error(`the mempool took a transaction signed by another key: ${hash}`);
  } catch (e) {
    if ((e as Error).message.startsWith('the mempool took')) throw e;
    console.log(`refused, as it must be: ${(e as Error).message.slice(0, 300)}`);
  }
}

const commands: Record<string, () => Promise<void>> = { fund, deploy, send, attack };
const run = commands[process.argv[2] ?? ''];
if (run === undefined) throw new Error('usage: node ethereum/frame-tx.ts fund | deploy | send | attack');
await run();
