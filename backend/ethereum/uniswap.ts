// Uniswap v4 on the EIP-8141 devnet, as SENDER frames of a FramePQAccount
// (ethereum/frame.ts): the swap a FORS+C signature authorizes, and the one
// transaction that set the pool up. Node and the browser alike.
//
// Command and action bytes are Uniswap's (universal-router Commands.sol,
// v4-periphery Actions.sol); every selector used here was found in the
// devnet's own bytecode. The pool is ETH/pqUSD, fee 0.30%, tick spacing 60,
// no hooks, made and funded by our account: deployments/eth-devnet.json.

import { concat, encodeAbiParameters, encodeFunctionData, getContractAddress, keccak256, parseAbi, parseAbiParameters, type Address, type Hex } from 'viem';

import { call, devnet, type Call } from './frame.ts';

const UNI = devnet.uniswap as {
  poolManager: Address; positionManager: Address; universalRouter: Address; permit2: Address;
  create2Deployer: Address; pqUSD: Address | null;
};
const ETH: Address = '0x0000000000000000000000000000000000000000';
const V4_SWAP = '0x10';
const A = { MINT_POSITION: 0x02, SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, SETTLE_PAIR: 0x0d, TAKE_ALL: 0x0f, SWEEP: 0x14 } as const;
const actions = (...a: number[]): Hex => `0x${a.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
const POOL_KEY = '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)';
// Full range at tick spacing 60: MIN_TICK and MAX_TICK (887272) rounded in to the spacing.
const TICK = 887_220;
const MAX_UINT = (1n << 256n) - 1n;

const ROUTER_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const POSM_ABI = parseAbi([
  'function initializePool((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) payable returns (int24)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
]);
const ERC20_ABI = parseAbi(['function approve(address spender, uint256 value) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const PERMIT2_ABI = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);
const EXTSLOAD_ABI = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);

export const pqUSD = (): Address => {
  if (UNI.pqUSD === null) throw new Error('no pqUSD pool on the devnet yet: node ethereum/frame-tx.ts pool');
  return UNI.pqUSD;
};
const poolKey = (token: Address) => ({ currency0: ETH, currency1: token, fee: 3000, tickSpacing: 60, hooks: ETH });

/** A deadline an hour past the devnet's own clock, which need not be ours. */
async function deadline(): Promise<bigint> {
  const block = await call('eth_getBlockByNumber', ['latest', false]);
  return BigInt(block.timestamp) + 3600n;
}

export async function tokenBalance(owner: Address, token: Address = pqUSD()): Promise<bigint> {
  const out: Hex = await call('eth_call', [{ to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }) }, 'latest']);
  return BigInt(out);
}

const isqrt = (n: bigint): bigint => {
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
};

/**
 * The SENDER frames of the one transaction that made the pool: deploy pqUSD
 * (its supply to `account`), approve Permit2 and the PositionManager in it,
 * initialize ETH/pqUSD at `price` pqUSD per ETH, and add full-range liquidity
 * of `eth` ETH and the pqUSD that matches it. Run as one atomic batch.
 */
export async function poolSetup(account: Address, tokenInitCode: Hex, eth: bigint, price: bigint): Promise<{ token: Address; calls: Call[] }> {
  const salt = `0x${'0'.repeat(62)}01` as Hex;
  const token = getContractAddress({ opcode: 'CREATE2', from: UNI.create2Deployer, salt, bytecode: tokenInitCode });
  const key = poolKey(token);
  // Both tokens have 18 decimals, so the raw price is `price`.
  const sqrtPriceX96 = isqrt(price << 192n);
  // Full range: amount0 = L * 2^96 / sqrtP, near enough, and amount1 = L * sqrtP / 2^96.
  const liquidity = (eth * sqrtPriceX96) >> 96n;
  const unlock = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [
    actions(A.MINT_POSITION, A.SETTLE_PAIR, A.SWEEP),
    [
      encodeAbiParameters(parseAbiParameters(`${POOL_KEY}, int24, int24, uint256, uint128, uint128, address, bytes`),
        [key, -TICK, TICK, liquidity, (eth * 11n) / 10n, (eth * price * 11n) / 10n, account, '0x']),
      encodeAbiParameters(parseAbiParameters('address, address'), [ETH, token]),
      // ETH left over from the 10% headroom comes back.
      encodeAbiParameters(parseAbiParameters('address, address'), [ETH, account]),
    ],
  ]);
  return {
    token,
    calls: [
      // The token's code and storage cost state gas (EIP-8037), about 3M.
      { to: UNI.create2Deployer, data: concat([salt, tokenInitCode]), gas: 1_500_000n, state: 4_000_000n },
      { to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [UNI.permit2, MAX_UINT] }), gas: 100_000n, state: 200_000n },
      { to: UNI.permit2, data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'approve', args: [token, UNI.positionManager, (1n << 160n) - 1n, (1 << 30) * 2] }), gas: 100_000n, state: 200_000n },
      { to: UNI.positionManager, data: encodeFunctionData({ abi: POSM_ABI, functionName: 'initializePool', args: [key, sqrtPriceX96] }), gas: 500_000n, state: 1_000_000n },
      { to: UNI.positionManager, value: (eth * 11n) / 10n, data: encodeFunctionData({ abi: POSM_ABI, functionName: 'modifyLiquidities', args: [unlock, await deadline()] }), gas: 1_500_000n, state: 2_000_000n },
    ],
  };
}

/**
 * What `amountIn` ETH buys now, from the pool's own state: its price and
 * liquidity read out of PoolManager storage (v4-core StateLibrary: pools at
 * slot 6, liquidity 3 slots past the pool's), then one v4 swap step. Exact for
 * this pool: a single full-range position, so a swap never crosses a tick.
 * Checked on chain: the price and liquidity read back are exactly the ones the
 * pool was made with, and a swap delivers what this quotes.
 */
export async function quote(amountIn: bigint): Promise<bigint> {
  const id = keccak256(encodeAbiParameters(parseAbiParameters(POOL_KEY), [poolKey(pqUSD())]));
  const slot = BigInt(keccak256(encodeAbiParameters(parseAbiParameters('bytes32, uint256'), [id, 6n])));
  const read = async (at: bigint) => BigInt(await call('eth_call', [{ to: UNI.poolManager, data: encodeFunctionData({ abi: EXTSLOAD_ABI, functionName: 'extsload', args: [`0x${at.toString(16).padStart(64, '0')}`] }) }, 'latest']));
  const [slot0, liquidity] = await Promise.all([read(slot), read(slot + 3n)]);
  const sqrtP = slot0 & ((1n << 160n) - 1n);
  const fee = (slot0 >> 208n) & 0xffffffn; // lpFee; this pool's protocol fee is 0
  const inLessFee = (amountIn * (1_000_000n - fee)) / 1_000_000n;
  // zeroForOne: the price falls to L*Q96*sqrtP / (L*Q96 + in*sqrtP), rounded up; out is L * (sqrtP - next) / Q96.
  const lq = liquidity << 96n;
  const next = (lq * sqrtP + (lq + inLessFee * sqrtP) - 1n) / (lq + inLessFee * sqrtP);
  return (liquidity * (sqrtP - next)) >> 96n;
}

/**
 * The router call that swaps `amountIn` ETH for pqUSD, delivered to the caller.
 * ExactInputSingleParams carries minHopPriceX36: the devnet's router is the
 * newer v4-periphery (an impossible minHopPriceX36 trips its price check).
 */
async function swapData(amountIn: bigint, minOut: bigint): Promise<Hex> {
  const token = pqUSD();
  const input = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [
    actions(A.SWAP_EXACT_IN_SINGLE, A.SETTLE_ALL, A.TAKE_ALL),
    [
      encodeAbiParameters(parseAbiParameters(`(${POOL_KEY} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)`),
        [{ poolKey: poolKey(token), zeroForOne: true, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: '0x' }]),
      encodeAbiParameters(parseAbiParameters('address, uint256'), [ETH, amountIn]),
      encodeAbiParameters(parseAbiParameters('address, uint256'), [token, minOut]),
    ],
  ]);
  return encodeFunctionData({ abi: ROUTER_ABI, functionName: 'execute', args: [V4_SWAP, [input], await deadline()] });
}

/** The SENDER frame that swaps `amountIn` ETH for pqUSD at no less than 99% of the quote. */
export async function swapCall(amountIn: bigint): Promise<{ call: Call; expected: bigint }> {
  const expected = await quote(amountIn);
  const data = await swapData(amountIn, (expected * 99n) / 100n);
  // The pqUSD balance the swap creates is a new storage slot: state gas.
  return { call: { to: UNI.universalRouter, value: amountIn, data, gas: 800_000n, state: 300_000n }, expected };
}
