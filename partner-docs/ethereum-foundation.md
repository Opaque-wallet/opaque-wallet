<div align="center">

# Ethereum Foundation: CROPS, anon-rpc and EIP-8141

### A wallet you can leave without us, reads nobody can trace, and transactions signed by a hash-based key alone.

[![CROPS](https://img.shields.io/badge/CROPS-C%20·%20O%20·%20P%20·%20S-FF7A18?style=flat-square)](#crops-stated-plainly)
[![anon-rpc](https://img.shields.io/badge/anon--rpc-Nox%20on%20Sepolia-FF7A18?style=flat-square)](https://ethereum.github.io/anon-rpc/)
[![EIP-8141](https://img.shields.io/badge/EIP--8141-FORS%2BC%20frame%20txs-FF7A18?style=flat-square)](#eip-8141-a-transaction-signed-by-fors-c-alone)

</div>

## Why this matters

- **Privacy has to be post-quantum today, not on the day a quantum computer arrives.** Chain data is permanent. A stealth payment hidden today with elliptic-curve Diffie-Hellman (ERC-5564's secp256k1 scheme) can be opened the day secp256k1 falls. Every payment ever announced becomes linkable at once.
- **Privacy that depends on one operator is a promise, not a property.** A wallet whose withdrawals need its operator's signature can be switched off or made to refuse.
- **"Who asked" leaks as much as "who paid".** An RPC provider that sees a wallet's reads sees which addresses that IP cares about, whatever the pool hides.

Opaque answers all three, live on Sepolia, and on the EIP-8141 devnet goes one step further: the whole transaction is post-quantum.

## anon-rpc: reads nobody can trace

- **Always on for ENS:** the wallet resolves every ENS name through EF's [anon-rpc](https://ethereum.github.io/anon-rpc/), over the Nox mixnet's Sepolia network.
- **A switch for everything else:** with it on, the account's reads and UserOperations (STATE, ESTIMATE, SUBMIT and RECEIPT) leave the browser through anon-rpc for a public RPC and the public bundler. The Privacy view counts every request anon-rpc answered.
- **The exit below runs entirely over anon-rpc,** with no server of Opaque's in the path.
- **Checked by [`e2e-sepolia.ts`](../backend/scripts/e2e-sepolia.ts):** with the switch on, no RPC or bundler request from the browser named the account. It saw only 2 direct requests, one of them anon-rpc's own bootstrap read.
- **Code:** [`frontend/src/lib/anon-rpc.ts`](../frontend/src/lib/anon-rpc.ts) and [`frontend/src/lib/without-opaque.ts`](../frontend/src/lib/without-opaque.ts).
- **We'd be anon-rpc's first wallet adopter.** The entry for its `adopters.json5` is drafted in [`docs/mumbai/anon-rpc-adopter.md`](../docs/mumbai/anon-rpc-adopter.md).

## C: your money leaves without us

- **Before:** every withdrawal from an Opaque pool needed Opaque's attester to sign it. If Opaque went away, or refused you, your notes were stuck.
- **Now:** each Sepolia pool's verifier, [`ExitableRingVerifier`](../contracts/src/opaque/pool/ExitableRingVerifier.sol), keeps the private path and adds an exit that needs nobody:
  1. the wallet announces the note's nullifier, bound to its payout;
  2. after the pool's delay (5 minutes on Sepolia), it reveals the note's secret;
  3. the contract recomputes the note's commitment and nullifier with AES-128 on chain ([`AES128.sol`](../contracts/src/opaque/lib/AES128.sol), checked byte for byte against the wallet's own derivation), and pays.
- **The proof:** `e2e-sepolia.ts` blocks every Opaque host in the browser. The wallet offers the way out instead of a dead end. It reads its notes from the chain through anon-rpc, then announces and withdraws a 50 tUSDC note through a public bundler. The receiving address gets it, and no RPC or bundler saw the account.
- **A standard, drafted:** [`docs/mumbai/erc-exitable-pools.md`](../docs/mumbai/erc-exitable-pools.md) is an ERC draft for exitable privacy pools.

## P: who was paid is hidden too, against quantum computers as well

- **Before:** the ring of 8 hid who paid, but the pool paid the recipient's own address in public.
- **Now:** post-quantum stealth payments, built on the standard registries ([`backend/chain/stealth.ts`](../backend/chain/stealth.ts)):
  - a wallet publishes one **ML-KEM-768** encapsulation key in [ERC-6538](https://eips.ethereum.org/EIPS/eip-6538)'s registry, under its own scheme id;
  - a payer encapsulates to that key. The shared secret draws the keys of a fresh FORS+C account, the pool pays that account, and the 1,088-byte ciphertext goes on [ERC-5564](https://eips.ethereum.org/EIPS/eip-5564)'s Announcer;
  - the payee's wallet scans the announcements, opens its own and sweeps each payment into its notes.
- **The cost of hash-based keys:** FORS+C keys have no algebra to tweak the way elliptic-curve keys do. So the payer also holds the one-time account's keys until the payee sweeps it. The wallet sweeps as soon as the payment lands.

## EIP-8141: a transaction signed by FORS+C alone

- **On Sepolia,** each action is authorized by the account's FORS+C key through ERC-4337. A bundler only carries the UserOperation.
- **On the EIP-8141 devnet,** the transaction itself is post-quantum: [`FramePQAccount`](../contracts/frame/FramePQAccount.sol) validates in a VERIFY frame with a FORS+C signature and pays for itself. There's no bundler and no paymaster.
- **It fits the public mempool's budget.** The devnet caps validation at `MAX_VERIFY_GAS` = 100,000 for every sender. The audited `ForsVerifier` spends 167k at k=13, a=13. [`LeanFors`](../contracts/src/ethereum/frame/LeanFors.sol) is the same function with its hot loop in assembly, at **53.6k**. A whole VERIFY frame used **76,430 gas**: no special treatment, no private mempool, no whitelisting.
  - `test/LeanFors.t.sol` holds it to `ForsVerifier`: the same commitment on both fixtures, the same verdict on 1,024 fuzzed tamperings, and the same reverts.
- **Accounts are created with no signature at all.** [`FramePQAccountFactory`](../contracts/frame/FramePQAccountFactory.sol) is the creating transaction's sender and pays for it. Its VERIFY approves only one `create(key)` frame to itself. The address is CREATE2 on the key, so the wallet knows it before the account exists.
- **Everything else runs on the devnet too, every signature FORS+C:**
  - private payments: pqUSDC notes in seven pools, ZKBoo ring proofs built in the page, three relays, an attester that's itself a FORS+C account, and the pool paying the recipient;
  - Uniswap v4 swaps in a pool only post-quantum accounts may use;
  - ENS names, resolved with ENSIP-11.
- **Try it:** [opaque.credit/testnet/devnet](https://www.opaque.credit/testnet/devnet), "Ethereum Devnet (Fully post-quantum)".

## CROPS, stated plainly

| | What we do | What we don't, yet |
|---|---|---|
| **C**, censorship resistance | Notes leave their pools with every Opaque server unreachable (exitable pools, anon-rpc, a public bundler). | Arc and XRPL pools have no such exit: a pool's verifier is fixed when it's deployed. Private *payments* still need our attester. |
| **O**, open source | [Apache-2.0](../LICENSE). Contracts, wallet, extension and stack build and run from this repo alone. | Our hosted stack's secrets are ours. Anyone can run a stack with their own. |
| **P**, privacy | Ring of 8, a three-hop relay mesh, a fresh account per app, ML-KEM stealth payments, reads through anon-rpc, no analytics. | anon-rpc's bootstrap reads its specifier contract directly, once. An exit makes that one note public. The amount is public. |
| **S**, security | FORS+C hash-based keys, sealed in the browser under the wallet password; few-time keys that rotate themselves; forge tests; the audited contracts unchanged. | The new contracts aren't audited. The relays are **one operator today; before mainnet they'll be run by multiple independent operators.** |

## Deployment addresses

**Sepolia** (full map: [`deployments/eth-sepolia.json`](../deployments/eth-sepolia.json)):

| Contract | Address |
|---|---|
| Exitable pool, 1 tUSDC | [`0xf5408a8e98773ed5fded3decb805bd6cb10b8668`](https://sepolia.etherscan.io/address/0xf5408a8e98773ed5fded3decb805bd6cb10b8668) |
| Exitable pool, 2 tUSDC | [`0x73066fbfbbd97781d8a409017dd7fdfad0e3b268`](https://sepolia.etherscan.io/address/0x73066fbfbbd97781d8a409017dd7fdfad0e3b268) |
| Exitable pool, 5 tUSDC | [`0x5b0287f1b5b57dc50769551a9511faeaeb475d42`](https://sepolia.etherscan.io/address/0x5b0287f1b5b57dc50769551a9511faeaeb475d42) |
| Exitable pool, 10 tUSDC | [`0xb812a927daa8b22983737d689d1f3af649530ed9`](https://sepolia.etherscan.io/address/0xb812a927daa8b22983737d689d1f3af649530ed9) |
| Exitable pool, 20 tUSDC | [`0x9905c992d43c531b0973d25209877f448fd660cf`](https://sepolia.etherscan.io/address/0x9905c992d43c531b0973d25209877f448fd660cf) |
| Exitable pool, 50 tUSDC | [`0xa1b56dbc554bef4e9d6caecf0346a97f3102ff8b`](https://sepolia.etherscan.io/address/0xa1b56dbc554bef4e9d6caecf0346a97f3102ff8b) |
| Exitable pool, 100 tUSDC | [`0x839dde4a593a4f669540efc8d699ae66118fc25c`](https://sepolia.etherscan.io/address/0x839dde4a593a4f669540efc8d699ae66118fc25c) |
| Exitable pool, 0.0005 ETH (WETH) | [`0x68c22d3c8f50f72c51bce410d5a658a3c50c9919`](https://sepolia.etherscan.io/address/0x68c22d3c8f50f72c51bce410d5a658a3c50c9919) |
| Exitable pool, 0.001 ETH (WETH) | [`0x04d4fb05dc905163ea28b6d7a5d869ab11b480dd`](https://sepolia.etherscan.io/address/0x04d4fb05dc905163ea28b6d7a5d869ab11b480dd) |
| Exitable pool, 0.005 ETH (WETH) | [`0xed9ad8f64a4656427d28dd0b864058d5267bf0dc`](https://sepolia.etherscan.io/address/0xed9ad8f64a4656427d28dd0b864058d5267bf0dc) |
| `PQKeyRegistry` | [`0x8b47560d32bcda788ab5233ab2bda55204cacca3`](https://sepolia.etherscan.io/address/0x8b47560d32bcda788ab5233ab2bda55204cacca3) |
| `PQAccountFactory` / `PQAccount` implementation | [`0xe5931be6e8ec9a689f96d4de767f73718bdab08f`](https://sepolia.etherscan.io/address/0xe5931be6e8ec9a689f96d4de767f73718bdab08f) / [`0x17fc96e5b93eb031b2db2aac415dd507ad932dbf`](https://sepolia.etherscan.io/address/0x17fc96e5b93eb031b2db2aac415dd507ad932dbf) |
| ERC-6538 registry / ERC-5564 Announcer (the standard ones) | [`0x6538e6bf4b0ebd30a8ea093027ac2422ce5d6538`](https://sepolia.etherscan.io/address/0x6538e6bf4b0ebd30a8ea093027ac2422ce5d6538) / [`0x55649e01b5df198d18d95b5cc5051630cfd45564`](https://sepolia.etherscan.io/address/0x55649e01b5df198d18d95b5cc5051630cfd45564) |

Each pool's exit waits 300 s on Sepolia.

**EIP-8141 devnet, chain 1337** (full map: [`deployments/eth-devnet.json`](../deployments/eth-devnet.json); explorer: [altmempoolexplorer.forshtat.com](https://altmempoolexplorer.forshtat.com)):

| Contract | Address |
|---|---|
| `FramePQAccountFactory` (accounts with no signature) | `0xd254366DeE9D4D2dE2F11982cabEAF94a16a3e0C` |
| `DevnetFaucet` (Opaque's devnet ETH) | `0x4F4b98A8f60Daaeee8D6a0D82a612003f3eaEec2` |
| `PQKeyRegistry` (devnet) | `0xbd9e98b96748f9a8083239d7ece0e9671483038f` |
| pqUSDC | `0xcd4b05a82c3e9a74d1f99bb688c359b8bea66037` |
| `TokenFaucet` (pqUSDC) | `0x786d0107d731e06a1c84f178a099a8b3e94c359f` |
| The attester, itself a FramePQAccount | `0x058fc5752b063765946af729311bae7ce032e3a2` |
| Seven pqUSDC privacy pools (1 to 100) | under `privacy.pools` |

## Reproduce it

```bash
cd contracts && forge test                                   # 142 pass, incl. LeanFors and ExitableRingVerifier
cd backend && node --use-system-ca scripts/e2e-sepolia.ts    # 33 checks: stealth, anon-rpc, the exit with Opaque blocked
cd backend && node --use-system-ca scripts/e2e-devnet-private.ts   # a private payment on the devnet, every signature FORS+C
cd backend && node ethereum/frame-tx.ts send                 # a FORS+C-only frame transaction
```

[Back to partner evidence](README.md) · [Main README](../README.md)
