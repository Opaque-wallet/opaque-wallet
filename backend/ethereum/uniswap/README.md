# backend/ethereum/uniswap

Uniswap v4 from TypeScript, for Node and the browser alike.

## Index

| File | What |
|---|---|
| [`uniswap-v4.ts`](uniswap-v4.ts) | **Sepolia**, at Uniswap's own v4: pool keys and ids, quotes computed from PoolManager storage (`extsload`, the v4 swap step), and the `V4_SWAP` swap, mint and guarded-decrease calls. The wallet's Swap tab and the exit's allowlist use it. |
| [`uniswap-sepolia.ts`](uniswap-sepolia.ts) | **Sepolia** script: deploys `PQAccountPoolHook` and `PQGuardHook` (salts mined for their permission bits), opens their pools, and shows every rule on chain. Run: `OPAQUE_NETWORK=sepolia node --use-system-ca ethereum/uniswap/uniswap-sepolia.ts`. |
| [`uniswap.ts`](uniswap.ts) | **EIP-8141 devnet**: v4 as SENDER frames of a FORS+C frame transaction, covering the pool setup, quotes from storage, swaps, and registration in the post-quantum pool. The devnet wallet and `frame-tx.ts pool | swap | pqpool` use it. |

The contracts are in [`contracts/src/ethereum/uniswap/`](../../../contracts/src/ethereum/uniswap/README.md), and the full write-up is [partner-docs/ethglobal-mumbai/uniswap.md](../../../partner-docs/ethglobal-mumbai/uniswap.md).
