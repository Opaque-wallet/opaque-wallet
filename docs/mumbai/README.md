<div align="center">

<img src="../../frontend/media/logo.png" alt="Opaque, post-quantum" width="360">

# Opaque · ETHGlobal Mumbai

### A private, post-quantum Ethereum wallet. Payments, names, swaps, liquidity and dapps, every one authorized by a hash-based key. Live today.

[**Open the wallet**](https://www.opaque.credit/testnet/devnet) · [The project page](https://www.opaque.credit/ethglobal-mumbai) · [Sepolia wallet](https://www.opaque.credit/sepolia/app) · [Keep MetaMask](https://www.opaque.credit/sepolia/vault) · [Opaque beside MetaMask](https://www.opaque.credit/connect-opaque)

![Opaque on Ethereum](../../diagrams/ethereum.svg)

</div>

## The problem

- **Ethereum's keys don't outlive a quantum computer.** Every account that has signed has published its ECDSA public key, and from a public key Shor's algorithm recovers the private key. When that's practical, every exposed wallet, LP position and ENS name can be taken. The protocol's own answer is a last-resort emergency fork. Nobody should be waiting for it.
- **Today's privacy expires.** Chain data is permanent. A stealth payment hidden with secp256k1 Diffie-Hellman (ERC-5564's scheme 1) can be opened the day secp256k1 falls, so every payment ever announced becomes linkable at once. Privacy that must still hold in ten years has to be post-quantum on the day the payment is made.
- **Privacy that depends on one operator is a promise.** If a wallet's withdrawals need its operator, the operator can switch them off.

## What we built

| | |
|---|---|
| **Post-quantum accounts** | FORS+C (hash-based) keys from one recovery phrase, sealed in the browser. Few-time keys that hand over to a key they committed to in advance. ERC-4337 on Sepolia, and EIP-8141 frame transactions on the devnet. |
| **Private payments, USDC and ETH** | Pools of fixed-size notes. A ring proof shows a note is one of 8 without saying which, carried by three relays. The pool pays. ETH goes in as WETH notes. |
| **Post-quantum stealth addresses** | An ML-KEM-768 meta-address in ERC-6538's registry, ciphertexts on ERC-5564's Announcer. Every payment lands at a fresh FORS+C account only the payee can find, and the wallet sweeps it into their notes. |
| **ENSv2 names a quantum computer can't take** | opaque.eth is owned by `PQNameController`, which acts only on a FORS+C signature. `name.opaque.eth` can be claimed only by post-quantum accounts, in the same signature that turns on stealth payments. |
| **Uniswap v4 liquidity a quantum computer can't take** | `PQGuardHook`, a FORS+C second factor for *any* LP, MetaMask's included, which pays only the recipient it signed. Plus pools only post-quantum accounts can trade in, on Uniswap's own Sepolia v4 and on the devnet. |
| **Keep MetaMask** | The Q-Day vault: MetaMask puts money in, and only a FORS+C signature takes it out. |
| **Opaque beside MetaMask in any dapp** | An EIP-6963 provider in the extension. Every transaction a dapp asks for is approved in Opaque and signed by the post-quantum account. |
| **Reads nobody can trace** | EF's anon-rpc (the Nox mixnet), for ENS always, and for the whole account with one switch. |
| **Leave without us** | Exitable pools: announce, wait, reveal, and AES-128 on chain recomputes the note. It works with every Opaque server down, through anon-rpc and a public bundler. |
| **Transactions signed by FORS+C alone** | On EIP-8141, the VERIFY frame checks FORS+C in 76,430 gas, inside the public mempool's 100k budget. The account pays for itself: no bundler, no paymaster. Accounts are created with no signature at all. |

## Prize tracks

| Track | What it gets | Evidence |
|---|---|---|
| **Uniswap**: v4 hooks | Three hooks that move pool authority to a hash-based key, live at Uniswap's own Sepolia v4 and on the devnet | [partner-docs/uniswap.md](../../partner-docs/uniswap.md) |
| **ENS**: ENSv2 | A real ENSv2 name held by a post-quantum key; subnames only for post-quantum accounts, with post-quantum stealth payments to them | [partner-docs/ens.md](../../partner-docs/ens.md) |
| **Ethereum Foundation**: CROPS, anon-rpc, EIP-8141 | An exit that needs nobody, ML-KEM stealth, anon-rpc reads, FORS+C-only frame transactions | [partner-docs/ethereum-foundation.md](../../partner-docs/ethereum-foundation.md) |

## How it's made

- **Signatures.** FORS+C is a few-time hash-based signature: keccak only, about 9 KB. It's implemented in TypeScript ([`packages/pq-wallet`](../../packages/pq-wallet/)) and verified on chain by the audited `ForsVerifier`.
  - On the devnet, that verifier spent 167k gas, more than EIP-8141's 100k validation cap. We rewrote its hot loop in assembly as [`LeanFors`](../../contracts/src/ethereum/frame/LeanFors.sol): **53.6k**.
  - `LeanFors` is held to the original on the same fixtures and 1,024 fuzzed tamperings.
- **Accounts.**
  - **Sepolia:** `PQAccount`, an ERC-4337 account whose FORS+C key lives in `PQKeyRegistry`. Pimlico's public bundler carries the UserOperations.
  - **Devnet:** `FramePQAccount`, an EIP-8141 account, encoded with `@forshtat/hegota-support`.
  - **Keys:** each account's key draws from the one recovery phrase. It rotates on its own before its uses run out, to a next key committed in advance.
- **Privacy.**
  - **Proofs:** ZKBoo ring proofs (MPC-in-the-head, hash-based), built in a Web Worker. The note secret never leaves the page.
  - **Transport:** intents are sealed and carried through a three-hop relay mesh with ML-KEM onion layers.
  - **Settlement:** an attester checks each proof and the pool pays.
  - **Stealth:** stealth payments use ML-KEM-768 on the standard ERC-5564/6538 contracts, with a scheme id of their own.
- **ENSv2.** ENSv2 moves every role over a name with its ERC-1155 token (`PermissionedRegistry._update`). So we transferred opaque.eth to a controller whose only authority is a FORS+C key. `OpaqueNames` is opaque.eth's subregistry and resolver; UniversalResolverV2 resolves through it unchanged.
- **Uniswap v4.**
  - The hooks' salts are mined for their permission bits.
  - The real caller is read through Uniswap's own PositionManager and router (`msgSender()`).
  - The guard keeps the signed recipient in transient storage and pays only it from `afterRemoveLiquidity`.
  - The wallet quotes from PoolManager storage (`extsload`) across the mesh.
- **The exit.** `ExitableRingVerifier` and `AES128.sol` recompute a note's commitment and nullifier on chain from its revealed secret, after a delay. The wallet runs the exit through anon-rpc with every Opaque host unreachable.
- **Hacky bits worth knowing:**
  - ethrex refuses `eth_call` from a contract address and takes no state overrides, so devnet quotes come from storage.
  - The alt mempool sometimes drops a transaction it accepted. FORS signing is deterministic, so the wallet re-broadcasts the *same bytes* until they're mined, and no key signs twice for one nonce.
  - Hash-based keys can't be tweaked like elliptic-curve keys, so a stealth payer briefly holds the one-time account's keys. The wallet sweeps as soon as the payment lands.
- **Stack.**
  - **Contracts:** Solidity with Foundry.
  - **Wallet:** TypeScript and Vite, as the web page, the Chrome MV3 extension and a PWA.
  - **Backend:** the hosted relays, exit and attester run on Railway, and the site is on Vercel.
  - **Tests:** Playwright e2e tests that run the real pages against Sepolia and the devnet.

## Try it

1. Open [opaque.credit/sepolia/app](https://www.opaque.credit/sepolia/app) and make a wallet (12 words, kept in your browser).
2. Tap **Get test funds**: tUSDC and gas. Auto-deposit makes the tUSDC into private notes.
3. Send privately. Claim a name in **Names**. Swap in **Swap**. Make ETH private under **Your funds**.
4. On [/testnet/devnet](https://www.opaque.credit/testnet/devnet), the same accounts on EIP-8141. Every transaction is signed by FORS+C alone.
5. Keep MetaMask: [/sepolia/vault](https://www.opaque.credit/sepolia/vault). Or install the extension and try [/connect-opaque](https://www.opaque.credit/connect-opaque).

## Proof

| Check | Result |
|---|---|
| `cd contracts && forge test` | 142 passed |
| `cd backend && npm test` | 394 passed |
| `scripts/e2e-sepolia.ts` | 33 checks against the live site and Sepolia: private payment, v4 swap, a name claimed and paid at a one-time address, the sweep, anon-rpc, and a note leaving its pool with every Opaque server blocked |
| `scripts/e2e-sepolia-eth.ts` | private ETH: the payee holds exactly 0.0015 WETH |
| `scripts/e2e-eth-connect.ts` | 19 checks: Opaque found by EIP-6963, connected, a mined transaction |
| `scripts/e2e-devnet-private.ts` | a private payment on the devnet, every signature FORS+C |

Deployment addresses are in each partner page, and in [`deployments/eth-sepolia.json`](../../deployments/eth-sepolia.json) and [`deployments/eth-devnet.json`](../../deployments/eth-devnet.json).

## Honest about it

- **One operator, for now.** Private payments use our attester and relays. **Before mainnet, the relays will be run by multiple independent operators.** The exit already works without any of it.
- **Amounts are public.** A read through anon-rpc takes about a second.
- **Testnet only.** The new contracts are tested, not audited. The audited contracts deploy unchanged.

## In this folder

- [`PLAN.md`](PLAN.md): the build, task by task, with every address checked on chain.
- [`anon-rpc-adopter.md`](anon-rpc-adopter.md): Opaque's entry for anon-rpc's adopters list.
- [`erc-exitable-pools.md`](erc-exitable-pools.md): a draft ERC for exitable privacy pools.
- [`opaque-ethereum.excalidraw`](opaque-ethereum.excalidraw), [`opaque-privacy-layer.excalidraw`](opaque-privacy-layer.excalidraw): the first sketches. The finished diagram is [`diagrams/ethereum.excalidraw`](../../diagrams/ethereum.excalidraw).

Apache-2.0 · [Main README](../../README.md)
