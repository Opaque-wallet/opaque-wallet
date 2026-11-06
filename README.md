<div align="center">

<img src="frontend/media/logo.png" alt="Opaque, post-quantum" width="420">

### Ethereum, private and post-quantum. Today, not on a roadmap.

[![Uniswap v4](https://img.shields.io/badge/Uniswap%20v4-post--quantum%20hooks-FF007A?style=flat-square)](partner-docs/ethglobal-mumbai/uniswap.md)
[![ENSv2](https://img.shields.io/badge/ENSv2-names%20held%20by%20FORS%2BC-0080BC?style=flat-square)](partner-docs/ethglobal-mumbai/ens.md)
[![EF](https://img.shields.io/badge/Ethereum%20Foundation-CROPS%20·%20anon--rpc%20·%20EIP--8141-627EEA?style=flat-square)](partner-docs/ethglobal-mumbai/ethereum-foundation.md)
[![forge](https://img.shields.io/badge/forge-142%20passed-FF7A18?style=flat-square)](contracts/)
[![backend](https://img.shields.io/badge/backend-394%20passed-FF7A18?style=flat-square)](backend/)
[![License](https://img.shields.io/badge/license-Apache--2.0-FF7A18?style=flat-square)](LICENSE)

**Opaque is an Ethereum wallet in which every authorization is a hash-based, post-quantum signature, and every payment is private by default.**

It covers paying and being paid, names, swaps and liquidity, any dapp, and keeping MetaMask.

It's live on Sepolia and on Ethereum's EIP-8141 devnet, built for ETHGlobal Mumbai.

[**Open the wallet**](https://www.opaque.credit/testnet/devnet) · [**ETHGlobal Mumbai submission**](docs/mumbai/README.md) · [The project page](https://www.opaque.credit/ethglobal-mumbai) · [Sepolia wallet](https://www.opaque.credit/sepolia/app) · [Keep MetaMask](https://www.opaque.credit/sepolia/vault) · [Opaque beside MetaMask](https://www.opaque.credit/connect-opaque) · [Partner pages](partner-docs/ethglobal-mumbai/README.md)

![Opaque on Ethereum: the wallet, its two transaction paths (EIP-8141 frame transactions on the devnet, ERC-4337 on Sepolia), the privacy layer, and the post-quantum authorization core under all of it](diagrams/ethereum.svg)

</div>

---

> **In one paragraph.**
> - **Signatures:** every signature that moves value is FORS+C, a hash-based scheme whose security rests on keccak alone. That covers the user's account, the attester that approves private spends, the ENS controller and the LP guard.
> - **Privacy:** it uses hashes, AES-128 and ML-KEM-768 only, so a quantum computer has nothing to recover keys from or decrypt later.
> - **On Sepolia:** it runs through ERC-4337, Uniswap's own v4 and ENSv2.
> - **On the EIP-8141 devnet:** the transaction itself is signed by FORS+C alone, in 76,430 gas.
> - **Leaving:** every note can leave its pool with every Opaque server switched off.
> - **Tests:** 142 contract tests, 394 backend tests and six browser suites check it against the live chains.

## Contents

1. [Why this is the need of the hour](#why-this-is-the-need-of-the-hour)
2. [What a quantum computer does to Ethereum](#what-a-quantum-computer-does-to-ethereum)
3. [What we built, live today](#what-we-built-live-today)
4. [The life of a private payment](#the-life-of-a-private-payment)
5. [The cryptography, layer by layer](#the-cryptography-layer-by-layer)
6. [Architecture: the moving parts](#architecture-the-moving-parts)
7. [Partner tracks: Uniswap, ENS, Ethereum Foundation](#partner-tracks)
8. [Hard problems we solved](#hard-problems-we-solved)
9. [The numbers](#the-numbers)
10. [Deployment addresses](#deployment-addresses)
11. [Proof: run it yourself](#proof-run-it-yourself)
12. [Threat model, and what we don't claim](#threat-model-and-what-we-dont-claim)
13. [Repository map](#repository-map)

---

## Why this is the need of the hour

**1. Every Ethereum account that has ever signed has already published what a quantum computer needs.**
- An ECDSA signature reveals its public key. From a public key, Shor's algorithm recovers the private key.
- When that becomes practical, every exposed account can be emptied by whoever runs the machine: wallets, LP positions, names.
- Ethereum's own plan for that day, Vitalik Buterin's 2024 "quantum emergency" hard fork, is a last resort: roll back, disable ECDSA transactions, and let users prove ownership another way. An emergency plan isn't a product, and nobody should be waiting for it.

**2. Privacy built on elliptic curves has an expiry date, and its data is already on chain.**
- Chain data is permanent. A stealth payment hidden today with secp256k1 Diffie-Hellman (ERC-5564's scheme 1) can be opened by whoever breaks secp256k1, at any point in the future. Every announcement ever made becomes linkable at once.
- That's "harvest now, decrypt later", and on a public ledger there is nothing left to harvest: it's all published.
- **Privacy that must still hold in ten years has to be post-quantum on the day the payment is made.**

**3. The cryptography is ready. Wallets aren't.**
- NIST standardized ML-KEM (FIPS 203) and hash-based signatures (SLH-DSA, FIPS 205) in August 2024.
- Published estimates of the hardware needed keep falling. Gidney (2025) puts RSA-2048 at under a million noisy qubits.
- Moving a user base takes years. **The cheapest time to move is before anyone has to.** Opaque lets people move now:
  - without leaving Ethereum;
  - without waiting for a fork;
  - without giving up MetaMask.

## What a quantum computer does to Ethereum

What breaks on the day elliptic-curve discrete logs become computable, and what Opaque puts in its place:

| What you hold | What protects it today | On that day | With Opaque |
|---|---|---|---|
| An EOA, or a smart account with an ECDSA or passkey (P-256) owner | Elliptic-curve signatures. The public key is on chain after the first signature. | The private key is recovered and the account emptied. | The account's only authority is a FORS+C key: `PQAccount` on Sepolia, `FramePQAccount` on the devnet. |
| A Uniswap LP position | The ECDSA key of the address that holds it | Removed by whoever recovers the key | `PQGuardHook`: a removal needs a FORS+C signature that names its recipient. |
| An ENS name | The owner's ECDSA key | Transferred, or pointed somewhere else | opaque.eth is held by `PQNameController`, which acts only on a FORS+C signature. |
| A note in a SNARK privacy pool (Tornado Cash's and Railgun's Groth16 proofs over BN254, for example) | Pairing-based elliptic-curve assumptions | A forged proof can pass, so a note can be withdrawn by someone who never deposited it. | A ZKBoo ring proof, built from hashes and AES-128 only |
| A secp256k1 stealth payment (ERC-5564 scheme 1) | secp256k1 Diffie-Hellman | Every announcement's shared secret is recomputed. Every payee, ever, is linked at once. | ML-KEM-768 (FIPS 203), on the same ERC-5564 and ERC-6538 contracts |
| What your RPC sees | Nothing: the provider sees your IP and every address you ask about | Not a quantum problem; it's already a leak. | EF's anon-rpc (the Nox mixnet) |

## What we built, live today

| You want to… | Opaque does it with… | Live on |
|---|---|---|
| **Pay privately** (USDC and ETH) | Pools of fixed-size notes. A hash-based ring proof shows you own one of 8 without saying which, sealed and carried by a three-hop relay mesh. ETH goes in as WETH notes, wrapped and deposited in one operation. | Sepolia, devnet |
| **Be paid privately** | **Post-quantum stealth addresses.** An ML-KEM-768 meta-address in [ERC-6538](https://eips.ethereum.org/EIPS/eip-6538)'s registry, with announcements on [ERC-5564](https://eips.ethereum.org/EIPS/eip-5564)'s Announcer. Each payment lands at a fresh FORS+C account only you can find, and the wallet sweeps it into your notes. | Sepolia |
| **Own a name** | **ENSv2.** opaque.eth is held by `PQNameController`, which acts only on a FORS+C signature. `name.opaque.eth` can be claimed only by post-quantum accounts, and it then labels your account in the wallet. | Sepolia |
| **Swap and provide liquidity** | **Uniswap v4 hooks.** Pools only post-quantum accounts can use, plus `PQGuardHook`, a FORS+C second factor that protects *any* LP's position, MetaMask's included. | Sepolia (Uniswap's v4), devnet |
| **Keep MetaMask** | **The Q-Day vault.** Your ECDSA key puts money in, and only your FORS+C key takes it out. | [Sepolia](https://www.opaque.credit/sepolia/vault) |
| **Use any dapp** | **Connect with Opaque.** An EIP-6963 provider, so dapps list Opaque beside MetaMask. Every transaction is approved in Opaque and signed by the post-quantum account. | [Sepolia](https://www.opaque.credit/connect-opaque) |
| **Read without being watched** | **EF's anon-rpc** (the Nox mixnet): always for ENS, and for the whole account with one switch. | Sepolia |
| **Leave without us** | **Exitable pools.** Every note can leave its pool with every Opaque server down: announce, wait, reveal, and AES-128 on chain recomputes the note. It runs through anon-rpc and a public bundler. | Sepolia |
| **Sign with nothing but a hash-based key** | **EIP-8141 frame transactions.** The account checks FORS+C in its VERIFY frame and pays for itself, in 76,430 gas, under the public mempool's 100k budget. No bundler, no paymaster. Accounts are created with no signature at all. | [Devnet](https://www.opaque.credit/testnet/devnet) |
| **See what you did** | **Activity.** Private payments, names, swaps, deposits, public sends and make-private, in the browser. A name claimed earlier is found again from `OpaqueNames`' `Claimed` event, read through anon-rpc. | Sepolia, devnet |

On Sepolia, each action is a UserOperation signed by the account's FORS+C key; the bundler only carries it. On the EIP-8141 devnet, the transaction itself is post-quantum.

## The life of a private payment

What happens, in order, when you pay 5 tUSDC privately on Sepolia. Every step names the file that does it.

```mermaid
sequenceDiagram
  autonumber
  participant W as Wallet (your browser)
  participant R as 3 of 6 relays
  participant E as Egress (last hop)
  participant T as Attester (FORS+C key)
  participant S as Settler
  participant P as PrivatePool + ExitableRingVerifier
  W->>W: pick the note, 7 decoys from the pool's own Deposited logs, sort the ring
  W->>W: ZKBoo proof in a Web Worker (1.08 MiB, 219 repetitions)
  W->>R: about 35 chunks, each in 3 ML-KEM-768 onion layers
  R->>E: relay 1 knows your IP, not the payment; relay 3 knows the payment, not your IP
  E->>T: the reassembled spend
  T->>T: verify the proof (2.0 s), sign an attestation with its own FORS+C key
  T->>S: the attested spend
  S->>P: spend(ring, nullifier, recipient, attestation)
  P->>P: attester's signature consumed in PQKeyRegistry, ring members real, nullifier fresh
  P-->>W: one 5 tUSDC note paid to the recipient. Your account sent nothing.
```

1. **Keys.**
   - One 12-word recovery phrase draws every chain's keys ([`wallet-keys.ts`](frontend/src/lib/wallet-keys.ts)).
   - The phrase never leaves the browser. With a wallet password, every secret record is sealed under a random data key that the password wraps with PBKDF2: the phrase, note secrets and payment history. The wallet locks after 15 idle minutes ([`lock.ts`](frontend/src/lib/lock.ts)).
   - The account's address is CREATE2 on its first key, so it's known before the account exists; its first UserOperation deploys it.
2. **Deposit.**
   - One UserOperation signed with FORS+C (9,251 bytes) approves the token and deposits any number of notes.
   - A note is a 16-byte secret `S`. The pool stores only `commitment = AES-128(S, noteBlock)`, where `noteBlock = keccak256(NOTE_DOMAIN, poolId, denomination)[0..16]`.
   - For ETH, the same operation calls WETH's `deposit{value}` first ([`runtime.ts`](frontend/src/lib/runtime.ts) `depositEth`).
3. **The ring.**
   - The wallet reads the pool's `Deposited` events (no indexer), takes its own note and 7 others, and sorts the 8 ascending, so the order can't reveal which one is real.
   - Every pool was seeded with 8 deposits whose secrets nobody keeps.
4. **The proof** ([`backend/zk`](backend/zk/README.md)). ZKBoo (MPC-in-the-head), run in a Web Worker. It proves knowledge of an `S` such that:
   - `AES-128(S, noteBlock)` is one of the 8 commitments;
   - the nullifier is `AES-128(S, nullBlock)`;
   - and it doesn't say which of the 8.

   Its Fiat-Shamir challenge binds the verifier, pool, chain, denomination, recipient, payment context, ring and nullifier, so the proof can't be redirected. It uses 219 repetitions for 2⁻¹²⁸ soundness, is 1.08 MiB, and takes about 2.2 s to prove.
5. **Transport** ([`backend/mesh`](backend/mesh/protocol.md)).
   - The spend is cut into chunks of 32,640 bytes, about 35 per payment.
   - Each chunk is wrapped once for each of three hops, chosen from six relays: ML-KEM-768 to the hop's key, HKDF-SHA-256, then AES-256-GCM with the routing header as associated data.
   - Every layer carries its own random 16-byte id, so the relays share no identifier to join their logs on.
   - The payload is padded to a fixed class, so a payment and a query are byte-identical at every hop.
6. **Attestation.**
   - The egress reassembles the spend, and the attester verifies the proof in about 2 s.
   - It then signs an attestation with **its own FORS+C key**, registered in `PQKeyRegistry`. That key rotates itself before its uses run out.
7. **Settlement.**
   - The settler sends `pool.spend`.
   - `AttestedRingVerifier`'s path in `ExitableRingVerifier` consumes the attester's signature through the registry.
   - `PrivatePool` checks all 8 members are real deposits and the nullifier is unused, then pays exactly one denomination to the bound recipient.
   - The chain shows the settler sending it, never the payer.
8. **If the payee has stealth on.** The recipient is a one-time `PQAccount` (see stealth addresses under [The cryptography](#the-cryptography-layer-by-layer)):
   - both of its keys come from an ML-KEM-768 shared secret;
   - the announcement goes on ERC-5564's Announcer;
   - the payee's wallet finds it with the view tag, decapsulates it, and sweeps it into its own notes.
9. **If Opaque disappears.** `announceExit` → 300 s → `spend` with `EXIT_TAG ‖ S`. `AES128.sol` recomputes the commitment and nullifier on chain. The [EF page](partner-docs/ethglobal-mumbai/ethereum-foundation.md#c-your-money-leaves-without-us) has every check.

## The cryptography, layer by layer

Nothing below rests on factoring or discrete logs.

| Layer | Primitive | Size and cost | Why this one |
|---|---|---|---|
| **Account, attester, ENS controller and LP guard signatures** | **FORS+C**, a few-time hash-based signature over keccak ([`fors.ts`](packages/pq-wallet/src/fors.ts)). FORS is the few-time layer inside SLH-DSA (FIPS 205). A key is `k` Merkle trees of height `a`; a signature reveals one leaf and its path in each tree. | **Sepolia:** k=32, a=8; 9,251 bytes; 32 uses per key. **Devnet:** k=13, a=13; about 5.9 KB; 8 uses per key. About 140 ms to sign. | It's keccak only, so the EVM checks it as a loop of hashes: 260k gas (`ForsVerifier`, k=32 a=8), or 53.6k (`LeanFors`, k=13 a=13). It's few-time, so every use is counted, locally and on chain (`PQKeyRegistry.consume`). Each key commits to its successor in advance, and the wallet rotates before the budget runs out. |
| **Ring proof** | **ZKBoo**: MPC-in-the-head over an AES-128 circuit, made non-interactive with Fiat-Shamir ([`zkboo.ts`](backend/zk/zkboo.ts)) | 1.08 MiB; 219 repetitions, so `(2/3)^219 < 2⁻¹²⁸`; 39,264 AND gates per repetition; 2.2 s to prove, 2.0 s to verify | Hashes and a block cipher only, with no trusted setup. AES-128 rather than keccak as the one-way function: about 5,760 AND gates per call against keccak's 38,400, the same reasoning as Picnic's. |
| **Note commitments and nullifiers** | **AES-128** under the note secret, over pool-bound blocks derived with keccak | 16 bytes, right-padded into `bytes32` | The same function the proof proves, and [`AES128.sol`](contracts/src/opaque/lib/AES128.sol) recomputes it on chain for the exit. The nullifier binds the secret and the pool, never the recipient, so one note can't be spent once per recipient. |
| **Transport** | **ML-KEM-768** per hop, HKDF-SHA-256, AES-256-GCM ([`transport.ts`](backend/mesh/transport.ts)) | 1,185 bytes per layer; padding classes of 4, 16 and 64 KiB | There's no X25519 anywhere in the path. ML-KEM-768 comes from `@noble/post-quantum`, because Node 22 and browsers have none. |
| **Stealth addresses** | **ML-KEM-768** (FIPS 203) on ERC-5564 and ERC-6538, scheme id `keccak256("opaque/v1/stealth/ml-kem-768/fors-c")` ([`stealth.ts`](backend/chain/stealth.ts)) | 1,184-byte meta-address, 1,088-byte ciphertext, a 1-byte view tag that skips 255 in 256 announcements | A quantum computer reading the announcements later can't recompute the shared secrets. The shared secret draws **both** FORS+C keys of the one-time account, because hash-based keys have no algebra to tweak. |
| **Reads** | **anon-rpc**: the Nox mixnet's worker, run only if its keccak matches the on-chain specifier, in a sandboxed null-origin iframe ([`anon-rpc.ts`](frontend/src/lib/anon-rpc.ts)) | About 1 s per read | An RPC or bundler answering through it sees the mixnet's exit, never the browser. |
| **Digests** | Length-prefixed keccak over a domain, the chain, the account, the scheme, the use count and `keccak(payload)` ([`Canonical.sol`](contracts/src/opaque/lib/Canonical.sol), [`digest.ts`](packages/pq-wallet/src/digest.ts)) | | A separator that can occur inside a field lets two inputs hash alike, so every field carries its length. Each action gets its own domain (`opaque/v1/ens/execute`, `opaque/v1/pq-wallet/action`), so a signature for one is never valid as another. |

## Architecture: the moving parts

| Part | Runs | Does | Trusted for |
|---|---|---|---|
| **Wallet**: web page, Chrome extension, PWA | Your browser | Keys, notes, proofs, onions, stealth scanning, the exit, the dapp provider | Everything: it's yours |
| **`PQAccount` + `PQKeyRegistry`** | Sepolia | An ERC-4337 v0.7 account. The registry holds the key's commitment, the next key's commitment and the use count. Only a FORS+C signature under the current key changes the key, with no owner, admin or upgrade path. | Nothing beyond the code |
| **`FramePQAccount` + factory** | EIP-8141 devnet | The account is its own validator, in its VERIFY frame. The factory creates accounts with no signature. | Nothing beyond the code |
| **`PrivatePool` + `ExitableRingVerifier`** | Sepolia, devnet | Custody of one note size, attested spends, and the exit | Nothing beyond the code |
| **Six relays** (three per path) | Railway | The onion hops | That no single relay links your IP to your payment, and no single one can |
| **Egress**, the mesh's last hop | Railway | Reassembles spends. Answers the wallet's chain reads and UserOperations, unless anon-rpc is on. Posts stealth announcements. | Liveness |
| **Attester** | Railway | Verifies ring proofs and signs attestations with its own FORS+C key | Soundness of private spends (see [Threat model](#threat-model-and-what-we-dont-claim)) |
| **Settler** | Railway | Sends `pool.spend` and pays its gas | Liveness only |
| **Faucet** | Railway | Test ETH and tUSDC, once an hour per address | Nothing |
| **Pimlico's public bundler** | Third party | Carries UserOperations | Nothing: it authorizes nothing |
| **anon-rpc (Nox)** | EF's mixnet | Carries reads and UserOperations | That the provider can't see your IP |

There's no indexer between the wallet and the chain: rings, notes and names are read from the contracts' own events.

## Partner tracks

### Uniswap v4: liquidity a quantum computer can't take

![Uniswap v4: the PoolManager calls each hook before liquidity changes and swaps; the hooks check that the real caller is a post-quantum account, and the guard pays a removal only to the recipient its FORS+C signature names](diagrams/uniswap.svg)

- **`PQAccountPoolHook`** (Sepolia, at Uniswap's own v4) and **`PQPoolHook`** (devnet) admit only post-quantum accounts.
  - **Flags `0xAA0`:** `beforeAddLiquidity`, `beforeRemoveLiquidity`, `beforeSwap` and `beforeDonate`.
  - **Who counts:** on Sepolia, an account is post-quantum by its code hash, the EIP-1167 clone of `PQAccount`. On the devnet, it's registered once by its CREATE2 address, so it stays admitted when its key rotates.
  - **`beforeSwap`** returns `(selector, 0, 0)`: no delta and no fee override, so a passing swap is exactly a hookless one.
  - **There's no `afterSwap`.** The gate belongs before the swap, and nothing needs doing after it.
- **`PQGuardHook`**, flags `0xB01`, is a FORS+C second factor for *any* LP:
  - `beforeAddLiquidity` binds a position to its funder's key;
  - `beforeRemoveLiquidity` verifies a signature over the recipient and a deadline, and keeps the recipient in transient storage;
  - `afterRemoveLiquidity`, with its return-delta flag, takes everything the removal released and pays only that recipient.
- **The real caller** is read through Uniswap's own PositionManager and Universal Router (`msgSender()`). Any other router counts as itself, so it can't name someone else.
- **On chain:**
  - an ECDSA wallet's swap through the Universal Router reverts with `NotPostQuantum(wallet)`;
  - the account's swap bought exactly the quote;
  - a cracked key's removal and a replayed signature are both refused with `BadSignature`.

→ [partner-docs/ethglobal-mumbai/uniswap.md](partner-docs/ethglobal-mumbai/uniswap.md): every callback, the flags bit by bit, the action bytes, errors, flows and addresses.

### ENS: names a quantum computer can't take

![ENSv2: opaque.eth's token, and every role with it, is held by PQNameController, which acts only on a FORS+C signature; OpaqueNames is its subregistry and resolver, and gives name.opaque.eth only to post-quantum accounts](diagrams/ens.svg)

- **No change to ENS was needed.** ENSv2 moves every role over a name with its ERC-1155 token (`PermissionedRegistry._update`). So opaque.eth was transferred to **`PQNameController`**, a contract whose only authority is a FORS+C key.
- **`execute`:** it calls out only on a signature over `("opaque/v1/ens/execute", chainId, controller, deadline, target, keccak(data))`, consumed once in `PQKeyRegistry`. Anyone may submit it, and paying for it authorizes nothing.
- **`OpaqueNames`** is opaque.eth's subregistry and resolver:
  - `name.opaque.eth` can be claimed only by a `PQAccount` (by code hash);
  - labels are 3–32 characters, one name per wallet;
  - it resolves `addr`, `addr(coin)` and ENSIP-10 `resolve`;
  - UniversalResolverV2 resolves through it unchanged, with ENSIP-11 coin `0x80000539` for the devnet.
- **The claim turns on stealth in the same signature,** so paying `name.opaque.eth` pays a fresh one-time account.
- **Every lookup goes through anon-rpc.**
- **On chain:** an ECDSA write to the resolver reverts, and the name's previous owner can no longer change it.

→ [partner-docs/ethglobal-mumbai/ens.md](partner-docs/ethglobal-mumbai/ens.md): the controller, the hand-over step by step, resolution, the wallet, errors and addresses.

### Ethereum Foundation: CROPS, anon-rpc and EIP-8141

![Ethereum Foundation: an EIP-8141 frame transaction validated by FORS+C alone in its VERIFY frame; an exit that needs no Opaque server; and post-quantum stealth payments with reads through anon-rpc](diagrams/ethereum-foundation.svg)

- **S: a transaction signed by FORS+C alone (EIP-8141).**
  - `FramePQAccount.verify` copies the signature with `SIGDATACOPY`, recovers the key with `LeanFors` and approves execution and payment.
  - The protocol nonce counts the key's uses, because a VERIFY frame can't write storage.
  - It runs in 76,430 gas against `MAX_VERIFY_GAS` = 100,000. The audited verifier needs 167k, so we rewrote its loop in assembly: 53.6k, held to the original on 1,024 fuzzed tamperings.
  - `FramePQAccountFactory` creates accounts with no signature at all: it is the transaction's sender and pays.
- **C: your money leaves without us.** `ExitableRingVerifier` puts beside the attested path a way out that needs nobody:
  - `announceExit(nullifier, keccak(S, paymentContext))` binds the payout and closes the note's private path (`NoteIsExiting`);
  - after `exitDelay`, `spend` reveals `S` and `AES128.sol` recomputes the note on chain;
  - the wallet does it through anon-rpc and a public bundler, with every Opaque host blocked.
- **P: who was paid is hidden, even later.** ML-KEM-768 stealth on the standard ERC-5564 and ERC-6538 contracts.
- **P: who paid is hidden.** The ring proof, the three-hop mesh, and a pool that pays.
- **anon-rpc:** ENS always, and the whole account with one switch, answered in the browser by the same code our egress runs.
- **O: Apache-2.0.** Every contract, the wallet, the extension and the stack build from this repository.

→ [partner-docs/ethglobal-mumbai/ethereum-foundation.md](partner-docs/ethglobal-mumbai/ethereum-foundation.md): CROPS letter by letter, the exit's every check, stealth, frame transactions and addresses.

## Hard problems we solved

| Problem | What we did |
|---|---|
| EIP-8141 caps validation at **100,000 gas** for every sender, and the audited FORS verifier needs 167k. | We wrote [`LeanFors`](contracts/src/ethereum/frame/LeanFors.sol): the same function with its hot loop in assembly, reading the signature from memory, where `SIGDATACOPY` puts it. It costs **53.6k**, and a VERIFY frame 76,430. It's held to the original: the same commitment on both fixtures, the same verdict on 1,024 fuzzed tamperings, the same reverts. |
| A VERIFY frame **can't write storage**, so it can't count a few-time key's uses. | The protocol nonce is the use counter. Each key covers a window of nonces, and `rotate(next)` runs from the account's own SENDER frame. |
| A **1.08 MiB proof can't go on chain**: its calldata alone is about 18M gas, and verifying it about 270M. | Verify it off chain, attest with a FORS+C key, and enforce everything else on chain. Then add an **exit** that needs no attester, so the attester can't hold notes hostage. |
| The exit reveals the note's secret, so it could be **raced**. | Announce first: `claim = keccak(S, paymentContext)` binds the payout without revealing `S`. An announced nullifier can't be spent privately (`NoteIsExiting`). A racer would need an announcement `exitDelay` old for a secret they hadn't seen. |
| **Hash-based keys can't be tweaked** the way elliptic-curve stealth keys are. | The ML-KEM shared secret draws both FORS+C keys of a fresh one-time account. The payer briefly holds them too, so the wallet sweeps as soon as the payment lands. |
| v4's periphery **hides the real caller** from a hook. | The hooks ask Uniswap's own PositionManager and Universal Router for `msgSender()`. Any other router counts as itself. |
| A hook's permissions **are its address**. | We mined CREATE2 salts for `0xAA0` and `0xB01`, and each constructor reverts if its address has the wrong bits. |
| ENSv2's roles **move with the token**. | Hold the token in a contract whose only authority is a FORS+C key. No ENS change was needed. |
| The devnet's ethrex **refuses `eth_call` from a contract** and takes no state overrides, so a v4 swap can't be simulated. | Quote from PoolManager storage (`extsload`) with v4's swap-step math. It matches the router to the unit. |
| The alt mempool sometimes **drops a transaction it accepted**. | FORS signing is deterministic, so the wallet re-broadcasts the *same bytes* to the gateway and the miner until mined. No key signs twice for one nonce. |
| A crash between signing and sending could make a few-time key **sign twice**. | A reservation is committed before a signature exists. A crash burns that index, and local and chain counters are never reconciled downward. |
| Pimlico prices Sepolia gas at about **1.15 gwei**, while the chain's own price is near zero. | Make private keeps 0.004 ETH back for gas, and a bundler refusal is explained in plain words. |

## The numbers

| | |
|---|---|
| FORS+C signature | 9,251 bytes (k=32, a=8); about 5.9 KB (k=13, a=13) |
| Signing | About 140 ms in Node; 231–313 ms in Chromium |
| On-chain FORS+C check | 260k gas (`ForsVerifier`, k=32 a=8) · 167k (k=13 a=13) · **53.6k** (`LeanFors`, k=13 a=13) |
| EIP-8141 VERIFY frame | **76,430** of 100,000 gas |
| Uses per key | 32 on Sepolia, 8 on the devnet, then a precommitted next key |
| Ring | 8 members, fixed note sizes |
| ZKBoo proof | 1.08 MiB, 219 repetitions, 2⁻¹²⁸ soundness, 2.2 s to prove, 2.0 s to verify |
| Mesh | 3 hops of 6 relays, 1,185 bytes per layer, about 35 chunks of 32,640 bytes per payment |
| ML-KEM-768 | 1,184-byte key, 1,088-byte ciphertext |
| Exit delay | 300 s on Sepolia (days for a real pool) |
| anon-rpc read | About 1 s |
| Pools | Sepolia: 7 tUSDC (1, 2, 5, 10, 20, 50, 100) and 3 WETH (0.0005, 0.001, 0.005 ETH). Devnet: 7 pqUSDC. |
| Tests | 142 forge, 394 backend, six Playwright suites against the live chains |

## Deployment addresses

**Sepolia** (full map in [`deployments/eth-sepolia.json`](deployments/eth-sepolia.json)):

| Contract | Address |
|---|---|
| `PQKeyRegistry` (every FORS+C key) | [`0x8b47560d32bcda788ab5233ab2bda55204cacca3`](https://sepolia.etherscan.io/address/0x8b47560d32bcda788ab5233ab2bda55204cacca3) |
| `PQAccountFactory` / implementation | [`0xe5931be6e8ec9a689f96d4de767f73718bdab08f`](https://sepolia.etherscan.io/address/0xe5931be6e8ec9a689f96d4de767f73718bdab08f) / [`0x17fc96e5b93eb031b2db2aac415dd507ad932dbf`](https://sepolia.etherscan.io/address/0x17fc96e5b93eb031b2db2aac415dd507ad932dbf) |
| Exitable tUSDC pools (1 to 100) and WETH pools (0.0005, 0.001, 0.005 ETH) | 10 pools, listed under `pools` |
| `PQNameController` (holds opaque.eth) / `OpaqueNames` | [`0x4d4df91933bb30640908f5cd4a42e2cac546c131`](https://sepolia.etherscan.io/address/0x4d4df91933bb30640908f5cd4a42e2cac546c131) / [`0x01f3419d2c8747f6b72032caf21a02fd0db44a28`](https://sepolia.etherscan.io/address/0x01f3419d2c8747f6b72032caf21a02fd0db44a28) |
| `PQGuardHook` / `PQAccountPoolHook` (at Uniswap's v4) | [`0xd0cfd61eb5ef783f6d70ea83b58d2c87fc034b01`](https://sepolia.etherscan.io/address/0xd0cfd61eb5ef783f6d70ea83b58d2c87fc034b01) / [`0xa68b63f17fe7926812d8591247b5a718a7244aa0`](https://sepolia.etherscan.io/address/0xa68b63f17fe7926812d8591247b5a718a7244aa0) |
| `PQVault` (the Q-Day vault) | [`0x0316a466f3e14850a016883aa46b3d5187b9aeb0`](https://sepolia.etherscan.io/address/0x0316a466f3e14850a016883aa46b3d5187b9aeb0) |
| Stealth registry / Announcer (the standard ones) | `0x6538…6538` / `0x5564…5564` |

**EIP-8141 devnet, chain 1337** (full map in [`deployments/eth-devnet.json`](deployments/eth-devnet.json); explorer: [altmempoolexplorer.forshtat.com](https://altmempoolexplorer.forshtat.com)):

| Contract | Address |
|---|---|
| `FramePQAccountFactory` | `0xd254366DeE9D4D2dE2F11982cabEAF94a16a3e0C` |
| `PQPoolHook` | `0x3B288a191c20c0333c06E90b386b611d2AC3caa0` |
| Privacy pools | Seven pqUSDC pools, whose attester is itself a FORS+C frame account |

**The hosted backend:** relays, egress, attester and settler for each network, on Railway. The site is on Vercel at [opaque.credit](https://www.opaque.credit).

## Proof: run it yourself

| Check | Result |
|---|---|
| `cd contracts && forge test` | 142 passed, 1 skipped |
| `cd backend && npm test` | 394 passed |
| `scripts/e2e-sepolia.ts` (in `backend/`, with `node --use-system-ca`) | 33 checks in Chromium, against the live site and Sepolia: a private payment, a v4 swap, a name claimed and paid at a one-time address, the stealth sweep, anon-rpc, and **a note leaving its pool with every Opaque server blocked** |
| `scripts/e2e-sepolia-eth.ts` | 0.0015 ETH made private as 0.001 + 0.0005 notes in one operation, then sent privately. The payee holds exactly 0.0015 WETH, with no transfer from the wallet's address. |
| `scripts/e2e-eth-connect.ts` | 19 checks: the extension's provider found by EIP-6963, connected, a mined transaction, a rejection returned as 4001 |
| `scripts/e2e-vault.ts` | MetaMask's flow: register, deposit, the thief refused, a signed withdrawal |
| `scripts/e2e-devnet-private.ts` | From an account with no ETH: deposit, then a private payment in which every signature is FORS+C |
| `scripts/e2e-devnet-page.ts` | The devnet account's whole life: created with no signature, a FORS+C-only send, a v4 swap |

**Try it in two minutes:**
1. Open [opaque.credit/sepolia/app](https://www.opaque.credit/sepolia/app) and make a wallet (12 words, kept in your browser).
2. Tap **Get test funds** for tUSDC and gas. Auto-deposit makes the tUSDC into private notes.
3. Send privately, claim a name in **Names**, swap in **Swap**, and make ETH private under **Your funds**.
4. Open [/testnet/devnet](https://www.opaque.credit/testnet/devnet): the same recovery phrase on EIP-8141, where every transaction is signed by FORS+C alone.
5. Keep MetaMask at [/sepolia/vault](https://www.opaque.credit/sepolia/vault). Or install the extension and connect at [/connect-opaque](https://www.opaque.credit/connect-opaque).

**Run the whole site locally:** `cd frontend && npm install && npm run preview:site`, then open http://localhost:5174.

## Threat model, and what we don't claim

| Who | What they can see or do | What they can't |
|---|---|---|
| **A quantum computer, now or in 20 years** | Everything public | Forge a FORS+C signature, forge a ring proof, or open a stealth announcement |
| **Anyone reading the chain** | Deposits, the pool paying a recipient, note sizes | Which of the 8 notes paid, or that the payer's account took part |
| **One relay** | Its neighbours in the path | Join your IP to your payment: the first hop sees one, the last the other |
| **Opaque's whole mesh** (one operator, today) | Could correlate by timing | Spend your notes, or learn which note paid |
| **The attester** | Proofs, which hide the payer | A dishonest attester could approve a spend no proof supports, so it's trusted for soundness today. It can't stop you leaving: the exit doesn't need it. |
| **Your RPC and bundler** | Without anon-rpc: your IP and your account. With it: the mixnet's exit. | With anon-rpc on, link the queries to you |

- **One operator, for now.** Opaque runs all six relays and the attester. **Before mainnet, the relays will be run by multiple independent operators.** The exit already works without any of it.
- **Hash-based keys have costs.**
  - A signature is about 9 KB.
  - Each key signs a set number of times before it rotates.
  - A stealth payer holds the one-time account's keys until the payee sweeps, which the wallet does at once.
- **Amounts are public, and the anonymity set is the ring.** Notes have fixed sizes, and each one hides among 8, not the whole pool.
- **Timing isn't hidden.** A payment is about 35 chunks and a query is one.
- **anon-rpc's bootstrap** reads its specifier contract directly, once. An exit makes that one note public.
- **Testnet only.**
  - The new contracts are tested, not audited.
  - The audited ones deploy unchanged, and new behaviour lives in adapters.
  - A compromised wallet origin could take the keys, as with any web wallet. Without a wallet password, anything that can read the browser's storage can read the phrase.

## Repository map

Each partner's code has folders of its own, one per layer, and every folder has a README index. [partner-docs/ethglobal-mumbai/](partner-docs/ethglobal-mumbai/README.md) has the full list.

| Partner | Contracts | Tests | Backend | Wallet |
|---|---|---|---|---|
| **Uniswap** | [`contracts/src/ethereum/uniswap/`](contracts/src/ethereum/uniswap/README.md) | [`contracts/test/uniswap/`](contracts/test/uniswap/README.md) | [`backend/ethereum/uniswap/`](backend/ethereum/uniswap/README.md) | the Swap tabs in [`frontend/src/app.ts`](frontend/src/app.ts) and [`devnet.ts`](frontend/src/ethereum/devnet.ts) |
| **ENS** | [`contracts/src/ethereum/ens/`](contracts/src/ethereum/ens/README.md) | [`contracts/test/ens/`](contracts/test/ens/README.md) | [`backend/ethereum/ens/`](backend/ethereum/ens/README.md) | [`frontend/src/ethereum/ens/`](frontend/src/ethereum/ens/README.md), the Names tab in [`frontend/src/app.ts`](frontend/src/app.ts) |
| **Ethereum Foundation** | [`contracts/frame/`](contracts/frame/README.md), [`contracts/src/ethereum/frame/`](contracts/src/ethereum/frame/README.md), [`ExitableRingVerifier`](contracts/src/opaque/pool/ExitableRingVerifier.sol), [`AES128`](contracts/src/opaque/lib/AES128.sol) | `LeanFors.t.sol`, `ExitableRingVerifier.t.sol` in [`contracts/test/`](contracts/test/) | [`backend/ethereum/`](backend/ethereum/README.md) (`frame.ts`, `frame-tx.ts`, `devnet-stack.ts`), [`backend/chain/stealth.ts`](backend/chain/stealth.ts) | [`anon-rpc.ts`](frontend/src/lib/anon-rpc.ts), [`without-opaque.ts`](frontend/src/lib/without-opaque.ts), [`stealth.ts`](frontend/src/lib/stealth.ts) |

| Folder | What | README |
|---|---|---|
| [`contracts/src/ethereum/`](contracts/src/ethereum/) | Every Ethereum-only contract: uniswap, ens, vault, frame | [README](contracts/src/ethereum/README.md) |
| [`contracts/src/opaque/`](contracts/src/opaque/) | Shared with Arc: pools, `ExitableRingVerifier`, `AES128`, `PQAccount`, `PQKeyRegistry` | [README](contracts/README.md) |
| [`packages/pq-wallet/`](packages/pq-wallet/) | FORS+C in TypeScript, and the signer's never-sign-twice state | [README](packages/pq-wallet/README.md) |
| [`backend/zk/`](backend/zk/) | The ZKBoo ring proof over AES-128 | [README](backend/zk/README.md) |
| [`backend/mesh/`](backend/mesh/) | The ML-KEM onion mesh | [protocol](backend/mesh/protocol.md) |
| [`backend/ethereum/`](backend/ethereum/) | Deploys, on-chain demos, the devnet's frame transactions and stack | [README](backend/ethereum/README.md) |
| [`backend/chain/`](backend/chain/) | Shared EVM backend: the wallet's RPC through the mesh, stealth, the exit | [README](backend/README.md) |
| [`frontend/src/ethereum/`](frontend/src/ethereum/) | The devnet wallet, the dapp approval window, ENS in Send | [README](frontend/src/ethereum/README.md) |
| [`extension/`](extension/) | One extension for every chain, with Connect with Opaque (EIP-6963) | [README](extension/README.md) |
| [`partner-docs/ethglobal-mumbai/`](partner-docs/ethglobal-mumbai/) | Uniswap, ENS and EF, in detail | [README](partner-docs/ethglobal-mumbai/README.md) |
| [`docs/mumbai/`](docs/mumbai/) | The ETHGlobal Mumbai submission, the build plan, the ERC and anon-rpc drafts | [README](docs/mumbai/README.md) |

## Opaque on other chains

Opaque runs on one codebase across chains: a network is a deployments file and a build path.
- **[Arc](docs/arc.md):** private USDC payments, live on Arc mainnet (not yet audited) and testnet. It's the base the Ethereum build grew from.
- **[XRP Ledger](docs/xrpl.md):** XRP, RLUSD and USDC on testnet, built on Batch and Credentials.

## License

[Apache-2.0](LICENSE). The contracts, wallet, extension and stack all build and run from this repository alone.
