// WALLET_RPC (§7.5): a wallet's own chain reads, and its account's
// UserOperations, answered at the mesh exit. The RPC and the bundler then see
// the exit and never the wallet.
//
// Not a general proxy. Each operation takes one JSON request and does one
// narrow thing:
//
//   STATE                   view calls, each to an allowlisted contract AND
//                           selector, all at one block
//   ESTIMATE                eth_estimateUserOperationGas, pimlico_getUserOperationGasPrice
//   SUBMIT_USER_OPERATION   eth_sendUserOperation
//   USER_OPERATION_RECEIPT  eth_getUserOperationReceipt
//   ROTATE                  PQKeyRegistry.rotate, signed by the account's
//                           current key and PAID FOR BY THIS EXIT
//   SWAP_QUOTE              LI.FI's best route between two of this network's
//                           swap tokens, for the account's own address. Asked
//                           from here, so LI.FI sees the exit, not the wallet;
//                           the wallet checks the answer calls only LI.FI's
//                           pinned contract (deployments/: swap.router)
//   STEALTH                 stealth payments (chain/stealth.ts): scan reads this
//                           scheme's ERC-5564 announcements a page at a time;
//                           announce posts one for a sender, and gas gives a
//                           found stealth account the ETH for its one sweep,
//                           both PAID FOR BY THIS EXIT, so neither the sender's
//                           nor the recipient's own account ever touches it
//
// Bundler calls must name the pinned v0.7 EntryPoint and come from a PQ
// account clone, or deploy one: an initCode is accepted only as the pinned
// factory's createAccount, which can create nothing but a PQ account. So the
// exit is not a free bundler for anything else.
//
// An answer carries its own error ({ error }) instead of failing the query.
// A query that fails at the exit leaves nothing at the drop, and the wallet
// would wait out its deadline to learn nothing.
//
// ROTATE is the one operation the exit pays for. An account cannot pay for its
// own rotation: a UserOperation spends a signature during validation, so a
// rotation carried inside one would be signed against the wrong useCount and
// revert. PQKeyRegistry.rotate takes the account as an argument and checks no
// msg.sender, so anyone may submit it, and the exit's egress key is already
// the thing that pays for settlement and the attester's own rotations.

import { decodeAbiParameters, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, toFunctionSelector, walletActions, type Account, type PublicClient } from 'viem';
import { formatUserOperationRequest, toPackedUserOperation } from 'viem/account-abstraction';

import { ProtocolFailure, type Address, type Bytes32, type Hex, type TxHash, type WalletRpcOperation } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { deployment, entryPoint, requireContract } from '../../deployments/index.ts';
import { rateLimit } from '../mesh/limit.ts';
import { writeInTurn } from './pool.ts';
import { ANNOUNCEMENT, ANNOUNCER, ANNOUNCER_ABI, CIPHERTEXT_BYTES, META_REGISTRY, SCHEME_ID } from './stealth.ts';
import { V4 } from '../ethereum/uniswap/uniswap-v4.ts';

/** The one thing the page hands the mesh: an operation and its JSON, as hex. */
export type WalletRpcSend = (operation: WalletRpcOperation, encodedRequest: Hex) => Promise<Hex>;

export const WALLET_RPC_OPERATIONS: readonly WalletRpcOperation[] = ['STATE', 'ESTIMATE', 'SUBMIT_USER_OPERATION', 'USER_OPERATION_RECEIPT', 'ROTATE', 'SWAP_QUOTE', 'STEALTH'];

const BUNDLER_METHODS: Readonly<Record<string, readonly string[]>> = {
  ESTIMATE: ['eth_estimateUserOperationGas', 'pimlico_getUserOperationGasPrice'],
  SUBMIT_USER_OPERATION: ['eth_sendUserOperation'],
  USER_OPERATION_RECEIPT: ['eth_getUserOperationReceipt'],
};

export const STATE_ABI = parseAbi([
  'function stateOf(address) view returns ((bytes32 pkCommitment, bytes32 nextCommitment, uint64 useCount, uint64 maxUses, uint64 rotationDeadline, uint64 disableAfter))',
  'function isNullifierSpent(bytes32) view returns (bool)',
  'function isCommitmentKnown(bytes32) view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function getNonce(address, uint192) view returns (uint256)',
  'function capabilities() view returns ((uint8 proofMode, uint8 ringSize, bytes32 verifierId, uint256 denomination, bool requiresCommitReveal))',
  'function getEthBalance(address) view returns (uint256)',
  'function stealthMetaAddressOf(address registrant, uint256 schemeId) view returns (bytes)',
]);
/** Multicall3, at this address on every EVM chain: its getEthBalance makes an ETH balance a view call STATE can make. */
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

/** Which view calls STATE will make: target -> selectors. Everything else is refused. */
export function walletRpcAllowlist(): ReadonlyMap<string, ReadonlySet<string>> {
  const sel = (signature: string) => toFunctionSelector(signature);
  const allow = new Map<string, Set<string>>();
  const add = (target: string, ...signatures: string[]) =>
    allow.set(target.toLowerCase(), new Set([...(allow.get(target.toLowerCase()) ?? []), ...signatures.map(sel)]));
  add(requireContract('pqKeyRegistry'), 'stateOf(address)');
  for (const pool of deployment.pools) add(pool.address, 'isNullifierSpent(bytes32)', 'isCommitmentKnown(bytes32)', 'capabilities()');
  add(deployment.tokens.usdc.address, 'balanceOf(address)');
  for (const token of deployment.swap.tokens) add(token.address, 'balanceOf(address)');
  add(entryPoint(), 'balanceOf(address)', 'getNonce(address,uint192)');
  // Where gas is ETH (Sepolia), the account's ETH is one of its assets. On Arc the native balance is the USDC read above.
  if (deployment.network.nativeCurrency.symbol !== 'USDC') add(MULTICALL3, 'getEthBalance(address)');
  // A payee's stealth meta-address, read before paying it.
  if (deployment.stealth !== undefined) add(META_REGISTRY, 'stealthMetaAddressOf(address,uint256)');
  // A v4 pool's price and liquidity, for a swap quote (ethereum/uniswap/uniswap-v4.ts).
  if (V4 !== undefined) add(V4.poolManager, 'extsload(bytes32)');
  return allow;
}

/**
 * A UserOperation request, ABI-encoded rather than JSON. Its FORS signature is
 * 9 KB; as hex in JSON in hex on the mesh it came to 82 KB, past the largest
 * size class, and as ABI it is about half that.
 */
const USER_OPERATION_REQUEST = parseAbiParameters('string method, address entryPoint, (address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) op');

const REGISTRY_ROTATE = parseAbi(['function rotate(address, bytes32, uint64, uint64, bytes)']);

/** Announcements a scan answers with: each carries a 1,088-byte ciphertext, and an answer is at most 64 KB. */
const STEALTH_PAGE = 8;
const STEALTH_RANGE = 10_000n;
/**
 * Blocks a scan stays behind the head. A load-balanced RPC's lagging node
 * answers getLogs without its last few blocks, and a page the wallet moved past
 * would never be read again: a payment lost from view.
 */
const STEALTH_LAG = 6n;
/** ETH a found stealth account is given for its one sweep: a deploy and a few deposits, about 3M gas. */
export const STEALTH_GAS_WEI = 8n * 10n ** 15n;
/** At most one relayed rotation per account per minute, so a loop cannot drain the egress. */
const ROTATE_COOLDOWN_MS = 60_000;

const MAX_CALLS = 8;
const CREATE_ACCOUNT = toFunctionSelector('createAccount(bytes32,bytes32,uint64,uint64)');
// Room for the largest contract a chain takes (EIP-3860: 49,152 bytes of initcode) beside a 9 KB FORS signature.
const MAX_REQUEST_BYTES = 64_000;
const utf8 = (s: string) => new TextEncoder().encode(s);
const json = (value: unknown): Hex => toHex(utf8(JSON.stringify(value))) as Hex;

/** The exit's side. Returns hex JSON: { result } or { error: { message } }. */
export function createWalletRpcAnswerer(options: {
  readonly publicClient: PublicClient;
  readonly bundlerUrl: string;
  readonly entryPoint: Address;
  readonly accountImplementation: Address;
  /** PQAccountFactory: the one initCode relayed is its createAccount. Unset, none is. */
  readonly factory?: Address;
  /** Pays for ROTATE. Unset, ROTATE is refused: nothing else here spends gas. */
  readonly payer?: Account;
  readonly allowlist?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly fetch?: typeof globalThis.fetch;
  /** LI.FI's API key, for its higher rate limit; without one, quotes share the public limit. */
  readonly lifiApiKey?: string;
  /** Swap quotes a minute, whoever asks (each is a call to LI.FI on a quota everyone shares). */
  readonly quotesPerMinute?: number;
  /** How long a bundler call may take before the answer is an error. */
  readonly bundlerTimeoutMs?: number;
  /** STEALTH announcements and gas this exit pays for a minute, whoever asks. */
  readonly stealthPerMinute?: number;
}): WalletRpcSend {
  const { publicClient } = options;
  const allowlist = options.allowlist ?? walletRpcAllowlist();
  const doFetch = options.fetch ?? globalThis.fetch;
  // EIP-1167 runtime code of a PQAccount clone: the only senders relayed.
  const cloneCode = `0x363d3d373d3d3d363d73${options.accountImplementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
  const pqAccounts = new Set<string>();

  const signer = options.payer === undefined ? undefined : publicClient.extend(walletActions);
  const rotatedAt = new Map<string, number>();
  // A flood of quote requests is refused here, rather than spending the LI.FI quota every swap needs.
  const quoteAllowance = rateLimit(options.quotesPerMinute ?? 60);
  const stealthAllowance = rateLimit(options.stealthPerMinute ?? 20);
  const gassed = new Set<string>();

  const refuse = (message: string): never => { throw new ProtocolFailure('INVALID_INPUT', message); };
  /** Only a deployed PQAccount clone. Cached: a clone's code never changes. */
  async function assertPqAccount(address: string): Promise<void> {
    if (pqAccounts.has(address)) return;
    const code = await publicClient.getCode({ address: address as Address });
    if (code?.toLowerCase() !== cloneCode) refuse('only PQ accounts are relayed');
    pqAccounts.add(address);
  }
  /** A first operation's factory call: only the pinned factory, only createAccount. */
  const deploys = (factory: unknown, factoryData: unknown): boolean => {
    if (factory === undefined || factory === null) return false;
    if (options.factory === undefined || String(factory).toLowerCase() !== options.factory.toLowerCase()
      || String(factoryData).slice(0, 10).toLowerCase() !== CREATE_ACCOUNT) refuse('the only initCode relayed is the PQ account factory\'s createAccount');
    return true;
  };

  async function state(request: { calls?: unknown }): Promise<unknown> {
    const calls = request.calls;
    if (!Array.isArray(calls) || calls.length === 0 || calls.length > MAX_CALLS) refuse(`STATE takes 1 to ${MAX_CALLS} calls`);
    for (const c of calls as { to?: unknown; data?: unknown }[]) {
      if (typeof c.to !== 'string' || typeof c.data !== 'string' || !/^0x[0-9a-fA-F]{8,136}$/.test(c.data)) refuse('a STATE call is { to, data }');
      const selectors = allowlist.get((c.to as string).toLowerCase());
      if (selectors === undefined || !selectors.has((c.data as string).slice(0, 10).toLowerCase())) refuse(`STATE does not read ${String(c.to)} ${String(c.data).slice(0, 10)}`);
    }
    // One block for every call, so a registry state and a balance agree.
    // Arc's public RPC is load-balanced: a node behind that block is asked again.
    for (let attempt = 0; ; attempt++) {
      try {
        const block = await publicClient.getBlock();
        const results = await Promise.all((calls as { to: Address; data: Hex }[]).map(async (c) =>
          (await publicClient.call({ to: c.to, data: c.data, blockNumber: block.number })).data ?? '0x'));
        return { blockNumber: block.number.toString(), timestamp: block.timestamp.toString(), results };
      } catch (error) {
        if (attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  async function bundler(operation: string, request: { method?: unknown; params?: unknown }): Promise<unknown> {
    const { method, params } = request;
    if (typeof method !== 'string' || !BUNDLER_METHODS[operation]?.includes(method)) refuse(`${operation} does not relay ${String(method)}`);
    if (!Array.isArray(params)) refuse('params must be an array');
    const p = params as unknown[];
    if (method === 'eth_estimateUserOperationGas' || method === 'eth_sendUserOperation') {
      if (String(p[1]).toLowerCase() !== options.entryPoint.toLowerCase()) refuse('only the pinned v0.7 EntryPoint is relayed');
      const op = (p[0] ?? {}) as { sender?: unknown; factory?: unknown; factoryData?: unknown };
      const sender = String(op.sender ?? '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(sender)) refuse('a UserOperation needs a sender');
      // A deploying operation's sender has no code yet; the EntryPoint refuses
      // it unless the factory created exactly that address.
      if (!deploys(op.factory, op.factoryData)) await assertPqAccount(sender);
    } else if (method === 'eth_getUserOperationReceipt') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(p[0]))) refuse('a receipt needs a UserOperation hash');
    }
    // Bounded (F-63c): a bundler that never answers would otherwise hold this
    // query, and the relay's request behind it, for as long as the socket lives.
    const response = await doFetch(options.bundlerUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(options.bundlerTimeoutMs ?? 20_000),
    });
    const body = await response.json() as { result?: unknown; error?: { message?: string; code?: number } };
    if (body.error !== undefined) throw new ProtocolFailure('SETTLEMENT_REVERTED', `bundler: ${body.error.message ?? 'refused'}`);
    if (method === 'eth_getUserOperationReceipt' && body.result) {
      // What the wallet uses, and no more: a full receipt's logs would outgrow the answer.
      const r = body.result as { success: boolean; actualGasUsed: Hex; receipt: { transactionHash: Hex; blockNumber: Hex } };
      return { success: r.success, actualGasUsed: r.actualGasUsed, receipt: { transactionHash: r.receipt.transactionHash, blockNumber: r.receipt.blockNumber } };
    }
    return body.result ?? null;
  }

  /**
   * A rotation the account's own key already signed, submitted with the exit's
   * gas. What makes that safe is on chain, not here: the registry verifies the
   * FORS signature against the key it holds for this account, at that key's
   * exact useCount, so this exit can neither forge a rotation nor replay one,
   * and a wrong one costs nothing because it is simulated first.
   *
   * What is left to guard is the gas bill, and both guards below are about
   * only that.
   */
  async function rotate(request: Record<string, unknown>): Promise<unknown> {
    // Thrown, not refused: `refuse` returns never but does not narrow here.
    if (signer === undefined) throw new ProtocolFailure('INVALID_INPUT', 'this exit does not relay rotations');
    const account = String(request['account'] ?? '').toLowerCase();
    const next = String(request['next'] ?? '').toLowerCase();
    const signature = String(request['signature'] ?? '');
    if (!/^0x[0-9a-f]{40}$/.test(account)) refuse('a rotation names its account');
    if (!/^0x[0-9a-f]{64}$/.test(next)) refuse('a rotation names the next key commitment');
    if (!/^0x[0-9a-f]+$/i.test(signature)) refuse('a rotation carries a signature');
    const maxUses = BigInt(String(request['maxUses']));
    const deadline = BigInt(String(request['deadline']));
    // Taken before the first await (F-57): set only once the transaction was
    // sent, every one of N rotations asked at once passed this check, and the
    // exit paid for N transactions of which one could land. Given back if
    // nothing is sent, so a refusal costs the account no wait.
    const before = rotatedAt.get(account);
    if (Date.now() - (before ?? 0) < ROTATE_COOLDOWN_MS) refuse('a rotation for this account was relayed a moment ago');
    rotatedAt.set(account, Date.now());
    const payer = options.payer!;
    let hash: TxHash;
    try {
      await assertPqAccount(account);
      // rotate() resets useCount to 0, so a key that has signed nothing is either
      // brand new or just rotated. Refusing those means every relayed rotation
      // costs whoever asks one real operation of their own first, which is what
      // stops this being free gas in a loop.
      const registry = requireContract('pqKeyRegistry') as Address;
      const read = await publicClient.call({ to: registry, data: encodeFunctionData({ abi: STATE_ABI, functionName: 'stateOf', args: [account as Address] }) as Hex });
      const state = decodeFunctionResult({ abi: STATE_ABI, functionName: 'stateOf', data: read.data ?? '0x' }) as unknown as { pkCommitment: Hex; useCount: bigint };
      if (BigInt(state.pkCommitment) === 0n) refuse('that account has no registered key');
      if (state.useCount === 0n) refuse('that key has signed nothing, so it does not need rotating');
      // Simulated first: a signature for the wrong useCount reverts here, for free.
      const { request: tx } = await publicClient.simulateContract({
        address: registry, abi: REGISTRY_ROTATE, functionName: 'rotate',
        args: [account as Address, next as Bytes32, maxUses, deadline, signature as Hex], account: payer,
      } as never);
      // In turn with every other transaction the egress key pays for (chain/pool.ts).
      hash = await writeInTurn(payer.address, () => signer.writeContract(tx as never)) as TxHash;
    } catch (error) {
      if (before === undefined) rotatedAt.delete(account);
      else rotatedAt.set(account, before);
      throw error;
    }
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new ProtocolFailure('SETTLEMENT_REVERTED', `rotate reverted in ${hash}`);
    return { txHash: hash };
  }

  /**
   * Stealth payments. What the exit pays for here is all it can lose, and each
   * is bounded: an announcement needs a ciphertext of the scheme's size for an
   * address with no code, and gas goes once to an address that holds USDC, has
   * no code yet, and was announced under this scheme.
   */
  async function stealth(request: Record<string, unknown>): Promise<unknown> {
    const start = deployment.stealth?.fromBlock;
    if (start === undefined) throw new ProtocolFailure('INVALID_INPUT', 'this network has no stealth payments');
    const action = request['action'];
    const addressOf = (key: string): Address => {
      const a = String(request[key] ?? '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) refuse(`${key} must be an address`);
      return a as Address;
    };
    const fresh = async (a: Address) => { if ((await publicClient.getCode({ address: a }) ?? '0x') !== '0x') refuse('that address is already an account'); };

    if (action === 'scan') {
      const from = BigInt(String(request['fromBlock'] ?? start));
      const skip = Number(request['skip'] ?? 0);
      if (from < BigInt(start) || !Number.isSafeInteger(skip) || skip < 0 || skip > 10_000) refuse('a scan names a block from this scheme\'s start, and a count to skip');
      const head = (await publicClient.getBlockNumber()) - STEALTH_LAG;
      const to = from + STEALTH_RANGE - 1n < head ? from + STEALTH_RANGE - 1n : head;
      if (to < from) return { announcements: [], next: { fromBlock: from.toString(), skip: 0 }, done: true };
      const logs = await publicClient.getLogs({ address: ANNOUNCER, event: ANNOUNCEMENT, args: { schemeId: SCHEME_ID }, fromBlock: from, toBlock: to });
      const page = logs.slice(skip, skip + STEALTH_PAGE);
      const more = logs.length > skip + STEALTH_PAGE;
      return {
        announcements: page.map((l) => ({ stealthAddress: l.args.stealthAddress!.toLowerCase(), ephemeralPubKey: l.args.ephemeralPubKey, metadata: l.args.metadata, blockNumber: l.blockNumber.toString() })),
        next: more ? { fromBlock: from.toString(), skip: skip + STEALTH_PAGE } : { fromBlock: (to + 1n).toString(), skip: 0 },
        done: !more && to === head,
      };
    }

    if (signer === undefined) throw new ProtocolFailure('INVALID_INPUT', 'this exit does not pay for stealth payments');
    const payer = options.payer!;

    if (action === 'announce') {
      const stealthAddress = addressOf('stealthAddress');
      const ct = String(request['ephemeralPubKey'] ?? '');
      const metadata = String(request['metadata'] ?? '');
      if (!new RegExp(`^0x[0-9a-fA-F]{${CIPHERTEXT_BYTES * 2}}$`).test(ct)) refuse('an announcement carries an ML-KEM-768 ciphertext');
      if (!/^0x([0-9a-fA-F]{2}){1,32}$/.test(metadata)) refuse('an announcement\'s metadata is 1 to 32 bytes, its view tag first');
      if (!stealthAllowance()) throw new ProtocolFailure('MESH_UNAVAILABLE', 'stealth announcements are busy: try again in a minute', true);
      await fresh(stealthAddress);
      const { request: tx } = await publicClient.simulateContract({
        address: ANNOUNCER, abi: ANNOUNCER_ABI, functionName: 'announce', args: [SCHEME_ID, stealthAddress, ct as Hex, metadata as Hex], account: payer,
      } as never);
      const hash = await writeInTurn(payer.address, () => signer.writeContract(tx as never)) as TxHash;
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new ProtocolFailure('SETTLEMENT_REVERTED', `announce reverted in ${hash}`);
      return { txHash: hash };
    }

    if (action === 'gas') {
      const account = addressOf('account');
      // Taken before the first await, like a rotation's cooldown (F-57), and given back if nothing is sent.
      if (gassed.has(account)) refuse('that stealth account was given its gas already');
      gassed.add(account);
      try {
        if (!stealthAllowance()) throw new ProtocolFailure('MESH_UNAVAILABLE', 'stealth gas is busy: try again in a minute', true);
        await fresh(account);
        const [usdc, eth, announced] = await Promise.all([
          publicClient.readContract({ address: deployment.tokens.usdc.address, abi: STATE_ABI, functionName: 'balanceOf', args: [account] }),
          publicClient.getBalance({ address: account }),
          // ponytail: one getLogs from the scheme's start; page it once Sepolia's RPC refuses the range.
          publicClient.getLogs({ address: ANNOUNCER, event: ANNOUNCEMENT, args: { schemeId: SCHEME_ID, stealthAddress: account }, fromBlock: BigInt(start) }),
        ]);
        if (announced.length === 0) refuse('no stealth payment was announced for that address');
        if ((usdc as bigint) < 10n ** BigInt(deployment.tokens.usdc.decimals)) refuse('that stealth account holds nothing to sweep yet');
        if (eth >= STEALTH_GAS_WEI) return { txHash: null };
        const hash = await writeInTurn(payer.address, () => signer.sendTransaction({ account: payer, chain: publicClient.chain, to: account, value: STEALTH_GAS_WEI } as never)) as TxHash;
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new ProtocolFailure('SETTLEMENT_REVERTED', `the gas transfer reverted in ${hash}`);
        return { txHash: hash };
      } catch (error) {
        gassed.delete(account);
        throw error;
      }
    }
    return refuse('STEALTH does scan, announce or gas');
  }

  /** An ABI UserOperation request, as the bundler's JSON-RPC params. */
  function unpack(encoded: Hex): { method: string; params: unknown[] } {
    const [method, entry, op] = decodeAbiParameters(USER_OPERATION_REQUEST, encoded);
    // Accounts pay their own gas: a paymaster is not something this route carries.
    // An initCode is split back into factory and factoryData, and checked with them.
    if (op.paymasterAndData !== '0x') refuse('no paymaster on this route');
    const high = (word: Hex) => BigInt(`0x${word.slice(2, 34)}`);
    const low = (word: Hex) => BigInt(`0x${word.slice(34)}`);
    const deploy = op.initCode === '0x' ? {} : { factory: op.initCode.slice(0, 42) as Address, factoryData: `0x${op.initCode.slice(42)}` as Hex };
    return {
      method,
      params: [formatUserOperationRequest({
        sender: op.sender, nonce: op.nonce, callData: op.callData, signature: op.signature, ...deploy,
        verificationGasLimit: high(op.accountGasLimits), callGasLimit: low(op.accountGasLimits),
        preVerificationGas: op.preVerificationGas,
        maxPriorityFeePerGas: high(op.gasFees), maxFeePerGas: low(op.gasFees),
      } as never), entry],
    };
  }

  /** LI.FI's quote, trimmed to what the wallet needs. Only this network's swap tokens, only to and from the account itself. */
  async function swapQuote(request: { from?: unknown; to?: unknown; amount?: unknown; account?: unknown }): Promise<SwapQuote> {
    const offered = new Set(deployment.swap.tokens.map((t) => t.address.toLowerCase()));
    const { from, to, amount, account } = request;
    if (typeof from !== 'string' || typeof to !== 'string' || !offered.has(from) || !offered.has(to) || from === to) refuse('a swap is between two of this network\'s swap tokens');
    if (typeof amount !== 'string' || !/^[1-9][0-9]{0,30}$/.test(amount)) refuse('a swap amount is a whole number of the token\'s smallest units');
    if (typeof account !== 'string' || !/^0x[0-9a-f]{40}$/.test(account)) refuse('a swap names its account');
    if (!quoteAllowance()) throw new ProtocolFailure('MESH_UNAVAILABLE', 'swap quotes are busy: try again in a minute', true);
    const chain = String(deployment.network.chainId);
    const query = new URLSearchParams({
      fromChain: chain, toChain: chain, fromToken: from as string, toToken: to as string, fromAmount: amount as string,
      fromAddress: account as string, toAddress: account as string, integrator: 'opaque', slippage: '0.005',
    });
    const response = await doFetch(`https://li.quest/v1/quote?${query}`, {
      signal: AbortSignal.timeout(20_000), ...(options.lifiApiKey ? { headers: { 'x-lifi-api-key': options.lifiApiKey } } : {}),
    });
    const body = await response.json().catch(() => ({})) as { message?: string; tool?: string; toolDetails?: { name?: string };
      estimate?: { toAmount?: string; toAmountMin?: string; approvalAddress?: string; feeCosts?: { amountUSD?: string }[] };
      transactionRequest?: { to?: string; data?: string; value?: string } };
    if (!response.ok || body.estimate === undefined || body.transactionRequest === undefined) {
      // Its own words stay with LI.FI: the wallet hears that there is no route, and the status.
      throw new ProtocolFailure('SETTLEMENT_REVERTED', `LI.FI found no route for that swap (${response.status})`, true);
    }
    const { estimate: e, transactionRequest: tx } = body;
    return {
      tool: String(body.toolDetails?.name ?? body.tool), toAmount: String(e.toAmount), toAmountMin: String(e.toAmountMin),
      approvalAddress: String(e.approvalAddress).toLowerCase() as Address, to: String(tx.to).toLowerCase() as Address,
      data: String(tx.data) as Hex, value: String(tx.value ?? '0x0'),
      feeUsd: (e.feeCosts ?? []).reduce((n, f) => n + Number(f.amountUSD ?? 0), 0),
    };
  }

  return async (operation, encodedRequest) => {
    try {
      if (!WALLET_RPC_OPERATIONS.includes(operation)) refuse(`unknown operation ${operation}`);
      const bytes = fromHex(encodedRequest);
      if (bytes.length > MAX_REQUEST_BYTES) refuse('request too large');
      // JSON starts with '{'; anything else is an ABI UserOperation request.
      const request: Record<string, unknown> = bytes[0] === 0x7b ? JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> : unpack(encodedRequest);
      const result = operation === 'STATE' ? await state(request)
        : operation === 'ROTATE' ? await rotate(request)
          : operation === 'SWAP_QUOTE' ? await swapQuote(request)
            : operation === 'STEALTH' ? await stealth(request)
              : await bundler(operation, request);
      return json({ result });
    } catch (error) {
      // Public messages only: nothing here carries a secret.
      const e = error as { publicMessage?: string; message?: string; code?: string; retryable?: boolean };
      return json({ error: { code: e.code ?? 'MESH_UNAVAILABLE', message: e.publicMessage ?? e.message ?? 'failed', retryable: e.retryable ?? true } });
    }
  };
}

// ── the wallet's side ─────────────────────────────────────────────────────

/** A swap as LI.FI routes it: what to approve, the call to make, and what it should deliver. */
export interface SwapQuote {
  /** The exchange LI.FI picked: "KyberSwap", "Fly"… */
  readonly tool: string;
  /** In the token's smallest units, as decimal strings. */
  readonly toAmount: string;
  readonly toAmountMin: string;
  readonly approvalAddress: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value: string;
  readonly feeUsd: number;
}

/** Each token's balance at `account`, at one block, through the mesh. */
export async function tokenBalances(send: WalletRpcSend, account: Address, tokens: readonly Address[]): Promise<bigint[]> {
  const { results } = await readState(send, tokens.map((to) => ({ to, data: encodeFunctionData({ abi: STATE_ABI, functionName: 'balanceOf', args: [account] }) as Hex })));
  return results.map((r) => BigInt(r));
}

/** The account's ETH, through the mesh (Multicall3.getEthBalance). */
export async function ethBalance(send: WalletRpcSend, account: Address): Promise<bigint> {
  const { results } = await readState(send, [{ to: MULTICALL3 as Address, data: encodeFunctionData({ abi: STATE_ABI, functionName: 'getEthBalance', args: [account] }) as Hex }]);
  return BigInt(results[0]!);
}

/** LI.FI's best route, asked through the mesh. */
export const swapQuote = (send: WalletRpcSend, request: { from: Address; to: Address; amount: bigint; account: Address }): Promise<SwapQuote> =>
  call(send, 'SWAP_QUOTE', { from: request.from.toLowerCase(), to: request.to.toLowerCase(), amount: request.amount.toString(), account: request.account.toLowerCase() }) as Promise<SwapQuote>;

/** A STEALTH request through the mesh: { action: 'scan' | 'announce' | 'gas', ... }. */
export const stealthCall = (send: WalletRpcSend, request: Record<string, unknown>): Promise<unknown> => call(send, 'STEALTH', request);

async function call(send: WalletRpcSend, operation: WalletRpcOperation, request: unknown): Promise<unknown> {
  return answerOf(await send(operation, json(request)));
}

function answerOf(hex: Hex): unknown {
  const answer = JSON.parse(new TextDecoder().decode(fromHex(hex))) as {
    result?: unknown; error?: { code: string; message: string; retryable: boolean };
  };
  if (answer.error !== undefined) throw new ProtocolFailure(answer.error.code as never, answer.error.message, answer.error.retryable);
  return answer.result;
}

/** eth_estimateUserOperationGas or eth_sendUserOperation, with the operation ABI-encoded. */
export async function userOperationCall(
  send: WalletRpcSend,
  method: 'eth_estimateUserOperationGas' | 'eth_sendUserOperation',
  op: Parameters<typeof toPackedUserOperation>[0],
  entryPoint: Address,
): Promise<unknown> {
  const packed = toPackedUserOperation(op);
  const operation: WalletRpcOperation = method === 'eth_sendUserOperation' ? 'SUBMIT_USER_OPERATION' : 'ESTIMATE';
  return answerOf(await send(operation, encodeAbiParameters(USER_OPERATION_REQUEST, [method, entryPoint, packed as never]) as Hex));
}

/**
 * A signed rotation, submitted and paid for at the exit. The account cannot pay
 * for this itself: a UserOperation spends a signature while it validates, so a
 * rotation inside one would be signed for the wrong useCount.
 */
export async function relayRotation(
  send: WalletRpcSend, account: Address, next: Bytes32, maxUses: bigint, deadline: bigint, signature: Hex,
): Promise<TxHash> {
  const { txHash } = await call(send, 'ROTATE', {
    account, next, maxUses: maxUses.toString(10), deadline: deadline.toString(10), signature,
  }) as { txHash: TxHash };
  return txHash;
}

export interface StateRead { readonly blockNumber: bigint; readonly timestamp: bigint; readonly results: readonly Hex[] }

/** View calls at one block, through `send`. */
export async function readState(send: WalletRpcSend, calls: readonly { to: Address; data: Hex }[]): Promise<StateRead> {
  const r = await call(send, 'STATE', { calls }) as { blockNumber: string; timestamp: string; results: Hex[] };
  return { blockNumber: BigInt(r.blockNumber), timestamp: BigInt(r.timestamp), results: r.results };
}

/** One allowlisted view, decoded. */
export async function readOne<const F extends (typeof STATE_ABI)[number]['name']>(
  send: WalletRpcSend, to: Address, functionName: F, args: readonly unknown[],
) {
  const { results, blockNumber, timestamp } = await readState(send, [{ to, data: encodeFunctionData({ abi: STATE_ABI, functionName, args } as never) }]);
  return { value: decodeFunctionResult({ abi: STATE_ABI, functionName, data: results[0]! } as never) as never, blockNumber, timestamp };
}

/** One bundler JSON-RPC call, through `send`. */
export const bundlerCall = (send: WalletRpcSend, method: string, params: readonly unknown[]): Promise<unknown> => {
  const operation: WalletRpcOperation | undefined = ({
    eth_estimateUserOperationGas: 'ESTIMATE',
    pimlico_getUserOperationGasPrice: 'ESTIMATE',
    eth_sendUserOperation: 'SUBMIT_USER_OPERATION',
    eth_getUserOperationReceipt: 'USER_OPERATION_RECEIPT',
  } as const)[method];
  if (operation === undefined) throw new ProtocolFailure('INVALID_INPUT', `the account's bundler route does not carry ${method}`);
  return call(send, operation, { method, params });
};
