# Handover: building Opaque for XRPL

> **Update, 17 October 2026: this file is history now.**
>
> - X0 to X3, and the MPT, USDC and sidechain parts of X4, are built and verified on testnet.
> - Read [docs/xrpl.md](docs/xrpl.md) first: the architecture, how to run every check, the results, and what is still open.
> - Out of date below:
>   - §3: `opaque/` is flattened into the repo root, not a submodule.
>   - §8: the code is in `backend/xrpl/`, `frontend/xrpl*.html` and `demo/xrpl-dapp/`, and imports Opaque by plain relative paths.
>   - §9: the spike is written and passes.
> - The rules in §2 still hold.

You are picking up a build that has been researched and planned, and barely started. Read this whole file before you touch code. Everything here was checked on 16 October 2026 unless it says otherwise.

## 1. Goal

Build **Opaque on the XRP Ledger**:

- private XRP and RLUSD (USDC and other XRPL tokens later);
- keys hardened against quantum attacks;
- private access to any XRPL dapp.

XRPL is the first target because XRPL Commons has offered Glow retro grants, The Aquarium incubator and a traditional grant, and because the money is there:

| Token on XRPL | Supply | Issuer controls |
|---|---|---|
| RLUSD | ≈1.047B | clawback on |
| USDC | ≈4.75M | can freeze, no clawback |

Opaque already runs on Arc mainnet (Circle's L1). This repo reuses its code wherever it can.

## 2. Rules from the user (follow exactly)

- **Commit as `Swarnim Raj <swarnim.raj78@gmail.com>`.** It's already set with `git config` in this repo and in `opaque/`. Never add `Co-authored-by` trailers or any AI attribution in commits, PRs or descriptions. Strip any trailer tooling adds.
- **Commit or push only when the user asks.** Nothing has been committed yet (see §3).
- **Lazy, minimal code.** Reuse before writing; shortest working diff; no speculative abstractions.
  - Non-trivial logic leaves one runnable check behind (a `node --test` file or an assert script).
  - Mark a deliberate shortcut with a `ponytail:` comment naming its ceiling.
- **Secrets:**
  - never print a secret or pass it on argv: `railway variable set KEY --stdin`;
  - never store a deployer key: it goes in at forge's hidden prompt;
  - mainnet keys are never shared with testnet. FORS keys are few-time, so a key that signed on one network must not sign on the other.
- **The user's network sits behind a Sophos TLS-intercepting firewall.**
  - Node may reject TLS: run with `--use-system-ca` (already in `npm run spike`).
  - publicnode RPCs fail certificate checks; for Ethereum use `eth.drpc.org`.
  - `curl` to `xrplcluster.com` and to `s.altnet.rippletest.net` / `s.devnet.rippletest.net` worked.
- **UX:** keep copy on the typical case ("usually seconds", not the worst case), and keep wallet popups to a minimum.
- **The wallet page talks only to its own origin and Opaque's servers.** The browser e2e fails on any other request. Third-party checkouts (MoonPay) open in a new tab.

## 3. Workspace state right now

```
/Users/swarnimraj/OpaqueXRPL          github.com/Opaque-wallet/opaque-wallet (public; renamed from OpaqueXRPL on 2026-11-05), branch main
├── LICENSE                           the only committed file (initial commit d44b2b1)
├── .gitmodules + opaque/             STAGED, not committed: submodule → github.com/minrawsjar/Opaque @ 4b29e07
├── package.json                      untracked: type module, node >=22.18, xrpl ^5.3.0, script "spike"
├── node_modules/                     xrpl 5.3.0 installed (published 2026-09-16)
└── HANDOVER.md                       this file, untracked
```

- `opaque/` is identical to the user's local checkout `/Users/swarnimraj/chaff` (same HEAD `4b29e07`).
- There is no `.gitignore` yet. Add one (`node_modules/`, `.env`, `*.env`) before the first commit.
- `backend/xrpl/spike.ts` does **not exist yet**. The previous session stopped while reading the xrpl.js Batch API (§9).

## 4. What Opaque is, and what to reuse from `opaque/`

**How a payment works on Arc:**
1. USDC is deposited into fixed-size notes (1, 2, 5, 10, 20, 50, 100), one pool per size.
2. To pay, the browser proves "I own one of these 8 notes" with a hash-only ZKBoo ring proof.
3. The payment is sealed to an enclave key and sent through a 3-hop ML-KEM relay mesh.
4. A Chainlink CRE workflow decides when to release it.
5. An attester verifies the 1.08 MiB proof off chain and signs with a FORS+C key.
6. The pool checks the ring members, the nullifier and the recipient, then pays.

Accounts are ERC-4337 with FORS+C hash-based keys (32 uses per key, automatic rotation).

| Reuse | Path in `opaque/` | Notes |
|---|---|---|
| Ring proof | `backend/zk` (`deriveCommitment`, `deriveNullifier`, `buildRingSpend`, `verifyRingSpend`) | ZKBoo, AES-128, 219 repetitions. Proof 1.08 MiB; prove 2.2 s, verify 2.0 s (measured). Only `poolId` and note size feed the statement, so an XRPL `poolId` works unchanged. Commitments and nullifiers are 128-bit, right-padded into bytes32. |
| Decoys and amount splitting | `packages/ring-client` (`selection.ts`, `greedy.ts`, `multi-note.ts`) | Selection is local; never ask a server to exclude your note. |
| Relay mesh | `backend/mesh` (`transport.ts`, `chunks.ts`, `client.ts`, `queries.ts`) | Each hop holds a message up to 250 ms plus up to 250 ms of random delay. A proof travels as about 35 chunks of 32,640 bytes. Add XRPL methods to the exit's WALLET_RPC allowlist (`backend/chain/wallet-rpc.ts`). |
| Sealing and release | `backend/cre` (`sealed-intent.ts`, `cre-release.ts`, `credential.ts`, `attest.ts`, `attester-keys.ts`, `simulator.ts`) | `cre-release.ts` is the release decision. `simulator.ts` runs it outside CRE, so the decision is portable. |
| FORS+C signer | `packages/pq-wallet` | Used for attester audit signatures on XRPL. XRPL L1 can't verify FORS on chain. |
| Wallet UI | `frontend/` (Vite, vanilla TS; `src/app.ts`, `src/lib/runtime.ts`, `note-storage.ts`, `backup.ts`) | Same page ships as the Chrome extension side panel. No inline scripts. |
| Deployment registry pattern | `deployments/index.ts` + one JSON per network | Addresses compiled in. The network is chosen at build time, never by a server. Add `xrpl-testnet.json` / `xrpl-mainnet.json`. |
| Frozen types | `packages/protocol-types` | Frozen: adding a chain field to `PoolScope` is a cross-team change. |

**Traps that are already known:**
- Keccak is `keccak_256` from `@noble/hashes/sha3.js`. Node's `sha3-256` is a different function.
- **The nullifier binds the note secret and the pool only, never the recipient.**
- ML-KEM comes from `@noble/post-quantum`, because Node has none.
- Tests: `npm test` in `opaque/backend` uses `node --test`; bun's runner is incompatible.

**Measured on Arc:**
- a private payment takes 33 s per note, and 82 s for four notes in four lanes;
- a FORS signature takes 231–313 ms in Chromium;
- most of a payment's time is the 30 s CRE cron tick (about 15 s average wait) and uploading the proof.

## 5. Verified XRPL facts

**Amendments on mainnet** (`feature` on xrplcluster.com):

| Status | Amendments |
|---|---|
| Enabled | BatchV1_1 (since 2026-10-09), fixBatchV1_2, Credentials, MPTokensV1, AMM, AMMClawback, Clawback, DeepFreeze, Escrow, TokenEscrow, PermissionedDomains, PermissionedDEX, PermissionDelegationV1_1, DynamicNFT |
| Voting | ConfidentialTransfer (XLS-96), SingleAssetVault, LendingProtocol, Sponsor, DynamicMPT |
| In no release | SmartEscrow (WASM), XLS-101 contracts |

- **No smart contracts on L1.** No MPT-DEX amendment is enabled.
- **Testnet** (`s.altnet.rippletest.net:51234`, wss `:51233`) has BatchV1_1, Credentials, PermissionedDEX and TokenEscrow. Devnet has everything, including Sponsor, Vault, Lending and ConfidentialTransfer.
- **Reserves and fees:** 1 XRP base + 0.2 XRP per object; base fee 10 drops. Ledger closes every 3–5 s.

**RLUSD issuer** `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`:
- `allowTrustLineClawback` true;
- `depositAuth`, `requireDestinationTag` and `disallowIncomingXRP` set;
- master key disabled.

**USDC issuer** `rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE`: no clawback, can freeze. Both tokens are trust-line tokens with transfer rate 0.

**Batch** (xrpl.org):
- **Shape:** modes `tfAllOrNothing` = 65536, tfOnlyOne, tfUntilFailure, tfIndependent; 2–8 inner transactions.
- **Each inner transaction** has `Flags` with `tfInnerBatchTxn` (1073741824), `Fee "0"`, `SigningPubKey ""` and no signature.
- **Sequences:** the outer transaction uses n and the inners use n+1, n+2…, or tickets.
- **Disallowed inside a Batch:** Vault* and Loan* transaction types.
- **Results:** the outer Batch returns tesSUCCESS even when its inners fail, so check each inner by hash, or check ledger state.
- **Signing:** BatchSigners are needed only for multi-account batches, and can be multisigned (Signers array). A single-account batch from the pool needs only the outer signature, and the outer tx can be multisigned.
- **Fee:** 2 × base, plus base per outer signature, plus the inners' base fees.

**CredentialCreate:**
- Issuer == Subject is allowed. CredentialType is 1–64 bytes, hex.
- A duplicate (same subject, issuer, type) gives **tecDUPLICATE**.
- **Never set Expiration** on a nullifier credential: an expired one can be deleted, and the note spent again.

**Other facts:**
- **Partial payments:** credit `meta.delivered_amount`, never `Amount`.
- **Memos** are limited to 1 KB per transaction. An ML-KEM-768 ciphertext is 1,088 bytes, so encrypted notes live off ledger with a hash on ledger.
- **Accounts:** an address is a hash of its public key, and the key is exposed only when it first signs.
- **AccountDelete** needs the account to be at least 256 ledgers old, burns 0.2 XRP as its fee, and accepts a DestinationTag.
- **XLS-96** (Confidential Transfers) is EC-ElGamal over secp256k1, not quantum-safe by its own docs, MPT-only and direct-payment only. Opaque's pitch covers what XLS-96 doesn't.
- **XRPL EVM sidechain:** chain 1440000, EntryPoint v0.7 on mainnet. Testnet 1449000 has only v0.8. XRP pays gas; there's no confirmed native USDC. Bridging is Axelar/Squid.

**Dapp connection: xrpl-connect 1.0** (maintained by XRPL Commons, https://xrpl-commons.github.io/xrpl-connect/):
- Adapter interface: `id`, `name`, `icon?`, `url?`, `isAvailable()`, `connect()`, `disconnect()`, `getAccount()`, `getNetwork()`, `sign(tx)` (returns hash, tx_blob, signature), `signAndSubmit(tx)` (returns hash), `signMessage(msg)` (returns message, signature, publicKey), and optional `on`/`off`.
- It has 9 built-in adapters, including Xaman, Crossmark, GemWallet, WalletConnect and Ledger.
- WalletConnect chain ids are `xrpl:0` (mainnet), `xrpl:1` (testnet) and `xrpl:2` (devnet).
- Dapps that only use Xaman's own servers can't reach another wallet.

**xrpl.js 5.3.0** (installed):
- **Types and flags:** a `Batch` type with `RawTransactions: [{RawTransaction}]`; `BatchFlags.tfAllOrNothing`; `GlobalFlags.tfInnerBatchTxn`.
- **`client.autofill(tx, signersCount)`** handles Batch:
  - `autofillBatchTxn` gives the first inner transaction from the outer account Sequence = next + 1 and increments from there;
  - it sets inner `Fee "0"` and `SigningPubKey ""`, and throws if they're set otherwise;
  - the fee sums the inner fees and adds `signersCount` × base.
- **Signing:**
  - `wallet.sign(tx, true)` makes one multisignature; `multisign([blobs])` combines them;
  - `signMultiBatch` and `combineBatchSigners` are for BatchSigners;
  - `hashSignedTx` accepts inner-batch transactions.

## 6. The design (approved)

Read the two research pages for the diagrams:
- XRPL build page: https://claude.ai/artifact/6wQ58CPsiTzqtiVpXxciAC
- Main research page, which covers every chain: https://claude.ai/artifact/VfVDy1JUdNWgZRzc5i7NKQ

Both open through the Artifact tool's `read` action. The approved multi-chain plan is `/Users/swarnimraj/.claude/plans/groovy-dazzling-cocke.md`. Its Stage 0 and Stage 1 are this work.

**Two homes**

| Home | Holds | Who checks proofs and keys |
|---|---|---|
| XRPL mainnet (L1) | the pools and all native XRPL features | the ledger can't check a proof or a FORS signature, so an attester quorum checks off ledger and co-signs payouts |
| XRPL EVM sidechain | dapps that need contract-checked post-quantum accounts | the Arc contracts, redeployed later (X4) |

**Pool account**: one per asset (XRP and RLUSD first, then USDC).
- Master key disabled; signer list = attesters (2-of-3 on testnet, 3-of-5 on mainnet).
- `asfRequireDest` on, so a payment without a tag is rejected. DepositAuth stays off so anyone can pay.
- Proposed note sizes: 1 · 10 · 100 · 1,000 per asset. Fewer sizes means bigger anonymity sets; tune with data.
- `poolId` for XRPL needs a new derivation, mirroring `opaque/contracts/src/opaque/lib/Canonical.sol`'s length-prefixed domain `opaque/v1/pool-id`, with an XRPL network id and the pool's AccountID instead of chainid and contract address. The denomination is bound in the zk statement as today.

**Deposit / receive**
- From your own account: a Payment with `InvoiceID` = commitment (it names the depositor).
- From anyone (exchange, MoonPay, friend): a Payment with a one-time random 32-bit `DestinationTag`.
  - The wallet registers `tag → [c1…cn]` with the attesters through the mesh.
  - The attesters credit `delivered_amount`, split it greedily into note sizes, and carry any remainder on that tag.
  - They refuse a tag that's already in use.
- The wallet invents the note secrets, so today's bearer notes work as they are.

**Spend**
1. The browser builds the existing ring proof.
2. The attesters check:
   - the proof (`verifyRingSpend` with the verifier id);
   - that all 8 ring members are in the pool's deposit log;
   - that no credential exists for the nullifier.
3. They multisign one Batch ALLORNOTHING:
   - `CredentialCreate` (Account = Subject = pool, CredentialType = nullifier hex, no Expiration);
   - `Payment` pool → recipient;
   - `SignerListSet` (the next single-use attester keys).
4. A batch holds at most 6 nullifiers, 1 Payment and 1 rotation.
5. Reusing a nullifier gives tecDUPLICATE, so nothing in the batch applies.

**Single-use keys (quantum resistance by timing)**
- Every attester signer key and every per-site regular key signs once.
- The same Batch rotates to a key known only by its hash, so an attacker gets about one ledger close per key.
- State this honestly as timing-based, not mathematical. FORS on the sidechain is the mathematical version.

**Per-site accounts (dapps)**

| Stage | What happens |
|---|---|
| Create | The pool pays ≥1 XRP, so XRPL's funded-by record names the pool. |
| Set up | The master key signs one Batch: `SetRegularKey`, AccountSet `asfDisableMaster`, any TrustSets. |
| Use | The dapp's transactions go through the mesh, in one of the three modes below. |
| Close | Leftovers and AccountDelete go to the pool with a fresh tag, so they become notes. |

The three signing modes:
- `signAndSubmit` = Batch [dapp tx, SetRegularKey(next)];
- `sign` = sign the dapp's tx as is, then rotate right after (needed for sign-only dapps, and for Vault/Loan txs, which can't go in a Batch);
- `signMessage` = the disabled master key (proves the account, can't move funds).

Dapps reach Opaque through an **Opaque xrpl-connect adapter**, offered upstream to XRPL Commons, plus WalletConnect `xrpl:0`.

**Onramp**
- Opaque never mints or sells. MoonPay sells XRP and RLUSD on XRPL (Transak is a fallback for RLUSD).
- The stack builds the checkout URL from **structured fields only** (asset, amount, pool address, tag) and signs it with HMAC-SHA256 (`node:crypto`, `MOONPAY_SECRET_KEY`). It never signs a caller-supplied URL.
- The wallet opens the URL in a new tab.
- To confirm in MoonPay's sandbox: the tag parameter name (likely `walletAddressTag`), and the RLUSD-on-XRPL currency code.
- Needs a MoonPay partner account (their KYB) first.

**Release / speed**
- Let "send now" payments, and those whose privacy score is already met, skip the enclave. That removes the 0–30 s CRE tick.
- Later, run `cre-release.ts` and the attester as Phala Cloud containers (Intel TDX, dstack KMS), deciding each payment as it arrives.
  - Pin the enclave key and image hash in the wallet build, after CI verifies the attestation.
  - Intel signs attestations with ECDSA, so they aren't quantum-safe; pinning protects against a forged one later.
  - TEE.fail (Oct 2025): someone with physical access and a DDR5 memory-bus tap can extract TDX keys, so spread attesters across providers.
- Estimates on XRPL after the fixes: private payment about 10–15 s; dapp action about 5–8 s; receive by tag about 5–7 s. A normal XRPL payment is 3–5 s. The mesh's 1.5–3 s stays on purpose.

**Costs in XRP**

| Item | XRP | Held or spent |
|---|---|---|
| Pool account | 1 | held |
| Signer list, each trust line or MPT holding | 0.2 each | held |
| **Each payout's nullifier credential** | 0.2 | locked for good, so charge a 0.2 XRP fee per payment |
| Per-site account | 1 + 0.2 per object | returned by AccountDelete |
| AccountDelete fee | 0.2 | spent |
| Multisigned Batch | under 0.001 | spent |

**Risks to keep visible**
- The attester quorum holds custody on L1.
- RLUSD can be clawed back from the pool; RLUSD and USDC can both be frozen. XRP can't.
- The 0.2 XRP per payment is locked for good.
- Batch is new.
- Unwanted or tainted inbound funds on a tag need a refuse-and-refund rule.
- Deposits from your own account name you.
- Several notes paid to one address can be linked back to the payer through their depositors.

## 7. Build order (each step has an exit check)

| Step | Ships | Passes when |
|---|---|---|
| **X0 testnet spike** | `backend/xrpl/spike.ts` | Reused nullifier gives inner tecDUPLICATE and its Payment is absent; the rotated signer list refuses old keys; the disabled master key is refused; a tagless payment to the pool is refused. |
| **X1 private XRP + RLUSD** | Pool accounts. Attester service (deposit log from `account_tx`, ring/nullifier checks, multisigned payouts). Wallet on xrpl.js through the mesh. Reused proof, ring client and release. | Deposit → note; a ring of 8 pays; a reused note is refused; the wallet page makes no outside requests. |
| **X2 receive by tag + Buy** | Tag registration via mesh; MoonPay signed URL; `delivered_amount` crediting with remainder carry. | A sandbox purchase, or a testnet payment with a tag (including a partial payment), ends as the right notes. |
| **X3 dapps** | Per-site accounts; Opaque xrpl-connect adapter; WalletConnect XRPL; the three signing modes. | DEX trade, AMM deposit and NFT purchase work from an xrpl-connect demo dapp; every regular key signs once; reserve returns as notes. |
| **X4 wider** | USDC and long-tail pools; MPT pools; Arc contracts on the XRPL EVM sidechain; cross-chain moves (NEAR Intents for XRP/ETH/SOL). | Sidechain FORS accounts pass Arc's tests; a cross-chain move lands as notes. |

## 8. Proposed layout for this repo

```
backend/xrpl/
  spike.ts        X0
  pool.ts         deposit log from account_tx, delivered_amount, tag table
  batch.ts        build + multisign the payout Batch
  attester.ts     proof, ring-in-log and nullifier checks (calls opaque/backend/zk)
  keys.ts         single-use key chains
backend/onramp/moonpay.ts
frontend/src/lib/xrpl/accounts.ts, adapter.ts
deployments/xrpl-testnet.json, xrpl-mainnet.json
opaque/           submodule; import its code by relative path (e.g. ../../opaque/backend/zk/index.ts)
```

## 9. Your first task: write and run the X0 spike

Write `backend/xrpl/spike.ts` (TypeScript, run directly by Node; `npm run spike`). It runs against **testnet** `wss://s.altnet.rippletest.net:51233`. Testnet XRP is free; it touches no real money.

1. **Fund P and R.** `client.fundWallet()` funds the pool P and a recipient R. Faucet amounts vary, so pay 1 XRP, not 10.
2. **Generate signer keys.** `Wallet.generate()` makes three sets: S1–S3, S4–S6, S7–S9. Signer keys need no funding.
3. **Set up P** with its master key:
   - SignerListSet (quorum 2, S1–S3, weight 1 each);
   - AccountSet `asfRequireDest`;
   - AccountSet `asfDisableMaster`, last.
4. **Batch 1**, from P, `Flags: tfAllOrNothing`:
   - inner txs: CredentialCreate {Account P, Subject P, CredentialType = 16 random bytes hex, no Expiration}; Payment P → R 1 XRP; SignerListSet → S4–S6;
   - `client.autofill(batch, 2)` (inner flags must include `tfInnerBatchTxn`);
   - set `SigningPubKey: ""`;
   - S1 and S2 each `wallet.sign(tx, true)`, then `multisign([...])`, then `submitAndWait`.
   - **Assert:** R +1 XRP; the credential exists (`ledger_entry` credential {subject P, issuer P, credential_type}); the signer list is S4–S6.
5. **Batch 2**: the same CredentialType, Payment 1 XRP, SignerListSet → S7–S9, signed by S4 and S5.
   - **Assert:** outer tesSUCCESS but the inners didn't apply: R's balance unchanged, the signer list still S4–S6, still one credential.
   - Try `tx` lookups on the inner hashes (`hashSignedTx`); expect them missing or failed.
6. **Old keys refused.** A multisigned AccountSet from S1 and S2 is rejected (tef…). The same from S4 and S5 succeeds.
7. **Master key refused.** A tx signed by P's master key gives tefMASTER_DISABLED.
8. **Tag required.** A Payment R → P with no tag gives tecDST_TAG_NEEDED.
9. **Report.** Print a pass/fail line per assertion, and exit non-zero on any failure.

If something fails, record exactly which rule broke and what rippled returned. The whole XRPL L1 design rests on steps 4–5. The two parts not yet proven anywhere are a multisigned Batch from an account with a signer list, and SignerListSet as an inner transaction. If either fails, the fallbacks are:
- tickets plus separate transactions (loses atomicity, so spends need a different nullifier guard);
- or the XRPL EVM sidechain (the Arc contracts almost unchanged).

## 10. After X0 passes

- Add `.gitignore` and a README using the GitHub About text:
  > Private XRP and RLUSD on the XRP Ledger. Hash-based ring proofs, one-time-tag receiving, single-use keys against quantum attacks, and a fresh account for every XRPL dapp. Built on Batch and Credentials, no smart contracts needed.
- Ask the user before the first commit or push.
- Then start X1 with `deployments/xrpl-testnet.json` and `backend/xrpl/pool.ts`.
