## Opaque: private, post-quantum payments

Private payments on Ethereum, Arc and the XRP Ledger. Money moves through shared pools of fixed-size notes:
- a hash-based ring proof shows you own one note of eight without saying which;
- a three-hop relay mesh hides who sent the payment;
- every app gets a fresh account of its own.

Keys are post-quantum: hash-based (FORS+C) on Ethereum and Arc, single-use on the XRP Ledger.

| Chain | Status | Start here |
|---|---|---|
| Arc | Live on mainnet (not yet audited) and testnet | The rest of this README |
| XRP Ledger | Live on testnet: XRP, RLUSD and USDC, built on Batch and Credentials | [docs/xrpl.md](docs/xrpl.md) |
| Ethereum | Live on Sepolia (private payments, `name.opaque.eth`, post-quantum stealth addresses, Uniswap v4 hooks, an exit that needs nobody) and on an EIP-8141 devnet | [docs/mumbai/PLAN.md](docs/mumbai/PLAN.md) |

**Post-quantum, today** ([opaque.credit/ethglobal-mumbai](https://www.opaque.credit/ethglobal-mumbai)):
- **Names:** `opaque.eth` on ENSv2 is held by a controller that acts only on a FORS+C signature; subnames can be claimed only by post-quantum accounts.
- **Stealth addresses:** an ML-KEM-768 meta-address in ERC-6538's registry, announcements on ERC-5564's Announcer ([`stealth.ts`](backend/chain/stealth.ts)).
- **Uniswap v4** ([`contracts/src/ethereum/uniswap/`](contracts/src/ethereum/uniswap/)):
  - `PQAccountPoolHook` (Sepolia) and `PQPoolHook` (EIP-8141 devnet): pools only post-quantum accounts can trade in or provide to. An ECDSA wallet's swap reverts with `NotPostQuantum`.
  - `PQGuardHook` (Sepolia): a FORS+C second factor for any liquidity provider, ECDSA wallets included. A removal needs a FORS+C signature naming its recipient, and the hook pays only that recipient, so a cracked ECDSA key can neither withdraw nor front-run.
  - Made and checked on chain by [`uniswap-sepolia.ts`](backend/ethereum/uniswap-sepolia.ts) and `frame-tx.ts pqpool`; the wallet swaps in the Sepolia pool.
- **Reads through a mixnet:** EF's anon-rpc (Nox) for ENS always, and for the whole account with one switch.

To run the whole site locally: `cd frontend && npm install && npm run preview:site`, then open http://localhost:5174 (the Sepolia wallet is at `/sepolia/app`). To run the XRPL wallet against a local stack: start `cd backend && npm run xrpl:stack`, then `cd frontend && npm run dev`, and open `/xrpl.html`. Contracts: `cd contracts && forge test`.

## CROPS

**New in this hackathon: C. Your money leaves without us.**
- **Before:** every withdrawal from an Opaque pool needed Opaque's attester to sign it, and every read and transaction crossed Opaque's relays and exit. If Opaque went away, or refused you, your notes were stuck in the pool.
- **Now (Sepolia):** each pool's verifier ([`ExitableRingVerifier`](contracts/src/opaque/pool/ExitableRingVerifier.sol)) keeps the private path unchanged and adds an exit that needs nobody:
  - the wallet announces the note's nullifier, bound to its payout;
  - after the pool's delay (5 minutes on Sepolia, days for a real pool), it reveals the note's secret;
  - the contract recomputes the note's commitment and nullifier with AES-128 on chain ([`AES128.sol`](contracts/src/opaque/lib/AES128.sol), checked byte for byte against the wallet's own derivation) and pays.
- **The wallet does this with every Opaque server unreachable.** Reads and UserOperations go to a public RPC and the public bundler through EF's [anon-rpc](https://ethereum.github.io/anon-rpc/) (the Nox mixnet), signed by the account's own FORS+C key ([`without-opaque.ts`](frontend/src/lib/without-opaque.ts)).
- **The proof:** [`backend/scripts/e2e-sepolia.ts`](backend/scripts/e2e-sepolia.ts) blocks every Opaque host and still takes a note out of its pool, end to end.

**Also new: P. Who was paid is hidden too, against quantum computers as well.**
- **Before:** the ring hid who paid, but the pool paid the recipient's own address in public. Anyone could list everything a wallet or a name received.
- **Now (Sepolia):** post-quantum stealth payments ([`stealth.ts`](backend/chain/stealth.ts)):
  - a wallet publishes one ML-KEM-768 key in the standard [ERC-6538](https://eips.ethereum.org/EIPS/eip-6538) registry, done in the same signature as claiming `name.opaque.eth`;
  - a payer encapsulates to it; the shared secret draws the keys of a fresh FORS+C account, which the pool pays, and the ciphertext goes on [ERC-5564](https://eips.ethereum.org/EIPS/eip-5564)'s Announcer;
  - the payee's wallet opens each announcement with its key and sweeps the payment into its own notes.
- **Why ML-KEM:** ERC-5564's secp256k1 scheme hides the payee today, but a quantum computer reading the announcements later recomputes every shared secret and links every payment. This scheme's cannot be.
- **The cost of hash-based keys:** an elliptic-curve stealth key is the payee's own key plus a tweak. FORS+C keys have no such algebra, so the payer also holds the one-time account's keys until the payee sweeps it. The wallet sweeps as soon as the payment lands, and shows which payments are final.
- **The proof:** the same e2e pays a wallet by name and checks that the pool paid a one-time address, that the wallet's own address received nothing, and that the wallet found the payment and swept it into notes.

**C: what users depend on, and what happens without it.**
- **What we run:** the site (opaque.credit; also the extension, and buildable from this repo), the relay mesh and its exit, the attester and the settler (Railway), and the test faucet.
- **If those go away or refuse you:**
  - private payments stop;
  - your notes still leave their pools through the exit above, with no server of ours;
  - the Arc and XRPL pools have no such exit yet (a pool's verifier is fixed when it is deployed).

**O: open source.**
- [Apache-2.0](LICENSE).
- Contracts, wallet, extension and stack all build and run from this repo alone.
- Our hosted stack's secrets (mesh master, attester keys) are ours. Anyone can run their own stack with their own keys.

**P: what each third party learns.**
- **Each relay:** one hop; never both you and your payment.
- **Our exit:**
  - answers reads and relays UserOperations;
  - never sees your IP (three hops away);
  - does see which account's state is read.
- **The attester:** the ring proof, not which of the 8 notes is yours.
- **The chain:** the payer is hidden among 8 deposits. The amount is public. The recipient is public too, unless it receives privately (stealth, above): then the chain shows a one-time address and a ciphertext.
- **Public RPCs and the bundler:** our exit's address, or the mixnet's (anon-rpc), never yours.
- **ENS lookups** in the wallet go through anon-rpc.
- **Leaks to know about:**
  - anon-rpc's bootstrap reads its network's specifier contract directly, once;
  - an exit makes that one note public, because its secret is revealed;
  - our exit posts stealth announcements and gives each one-time account the gas for its sweep, so it sees which one-time addresses exist, never whose they are;
  - the homepage and docs load Google Fonts (the wallet pages load nothing third-party).
- No analytics, no trackers.

**S: keys, data and trust.**
- **Keys:** FORS+C (hash-based, post-quantum), kept in the browser, sealed by the wallet password (PBKDF2 and AES-GCM).
- **The recovery phrase** never leaves the device. The optional passkey backup is encrypted on the device and stored on our server.
- **Trust in the attester:** a dishonest attester could approve a spend no proof supports, so it could drain a pool; it cannot learn who paid. The exit removes the need for the attester to get out, not to pay privately.
- **Contracts:** the new contracts (`ExitableRingVerifier`, `AES128`, `OpaqueNames`) are tested with forge, not audited. The audited contracts are unchanged.

The rest of this README is Opaque on Arc, which the other chains build on.

---

<div align="center">

<img src="frontend/media/logo.png" alt="Opaque — post quantum" width="420">


### Private USDC settlement for the quantum era

[![Settlement](https://img.shields.io/badge/settlement-USDC%20on%20Arc-FF7A18?style=flat-square)](https://arc.network/)
[![Chainlink](https://img.shields.io/badge/conditional%20release-Chainlink%20CRE-375BD2?style=flat-square)](partner-docs/chainlink.md)
[![The Graph](https://img.shields.io/badge/privacy%20coordination-The%20Graph-6747ED?style=flat-square)](partner-docs/the-graph.md)
[![Account](https://img.shields.io/badge/account-ERC--4337%20%2B%20FORS%2BC-FF7A18?style=flat-square)](packages/pq-wallet/)

**Opaque is a post-quantum private settlement rail for USDC, live on Arc mainnet. It keeps four
linkages out of the settlement trail: wallet identity, payment timing, RPC/query
activity, and IP origin—coordinating key, spend, network, and release privacy in
one system.**

[Launch Opaque](https://www.opaque.credit/app.html) · [Install extension](extension/README.md#install-from-the-zip) · [Architecture](#architecture) · [Partners](partner-docs/README.md)

![Opaque end-to-end architecture](diagrams/e2e.svg)

</div>

---

## Partner-wise READMEs
[The Graph](partner-docs/the-graph.md)
 · [Arc](partner-docs/arc.md)
 · [Chainlink](partner-docs/chainlink.md)

## The market gap

Most on-chain privacy systems protect only the final transaction. That leaves three earlier points of failure:

| Exposure | What breaks | Opaque’s answer |
|---|---|---|
| **Authorization** | A public elliptic-curve key can be harvested today and attacked later. | A FORS+C hash-based key controls an ERC-4337 smart account. |
| **Settlement** | A public transfer reveals the payer, recipient, and note linkage. | An eight-member hash-based MPC-in-the-head ring proves one eligible note was spent without naming it. |
| **Network origin** | RPCs and services can connect a wallet IP to a payment request. | Every wallet request uses a fresh three-hop ML-KEM onion path. |
| **Timing** | An immediate spend can be correlated with its funding event. | A confidential privacy window waits for stronger conditions or settles no later than the user’s deadline. |

**Our position:** Opaque is quantum-transition-ready private USDC infrastructure—not a privacy skin around a conventional wallet, and not a mixer that ignores network metadata.

## The confidential-payments market

Stablecoins are becoming the settlement layer for payroll, treasury movement,
merchant payouts, and cross-border value transfer. Those users need more than
a hidden calldata field: they need the payer’s authority, payment linkage,
execution time, and network origin to remain difficult to correlate.

Today’s confidential-payment options usually cover only one part of that
problem. A pool can hide the sending address while leaving RPC/IP metadata
visible; a conventional smart wallet can improve UX while retaining
elliptic-curve authorization; a privacy protocol can hide the transfer while
settling immediately into a predictable timing pattern. None provides one
coherent, post-quantum path from wallet authorization to network transport to
conditional settlement.

Opaque is built for that missing layer: **confidential USDC settlement that is
private at the key, transaction, timing, and network levels—and designed for
the day elliptic-curve cryptography can no longer be trusted.**

### Network-adaptive privacy

Opaque does not treat privacy as a fixed switch. As pool composition, relay
reliability, traffic occupancy, and operator diversity change, The Graph feeds
fresh public signals back into decoy ranking, Markov-chain route selection, and
conditional settlement. Each payment adapts to the network it is entering.

---

## The product in one payment

~~~text
USDC deposit → fixed-denomination private note → local 8-member ring
  → sealed payment → 3-hop relay mesh → confidential privacy policy
  → Arc pool settlement → fresh Graph signals for the next payment
~~~

<table>
<tr>
<td width="33%"><b>1. Own with a PQ key</b><br/>The browser creates a local FORS+C key. It authorizes an ERC-4337 account through <code>PQKeyRegistry</code>; no ECDSA owner can rotate or drain it.</td>
<td width="33%"><b>2. Spend among eight</b><br/>USDC becomes 1, 2, 5, 10, 20, 50, or 100 USDC notes. The wallet proves ownership of one same-value note among eight, locally.</td>
<td width="33%"><b>3. Release under conditions</b><br/>Recipient, threshold, and deadline are sealed to Chainlink CRE. It releases early only when public privacy conditions are strong, or at the user’s latest-settlement deadline.</td>
</tr>
</table>

### What a private payment does—and does not—reveal

| Public on Arc | Kept private from the chain, RPC, and ordinary backend |
|---|---|
| A deposit is attributable by design. | Which eligible deposit supplied the private spend. |
| Pool denomination and the recipient at final settlement. | Sender identity, selected decoys, payment key, privacy threshold, and deadline. |
| Aggregate relay health and pool events. | Wallet IP, direct Graph query, and relay path. |

---

## Architecture

<a id="architecture"></a>

### Architecture diagrams

| Diagram | What it covers |
|---|---|
| [End-to-end architecture](diagrams/e2e.svg) | Wallet → ring → relay mesh → Graph → CRE → Arc settlement. |
| [Wallet and account authority](diagrams/wallet.svg) | ERC-4337 account flow, FORS+C authorization, and key lifecycle. |
| [Ring proof and note spend](diagrams/proof.svg) | Same-denomination ring construction, proof, nullifier, and pool spend. |
| [Graph privacy feedback loop](diagrams/graph.svg) | Intelligence signals, decoy/routing decisions, and feedback from settlement. |
| [CRE + Arc settlement](diagrams/cre-arc.svg) | Confidential policy release and Arc contract settlement path. |

| Layer | Crux | Technical implementation |
|---|---|---|
| **Quantum-safe authority** | A future quantum attacker should not turn a published account key into control of the wallet. | ERC-4337 v0.7 smart account; FORS+C signatures verified through Solidity and PQKeyRegistry; pre-committed rotation and bounded key use. |
| **Private settlement** | A pool pays the recipient without naming which note in an eight-member same-denomination set was opened. | Hash-based MPC-in-the-head ring proof, local note vault, one fresh nullifier, membership checks, and a post-quantum attestation gate. |
| **Network privacy** | Infrastructure should not see who asked to pay. | Three ML-KEM-768 onion layers, AES-256-GCM payload protection, padding, batching, delay, and operator-diverse paths. |
| **Privacy coordination** | Privacy is a condition, not a toggle. | The Graph’s Arc intelligence layer indexes public pool and relay signals; the wallet selects the strongest eligible decoys locally, while Chainlink CRE evaluates the sealed threshold/deadline policy. |
---

## Partner integrations

| Partner | What is live | Why it is core |
|---|---|---|
| **Arc + Circle** | USDC settlement, USDC gas, ERC-4337 accounts, seven denomination pools, CCTP V2 entry from Sepolia. | The product is programmable private USDC on Arc—not a token adapter. |
| **Chainlink CRE** | Active opaque-confidential-release workflow in AWS Nitro; Vault DON secrets; 30-second confidentiality policy ticks. | CRE is the authority that can release a sealed payment under the payer’s conditions. |
| **The Graph** | Arc intelligence layer for wallet/CRE coordination, plus a typed Graph Client composition with an independent Arbitrum USDC context and Privacy Sentinel MCP. | It makes privacy adaptive across payments and gives judges a reusable, inspectable Graph product—not a one-off query. |

<div align="center">

[Arc + Circle details](partner-docs/arc.md) · [Chainlink CRE details](partner-docs/chainlink.md) · [The Graph details](partner-docs/the-graph.md)

</div>

---

## Live evidence

| Surface | Evidence |
|---|---|
| **Wallet** | [opaque.credit/app.html](https://www.opaque.credit/app.html) on **Arc mainnet**, [opaque.credit/testnet/app.html](https://www.opaque.credit/testnet/app.html) on testnet; the header picker switches · [browser extension](extension/README.md#install-from-the-zip), both networks |
| **Arc mainnet** | Chain ID 5042 · [Explorer](https://explorer.arc.io) · PQ wallet layer, relay directory and seven RING_8 pools (unaudited) · [deployment registry](deployments/arc-mainnet.json) |
| **Arc testnet** | Chain ID 5042002 · [Explorer](https://testnet.arcscan.app) · the same stack, for development · [deployment registry](deployments/arc-testnet.json) |
| **Graph** | Mainnet: [opaque-mainnet/v0.3.0](https://api.studio.thegraph.com/query/1760100/opaque-mainnet/v0.3.0) · Testnet: [opaque/v0.3.0](https://api.studio.thegraph.com/query/1760100/opaque/v0.3.0) |
| **Backend** | Mainnet: [stack.json](https://opaque-mainnet-production-28a9.up.railway.app/stack.json) · Testnet: [stack.json](https://opaque-testnet-production-b084.up.railway.app/stack.json) |
| **CRE** | Mainnet: `opaque-confidential-release-mainnet` (workflow ID 001ddf30986164a736dfd6488e3af33911f8a234c5dcf2d94116f1a905a3d4ba), its own Vault keys · Testnet: `opaque-confidential-release` (workflow ID 0032cd02054f1c9da93214b7984ec4fdfe965bb8f333d37339e2b3eb11b53b40) |
| **Privacy Sentinel** | Graph MCP server, self-hostable from [graph/sentinel](graph/sentinel) |
| **Contracts** | [Mainnet registry](deployments/arc-mainnet.json) · [testnet registry](deployments/arc-testnet.json), both checked against the chain by `backend/chain/test/deployments.test.ts` |

### Core contracts on Arc mainnet

| Contract | Address | Role |
|---|---|---|
| PQKeyRegistry | [0x33a9…2FAf](https://explorer.arc.io/address/0x33a9D3E188835e8287f55a1a8cB7bd6554eD2FAf) | PQ key registration, use budget, and rotation |
| PQAccountFactory | [0x5f8b…0206](https://explorer.arc.io/address/0x5f8bd9531A08b6c06eeB41d9f617038E38D40206) | Counterfactual ERC-4337 accounts, staked in EntryPoint v0.7 |
| RelayDirectory | [0x342c…D281](https://explorer.arc.io/address/0x342ced088848740B7B3885C70c5AE6368F79D281) | Relay identity and health events |
| PrivatePool, 7 pools (1–100 USDC) | [e.g. 10 USDC: 0xe3d1…9026](https://explorer.arc.io/address/0xe3d1C899d2700559403341dB5dC26577d2669026) | RING_8 note pools; all seven in the [registry](deployments/arc-mainnet.json) |

### Core contracts on Arc testnet

| Contract | Address | Role |
|---|---|---|
| PQKeyRegistry | [0x6eb5…8e8f](https://testnet.arcscan.app/address/0x6eb5b42373191121d31dfc4b5c8571c4eaf58e8f) | PQ key registration, use budget, and rotation |
| PQAccountFactory | [0x13be…b214](https://testnet.arcscan.app/address/0x13beaec42922e3f63fa0dbe5bba270edf46ab214) | Counterfactual ERC-4337 accounts |
| RelayDirectory | [0xcf58…6653](https://testnet.arcscan.app/address/0xcf588b5b8ab2fa11ccf28a5c0631da4269a36653) | Relay identity and health events indexed by The Graph |

---

## Security model, stated plainly

| Boundary | Enforced by | What it prevents |
|---|---|---|
| Account authority | PQKeyRegistry + PQ account validator | Conventional wallet key takeover and unauthorized rotation. |
| One spend per note | Pool nullifier state | Double-spending. |
| Ring eligibility | Pool membership validation | Synthetic/unknown decoy memberships. |
| Payment release terms | CRE envelope + MAC-bound decision | A backend altering recipient, privacy threshold, or deadline. |
| Route authority | Signed pinned relay directory | A Graph query inventing a relay identity or key. |
| Early release | Fresh, healthy Graph observations | Treating a stale or broken index as strong privacy. |

The current V1 proof verifier is split: the hash-based MPC-in-the-head proof is checked by the attester, while Arc enforces denomination, ring membership, one-time nullifier use, recipient binding, and the live post-quantum attestation. See the module contracts in [docs/interfaces.md](docs/interfaces.md).

---

## Repository map

~~~text
frontend/                  wallet + browser extension experience
packages/pq-wallet/        FORS+C signer and ERC-4337 SDK
packages/ring-client/      note vault and local decoy selection
backend/mesh/              ML-KEM onion transport, relay policy, Graph clamping
backend/zk/                hash-based MPC-in-the-head ring proof
backend/cre/               sealed intents, release policy, settlement
opaque-cre/                deployed Chainlink CRE confidential workflow
graph/                     Arc subgraph, Graph client, Markov and score policies
contracts/src/opaque/      accounts, registry, pools, verifier, relay directory
deployments/               Arc mainnet and testnet addresses, one JSON per network
diagrams/                  architecture diagrams used throughout this README
~~~

## Run and verify

Opaque uses **Bun** for package installation, scripts, and tests.

~~~bash
git clone https://github.com/minrawsjar/Opaque.git
cd Opaque

for dir in packages/protocol-types packages/pq-wallet packages/ring-client graph backend frontend; do
  (cd "$dir" && bun install)
done

(cd graph && bun test)
(cd backend && npm test)          # node --test; bun's runner is not compatible
(cd frontend && bun test)
(cd contracts && forge test)
~~~

Testnet is the default everywhere. Mainnet is chosen at build/boot time:
`OPAQUE_NETWORK=mainnet` (backend, scripts, subgraph), `VITE_NETWORK=mainnet`
(wallet build), `DEPLOYMENTS=arc-mainnet.json` (forge). See
[deployments/README.md](deployments/README.md).

For all implementation and deployment instructions, start at [docs/README.md](docs/README.md). For protocol interfaces, read [docs/interfaces.md](docs/interfaces.md).

---

<div align="center">

Built for Arc Microgrants 2026 · [Architecture docs](docs/README.md) · [Partner docs](partner-docs/README.md) · [Apache-2.0](LICENSE)

</div>
