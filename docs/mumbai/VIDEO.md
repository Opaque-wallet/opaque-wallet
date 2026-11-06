# The demo video: script

For recording the ETHGlobal Mumbai video. **Four minutes.** Three parts: the problem, the architecture, the demo. Every number below is checked against the repo; read the voiceover as written, or close to it.

**Opaque is a layer, not a wallet.** Say "Opaque" for the layer. Say "the Opaque wallet" only while that app is on screen, and never as what Opaque is.

## The one sentence

**Opaque is the post-quantum security layer for Ethereum.**
- It moves everything ECDSA guards today to hash-based keys: accounts, payments, ENS names, Uniswap liquidity and any protocol's admin keys.
- It makes payments private.
- The wallet is one way in; MetaMask users, LPs and any protocol plug in without switching.

## The 15-second version (a lightning intro)

> "Every Ethereum key that has ever signed is already exposed to a quantum computer. Opaque is the layer that moves what those keys guard to hash-based keys: accounts, payments, ENS names, Uniswap liquidity, any protocol's admin key. Keep MetaMask, keep your protocol; plug in. On the EIP-8141 devnet, a transaction is signed by a hash-based key alone, in 76,430 gas. Live now."

## Timing

| Part | Time | Length |
|---|---|---|
| 1. The problem | 0:00–0:30 | 30 s |
| 2. The architecture | 0:30–1:20 | 50 s |
| 3. The demo | 1:20–3:45 | 145 s |
| 3.1 The layer: a transaction signed by FORS+C alone | 1:20–1:40 | 20 s |
| 3.2 Any protocol: its admin keys, quantum-safe | 1:40–2:05 | 25 s |
| 3.3 Any LP: Uniswap v4 hooks | 2:05–2:20 | 15 s |
| 3.4 MetaMask users: the Q-Day vault | 2:20–2:35 | 15 s |
| 3.5 Any dapp: Connect with Opaque | 2:35–2:45 | 10 s |
| 3.6 Private payments | 2:45–3:03 | 18 s |
| 3.7 A name a quantum computer can't take | 3:03–3:20 | 17 s |
| 3.8 Leave without Opaque | 3:20–3:45 | 25 s |
| 4. The close | 3:45–4:00 | 15 s |

**If you run over,** trim 3.5 to a single shot, then shorten 3.3 to its terminal line. Keep 3.1, 3.2 and 3.8 whole:
- 3.1 shows the layer itself;
- 3.2 shows that any protocol can plug in;
- 3.8 is the exit EF asked for.

## 1. The problem (0:00–0:30)

| Time | On screen | Voiceover |
|---|---|---|
| 0:00 | [opaque.credit/ethglobal-mumbai](https://www.opaque.credit/ethglobal-mumbai), top of the page | "Everything on Ethereum is guarded by ECDSA keys, and every key that has ever signed has put its public key on chain. From a public key, a quantum computer derives the private key." |
| 0:10 | Scroll to "Why now" | "So on Q-Day, wallets, Uniswap positions, ENS names and protocols' admin keys can all be taken. Whoever cracks one admin key upgrades the protocol." |
| 0:20 | Stay | "And today's stealth payments use secp256k1 too: anyone can unmask them later. Harvest now, decrypt later, and on a public chain the harvest is already done." |

## 2. The architecture (0:30–1:20)

| Time | On screen | Voiceover |
|---|---|---|
| 0:30 | [diagrams/ethereum.svg](../../diagrams/ethereum.svg) full screen (the top of the GitHub README) | "Opaque is a security layer under all of that. At its core is FORS+C, a hash-based signature that rests on keccak alone, and a key registry where only a FORS+C signature can change a key. Keys rotate before they run out." |
| 0:42 | Point at Path A | "On the EIP-8141 devnet, the transaction itself is post-quantum. Its VERIFY frame checks FORS+C in 76,430 gas, under the public mempool's 100,000 cap. The audited verifier needs 167,000, so we rewrote it in assembly: 53,600." |
| 0:53 | Point at Path B | "On Sepolia, the same keys sign ERC-4337 UserOperations, and a public bundler only carries them." |
| 0:59 | Point at the side boxes: dapps, MetaMask | "Everything plugs into that core without switching. A protocol hands its admin keys to it. A Uniswap LP adds a second factor. A MetaMask user keeps MetaMask. A dapp lists Opaque beside MetaMask." |
| 1:08 | Point at the privacy layer | "On top, privacy. Payments are notes in fixed-size pools. A ring proof, hashes and AES only, shows you own one of 8 without saying which. It travels through three of six relays, each layer sealed with ML-KEM-768, and the pool pays. Payees get ML-KEM stealth addresses on the standard ERC-5564 contracts. Reads go through EF's anon-rpc." |

## 3. The demo (1:20–3:45)

### 3.1 The layer: a transaction signed by FORS+C alone (1:20–1:40, 20 s)

| Time | On screen | Voiceover |
|---|---|---|
| 1:20 | [opaque.credit/testnet/devnet](https://www.opaque.credit/testnet/devnet), the Opaque wallet on the EIP-8141 devnet → **Activity** → a **Deposit** transaction → **Explorer ↗** ([altmempoolexplorer.forshtat.com](https://altmempoolexplorer.forshtat.com)) | "Here's the core on EIP-8141. Frame zero is the account verifying itself with FORS+C and paying its own gas: no bundler, no paymaster." |
| 1:30 | Point at frames 1–7, "atomic with the next frame", then "Every rule passed" | "Seven frames do the work, all or nothing, and one hash-based signature covers every one of them. The public mempool admitted it by its own rules." |

### 3.2 Any protocol: its admin keys, quantum-safe (1:40–2:05, 25 s)

| Time | On screen | Voiceover |
|---|---|---|
| 1:40 | [opaque.credit/sepolia/quantum-safe](https://www.opaque.credit/sepolia/quantum-safe) → **Connect your wallet** (MetaMask) → **Make a guard key** (12 words, registered) → **Make a demo protocol** → **Find its admin keys** | "Now any protocol. This is an OpenZeppelin upgradeable contract with two admin keys, upgrades and the fee, both held by my MetaMask." |
| 1:50 | **Make it quantum-safe** | "One button hands both to a contract that acts only on my post-quantum guard key." |
| 1:56 | **Try it as a thief** → **Take it back with the cracked key** → "Refused by the chain, every time …"; then **Sign and set the fee** and **Sign and upgrade** | "MetaMask's key alone is now refused. A FORS+C-signed fee change and upgrade go through. That works for any protocol." |

### 3.3 Any LP: Uniswap v4 hooks (2:05–2:20, 15 s)

| Time | On screen | Voiceover |
|---|---|---|
| 2:05 | [diagrams/uniswap.svg](../../diagrams/uniswap.svg), then the terminal output from your earlier run (see the checklist) | "On Uniswap's own Sepolia v4, our guard hook gives any LP, MetaMask's included, a post-quantum second factor. A removal pays only the recipient its FORS+C signature names." |
| 2:13 | The output line: "an ECDSA wallet's swap … reverts with NotPostQuantum" | "And in our post-quantum pools, an ordinary wallet's swap reverts." |

### 3.4 MetaMask users: the Q-Day vault (2:20–2:35, 15 s)

| Time | On screen | Voiceover |
|---|---|---|
| 2:20 | [opaque.credit/sepolia/vault](https://www.opaque.credit/sepolia/vault) → **Put money in** → **Deposit** from MetaMask | "Keep MetaMask. MetaMask puts money in the vault." |
| 2:26 | **Try it as a thief** → **Withdraw with the cracked key** → "Refused by the chain: BadSignature" | "A thief with the cracked MetaMask key is refused. Only the guard key's signature takes it out: **Sign and withdraw**." |

### 3.5 Any dapp: Connect with Opaque (2:35–2:45, 10 s)

| Time | On screen | Voiceover |
|---|---|---|
| 2:35 | [opaque.credit/connect-opaque](https://www.opaque.credit/connect-opaque): "Wallets in this browser" lists Opaque beside MetaMask → connect → **Send 0.0001 ETH** → approve in Opaque's window | "Any dapp finds Opaque beside MetaMask, through EIP-6963. Each transaction it asks for is approved in Opaque and signed with a hash-based key." |

### 3.6 Private payments (2:45–3:03, 18 s)

| Time | On screen | Voiceover |
|---|---|---|
| 2:45 | [opaque.credit/sepolia/app](https://www.opaque.credit/sepolia/app), the Opaque wallet → **Send** → 5 tUSDC to any address | "Now privacy, in the Opaque wallet on Sepolia. I pay 5 dollars privately. The proof is built in the browser; my note's secret never leaves the page." |
| 2:54 | **Activity** → the payment → Etherscan | "On chain, the pool pays the recipient, in a transaction Opaque's settler sends. My account sent nothing, and the proof hides which of 8 notes was mine." |

### 3.7 A name a quantum computer can't take (3:03–3:20, 17 s)

| Time | On screen | Voiceover |
|---|---|---|
| 3:03 | **Names** → claim `yourname.opaque.eth` → one signature | "One signature claims a real ENSv2 name and publishes an ML-KEM key. opaque.eth itself is held by a contract that obeys only a FORS+C signature, so nobody's ECDSA key can take it." |
| 3:12 | **Send** → type `yourname.opaque.eth` | "Paying the name pays a fresh one-time account only its owner can find. A quantum computer reading the announcements later still can't link them." |

### 3.8 Leave without Opaque (3:20–3:45, 25 s)

| Time | On screen | Voiceover |
|---|---|---|
| 3:20 | DevTools → Network → request blocking on `*opaque*` and `*railway.app*`, then reload | "Last: what if Opaque disappears? I block every Opaque server." |
| 3:26 | **Privacy** → **Leave without Opaque** → **Find my notes, without Opaque** | "The wallet still finds my notes, through EF's anon-rpc and a public bundler." |
| 3:33 | The withdrawal step (cut the 300-second wait in the edit, or announce before you record) | "It announces the exit, waits, then reveals the note. The pool's contract recomputes it on chain with AES-128 and pays. Nobody's permission needed, ours included." |

## 4. The close (3:45–4:00)

| Time | On screen | Voiceover |
|---|---|---|
| 3:45 | The GitHub README's top: diagram, badges | "Opaque is the post-quantum security layer for Ethereum: accounts, payments, names, liquidity and admin keys, live on Sepolia and the EIP-8141 devnet. 153 contract tests, 394 backend tests, eight browser suites against the live chains. One operator runs the relays today; before mainnet, multiple independent operators will." |

## Before you record

- **Accounts and funds**
  - **Sepolia wallet:**
    - made, with tUSDC notes (**Get test funds**, auto-deposit on) and some Sepolia ETH;
    - keep about 0.004 ETH spare, because Pimlico's bundler prices gas at about 1.15 gwei.
  - **Devnet account:**
    - created already;
    - devnet ETH from **Get devnet ETH**;
    - pqUSDC deposited, so a Deposit transaction with eight frames is in Activity for 3.1.
  - **MetaMask:** on Sepolia, with a little ETH, for 3.2, 3.4 and 3.5.
    - For 3.2, either make the guard key and demo protocol beforehand and record from **Find its admin keys**, or record straight through and cut the waits.
    - The vault and the quantum-safe page share one guard key per MetaMask address.
  - **The extension:** 0.9 or newer, loaded, for 3.5.
  - **A name:** claim it before recording, or have a fresh label ready to claim on camera.
- **The exit.** It waits 300 s between announcing and withdrawing:
  - either announce the exit before recording and show the withdrawal;
  - or record straight through and cut the wait.
- **Uniswap terminal output.** For 3.3, run `OPAQUE_NETWORK=sepolia node --use-system-ca ethereum/uniswap/uniswap-sepolia.ts` (in `backend/`) beforehand and keep the output on screen.
- **Tabs, open in order:**
  1. the Mumbai page;
  2. the README on GitHub;
  3. the devnet wallet;
  4. the devnet explorer;
  5. `/sepolia/quantum-safe`;
  6. `diagrams/uniswap.svg` and the terminal;
  7. `/sepolia/vault`;
  8. `/connect-opaque`;
  9. the Sepolia wallet;
  10. Sepolia Etherscan.
- **DevTools request blocking** set up in advance for 3.8, but switched off until that beat.
- **Make sure each page loads:** the devnet stack at `opaque-eth-devnet-production.up.railway.app`, the Sepolia stack at `opaque-sepolia-production.up.railway.app`.
- **Screen:** browser zoom at 110–125%, notifications off, and a clean profile with no wallet extensions on screen except MetaMask and Opaque.

## If something breaks live

| What breaks | Do this |
|---|---|
| The devnet gateway answers 502 or "Failed to fetch" | Wait a few seconds: the wallet falls back to the miner (`altmempool.forshtat.com`) on its own. If both are down, use the recorded e2e transaction from `scripts/e2e-devnet-page.ts`. |
| A devnet transaction sits "New" | The wallet re-broadcasts the same bytes to the gateway and the miner until it's mined. Give it up to a minute. |
| The devnet faucet is dry | Opaque's own faucet steps in (0.001 ETH an hour), or run `node ethereum/frame-tx.ts send <address> 0.01` in `backend/`. |
| A MetaMask transaction on Sepolia is slow | Sepolia's base fee is a few wei, and a 2-wei tip can sit for minutes. Speed it up in MetaMask. |
| "The bundler refused it" on Sepolia | The account can't cover the amount and gas at Pimlico's price. Send less, or add ETH. |
| A private payment is slow to settle | Check Activity: it shows each note as it lands. Usually seconds. |
| anon-rpc reads are slow | They take about a second each. Say so, or cut. |
| Anything else | Show the recorded browser-test output: `scripts/e2e-sepolia.ts` (33 checks, including the exit with Opaque blocked), `e2e-devnet-private.ts`, `e2e-vault.ts`, `e2e-eth-connect.ts`. |

Never claim more than the page shows. The honest lines stay in, because judges trust them:
- the attester is trusted for whether a spend is valid;
- one operator runs everything today;
- the anonymity set is the ring of 8.
