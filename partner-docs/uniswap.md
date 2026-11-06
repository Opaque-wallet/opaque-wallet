<div align="center">

# Uniswap v4: liquidity a quantum computer can't take

### Three v4 hooks that move pool authority to a hash-based key. Live at Uniswap's own v4 on Sepolia, and on the EIP-8141 devnet.

[![Sepolia](https://img.shields.io/badge/Sepolia-live-FF7A18?style=flat-square)](https://sepolia.etherscan.io/address/0xd0cfd61eb5ef783f6d70ea83b58d2c87fc034b01)
[![Hooks](https://img.shields.io/badge/hooks-3-FF7A18?style=flat-square)](../contracts/src/ethereum/uniswap/)
[![Tests](https://img.shields.io/badge/forge-15%20hook%20tests-FF7A18?style=flat-square)](../contracts/test/)

</div>

## Why this matters

A liquidity position can sit in a pool for years, and today one ECDSA key decides where it goes. That key's public key went on chain with its first transaction. On the day a large quantum computer can derive private keys, every position held by an ECDSA wallet can be removed by someone else. LPs are the slowest money to move and the easiest to find.

A v4 hook decides who may add, remove, swap and donate. So a hook can make a pool's authority post-quantum **now**, at the pool, with no change to Ethereum's account layer and none to Uniswap's core.

## What we built

| Hook | Network | What it enforces | Address |
|---|---|---|---|
| **`PQGuardHook`** | Sepolia | A FORS+C second factor for **any** LP, MetaMask wallets included. Removing liquidity needs a post-quantum signature that names the recipient, and the hook pays only that recipient. | [`0xd0cf…4b01`](https://sepolia.etherscan.io/address/0xd0cfd61eb5ef783f6d70ea83b58d2c87fc034b01) |
| **`PQAccountPoolHook`** | Sepolia | A pool only post-quantum accounts can trade in or provide to. An ECDSA wallet's swap reverts with `NotPostQuantum(wallet)`. | [`0xa68b…4aa0`](https://sepolia.etherscan.io/address/0xa68b63f17fe7926812d8591247b5a718a7244aa0) |
| **`PQPoolHook`** | EIP-8141 devnet | The same pool for FORS+C frame-transaction accounts. Admission survives key rotation. | `0x3B28…caa0` |

### `PQGuardHook`: keep your wallet, guard your position

- **The flow.**
  - The LP registers a FORS+C key in `PQKeyRegistry` with one ordinary transaction, from any wallet.
  - From then on, `beforeRemoveLiquidity` calls `registry.consume(guardian, payload, signature)`. The payload binds the pool, the position, the amount, the **recipient** and a deadline.
  - The hook keeps the signed recipient in transient storage. In `afterRemoveLiquidity` it takes everything the removal released and pays it to that recipient alone. It returns the full delta, so the caller gets nothing.
- **What a thief can't do.** With the LP's cracked ECDSA key, they can call the PositionManager, but:
  - a signature from any other FORS+C key fails with `BadSignature`;
  - the LP's real signature, replayed with the thief's own recipient, also fails with `BadSignature`;
  - so they can neither withdraw nor front-run.
- **Permission bits:** `0xB01` (beforeAddLiquidity, beforeRemoveLiquidity, afterRemoveLiquidity, afterRemoveLiquidityReturnDelta). The salt was mined for the CREATE2 deployer `0x4e59…`.

### `PQAccountPoolHook` and `PQPoolHook`: post-quantum-only pools

- **What runs:** both hooks run before add, remove, swap and donate (bits `0xAA0`).
- **Who counts as the caller:** they read the real caller through Uniswap's own PositionManager and Universal Router (`msgSender()`). Any other router counts as itself.
- **Sepolia:** admits an account when its code is the EIP-1167 clone of Opaque's `PQAccount`, which moves funds on a FORS+C signature only.
- **Devnet:** `register(firstKey)` checks the frame-account factory's CREATE2 address. An account stays admitted after it rotates its key, and nothing else gets in.
- **Positions handed to an ECDSA wallet freeze.** They don't move.

## What a judge can check

**Sepolia, at Uniswap's own v4.** PoolManager is `0xE03A…3543`, PositionManager `0x429b…09b4` and Universal Router `0x3A9D…f98b`. All are listed in [`deployments/eth-sepolia.json`](../deployments/eth-sepolia.json) under `uniswap`.

- A PQ account's first UserOperation deployed the account and funded the post-quantum pool. Its swap bought exactly the quoted amount.
- An ECDSA wallet's swap in that pool reverts with `NotPostQuantum(wallet)`.
- The guard demo:
  - position **#41441**, opened by an ordinary ECDSA wallet with a registered guard key;
  - another key's signature and a replayed signature are both refused;
  - the signed removal paid 0.002 ETH and 3.999999 tUSDC to the recipient it named, and 0 to the caller.
- **The wallet swaps here.** The Swap tab at [opaque.credit/sepolia/app](https://www.opaque.credit/sepolia/app) quotes from the pool's own storage, read across Opaque's relay mesh (the exit allows only `PoolManager.extsload`). One UserOperation, signed by the account's FORS+C key, makes the swap.

**EIP-8141 devnet:**

- `frame-tx.ts pqpool` made the pool in **one atomic FORS-signed frame transaction**: deploy the hook, register, initialize ETH/pqUSD under it, and add 0.1 ETH of liquidity.
- The account's swap bought 1.974316 pqUSD for 0.001 ETH, the exact quote from PoolManager storage.
- The devnet wallet's Swap tab trades in this pool. It registers the account in the same signature as its first swap.

**Reproduce it:**

```bash
cd contracts && forge test --match-path 'test/PQ*Hook.t.sol'          # 15 tests
cd backend && OPAQUE_NETWORK=sepolia node --use-system-ca ethereum/uniswap-sepolia.ts   # deploys or shows every rule on chain
cd backend && node --use-system-ca scripts/e2e-sepolia.ts             # includes "swapped on Uniswap v4 from the page"
```

## Where the code is

| File | What |
|---|---|
| [`contracts/src/ethereum/uniswap/`](../contracts/src/ethereum/uniswap/) | The three hooks ([folder README](../contracts/src/ethereum/uniswap/README.md)) |
| [`contracts/test/PQGuardHook.t.sol`](../contracts/test/PQGuardHook.t.sol), [`PQPoolHook.t.sol`](../contracts/test/PQPoolHook.t.sol) | 8 and 7 tests with real FORS+C signatures: nothing out without one, only the signed recipient paid and only once, deadlines, ECDSA wallets refused, routers counted as themselves |
| [`backend/chain/uniswap-v4.ts`](../backend/chain/uniswap-v4.ts) | Sepolia: pool keys, quotes from PoolManager storage (`extsload`), swap, mint and decrease calls |
| [`backend/ethereum/uniswap-sepolia.ts`](../backend/ethereum/uniswap-sepolia.ts) | Deploys the Sepolia hooks (salt mining) and proves each rule on chain |
| [`backend/ethereum/uniswap.ts`](../backend/ethereum/uniswap.ts) | Devnet: v4 as SENDER frames of a FORS+C frame transaction |

## The boundary

- **What the hooks protect:** who may move liquidity and trade, in pools that use them. They don't make an ECDSA wallet's other assets safe. That's what the [Q-Day vault](https://www.opaque.credit/sepolia/vault) and Opaque accounts are for.
- **Cost:** a FORS+C signature is about 9 KB of calldata. The guard asks for one only on removal, the rare action.
- **Status:** tested with forge, not audited. Testnet only.

[Back to partner evidence](README.md) · [Main README](../README.md)
