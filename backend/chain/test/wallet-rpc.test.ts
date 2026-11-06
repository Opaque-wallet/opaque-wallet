// What the exit's egress key pays for from WALLET_RPC, and the bundler it
// relays to. The chain and the bundler are stood in for, so this runs offline;
// viem, its nonce manager and the exit's own code are the real ones.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPublicClient, custom, encodeFunctionResult, keccak256, parseTransaction, toFunctionSelector, toHex as hexOf, type Hex as ViemHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createNonceManager, jsonRpc } from 'viem/nonce';

import type { Address, Bytes32, Hex, PrivateSpend } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { entryPoint } from '../../../deployments/index.ts';
import { ARC, POOL_ABI, createPoolClient } from '../pool.ts';
import { createWalletRpcAnswerer, relayRotation, STATE_ABI, type WalletRpcSend } from '../wallet-rpc.ts';

const implementation = `0x${'ab'.repeat(20)}` as Address;
const cloneCode = `0x363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`;
const ACCOUNT = `0x${'33'.repeat(20)}` as Address;
const NEXT = `0x${'cd'.repeat(32)}` as Bytes32;
const SIGNATURE = `0x${'ef'.repeat(64)}` as Hex;
const offChain = { pqWallet: 'LIVE', graph: 'LIVE', confidentialExecution: 'SIMULATED', policyScope: 'CRE_WORKFLOW_ONLY' } as const;
// A published, worthless key: Foundry's anvil account 0.
const EGRESS_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const stateOf = encodeFunctionResult({ abi: STATE_ABI, functionName: 'stateOf', result: {
  pkCommitment: `0x${'aa'.repeat(32)}`, nextCommitment: `0x${'bb'.repeat(32)}`, useCount: 7n, maxUses: 32n, rotationDeadline: 2_000_000_000n, disableAfter: 0n,
} as never });

const ask = async (send: WalletRpcSend, operation: string, request: unknown) =>
  JSON.parse(new TextDecoder().decode(fromHex(await send(operation as never, toHex(new TextEncoder().encode(JSON.stringify(request))) as Hex))));

/** `n` turns of the event loop: long enough for anything not waiting on something else. */
const turns = (n: number) => new Promise<void>((resolve) => {
  const step = (left: number): void => { if (left === 0) resolve(); else setImmediate(() => step(left - 1)); };
  step(n);
});

test('F57_rotations_asked_at_once_are_relayed_once', async () => {
  // The PoC: the cooldown was set only after the transaction was sent, so N
  // rotations asked at once all passed it, and the exit paid for N
  // transactions of which one could land.
  const written: unknown[] = [];
  const yieldThen = <T>(value: T) => new Promise<T>((resolve) => setImmediate(() => resolve(value)));
  const publicClient = {
    getCode: () => yieldThen(cloneCode),
    call: () => yieldThen({ data: stateOf }),
    simulateContract: (request: unknown) => yieldThen({ request }),
    extend: () => ({ writeContract: async (request: unknown) => { written.push(request); return `0x${'99'.repeat(32)}`; } }),
    waitForTransactionReceipt: async () => ({ status: 'success' }),
  };
  const send = createWalletRpcAnswerer({
    publicClient: publicClient as never, bundlerUrl: 'https://bundler.invalid', entryPoint: entryPoint() as Address,
    accountImplementation: implementation, payer: { address: `0x${'ee'.repeat(20)}` } as never,
  });
  const asked = await Promise.allSettled(Array.from({ length: 5 }, () => relayRotation(send, ACCOUNT, NEXT, 32n, 2_000_000_000n, SIGNATURE)));
  assert.equal(written.length, 1, 'one transaction paid for');
  assert.equal(asked.filter((a) => a.status === 'fulfilled').length, 1);
  for (const a of asked) if (a.status === 'rejected') assert.match(String(a.reason), /a moment ago/);
});

test('F57_a_rotation_that_fails_after_taking_a_nonce_leaves_no_gap_for_a_settlement', async () => {
  // The PoC: one egress key, two writers. A relayed rotation took nonce 5 and
  // was still estimating its gas when a settlement took nonce 6. The estimate
  // reverted, viem forgot nonce 5, and the settlement sat behind a gap that
  // nothing would fill, its receipt wait timing out and the turn moving on.
  const sent: number[] = [];
  // The rotation's gas estimate is held until the test lets it revert.
  let estimating = false;
  let reverting = false;
  const held: (() => void)[] = [];
  const revert = () => Object.assign(new Error('execution reverted'), { code: -32000 });
  const failRotation = () => { reverting = true; for (const reject of held) reject(); };
  const rotateSelector = toFunctionSelector('rotate(address,bytes32,uint64,uint64,bytes)');
  const capabilities = toFunctionSelector('capabilities()');
  const rpc = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const [first] = (params ?? []) as [Record<string, string>?];
      switch (method) {
        case 'eth_chainId': return hexOf(ARC.id);
        // Five mined before; then only what would execute: a nonce behind a gap is not pending.
        case 'eth_getTransactionCount': { let n = 5; while (sent.includes(n)) n++; return hexOf(n); }
        case 'eth_getBlockByNumber': return { number: '0x10', hash: `0x${'01'.repeat(32)}`, timestamp: '0x1', baseFeePerGas: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [] };
        case 'eth_maxPriorityFeePerGas': return '0x1';
        case 'eth_getCode': return cloneCode;
        case 'eth_call':
          if (first?.['data']?.startsWith(capabilities)) {
            return encodeFunctionResult({ abi: POOL_ABI, functionName: 'capabilities', result: { proofMode: 0, ringSize: 8, verifierId: `0x${'44'.repeat(32)}`, denomination: 1_000_000n, requiresCommitReveal: false } as never });
          }
          return first?.['data']?.startsWith('0x') && first['data'].length === 74 ? stateOf : '0x';
        case 'eth_estimateGas':
          if (!first?.['data']?.startsWith(rotateSelector)) return '0x5208';
          estimating = true;
          if (reverting) throw revert();
          return new Promise((_resolve, reject) => { held.push(() => reject(revert())); });
        case 'eth_sendRawTransaction': {
          const raw = (params as [ViemHex])[0];
          sent.push(parseTransaction(raw).nonce!);
          return keccak256(raw);
        }
        // Anything else (eth_fillTransaction, say) is a method this node lacks.
        default: throw Object.assign(new Error(`no ${method} here`), { code: -32601 });
      }
    },
  });
  // The egress key, as stack.ts gives it to both: one account, one nonce manager.
  const egress = privateKeyToAccount(EGRESS_KEY, { nonceManager: createNonceManager({ source: jsonRpc() }) });
  const send = createWalletRpcAnswerer({
    publicClient: createPublicClient({ chain: ARC, transport: rpc }) as never, bundlerUrl: 'https://bundler.invalid',
    entryPoint: entryPoint() as Address, accountImplementation: implementation, payer: egress,
  });
  const pool = createPoolClient({ account: egress, offChain, transport: rpc });

  const rotating = relayRotation(send, ACCOUNT, NEXT, 32n, 2_000_000_000n, SIGNATURE).catch((e: Error) => e);
  while (!estimating) await turns(1);
  const settling = pool.spend({
    mode: 'RING_8', scope: { chainId: BigInt(ARC.id), pool: `0x${'11'.repeat(20)}`, denomination: 1_000_000 },
    ring: Array.from({ length: 8 }, (_, i) => `0x${String(i + 1).padStart(64, '0')}`), proof: `0x${'22'.repeat(64)}`,
    recipient: `0x${'aa'.repeat(20)}`, nullifier: `0x${'55'.repeat(32)}`,
  } as unknown as PrivateSpend);
  await turns(50);
  failRotation();
  assert.match(String(await rotating), /reverted/);
  await settling;
  assert.deepEqual(sent, [5], 'the settlement took the nonce the failed rotation gave back');
});

test('F63c_a_bundler_that_never_answers_is_given_up_on', async () => {
  // The PoC: the bundler call had no deadline, so one that never answered held
  // the query, and the relay's request behind it, for as long as the socket lived.
  const send = createWalletRpcAnswerer({
    publicClient: {} as never, bundlerUrl: 'https://bundler.invalid', entryPoint: entryPoint() as Address,
    accountImplementation: implementation, bundlerTimeoutMs: 5,
    fetch: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      assert.ok(init.signal, 'the call carries a deadline');
      init.signal.addEventListener('abort', () => reject(init.signal!.reason));
    })) as never,
  });
  // AbortSignal.timeout's timer does not hold the process open; a server's sockets do.
  const alive = setInterval(() => undefined, 1_000);
  try {
    const answer = await ask(send, 'USER_OPERATION_RECEIPT', { method: 'eth_getUserOperationReceipt', params: [`0x${'12'.repeat(32)}`] });
    assert.match(answer.error.message, /timeout|abort/i);
  } finally {
    clearInterval(alive);
  }
});

test('an_eth_balance_read_is_allowed_only_where_gas_is_eth', async () => {
  const { walletRpcAllowlist } = await import('../wallet-rpc.ts');
  const { deployment } = await import('../../../deployments/index.ts');
  const multicall = walletRpcAllowlist().get('0xca11bde05977b3631167028862be2a173976ca11');
  if (deployment.network.nativeCurrency.symbol === 'USDC') assert.equal(multicall, undefined, 'Arc reads its USDC, never Multicall3');
  else assert.deepEqual([...multicall!], [toFunctionSelector('getEthBalance(address)')], 'only getEthBalance, nothing else Multicall3 can do');
});

test('stealth_the_exit_pays_only_for_a_well_formed_announcement_and_a_sweep_it_can_check', async () => {
  const { deployment } = await import('../../../deployments/index.ts');
  const { CIPHERTEXT_BYTES } = await import('../stealth.ts');
  const written: unknown[] = [];
  const sent: unknown[] = [];
  let code = '0x';
  let announced: unknown[] = [];
  const publicClient = {
    getCode: async () => code,
    getBlockNumber: async () => BigInt(deployment.stealth?.fromBlock ?? 0) + 100n,
    getLogs: async () => announced,
    readContract: async () => 5_000_000n,
    getBalance: async () => 0n,
    simulateContract: async (request: unknown) => ({ request }),
    extend: () => ({
      writeContract: async (request: unknown) => { written.push(request); return `0x${'99'.repeat(32)}`; },
      sendTransaction: async (request: unknown) => { sent.push(request); return `0x${'98'.repeat(32)}`; },
    }),
    waitForTransactionReceipt: async () => ({ status: 'success' }),
  };
  const send = createWalletRpcAnswerer({
    publicClient: publicClient as never, bundlerUrl: 'https://bundler.invalid', entryPoint: entryPoint() as Address,
    accountImplementation: implementation, payer: { address: `0x${'ee'.repeat(20)}` } as never,
  });
  if (deployment.stealth === undefined) {
    assert.match((await ask(send, 'STEALTH', { action: 'scan' })).error.message, /no stealth payments/);
    return;
  }
  const ct = `0x${'ab'.repeat(CIPHERTEXT_BYTES)}`;
  const to = `0x${'44'.repeat(20)}`;
  assert.match((await ask(send, 'STEALTH', { action: 'announce', stealthAddress: to, ephemeralPubKey: '0xabcd', metadata: '0x01' })).error.message, /ciphertext/);
  assert.ok((await ask(send, 'STEALTH', { action: 'announce', stealthAddress: to, ephemeralPubKey: ct, metadata: '0x01' })).result.txHash);
  assert.equal(written.length, 1, 'one announcement paid for');

  // Gas: never for an address nobody announced, once for one that was.
  assert.match((await ask(send, 'STEALTH', { action: 'gas', account: to })).error.message, /no stealth payment was announced/);
  assert.equal(sent.length, 0);
  announced = [{ args: { stealthAddress: to, ephemeralPubKey: ct, metadata: '0x01' }, blockNumber: 1n }];
  assert.ok((await ask(send, 'STEALTH', { action: 'gas', account: to })).result.txHash);
  assert.match((await ask(send, 'STEALTH', { action: 'gas', account: to })).error.message, /already/);
  assert.equal(sent.length, 1, 'one gas transfer paid for');
  // An address that is already an account is neither announced nor given gas.
  code = cloneCode;
  assert.match((await ask(send, 'STEALTH', { action: 'announce', stealthAddress: `0x${'45'.repeat(20)}`, ephemeralPubKey: ct, metadata: '0x01' })).error.message, /already an account/);

  // Scans come a page at a time, so an answer stays inside the mesh's largest message.
  announced = Array.from({ length: 10 }, (_, i) => ({ args: { stealthAddress: to, ephemeralPubKey: ct, metadata: '0x01' }, blockNumber: BigInt(i) }));
  const first = (await ask(send, 'STEALTH', { action: 'scan' })).result;
  assert.equal(first.announcements.length, 8);
  assert.deepEqual([first.next.skip, first.done], [8, false]);
  const second = (await ask(send, 'STEALTH', { action: 'scan', ...first.next })).result;
  assert.equal(second.announcements.length, 2);
});
