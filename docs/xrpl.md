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

A transaction that shows its keys without rotating them is followed at once by the rotation alone. That covers a payout Batch that was refused, expired, or validated with its inner transactions failed, and the same for a per-site Batch or a failed close. A shown key is never left listed. X2 checks this on testnet, with a payout that fails on the ledger itself.

**Per-site accounts (dapps).** The XRPL wallet makes one account per dapp origin, through the xrpl-connect adapter.
- **Funding:** a private payment from a pool, so the ledger's funded-by record names the pool.
- **Setup:** the master key sets a single-use regular key plus any trust lines, then disables itself.
- **`signAndSubmit`:** a Batch (INDEPENDENT) of [dapp tx, SetRegularKey(next)].
- **`sign`:** returns the dapp's transaction for it to submit within 5 ledgers (about 20 seconds), followed by a rotation. The key stays listed for that window, with its public key in the dapp's hands.
- **`signMessage`:** uses the disabled master key, which proves the account but cannot move funds. Its public key is on the ledger from setup, so a quantum attacker could forge messages from this account, though never payments. Signing with a regular key instead would break how dapps check a message (the key's address must equal the account's), so this stays until XRPL has post-quantum keys.
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
| [backend/xrpl/queries.ts](../backend/xrpl/queries.ts) | The `XRPL` mesh query (REGISTER_TAG, TAG_STATUS, NULLIFIER_SPENT, ONRAMP_URL, FAUCET on testnet, READ, SUBMIT), both ends. |
| [backend/xrpl/node.ts](../backend/xrpl/node.ts), [stack.ts](../backend/xrpl/stack.ts) | The XRPL backend, and the stack the wallet talks to. |
| [backend/onramp/moonpay.ts](../backend/onramp/moonpay.ts) | Signed MoonPay checkout URLs, from structured fields only. |
| [frontend/xrpl.html](../frontend/xrpl.html), [src/lib/xrpl-runtime.ts](../frontend/src/lib/xrpl-runtime.ts) | The XRPL wallet: Overview, Send, Receive (tag + Buy), Activity, Apps. |
| [frontend/xrpl-connect.html](../frontend/xrpl-connect.html), [src/lib/opaque-adapter.ts](../frontend/src/lib/opaque-adapter.ts) | The wallet popup and the xrpl-connect adapter dapps use. |
| [frontend/src/lib/walletconnect.ts](../frontend/src/lib/walletconnect.ts) | WalletConnect sessions, for dapps on any wallet SDK; their requests use the popup's approval card. |
| [backend/deploy/xrpl.Dockerfile](../backend/deploy/xrpl.Dockerfile) | The hosted service's image: the stack. |
| [frontend/vercel.xrpl.json](../frontend/vercel.xrpl.json) | The Vercel site's redirects and headers (`npm run deploy:xrpl`). |
| [demo/xrpl-dapp](../demo/xrpl-dapp) | An ordinary dapp on xrpl-connect, used by the X3 check and hosted at `opaque-xrpl-demo.vercel.app` (`npm run deploy`). |
| [extension-xrpl/](../extension-xrpl) | The browser extension: dapps that support GemWallet or Crossmark open Opaque. |
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
| `WALLETCONNECT_PROJECT_ID=… npm run xrpl:e2e:dapp -- --walletconnect` | X3 again, with the dapp on xrpl-connect's own WalletConnect adapter: its link pasted into Opaque, every socket policed. |
| `npm run xrpl:e2e:extension [-- <wallet> <dapp>]` | The extension in Playwright's Chromium: the hosted demo dapp's stock GemWallet and Crossmark adapters reach Opaque's popup (build it first: `cd frontend && npm run ext:xrpl`). |
| `npm run xrpl:e2e:accounts` | One wallet, an account per app: two origins get two accounts; the same origin by the popup, the extension and WalletConnect gets the same one; the ledger links neither to the other or to the user. |
| `npm run xrpl:smoke:hosted [-- <wallet> <service>]` | The hosted wallet in Chrome: boot against the compiled-in root, receive by tag, a private payment; nothing outside the wallet's origin and the service's. |

## Hosted (testnet)

The same split as Arc: the wallet on Vercel, the backend on Railway.

- **Site and wallet: `https://opaque-xrpl.vercel.app`**, the Vercel project `opaque-xrpl`. `/` is the one-page site ([frontend/site/](../frontend/site), plain JavaScript): a sticky scroll story played by the ring of eight on a canvas, with a still version for reduced motion. The wallet is `/testnet/xrpl.html`. Dapps use `/testnet/xrpl-connect.html`, which the adapter defaults to. `/app.html` goes to the Arc wallet on opaque.credit. Deploy from `frontend/` with `npm run deploy:xrpl`: a static build, with `vercel.xrpl.json` as its `vercel.json`, pointed at the service's `xrpl-stack.json`.
- **Backend: `https://opaque-xrpl-testnet-production.up.railway.app`**, the Railway service `opaque-xrpl-testnet` in the project `opaque`, next to the Arc services and sharing nothing with them. It runs `backend/xrpl/stack.ts`: relays, exit, attesters, the CRE stand-in (the mocked TEE) and the credential authority. Vercel can't host it: it is one long-running process with sockets, a volume and in-memory intents.
- **Mesh.** Its relay directories derive from `XRPL_MESH_MASTER` (its own secret, never Arc's), week by week from the genesis in `deployments/xrpl-testnet.json`, whose root the built wallet pins. The service exits at the end of each week and Railway restarts it into the next generation.
- **Attesters.** `XRPL_ATTESTER_SEEDS` brings the seeds that own the pools' signer lists, on first boot only. After that, `backend/.stack` on the service's volume is the record: key positions, receive tags and the CRE stand-in's intent key. Losing that volume would lose registered tags, so it must stay.
- **Deposit** (the Receive flow, renamed) makes a fresh tag. On testnet it also offers "Deposit 95 test XRP from the faucet": the `FAUCET` query, through the relays, has a fresh faucet account pay the tag, so a visitor needs no test XRP of their own.
- Wallet pages are served with `frame-ancestors 'none'`, so the approval popup can't be framed and clicked through. The page talks to its own origin and the service only.
- **Demo dapp: `https://opaque-xrpl-demo.vercel.app`**, the Vercel project `opaque-xrpl-demo`: the X3 dapp, trading against the testnet RLUSD AMM and minting its own NFT, with buttons for Opaque's adapter and for xrpl-connect's stock GemWallet and Crossmark adapters.
- **Still one operator.** Six relays, three attesters and the CRE stand-in run in one process on one provider, and its credential authority issues to anyone. Testnet only.
- **Two operators share the pools.** A laptop's `xrpl:*` e2e scripts use the same seeds as the hosted service. Both can pay out, and a race costs only a retry. A laptop that falls more than 64 rotations behind won't find its keys (the search window).

Set up, from the repo root; secrets go over stdin, never argv:

```bash
railway link -p beddfe7a-a579-4a22-99fd-fa27fcf0f5d2 -e production
railway add --service opaque-xrpl-testnet
S=opaque-xrpl-testnet
railway volume -s <service id> add -m /app/backend/.stack
railway variable set RAILWAY_DOCKERFILE_PATH=backend/deploy/xrpl.Dockerfile PORT=8080 --skip-deploys --service $S
node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("backend/.stack/xrpl/attesters.json","utf8")).seeds.join(","))' \
  | railway variable set XRPL_ATTESTER_SEEDS --stdin --skip-deploys --service $S
tr -d '\n' < backend/.stack/xrpl/mesh-master | railway variable set XRPL_MESH_MASTER --stdin --skip-deploys --service $S
railway domain --port 8080 --service $S
railway up --detach --service $S     # again after every change: it is not connected to GitHub
```

`backend/.stack/xrpl/mesh-master` is the only copy of that secret off Railway. Keep it, or the directories can't be re-derived.

## The extension

For dapps that support GemWallet or Crossmark: [extension-xrpl/](../extension-xrpl) answers both wallets' page protocols in each page and hands every request to Opaque's adapter, so the same popup approves it. It holds no key and asks for no permission. Testnet only, and it answers as both wallets, so it shouldn't run beside a real GemWallet or Crossmark. Install and limits: [extension-xrpl/README.md](../extension-xrpl/README.md).

## WalletConnect

For dapps that don't load Opaque's adapter: any dapp on WalletConnect's XRPL methods, xrpl-connect's own WalletConnect adapter among them. The user opens Opaque's connect page (the wallet's **Apps** → **Connect an app**), scans the dapp's QR code with **Scan QR** or pastes its `wc:` link, and approves. Requests then appear on the same card as popup requests, while that page stays open. On by default on the hosted service (Reown project `ac0ee697…`).

- **Phone.** The wallet installs to a home screen (`xrpl.webmanifest`), so a phone can scan a desktop dapp's code. Notes live per browser: a phone holds its own, by deposit or from a backup. A request waits on the relay until the page is open again.
- **Scan QR** decodes camera frames on the page itself (jsQR, loaded only then); nothing about them leaves the device.
- **Other chains are refused first.** An app whose session wants another chain (an EVM app, or XRPL mainnet while Opaque is on testnet) is turned away before anything is asked or funded, and the page says which chains it wanted.

- **Relay.** The page's relay socket goes to `/v1/walletconnect` on the Opaque service, which tunnels it to Reown's relay byte for byte. The page talks to its own origin only, and Reown sees Opaque's server, never the user. Messages are end-to-end encrypted between the dapp and the page. The client is still given Reown's relay URL, because the relay checks that its auth token names that URL as audience; only the socket is pointed at the tunnel.
- **Verify.** Reown's check that the dapp is the site it claims goes through `/v1/wc-verify` the same way. A VALID dapp shares the account its origin has through the popup. Anything else gets an account of its own, and the card says the address is unverified. A known scam is refused.
- **Methods.**
  - `xrpl_signTransaction`: `submit` (the default) is signAndSubmit, with the key rotating in the same Batch; `submit: false` is sign only. Opaque always fills Sequence, Fee and LastLedgerSequence itself.
  - `xrpl_signTransactionFor` is refused, because no site account is anyone's multisigner.
  - There is no message signing over WalletConnect.
- **Telemetry** is off. The library (`@walletconnect/sign-client` 2.25.0, pinned) loads only when used.
- **Turn it on elsewhere:** set `WALLETCONNECT_PROJECT_ID` (a Reown project id, which is public) on the service and redeploy. Locally, set it with `PORT`.

## Verified on testnet (17 October 2026)

| Check | Result |
|---|---|
| X0 spike | 12/12 |
| X1 e2e | 10/10 (payment settled ~14 s after release; proof 2.2 s) |
| X2 e2e | 15/15 (including a payout the destination cannot take: refused at once, the note left unspent; and one that fails on the ledger itself: its signers' keys retired at once, the pool paying again under the new ones) |
| Wallet page in Chrome | 6/6 (send settled 45 s after the click, proof built in the page) |
| Per-site spike | 7/7 |
| X3 dapp e2e | 11/11 |
| X3 dapp e2e with `--close` | 17/17 (an app account holding LP tokens is refused; a second app's account is deleted into the XRP pool and comes back as 8 private XRP) |
| MPT pool e2e | 4/4 (payout settled 16 s after release) |
| One wallet, an account per app | 10/10 (two apps, two accounts, each funded by the pool in its own payout, 19 ledgers apart; app A by the extension and by WalletConnect got A's account again; neither history names the other; master keys off; the Apps tab lists exactly the two) |
| X3 over WalletConnect | 10/10 (xrpl-connect's own WalletConnect adapter, its link pasted into Opaque, the relay through the stack's tunnel: connect, a DEX trade, an AMM deposit, an NFT the dapp submits; no message signing over WalletConnect) |
| Scan QR, hosted | a WalletConnect code read from a (fake) camera in 1.2 s, the camera off again, pairing started |
| Extension, hosted wallet and demo dapp | 11/11 (as GemWallet: connect, a DEX trade, an NFT minted and submitted by the dapp, signMessage; Reject reaches the dapp as a refusal; as Crossmark: connect without a popup and a trade; reconnect after a reload without a popup) |
| Hosted, from outside (wallet on Vercel, service on Railway) | 6/6 (the built wallet verifies the hosted mesh against its compiled-in root; a deposit from the testnet faucet button, 95 XRP as 14 notes; a private payment settled 42 s after the click; no request or socket outside the wallet's origin and the service's) |
| Unit tests | `test:xrpl` 16/16; backend 280/280 (including the settler's XRPL paths), protocol-types 16/16, ring-client 6/6, frontend 9/9, root 3/3; contracts `forge test` 97 passed, 1 skipped |

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

- **Independent operators.** The hosted service runs all six relays, all three attesters and the CRE stand-in, so they are one operator. Each split is a deployment step, not a code change:
  - hosted relays via `MESH_CONFIG`;
  - one host and seed per attester (`createAttester` is already per attester);
  - the CRE workflow.
- **opaque.credit.** Its Vercel build comes from the original Opaque repo, so the XRPL wallet is its own Vercel project (`opaque-xrpl.vercel.app`) for now, and opaque.credit's picker lists XRPL as coming soon.
- **Mainnet pools.** These need new keys that never signed on testnet, real attester operators (3-of-5), and XRP for reserves.
- **MoonPay.** This needs a partner account (KYB). The RLUSD-on-XRPL currency code is still unconfirmed, so Buy is offered for XRP only. `walletAddressTag` is confirmed in MoonPay's docs.
- **Store apps.** The wallet installs from the browser; an App Store or Play build (the same code wrapped, with push for incoming requests) needs developer accounts.
- **XRPL EVM deployment.** It needs the deployer key at forge's hidden prompt. On testnet, EntryPoint v0.7 must be deployed first, or the accounts moved to v0.8.
- **Cross-chain moves (NEAR Intents).** These are mainnet-only and move real money, so nothing here can test them.
- **Refunds.** A payment to an unregistered tag, or an InvoiceID deposit of the wrong size, is held, not credited, and never auto-refunded yet. A tag that ever received a payment can never be registered, so such a payment cannot be credited later by mistake.
- **Fees.** Each spent note keeps 0.2001 XRP (or 0.5 of a token). That is the nullifier credential's reserve, locked for good, plus the batch fee. A 1 XRP note therefore delivers 0.7999 XRP.
- **Credential authority.** As on Arc, the stand-in credential authority is contacted directly, not through the mesh, and sees the recipient binding. It is a placeholder for a real policy authority.
