# Uniswap developer feedback

From Opaque's ETHGlobal Mumbai build (5–7 November 2026): three v4 hooks on Uniswap's own Sepolia deployment and on the EIP-8141 devnet, a wallet that quotes and swaps through the Universal Router, and a guard that pays a liquidity removal only to the recipient a post-quantum signature names. The code is in [`contracts/src/ethereum/uniswap/`](contracts/src/ethereum/uniswap/) and [`backend/ethereum/uniswap/`](backend/ethereum/uniswap/); the full write-up is [`partner-docs/ethglobal-mumbai/uniswap.md`](partner-docs/ethglobal-mumbai/uniswap.md).

## What worked well

- **Permissions in the hook's address.** Mining a CREATE2 salt for the flag bits was quick. Having the constructor check its own address (`WrongHookAddress`) caught a wrong salt before anything was deployed. The docs could recommend that check by default.
- **Transient storage between the before and after hooks.** `beforeRemoveLiquidity` verifies the signature and stores the signed recipient with `tstore`. `afterRemoveLiquidity` reads it, and v4's return delta lets the hook take everything the removal released and pay only that recipient. No custody, and no leftover storage.
- **The Sepolia addresses in the docs were right.** `poolManager()` on the PositionManager, StateView and Quoter, and `permit2()` on the PositionManager, all matched the chain.
- **ETH-native pairs.** An ETH/token pool with `currency0 = address(0)` kept the swap to one call, with no Permit2 approval on the ETH side.

## What cost us time

1. **Finding out who the user is.** A hook's `sender` is the router or the PositionManager, not the user. Both expose `msgSender()`, so our hooks trust exactly those two contracts and treat any other caller as itself. That's safe, but it locks out aggregators and other routers. *Ask:* a documented, standard way for any router to vouch for its caller (an interface plus guidance on when a hook may trust it), so access-control hooks can work beyond Uniswap's own periphery.
2. **Fee collection runs the remove hooks.** v4-core calls `beforeRemoveLiquidity` for `liquidityDelta <= 0`, so collecting fees with a zero decrease goes through the same gate as a real removal. For our guard that's the right behaviour, since fees need the signature too. But it's easy to miss. *Ask:* say it plainly in the hooks guide, next to the flag table.
3. **Quoting without `eth_call`.** The Quoter simulates with `eth_call`. The EIP-8141 devnet's client (ethrex) refuses `eth_call` from a contract address and takes no state overrides, so we rebuilt a single-range quote from PoolManager storage (`extsload`) with v4's swap-step math. It matches the router to the unit, but we had to write it. *Ask:* an SDK helper that quotes from StateView or `extsload` reads alone, for wallets and chains where simulation isn't available.
4. **Periphery ABI drift between deployments.** The devnet's Universal Router is a newer v4-periphery, whose `ExactInputSingleParams` carries `minHopPriceX36`. The Sepolia one doesn't. Same contract name, different calldata, and nothing on chain says which version answers. *Ask:* a `version()` getter on periphery contracts, or a published version per deployment address.
5. **The sign of the return delta.** `afterRemoveLiquidityReturnDelta` is exactly the right tool for redirecting a removal's proceeds. Which sign of the returned delta claims the released amount is clearest from `Hooks.sol` itself. *Ask:* a short worked example in the docs: "pay a removal to another address".

## Who we are

Opaque is the post-quantum security layer for Ethereum: [opaque.credit](https://www.opaque.credit), [github.com/Opaque-wallet/opaque-wallet](https://github.com/Opaque-wallet/opaque-wallet).
