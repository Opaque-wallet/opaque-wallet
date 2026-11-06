// Uniswap v4 on Sepolia, at Uniswap's own deployment: the two pools Opaque's hooks
// make (contracts/src/ethereum/uniswap/). Node and the browser alike.
//
//   pq     ETH/tUSDC under PQAccountPoolHook: only Opaque's PQ accounts trade or provide
//   guard  ETH/tUSDC under PQGuardHook: anyone trades; a position's withdrawals need
//          its provider's FORS+C signature, and pay only the recipient it signed
//
// Command and action bytes are Uniswap's (universal-router Commands.sol,
// v4-periphery Actions.sol). Reads go through `read`, so the wallet can pass
// its mesh (WALLET_RPC STATE) and a script its public client.

import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, type Address, type Hex } from 'viem';

import { deployment } from '../../deployments/index.ts';

export interface V4Pool { readonly hook: Address; readonly fee: number; readonly tickSpacing: number }
export interface V4Deployment {
  readonly poolManager: Address; readonly positionManager: Address; readonly universalRouter: Address; readonly permit2: Address;
  readonly pq?: V4Pool; readonly guard?: V4Pool;
}
/** Sepolia's v4 and our pools, where this network has them. */
export const V4: V4Deployment | undefined = (deployment as { uniswap?: V4Deployment }).uniswap;

export const ETH = '0x0000000000000000000000000000000000000000' as Address;
const V4_SWAP = '0x10';
export const ACTIONS = { DECREASE_LIQUIDITY: 0x01, MINT_POSITION: 0x02, SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, SETTLE_PAIR: 0x0d, TAKE_ALL: 0x0f, TAKE_PAIR: 0x11, SWEEP: 0x14 } as const;
export const actions = (...a: number[]): Hex => `0x${a.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
export const POOL_KEY = '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)';
/** Full range at tick spacing 60: MIN_TICK and MAX_TICK (887272) rounded in to the spacing. */
export const TICK = 887_220;

export const ROUTER_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
export const POSM_ABI = parseAbi([
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
  'function nextTokenId() view returns (uint256)',
]);
export const PM_ABI = parseAbi([
  'function initialize((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) returns (int24)',
  'function extsload(bytes32 slot) view returns (bytes32)',
]);
export const ERC20_ABI = parseAbi(['function approve(address spender, uint256 value) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
export const PERMIT2_ABI = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
/** ETH and the network's tUSDC, under `pool`'s hook. */
export const keyOf = (pool: V4Pool): PoolKey => ({ currency0: ETH, currency1: deployment.tokens.usdc.address as Address, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hook });
export const poolIdOf = (key: PoolKey): Hex => keccak256(encodeAbiParameters(parseAbiParameters(POOL_KEY), [key]));

export const isqrt = (n: bigint): bigint => {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
};
/** sqrtPriceX96 for `usdcPerEth` tUSDC (6 decimals) per ETH (18): raw price usdcPerEth * 1e6 / 1e18. */
export const sqrtPriceOf = (usdcPerEth: bigint): bigint => isqrt((usdcPerEth * 10n ** 6n << 192n) / 10n ** 18n);

/** One PoolManager storage word, as hex. */
export type SlotReader = (slot: Hex) => Promise<bigint>;
export const extsloadCall = (slot: Hex): { to: Address; data: Hex } => ({ to: V4!.poolManager, data: encodeFunctionData({ abi: PM_ABI, functionName: 'extsload', args: [slot] }) });

/**
 * What `amountIn` buys in `key`'s pool now, ETH for tUSDC or (`ethIn` false) back:
 * its price and liquidity from PoolManager storage (v4-core StateLibrary: pools at
 * slot 6, liquidity 3 slots on), then one swap step. Exact for a pool of one
 * full-range position, where a swap crosses no tick.
 */
export async function quote(read: SlotReader, key: PoolKey, amountIn: bigint, ethIn: boolean): Promise<bigint> {
  const slot = BigInt(keccak256(encodeAbiParameters(parseAbiParameters('bytes32, uint256'), [poolIdOf(key), 6n])));
  const hex = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;
  const [slot0, liquidity] = await Promise.all([read(hex(slot)), read(hex(slot + 3n))]);
  const sqrtP = slot0 & ((1n << 160n) - 1n);
  if (sqrtP === 0n || liquidity === 0n) throw new Error('that pool has no liquidity yet');
  const fee = (slot0 >> 208n) & 0xffffffn;
  const inLessFee = (amountIn * (1_000_000n - fee)) / 1_000_000n;
  const lq = liquidity << 96n;
  if (ethIn) {
    const next = (lq * sqrtP + (lq + inLessFee * sqrtP) - 1n) / (lq + inLessFee * sqrtP);
    return (liquidity * (sqrtP - next)) >> 96n;
  }
  const next = sqrtP + (inLessFee << 96n) / liquidity;
  return (lq * (next - sqrtP)) / next / sqrtP;
}

const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 900);

/**
 * The calls that swap `amountIn` in `key`'s pool at no less than `minOut`, delivered to
 * the caller: the router's V4_SWAP, and for tUSDC in, its exact approvals first
 * (to Permit2, then the router until this block ends).
 */
export function swapCalls(key: PoolKey, amountIn: bigint, minOut: bigint, ethIn: boolean): { to: Address; data: Hex; value?: bigint }[] {
  const token = key.currency1;
  const [tokenIn, tokenOut] = ethIn ? [ETH, token] : [token, ETH];
  const input = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [
    actions(ACTIONS.SWAP_EXACT_IN_SINGLE, ACTIONS.SETTLE_ALL, ACTIONS.TAKE_ALL),
    [
      encodeAbiParameters(parseAbiParameters(`(${POOL_KEY} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)`),
        [{ poolKey: key, zeroForOne: ethIn, amountIn, amountOutMinimum: minOut, hookData: '0x' }]),
      encodeAbiParameters(parseAbiParameters('address, uint256'), [tokenIn, amountIn]),
      encodeAbiParameters(parseAbiParameters('address, uint256'), [tokenOut, minOut]),
    ],
  ]);
  const swap = { to: V4!.universalRouter, data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'execute', args: [V4_SWAP, [input], deadline()] }), ...(ethIn ? { value: amountIn } : {}) };
  if (ethIn) return [swap];
  return [
    { to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [V4!.permit2, amountIn] }) },
    { to: V4!.permit2, data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'approve', args: [token, V4!.universalRouter, amountIn, 0] }) },
    swap,
  ];
}

/**
 * The calls that open a full-range position of `eth` ETH and the tUSDC that matches it
 * at `sqrtPriceX96`, owned by `owner`: tUSDC approved to Permit2 and the PositionManager
 * in it, then MINT_POSITION, SETTLE_PAIR and SWEEP (ETH over the 10% headroom comes back).
 */
export function mintCalls(key: PoolKey, owner: Address, eth: bigint, sqrtPriceX96: bigint, hookData: Hex = '0x'): { to: Address; data: Hex; value?: bigint }[] {
  const liquidity = (eth * sqrtPriceX96) >> 96n;
  const usdc = (liquidity * sqrtPriceX96) >> 96n;
  const unlock = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [
    actions(ACTIONS.MINT_POSITION, ACTIONS.SETTLE_PAIR, ACTIONS.SWEEP),
    [
      encodeAbiParameters(parseAbiParameters(`${POOL_KEY}, int24, int24, uint256, uint128, uint128, address, bytes`),
        [key, -TICK, TICK, liquidity, (eth * 11n) / 10n, (usdc * 11n) / 10n + 1n, owner, hookData]),
      encodeAbiParameters(parseAbiParameters('address, address'), [ETH, key.currency1]),
      encodeAbiParameters(parseAbiParameters('address, address'), [ETH, owner]),
    ],
  ]);
  return [
    { to: key.currency1, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [V4!.permit2, (usdc * 11n) / 10n + 1n] }) },
    { to: V4!.permit2, data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'approve', args: [key.currency1, V4!.positionManager, (usdc * 11n) / 10n + 1n, Number(deadline())] }) },
    { to: V4!.positionManager, value: (eth * 11n) / 10n, data: encodeFunctionData({ abi: POSM_ABI, functionName: 'modifyLiquidities', args: [unlock, deadline()] }) },
  ];
}

/** The PositionManager call that takes all of `tokenId`'s `liquidity` out, with `hookData`, the pair to `to`. */
export function decreaseCall(key: PoolKey, tokenId: bigint, liquidity: bigint, to: Address, hookData: Hex): { to: Address; data: Hex } {
  const unlock = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [
    actions(ACTIONS.DECREASE_LIQUIDITY, ACTIONS.TAKE_PAIR),
    [
      encodeAbiParameters(parseAbiParameters('uint256, uint256, uint128, uint128, bytes'), [tokenId, liquidity, 0n, 0n, hookData]),
      encodeAbiParameters(parseAbiParameters('address, address, address'), [ETH, key.currency1, to]),
    ],
  ]);
  return { to: V4!.positionManager, data: encodeFunctionData({ abi: POSM_ABI, functionName: 'modifyLiquidities', args: [unlock, deadline()] }) };
}
