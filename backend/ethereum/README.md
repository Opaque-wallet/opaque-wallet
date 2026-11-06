# backend/ethereum: deploys, demos and the devnet's transactions

Ethereum-only backend code. The shared EVM backend (pools, attestation, the wallet's RPC through the mesh, stealth payments, the v4 reads the wallet uses) is in [`backend/chain/`](../chain/). Every script is resumable: it reads the chain first, and what it makes goes into `deployments/eth-*.json`.

Run from `backend/`, with `--use-system-ca` behind a TLS-inspecting proxy. Sepolia scripts need `OPAQUE_NETWORK=sepolia`.

## Sepolia

| Script | What it does |
|---|---|
| [`sepolia-deploy.ts`](sepolia-deploy.ts) | Opaque on Sepolia end to end: tUSDC, the PQ account stack (factory, implementation, validator, `PQKeyRegistry`), the attester's keys, and seven exitable tUSDC pools (1–100), each seeded with 8 decoys. |
| [`weth-pools.ts`](weth-pools.ts) | Private ETH: three exitable WETH pools (0.0005, 0.001 and 0.005 ETH), with the same contracts as the tUSDC pools. |
| [`ens-sepolia.ts`](ens-sepolia.ts) | opaque.eth on ENSv2: `deploy`, `adopt`, `records` and `status` for `PQNameController`. |
| [`ens.ts`](ens.ts) | The FORS+C signed-call format `PQNameController` checks (`signExecute`, `signAction`, rotations). |
| [`uniswap-sepolia.ts`](uniswap-sepolia.ts) | Deploys `PQAccountPoolHook` and `PQGuardHook` at Uniswap's own v4 (with salt mining), opens their pools, and proves each rule on chain. |
| [`vault-sepolia.ts`](vault-sepolia.ts) | Deploys the Q-Day vault and proves it on chain: a thief's key refused, a replay refused, the signed withdrawal paid. |

## EIP-8141 devnet

| Script | What it does |
|---|---|
| [`frame.ts`](frame.ts) | FramePQAccount's frame transactions, for Node and the browser alike: build, sign with FORS+C, send to the gateway and the miner, wait, re-broadcast the same bytes if the mempool drops them. The wallet's devnet page imports it. |
| [`frame-tx.ts`](frame-tx.ts) | The devnet from the command line: `fund`, `factory`, `devnet-faucet`, `create`, `send`, `attack`, `rotate`, `pool`, `swap`, `pqpool`, `privacy`. |
| [`uniswap.ts`](uniswap.ts) | Uniswap v4 as SENDER frames: the pool setup, quotes from PoolManager storage, swaps, and registration in the post-quantum pool. |
| [`devnet-stack.ts`](devnet-stack.ts) | Opaque's privacy layer on the devnet: six relays, the exit, the attester and the settler as one FORS+C account. Hosted on Railway as `opaque-eth-devnet`. |

## End-to-end tests (in `backend/scripts/`)

| Test | What it proves |
|---|---|
| `e2e-sepolia.ts` | The whole Sepolia wallet in Chromium: private payment, ETH send, a v4 swap through the post-quantum pool, a name claimed and paid at a one-time address, the stealth sweep, anon-rpc, and a note leaving its pool with every Opaque server blocked. 33 checks. |
| `e2e-sepolia-eth.ts` | Private ETH: make 0.0065 ETH private as WETH notes, send 0.0015 privately; the payee holds exactly 0.0015 WETH. |
| `e2e-eth-connect.ts` | The extension's EIP-6963 provider: a dapp finds Opaque beside MetaMask, connects, sends 0.001 ETH, and a rejection is 4001. It also runs the `/connect-opaque` page. 19 checks. |
| `e2e-vault.ts` | The Q-Day vault page with a stand-in MetaMask: register, deposit, the thief refused, a signed withdrawal. |
| `e2e-devnet-private.ts` | The devnet wallet from an account with no ETH: gas and pqUSDC from the faucet, a deposit, and a private payment where every signature is FORS+C. |
