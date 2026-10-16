# Opaque on the XRP Ledger

Private XRP and RLUSD on the XRP Ledger, plus private access to XRPL dapps. Mainnet XRPL has no smart contracts, so a quorum of attesters checks Opaque's ring proofs off ledger and co-signs every payout. The ledger itself enforces the rest: Batch makes a payout all-or-nothing, and Credentials refuse a second spend of the same note.

Everything below runs against **XRPL testnet** today. Mainnet has no pools yet ([deployments/xrpl-mainnet.json](../deployments/xrpl-mainnet.json)).

Testnet pools ([deployments/xrpl-testnet.json](../deployments/xrpl-testnet.json)) all use notes of 1, 10 and 100, and each pool's issuer is checked at setup:

| Pool | Asset | Issuer controls |
|---|---|---|
| XRP | native | none |
| RLUSD | trust-line token, test issuer set up like Ripple's | can claw back, can freeze |
| USDC | trust-line token, test issuer set up like Circle's | can freeze, no clawback |
| tMPT | Multi-Purpose Token, AssetScale 2 | can claw back, cannot lock |

Setup refuses an issuer that charges a transfer fee, which would break fixed note sizes. It also refuses one that requires authorization, since that issuer could lock the pool out.

## How a payment works

1. **Deposit.**
   - From anyone: a Payment to the pool account with a one-time **destination tag** the wallet registered first. Sources include an exchange, MoonPay or a friend.
   - From your own account: a Payment with `DestinationTag 0` and `InvoiceID` set to the note's commitment. This names the depositor.
   - The pool counts `delivered_amount` and never `Amount`, splits it greedily into notes of 1, 10 and 100, and carries any remainder on the tag.
2. **Pay.** The browser builds the same 219-repetition ZKBoo ring proof as on Arc: "I own one of these 8 notes". The proof binds the recipient's account **and** tag. The spend is sealed to the CRE key and crosses the 3-hop mesh.
3. **Release.** The CRE decision is unchanged from Arc: it picks the moment, and "send now" goes at once.
4. **Settle.** Each attester checks, on its own:
   - the proof, at the pinned verifier;
   - that every ring member is a deposit **of that note size**;
   - that no credential exists yet for the nullifier;
   - that the recipient binding matches the account and tag being paid;
   - that the proposed Batch is exactly that payout: the pool's next sequence, a fee cap, a short validity window, no `NetworkID` from another network;
   - that the next signer list holds each attester's own next key.

   Then 2 of 3 multisign one Batch ALLORNOTHING: `CredentialCreate` (CredentialType = nullifier, never an Expiration), `Payment`, `SignerListSet` (the next keys).
5. **Evidence.** The payment is SETTLED only when the ledger shows the inner Payment succeeded and the credential exists.

**Single-use keys.** Every attester key, and every per-site regular key, signs one ledger's worth of transactions. The same transaction installs the next key, which the ledger knows only by its address (a hash of the public key). A quantum attacker therefore gets about one ledger close per key. That is protection by timing, not by mathematics, and the wallet says so.

**Per-site accounts (dapps).** The XRPL wallet makes one account per dapp origin, through the xrpl-connect adapter.
- **Funding:** a private payment from a pool, so the ledger's funded-by record names the pool.
- **Setup:** the master key sets a single-use regular key plus any trust lines, then disables itself.
- **`signAndSubmit`:** a Batch (INDEPENDENT) of [dapp tx, SetRegularKey(next)].
- **`sign`:** returns the dapp's transaction for it to submit, followed by a rotation.
- **`signMessage`:** uses the disabled master key, which proves the account but cannot move funds.
- **Close:** sends tokens back into their pools, then `AccountDelete` into the XRP pool under a fresh tag. Everything comes back as notes.

## Where the code is

| Path | What it is |
|---|---|
| [backend/xrpl/protocol.ts](../backend/xrpl/protocol.ts) | XRPL on the frozen §2 types. `chainId` = 2^64 + network id, `pool` = AccountID, recipient = keccak(account, tag)[0:20], nullifier ↔ CredentialType, commitment ↔ InvoiceID; XRP, token and MPT amounts. Browser-safe. |
| [backend/xrpl/pool.ts](../backend/xrpl/pool.ts) | The deposit log: a pure function of (payments in ledger order, tag table), plus ledger sync, tag registration and the nullifier check. |
| [backend/xrpl/batch.ts](../backend/xrpl/batch.ts) | The payout Batch, and `checkProposal`: what an attester refuses to sign. |
| [backend/xrpl/attester.ts](../backend/xrpl/attester.ts) | One attester: every check above, then a multisignature with its listed key. |
| [backend/xrpl/settlement.ts](../backend/xrpl/settlement.ts) | The coordinator the CRE settler delivers to: builds, collects the quorum, submits, reads evidence. |
| [backend/xrpl/keys.ts](../backend/xrpl/keys.ts) | Single-use key chains (attesters, per-site regular keys). |
| [backend/xrpl/site.ts](../backend/xrpl/site.ts) | Per-site accounts. Browser-safe; the ledger is injected. |
| [backend/xrpl/queries.ts](../backend/xrpl/queries.ts) | The `XRPL` mesh query (REGISTER_TAG, TAG_STATUS, NULLIFIER_SPENT, ONRAMP_URL, READ, SUBMIT), both ends. |
| [backend/xrpl/node.ts](../backend/xrpl/node.ts), [stack.ts](../backend/xrpl/stack.ts) | The XRPL backend, and the stack the wallet talks to. |
| [backend/onramp/moonpay.ts](../backend/onramp/moonpay.ts) | Signed MoonPay checkout URLs, from structured fields only. |
| [frontend/xrpl.html](../frontend/xrpl.html), [src/lib/xrpl-runtime.ts](../frontend/src/lib/xrpl-runtime.ts) | The XRPL wallet: Overview, Send, Receive (tag + Buy), Activity, Apps. |
| [frontend/xrpl-connect.html](../frontend/xrpl-connect.html), [src/lib/opaque-adapter.ts](../frontend/src/lib/opaque-adapter.ts) | The wallet popup and the xrpl-connect adapter dapps use. |
| [demo/xrpl-dapp](../demo/xrpl-dapp) | An ordinary dapp on xrpl-connect, used by the X3 check. |
| [deployments/xrpl.ts](../deployments/xrpl.ts), `xrpl-*.json` | Compiled-in pools; the network is chosen at build or boot time, never by a server. |

Changes to shared code, all additive:
- `protocol-types` gains the `XRPL` mesh query kind, and spend encoding is unchanged.
- The CRE settler's `attester` is optional: XRPL's quorum verifies the proof itself, and the settler carries the XRPL destination beside the spend.
- An intent now fails, instead of retrying forever, on a refusal raised before any broadcast: `NULLIFIER_SPENT`, or a non-retryable `SETTLEMENT_REVERTED`. The XRPL coordinator raises the second when its dry run of the Payment says the destination can never take it (no trust line, below the new-account reserve, missing a required tag).

## Running it

Run everything from `backend/` unless noted. Every script uses `--use-system-ca`, for the Sophos TLS proxy.

| Command | What it does |
|---|---|
| `npm run xrpl:setup [-- --force \| --add USDC \| --add MPT]` | Creates testnet pools and writes `deployments/xrpl-testnet.json`. Attester seeds and test-issuer seeds go in `backend/.stack/xrpl/` (0600, gitignored). |
| `npm run xrpl:stack`, then `cd frontend && npm run dev` | The wallet, at `/xrpl.html`. `MOONPAY_API_KEY` and `MOONPAY_SECRET_KEY` turn Buy on (sandbox; `MOONPAY_LIVE=1` for live). |
| `npm run test:xrpl` | Offline unit tests for the XRPL layer and the MoonPay signer. |
| `npm run spike` (repo root) | X0: Batch, Credentials and signer rotation on testnet. |
| `npm run xrpl:e2e` | X1: deposits, a private payment through every component, a reused note refused. |
| `npm run xrpl:e2e:receive` | X2: receive by tag, Buy, a partial payment credited by `delivered_amount`, an RLUSD payout. |
| `npm run xrpl:e2e:browser` | The wallet page in Chrome: receive, Buy (new tab), send; no request outside its origin and the stack. |
| `npm run xrpl:spike:sites` | X3 ledger mechanics: per-site account, DEX, AMM, NFT, key rotation. |
| `npm run xrpl:e2e:dapp [-- --close]` | X3 in Chrome: the demo dapp through xrpl-connect and the Opaque popup; `--close` also closes an account into notes (~20 min: the ledger keeps an account 256 ledgers). |
| `npm run xrpl:e2e:mpt` | X4: an MPT pool, with deposits in the token's own scale and a private payout to a holder. |

## Verified on testnet (17 October 2026)

| Check | Result |
|---|---|
| X0 spike | 12/12 |
| X1 e2e | 10/10 (payment settled ~14 s after release; proof 2.2 s) |
| X2 e2e | 11/11 (including a payout the destination cannot take: refused at once, the note left unspent) |
| Wallet page in Chrome | 6/6 (send settled 45 s after the click, proof built in the page) |
| Per-site spike | 7/7 |
| X3 dapp e2e | 12/12 |
| X3 dapp e2e with `--close` | 17/17 (an app account holding LP tokens is refused; a second app's account is deleted into the XRP pool and comes back as 8 private XRP) |
| MPT pool e2e | 4/4 (payout settled 16 s after release) |
| Unit tests | `test:xrpl` 15/15; backend 280/280 (including the settler's XRPL paths), protocol-types 16/16, ring-client 6/6, frontend 9/9, root 3/3; contracts `forge test` 97 passed, 1 skipped |

## Ledger facts this work established

- A failed ALLORNOTHING Batch records **none** of its inner transactions (`txnNotFound`), and the outer still says `tesSUCCESS`. Read the outcome from ledger state or from the inner Payment's own result.
- A reused nullifier's CredentialCreate is `tecDUPLICATE` (confirmed with `simulate`), and nothing in its Batch applies.
- Multisigned Batches from an account with a signer list work, and so does SignerListSet as an inner transaction.
- **`AccountSet asfDisableMaster` cannot run inside a Batch:** `tecNEED_MASTER_KEY`, because an inner transaction has no signature of its own. A per-site account therefore disables its master key in a separate transaction.
- A Batch needs at least 2 inner transactions (`temARRAY_EMPTY`).
- `AccountDelete` pays the remaining XRP to its `Destination` (with its `DestinationTag`), and the metadata's `delivered_amount` gives the amount. A pool that counts only `Payment` misses the XRP an app account sends when it closes; the first `--close` run failed on exactly this.
- xrpl.js types `ledger_entry` credentials with `credentialType`, but rippled wants `credential_type`.
- XRP-to-XRP partial payments are not allowed, so the partial-payment test uses a token.
- xrpl.js 5.3 bundles 2 MB of confidential-MPT WebAssembly. The wallet imports `ripple-address-codec`, `ripple-keypairs` and `ripple-binary-codec` directly; its XRPL page is 42 KB of script.
- **XRPL EVM sidechain:**
  - Mainnet (chain 1440000) runs Cancun opcodes and has EntryPoint v0.7. Testnet (1449000) has only EntryPoint v0.8.
  - Arc's PQ stack deploys on a fork of mainnet as it is: `contracts/script/deploy-xrpl-evm.sh`.
  - The contracts use no precompile.

## Not done, and why

- **Hosting.** One machine runs all six relays, all three attesters and the CRE stand-in, so they are one operator. Each is a deployment step, not a code change:
  - hosted relays via `MESH_CONFIG`;
  - one host and seed per attester (`createAttester` is already per attester);
  - the CRE workflow.
- **Mainnet pools.** These need new keys that never signed on testnet, real attester operators (3-of-5), and XRP for reserves.
- **MoonPay.** This needs a partner account (KYB). The RLUSD-on-XRPL currency code is still unconfirmed, so Buy is offered for XRP only. `walletAddressTag` is confirmed in MoonPay's docs.
- **WalletConnect `xrpl:0`.**
  - It needs a Reown project id.
  - It needs a decision: WalletConnect's relay is a third-party server, and the wallet page talks only to its own origin and Opaque's servers.
  - xrpl-connect dapps already reach Opaque through the adapter.
- **XRPL EVM deployment.** It needs the deployer key at forge's hidden prompt. On testnet, EntryPoint v0.7 must be deployed first, or the accounts moved to v0.8.
- **Cross-chain moves (NEAR Intents).** These are mainnet-only and move real money, so nothing here can test them.
- **Refunds.** A payment to an unregistered tag, or an InvoiceID deposit of the wrong size, is held, not credited, and never auto-refunded yet. A tag that ever received a payment can never be registered, so such a payment cannot be credited later by mistake.
- **Fees.** Each spent note keeps 0.2001 XRP (or 0.5 of a token). That is the nullifier credential's reserve, locked for good, plus the batch fee. A 1 XRP note therefore delivers 0.7999 XRP.
- **Credential authority.** As on Arc, the stand-in credential authority is contacted directly, not through the mesh, and sees the recipient binding. It is a placeholder for a real policy authority.
