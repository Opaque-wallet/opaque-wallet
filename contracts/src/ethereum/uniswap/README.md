# Uniswap v4 hooks

Three hooks that move a pool's authority to a FORS+C key: hash-based and post-quantum. They run at Uniswap's own v4 on Sepolia and on the EIP-8141 devnet. The partner write-up is [partner-docs/ethglobal-mumbai/uniswap.md](../../../../partner-docs/ethglobal-mumbai/uniswap.md).

## Index

| Contract | Bits | Rule | Deployed |
|---|---|---|---|
| [`PQGuardHook.sol`](PQGuardHook.sol) | `0xB01` | A removal needs a FORS+C signature from the position's guard key, binding the recipient and a deadline. The hook then pays only that recipient. Works for any LP, ECDSA wallets included. | Sepolia `0xd0cfd61eb5ef783f6d70ea83b58d2c87fc034b01` |
| [`PQAccountPoolHook.sol`](PQAccountPoolHook.sol) | `0xAA0` | Only Opaque's ERC-4337 PQ accounts may swap, add, remove or donate. They're recognized by the code hash of the EIP-1167 clone. | Sepolia `0xa68b63f17fe7926812d8591247b5a718a7244aa0` |
| [`PQPoolHook.sol`](PQPoolHook.sol) | `0xAA0` | The same rule for EIP-8141 FramePQAccounts: `register(firstKey)` checks the factory's CREATE2 address, so a rotated key stays admitted. | Devnet `0x3B288a191c20c0333c06E90b386b611d2AC3caa0` |

## Callbacks each hook implements

The PoolManager calls only the callbacks whose bit is set in the hook's address; the rest don't exist in the contract.

| Callback | `PQAccountPoolHook` / `PQPoolHook` (`0xAA0`) | `PQGuardHook` (`0xB01`) |
|---|---|---|
| `beforeInitialize`, `afterInitialize` | not called | not called |
| `beforeAddLiquidity` | the actor must be post-quantum | binds a new position to its funder's FORS+C key |
| `afterAddLiquidity` | not called | not called |
| `beforeRemoveLiquidity` | the actor must be post-quantum | checks the FORS+C signature in `hookData`, stores the recipient |
| `afterRemoveLiquidity` (+ `ReturnDelta`) | not called | pays everything to the signed recipient, returns the delta |
| `beforeSwap` | the actor must be post-quantum; returns `(selector, 0, 0)`: no delta, no fee override | not called: guarded pools trade freely |
| `afterSwap` | not called: the gate runs before the swap moves anything | not called |
| `beforeDonate` | the actor must be post-quantum | not called |
| `afterDonate`, swap and add-liquidity return deltas | not called / off | not called / off |

Every flag, signature and return value is in [partner-docs/ethglobal-mumbai/uniswap.md](../../../../partner-docs/ethglobal-mumbai/uniswap.md#every-callback-hook-by-hook).

## All the Uniswap code in this repo

| Where | What |
|---|---|
| here | the three hooks |
| [`contracts/test/uniswap/`](../../../test/uniswap/) | their 15 tests |
| [`backend/ethereum/uniswap/`](../../../../backend/ethereum/uniswap/) | Sepolia reads and calls, the deploy script, the devnet's v4 frames |
| [`frontend/src/app.ts`](../../../../frontend/src/app.ts) (`setupV4Swap`), [`frontend/src/ethereum/devnet.ts`](../../../../frontend/src/ethereum/devnet.ts) | the wallets' Swap tabs |

## How they decide who is acting

- **The real caller** comes from Uniswap's own PositionManager and Universal Router through their `msgSender()`. Any other router counts as itself, so it can't launder an ECDSA caller.
- **A position moved to an ECDSA wallet freezes:** it can't be removed. It doesn't leave the pool.
- **`PQGuardHook` uses `PQKeyRegistry.consume`.** It counts the guard key's uses and refuses a replay or another key's signature with `BadSignature`.
  - `beforeRemoveLiquidity` checks the signature and keeps the signed recipient in transient storage.
  - `afterRemoveLiquidity` takes everything the removal released, pays it to that recipient, and returns the full delta, so the caller receives nothing.

## Tests

```bash
cd contracts
forge test --match-path test/uniswap/PQGuardHook.t.sol     # 8: no signature, nothing out; pays only the signed recipient, once; deadline; guard key required; PQAccountPoolHook's ECDSA refusal
forge test --match-path test/uniswap/PQPoolHook.t.sol      # 7: permission bits; only factory accounts; swaps and provides via Uniswap's periphery; ECDSA refused; routers count as themselves
```

## Deploying

The address carries the permission bits, so the salt is mined for the CREATE2 deployer `0x4e59b44847b379578588920ca78fbf26c0b4956c`.

- **Sepolia:** `cd backend && OPAQUE_NETWORK=sepolia node --use-system-ca ethereum/uniswap/uniswap-sepolia.ts`. It deploys the hooks, opens their ETH/tUSDC pools, shows every rule on chain, and writes `deployments/eth-sepolia.json` → `uniswap`.
- **Devnet:** `cd backend && node ethereum/frame-tx.ts pqpool`, in one atomic FORS-signed frame transaction.

Not audited. Testnet only.
