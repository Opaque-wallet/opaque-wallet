# Opaque on Ethereum: the build, one task at a time

Written for ETHGlobal Mumbai, checked on 5 November 2026. Work through the tasks in order: each ends with a check that proves it is done. Tick a task only when its check passes.

## Decisions already made

- **Testnet only.** Sepolia, through ERC-4337 and Pimlico, plus the EIP-8141 alt-mempool devnet (chain 1337). No mainnet.
- **Arc and Ethereum share one EVM codebase.** A network is a deployments file and a build path, never a copy of the code.
- **The existing contracts deploy unchanged.** New behaviour goes in adapters under `contracts/src/ethereum/`.
- **Never invent an address or an ABI.** Read it from the chain or the verified source, then write it down here.
- **The EF entry is a CROPS upgrade.** The new property is no ECDSA anywhere in a user's transaction (EIP-8141), plus an exit that works without our attester (T10). Only one EF prize per project, and EF's judges pick which one.

## Where things live

| Path | What |
|---|---|
| `contracts/src/opaque/` | Shared EVM contracts (Arc and Ethereum): pools, verifiers, the PQ account, the key registry |
| `contracts/src/ethereum/{ens,uniswap,frame}/` | New: the Ethereum-only adapters (created by T7–T9) |
| `contracts/frame/` | The EIP-8141 devnet account, built on its own: `FOUNDRY_PROFILE=frame forge build` (solc 0.8.28) |
| `backend/ethereum/frame-tx.ts` | Funds, deploys and sends frame transactions on the devnet |
| `backend/chain/` | Shared EVM backend: pool reads, attestation, wallet RPC |
| `backend/ethereum/` | New: ENS, v4 and frame-transaction helpers (created by T7–T9) |
| `backend/mesh`, `backend/cre`, `backend/zk` | The shared core: relays, sealing, ring proofs |
| `backend/xrpl/` (+ `scripts/`) | The XRP Ledger, and its browser e2e scripts |
| `frontend/app.html` | The EVM wallet, built once per network (`VITE_NETWORK`) |
| `frontend/src/xrpl/` | The XRPL wallet's code (its pages stay at `frontend/xrpl*.html`, so the URLs don't change) |
| `frontend/src/lib/wallet-keys.ts` | The recovery phrase and every chain's accounts (shared) |
| `deployments/arc-*.json`, `deployments/eth-*.json` | One file per EVM network (`eth-*` arrive in T3) |
| `deployments/xrpl/` | XRPL pools and the XRPL EVM sidechain |

## Checked addresses

### Sepolia (chain 11155111)

RPC through this office's proxy: `https://ethereum-sepolia-rpc.publicnode.com`, fallback `https://1rpc.io/sepolia`. drpc refuses Sepolia on its free plan.

Every address below has code on chain. For v4, `poolManager()` on the PositionManager, StateView and Quoter returns the PoolManager below, and the PositionManager's `permit2()` returns Permit2.

| Contract | Address |
|---|---|
| USDC (Circle, 6 decimals) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| WETH | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` |
| EntryPoint v0.7 / v0.8 | `0x0000000071727De22E5E9d8BAF0edAc6f37da032` / `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` |
| CREATE2 factory | `0x4e59b44847b379578588920ca78fbf26c0b4956c` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| v4 PoolManager | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` |
| v4 PositionManager | `0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4` |
| v4 Universal Router | `0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b` |
| v4 StateView / Quoter | `0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c` / `0x61b3f2011a92d183c7dbadbda940a7555ccf9227` |
| v4 PoolSwapTest | `0x9b6b46e2c869aa39918db7f52f5557fe577b6eee` |
| ENSv2 RootRegistry | `0xb458d6a3a77919449d03e7a6903c26827c1ec43f` |
| ENSv2 ETHRegistry | `0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4` |
| ENSv2 ETHRegistrar | `0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3` |
| ENSv2 UniversalResolverV2 | `0x24e1d8e068620b647ca097f961a61055f4f42d72` |
| ENSv2 PermissionedResolverImpl | `0x115eb53f0c60696633855f90b138178fb40b2b2c` |
| ENSv2 VerifiableFactory | `0xda70306c98e97ece36f997a21368e53298572991` |

Bundler: `https://public.pimlico.io/v2/11155111/rpc`. This is the same URL pattern Arc uses; T3 confirms it answers.

### EIP-8141 devnet (chain 1337)

- **Miner:** `https://altmempool.forshtat.com`, at block 403,141 when checked.
- **Gateway, the alt mempool:** `https://altmempoolgateway.forshtat.com/rpc`. It is answering again. Its faucet is `skandha_explorer_faucet`, once an hour.
- **Explorer:** `https://altmempoolexplorer.forshtat.com`.
- **Client:** ethrex `v23.0.0-eip8141-tracer`, gas limit 60M, base fee 7 wei.

Predeployed contracts:

| Contract | Address |
|---|---|
| PoolManager | `0x6bF9Aa9c04fd001385742d61f6818C3236429848` |
| PositionManager | `0x5bF24B2CD6f4cc0057F4BeD53264d591620Af57B` |
| Universal Router | `0x5e2250a42608a5cc9f62e23ab24824ee25b5e2be` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| WETH9 | `0x1b7d32025F7cA633943BbCC9Ec61a98ef66187b6` |
| NaiveStakingRegistry | `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f` |

Frame transactions already swap on this v4. For example, tx `0xd492b80a…18a` has 5 frames, in block 266,209.

Never use the devnet's published genesis or deployer keys: one of them is the node's relayer.

## Tasks

### T0. Housekeeping (needs the user)

- Run the security pass on the pending work, then commit it on `xrpl-testnet`.
- Branch `ethereum` from that commit, and tag `mumbai-start` there.
- Pick a license, Apache-2.0 or MIT. Today's `LICENSE` is proprietary, which fails CROPS "O". Switching means a new `LICENSE` file, the SPDX headers (`UNLICENSED` today) and every `package.json` license field.

**Done when:** the tag exists and `LICENSE` is open source.

### T1. Chain-agnostic site. Done, not committed yet

- **Landing page** (`frontend/site/`): the phone shows ETH, USDC and XRP notes; addresses mix `0x` and `r`; the hero's ledger scrolls Ethereum and XRPL rows; the explorer links cover Sepolia, Arc and XRPL.
- **Wallet:** the network picker has an Ethereum group (Sepolia, EIP-8141 devnet) marked Soon.
- **Run it locally:** `cd frontend && npm run preview:site`, then open http://localhost:5174. That builds and serves the whole site as deployed, so Open wallet works too. `npm run dev:site` reloads on every edit, but serves the landing page alone.
- **Ship it with T6,** so the site doesn't promise Ethereum before it works.

### T2. Sepolia in the deployments

- Add `deployments/eth-sepolia.json`, in the shape of `arc-testnet.json`:
  - `network`: chainId 11155111, the RPCs above, explorer `https://sepolia.etherscan.io`, sitePath `sepolia/`, native currency ETH with 18 decimals.
  - `tokens.usdc`: the address above, 6 decimals.
  - Every contract `null` except `create2Factory`.
  - `erc4337`: the EntryPoints and the Pimlico URL.
  - `mesh`: a new genesis and trust root, from a new mesh master that Arc never uses.
  - `services`: all `null`.
- Change `deployments/index.ts`: add `sepolia` to `NETWORKS`. **Done.** `accounts.attester` and `swap.router` may now be `null`, and `requireAttester()` refuses the null attester the way `requireContract()` refuses a missing contract.
- **Make the mesh root (the user runs this; the secret never leaves the laptop):** `cd backend && node scripts/new-mesh-master.ts eth-sepolia`. It writes the master to `backend/.stack/eth-sepolia/mesh-master` (0600) and pins the genesis and root in `eth-sepolia.json`. Until it runs, `OPAQUE_NETWORK=sepolia` refuses with "mesh.genesis must be unix seconds".
- Arc-only assumptions to fix on the way:
  - `swap.router` is LI.FI, which has no testnets. On Sepolia, T8 replaces it with v4.
  - Arc's USDC doubles as its native gas token. Ethereum's doesn't.
  - `FACTORY_STAKE = 1 ether` in `DeployPQStack.s.sol` means 1 real Sepolia ETH (see T4).
- The forge scripts need no change: `DEPLOYMENTS=eth-sepolia.json` already picks the file and checks the chain id.

**Done when:**
- `OPAQUE_NETWORK=sepolia node --test chain/test/deployments.test.ts` passes (in `backend/`);
- the Pimlico URL answers `eth_supportedEntryPoints`. **Done:** it serves v0.6–v0.9 on chain 0xaa36a7.

### T3. ETH notes (optional; after T6 if time is short)

- `PrivatePool` already takes any ERC-20 at any size, so WETH pools need no contract change.
- Note sizes stay the frozen 1–100 integers (`DENOMINATIONS` in protocol-types). Each pool gets a `unit` in the deployments file:
  - USDC: `1e6`;
  - WETH: `1e16`, which is 0.01 ETH, so the notes are 0.01, 0.02, 0.05, 0.1, 0.2, 0.5 and 1 ETH.
- The unit exists because 0.01 ETH in wei (1e16) is beyond `Number.MAX_SAFE_INTEGER`.
- Files to change:
  - `deployments/index.ts` (`PoolDeployment.unit`);
  - the whitelist in `DeployRingPool.s.sol` (size × unit);
  - wherever the wallet turns a size into an amount;
  - the subgraph, if it stores amounts.
- To deposit, the wallet wraps ETH and deposits in one UserOp through `PQAccount.executeBatch` (WETH `deposit`, `approve`, then the pool's `deposit`).

**Done when:** a 0.01 ETH note deposits and pays on Sepolia.

### T4. Deploy to Sepolia (the user signs; the deployer key goes in at forge's hidden prompt)

1. **Decide the exit verifier first (T10a).** A pool's verifier is immutable, so it is fixed the moment `DeployRingPool` runs.
2. **Funding:**
   - About 1.3 Sepolia ETH for the deployer. 1 ETH of that is the factory's EntryPoint stake: confirm Pimlico's Sepolia minimum before sending it.
   - A new attester address with enough ETH for its one registration transaction.
   - New FORS commitments for the attester. Never reuse Arc's keys: they are few-time.
3. **Deploy:**
   - `DEPLOYMENTS=eth-sepolia.json forge script script/DeployPQStack.s.sol --rpc-url <sepolia> --broadcast --interactives 1 --sender 0x…`, then record the addresses;
   - then `DeployRingPool.s.sol` for sizes 1 and 10 to start, then record those.
4. **Seed the rings.** Each pool needs 8 notes before the first private payment: `chain/fill-pools.ts` with Sepolia USDC from faucet.circle.com. That's 8×1 + 8×10 = 88 USDC; check the faucet's amount per request.

**Done when:** `deployments.test.ts` passes on Sepolia and both pools hold at least 8 notes.

### T5. Backend for Sepolia (Railway and The Graph need the user's go)

- **Railway:** a new service from `backend/deploy/stack.Dockerfile` with `OPAQUE_NETWORK=sepolia` and its own secrets:
  - mesh master, attester, egress;
  - an executor address funded with Sepolia ETH (it submits spends).
  - Set secrets with `railway variable set KEY --stdin`, never on argv.
- **Subgraph:** `graph/scripts/render-manifest.ts` for network `sepolia`, deployed to The Graph Studio, then set `services.graphUrl`.
- **Wallet RPC allowlist** (`backend/chain/wallet-rpc.ts`, `pq-wallet-chain.ts`): add Sepolia's chain id. `pq-wallet-chain.ts` only accepts LI.FI swaps today; T8 adds v4.

**Done when:** `scripts/smoke-network.ts` passes against the Sepolia service.

### T6. Wallet and extension on Sepolia

- **Build:** in `frontend/package.json`, `build:site` gains `VITE_NETWORK=sepolia vite build --outDir dist/sepolia`.
- **Picker:** add `sepolia` to `networks` in `deployments/index.ts` with a `chain` field, and replace the hand-written Sepolia "Soon" row in `network-picker.ts`.
- **Extension:** `extension/build.mjs` gains `sepolia/app.html` in `PAGES`.
- **Copy:** text that names Arc becomes the network's `displayName`, for example "Enter an Arc address" in `src/app.ts`.
- **e2e:** run `backend/scripts/e2e-arc-contracts.ts` as the template, with `OPAQUE_NETWORK=sepolia`.
- **Deploy:** the site (user's go), which ships T1 as well.

**Done when:** a private payment goes through in the browser on Sepolia, with the settlement on sepolia.etherscan.io.

### T7. ENSv2 with post-quantum authority (Sepolia)

- **Read first:**
  - `IRegistry`, `ETHRegistrar` (`register`, `REGISTRATION_ROLE_BITMAP`) and `PermissionedResolver`, from ENS contracts-v2;
  - the verified source of the addresses above.
- **`contracts/src/ethereum/ens/PQRegistry.sol`:**
  - an `IRegistry` (`getSubregistry`, `getResolver`, `getParent`) whose writes need a FORS+C signature, through the existing `PQKeyRegistry`/`ForsVerifier`;
  - each signed message binds the name, a nonce and a deadline;
  - it has no ECDSA owner.
- **Records:** `addr`, plus a text record carrying the account's PQ key commitment.
- **Name:**
  - register a demo `.eth` through `ETHRegistrar`, then point its subregistry at `PQRegistry`;
  - Tripwire: the ECDSA owner revokes `setResolver`, `ROLE_UPGRADE` and the root roles, together with their admin roles. Otherwise ECDSA can route around the PQ registry.
- **Wallet:** "Pay alice.eth" resolves the name through `UniversalResolverV2`, then makes a private payment.

**Done when:** a record changes only with a FORS signature (an ECDSA attempt reverts), and the wallet pays a name.

### T8. Uniswap v4

- **Swaps on Sepolia:**
  - swap at the account's address through the Universal Router;
  - add a `uniswap` section to `eth-sepolia.json` (poolManager, positionManager, universalRouter, permit2, stateView, quoter);
  - `pq-wallet-chain.ts` accepts `execute` with a V4_SWAP command.
- **The PQ hook** (`contracts/src/ethereum/uniswap/`):
  - a base hook that checks a FORS-signed `hookData`;
  - an LP guard whose `beforeRemoveLiquidity` needs a PQ signature binding the recipient and a deadline, so it can't be front-run. A transferred position freezes; it doesn't move.
  - The hook's address needs its permission bits, so mine a salt for the CREATE2 factory.
- **Devnet:** v4 is already there (addresses above), so T9 only adds the hook.

**Done when:**
- the wallet swaps on Sepolia;
- removing liquidity without the PQ signature reverts.

### T9. The EIP-8141 transaction (devnet)

**Steps 1–4 are done (5 November).** A frame transaction signed only with FORS+C runs on the devnet: no ECDSA key in it anywhere, and no bundler or paymaster. The account pays for itself.

**What we found:** the devnet caps validation at `MAX_VERIFY_GAS` = 100,000 for every sender, staked or not. It's a structural rule on the whole validation prefix: VERIFY frames' gas plus signature costs, in the sidecar's `validationPrefix.ts`. Staking doesn't raise it. `ForsVerifier` spends 167k on k=13, a=13, so it could never fit. **`LeanFors`** (`contracts/src/ethereum/frame/`) is the same verifier with its loop in assembly:

| Parameters | `ForsVerifier` | `LeanFors` |
|---|---|---|
| k=13, a=13 | 167k | **53.6k** |
| k=32, a=8 | 260k | 83k |

`test/LeanFors.t.sol` holds it to `ForsVerifier`: the same commitment on both fixtures, the same verdict on 1,024 fuzzed tamperings, and the same reverts.

**What is built:**
- **`contracts/frame/FramePQAccount.sol`** (`FOUNDRY_PROFILE=frame forge build`; the support library pins solc 0.8.28):
  - `verify()` is the VERIFY frame. It copies the ARBITRARY signature entry out with SIGDATACOPY, signs `keccak256(abi.encode(DOMAIN, sighash))`, recovers the key with `LeanFors` and approves execution and payment.
  - The protocol nonce counts the key's uses (8 per key at k=13, a=13), because a VERIFY frame can't write storage.
  - `rotate(next)` is called from a SENDER frame of the account's own transaction.
  - It refuses keyed nonces.
- **`backend/ethereum/frame-tx.ts`:** `fund`, `deploy`, `send`, `attack`. Keys are in `backend/.stack/eth-devnet/` (0600). It encodes with `@forshtat/hegota-support` (profile `ethrex-eip8141-tracer`), installed without touching the backend's viem.

**On chain:**
- **The account:** `0xF3039b74322b725cF8C799c727d92D317E94A2e2`. Its nonce started at 8: one, plus seven opcode helpers.
- **Transactions:**
  - `0x3bc85a308a16edb460e670296f09b7fbda41846baa6979a348c459b7a3e9c88f` (block 404,116, nonce 8);
  - `0xf1a38d414a25251392d2b95ede11d2fe4fc188aebba6e74323d999bdcdf9c4c6` (block 404,130, nonce 9).
  - Both are type 0x6, the payer is the account, and VERIFY used 76,430 gas.
- **The attack:** a transaction signed by another FORS key is refused at admission with `BadSignature()`.
- **Deploy gas:** contract code costs state gas here (EIP-8037: (120 + bytes) × 1,530), so deploying took more than 6M gas; the script sends 16M.

**Creating an account needs no ECDSA either:**
- **`FramePQAccountFactory`** (`contracts/frame/`, at `0x5516c44Eb7cBCCC15b9E1dFf522b7F75452880ae`) is the sender of the creating transaction and pays for it. Its VERIFY approves only a transaction that is exactly one `create(key)` frame to itself.
- **The address is CREATE2** with the key as salt, so a wallet knows it before the account exists, and the faucet funds it first.
- **Proof:** `node ethereum/frame-tx.ts create` made `0xAeD8621f6Dd36539D004E545e8E7Dda7d06aabCe` in `0xf8de0e0b32adcd19566a2e3e053480e42923fededa0984325a2f528af968a7be`, a frame transaction with no signature at all. Its first FORS-signed transfer is `0x1cde7c5b683f24eca6c2d99911d390f8353a5461f0dfd5a76da4e50b909903f7`.
- **Shared code:** the transaction logic is `backend/ethereum/frame.ts`, which runs in the browser too.

**In the wallet: "Fully post-quantum"** (the Ethereum group of the network picker, `frontend/devnet.html`, at `/testnet/devnet`):
- It uses the wallet's recovery phrase; the key is `stream(account key, "eip8141/1337/fors/0")`.
- It shows the account's address before the account exists, then: Get devnet ETH (the faucet), Create account (the factory pays), and Send (signed by FORS+C alone).
- It shows the signatures left out of 8, and links each transaction to the explorer.
- It talks straight to the devnet gateway, which allows any origin; this devnet has no relay mesh.
- `backend/scripts/e2e-devnet-page.ts` runs that whole life in Chromium against the live devnet.

**Uniswap v4, signed with FORS+C (`backend/ethereum/uniswap.ts`):**
- **Setup (`frame-tx.ts pool`):** one atomic FORS-signed transaction of 5 SENDER frames:
  - deploy pqUSD (`contracts/frame/TestToken.sol`, through the CREATE2 deployer, so no ECDSA deploys it);
  - approve Permit2, and the PositionManager in Permit2;
  - initialize ETH/pqUSD (fee 0.30%, tick spacing 60, no hooks, 2,000 pqUSD per ETH);
  - add 0.1 ETH of full-range liquidity.
- **pqUSD** is at `0x26453ffc2FdEC380396852947A3b2c1467384D9B`. The pool's price and liquidity, read back from PoolManager storage, are exactly the ones set.
- **Swap (`frame-tx.ts swap`):** one SENDER frame, `UniversalRouter.execute` with V4_SWAP: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL.
  - `0x6a530b4d8c639053af8b59a171868a1c7c9e034525e0726add5bdd32463f205a` swapped 0.001 ETH for 1.974316068794122597 pqUSD.
  - That's exactly the quote, computed from the pool's storage with the v4 swap step. The quote matches the router's own answer to the unit.
- **Found on the way:**
  - The devnet runs the newer v4-periphery: `ExactInputSingleParams` carries `minHopPriceX36`, and an impossible value trips its price check.
  - ethrex refuses `eth_call` from a contract address and takes no state overrides. So the quote comes from storage, not a simulation.

- **The wallet page swaps too:** "Swap ETH for pqUSD on Uniswap v4", with a live quote from the pool's state. The browser test runs it after the send; 0.001 ETH bought 1.9357 pqUSD, and 6 signatures were left.
- **The alt-mempool relay can drop.** On 6 November the gateway held a transaction as "New" while the miner never saw it; given to the miner directly, it was mined at once. `frame.ts` now sends every transaction to both.
- **The devnet's faucet ran dry on 6 November.** The browser test then funds the page's account from our own account, with a FORS-signed transfer.

**Still to do:**
- **SENDER frames that do the demo,** under `ATOMIC_BATCH_FLAG` (all or nothing):
  - (a) set the ENS name and records (the T7 registry, deployed on the devnet);
  - (b) swap or add liquidity on the predeployed v4 (the T8 hook);
  - (c) an Opaque deposit.
- **A rotation in the same transaction** as a payment, to show the handover.
- **Sepolia:** the same three calls as one ERC-4337 UserOp.

**Done when:** one 0x06 transaction on the devnet explorer runs all three, signed only with FORS+C.

### T11. Opaque's privacy on the devnet

Today the devnet page is post-quantum but not private: its sends and swaps come straight from the account. The privacy layer has to come over too. The order is: contracts, then the backend, then the page.

1. **Contracts (devnet):**
   - deploy `PQKeyRegistry`, `AttestedRingVerifier` and `PrivatePool` for a 6-decimal test dollar (pqUSDC), so the frozen 1–100 note sizes and every TypeScript amount work unchanged;
   - register an attester with its own FORS keys;
   - seed each pool's first ring of 8 notes, with deposits the FramePQAccount signs.
2. **Backend:**
   - `devnet` in `deployments/index.ts`, with a full deployments file;
   - a stack (relays, exit, attester) with its own mesh master;
   - a settler that submits `spend`. Planned: a FramePQAccount, so even the courier signs with FORS rather than ECDSA.
   - Hosting: locally first, then a Railway service (needs the user's go).
3. **The page gets a Private tab:**
   - a deposit into a pool, signed with FORS;
   - a private send: a ring proof in the browser, sealed, carried through the three-hop mesh, attested, and paid by the pool.
   - It reuses the Arc wallet's runtime pieces: note storage, ring client, prover worker, sealing, mesh client.

**Done when:** the browser test makes a private payment on the devnet in which nothing signs with ECDSA, and the explorer shows the pool, not the account, paying the recipient.

### T10. CROPS, and what the video shows

- **T10a, the exit without our attester.** A timelocked public withdrawal through an adapter verifier on the new Sepolia pools.
  - First check that ring-pool deposit commitments work with `SingleNotePqVerifier`.
  - This must land before T4's pools are deployed.
- **README:**
  - how to run it;
  - a CROPS section covering C, O, P and S, each stated honestly. Today one operator runs all six relays and the attester.
  - before vs new.
- **Fonts:** self-host them on `frontend/site/index.html`, `public/docs.html` and `developers.html`. Google Fonts is a third-party request.
- **Video, 3 minutes at most.** Show the moment the property matters:
  - our attester is switched off, and the user still exits;
  - the 8141 transaction has no ECDSA in it.

**Done when:** the README and the video are linked in the submission.

## Who does what

- **The user:**
  - keys, signing and funding;
  - faucets, Railway and The Graph;
  - the license choice;
  - each deploy's go, and the video.
- **Claude:** code, scripts, tests and the README, plus this file's ticks.
