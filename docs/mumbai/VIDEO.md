# The demo video: script

For recording the ETHGlobal Mumbai video. **Four and a half minutes at most**: the problem, the architecture, the demo. The same script, with a rehearsal timer and the architecture diagrams, is the Opaque Demo Script artifact. Every number is checked against the repo; read the voiceover as written, at about 2.5 words a second.

**Opaque is a layer, not a wallet.** Say "Opaque" for the layer, and "the Opaque wallet" only while that app is on screen.

## The one sentence

**Opaque is the quantum-safe layer for Ethereum.** It moves everything ECDSA guards today to hash-based keys (accounts, payments, ENS names, Uniswap liquidity and any protocol's admin keys) and makes payments private. The wallet is one way in; MetaMask users, LPs and any protocol plug in without switching.

## Timing

| Part | Time | Length |
|---|---|---|
| The problem, and Opaque | 0:00–0:38 | 38 s |
| The architecture | 0:38–2:08 | 90 s |
| The demo | 2:08–4:13 | 125 s |
| The close | 4:13–4:30 | 17 s |

## The architecture, in parts

What each part does, for reading before you record. The voiceover in part 2 covers all of it.

| Part | What it does | Number to know |
|---|---|---|
| **Keys** | FORS+C, a few-time hash-based signature over keccak. Keys come from one 12-word phrase, kept in the browser. | 9,251-byte signature; at most 8 signatures per key: 2⁻¹⁶⁰ against forgery |
| **Registry** | PQKeyRegistry holds each account's key and its next one. Only a signature under the current key changes it. No owner, no admin. | Each signature is counted and used once |
| **EIP-8141** | FramePQAccount checks FORS+C in its VERIFY frame and pays its own gas. Its factory creates accounts with no signature at all. | 76,430 gas of the 100,000 cap; LeanFors 53.6k vs 167k |
| **ERC-4337** | PQAccount on Sepolia: the key signs each UserOperation; Pimlico's public bundler only carries it. | One operation can batch many calls |
| **Privacy** | Fixed-size note pools. A ZKBoo ring proof (AES-128, hashes) shows a note is one of 8. Three of six relays carry it in ML-KEM-768 onion layers. The attester verifies it and signs with its own FORS+C key; the settler sends pool.spend. | Proof 1.08 MiB, 2.2 s to prove; 35 chunks |
| **Stealth** | An ML-KEM-768 key in ERC-6538's registry; each payment goes to a fresh one-time account announced on ERC-5564. | 1,184-byte key, 1,088-byte ciphertext |
| **Any protocol** | PQAdmin takes a contract's owner, ProxyAdmin, beacon, AccessControl roles or AccessManager admin, and calls out only on a FORS+C signature from the team's guard key. | One button on /sepolia/quantum-safe |
| **Uniswap v4** | PQAccountPoolHook and PQPoolHook admit only post-quantum accounts (beforeSwap and the liquidity callbacks). PQGuardHook: a removal pays only the recipient its signature names. | Flags 0xAA0 and 0xB01 |
| **ENSv2** | PQNameController holds opaque.eth, and every role moves with the token. OpaqueNames gives name.opaque.eth only to post-quantum accounts. | Resolves through UniversalResolverV2, unchanged |
| **anon-rpc** | EF's Nox mixnet, run in a sandboxed iframe: ENS lookups always, and the whole account with one switch. | About 1 s a read |
| **Exit** | ExitableRingVerifier: announce, wait, reveal; AES128.sol recomputes the note on chain. Works with every Opaque server down. | 300 s delay on Sepolia |
| **Keep MetaMask** | The Q-Day vault: MetaMask puts money in, only a FORS+C signature takes it out. Connect with Opaque lists Opaque beside MetaMask in any dapp (EIP-6963). | Same guard key as the admin page |

**How any protocol becomes quantum-safe.** Before: the protocol's admin powers (its owner, its ProxyAdmin or beacon, its AccessControl roles) are held by one ECDSA key, and whoever cracks it upgrades or drains the protocol. After one button on /sepolia/quantum-safe, every power the team's wallet held is held by its `PQAdmin`. `PQAdmin.execute(target, data, deadline, signature)` calls out only if `PQKeyRegistry.consume` accepts a FORS+C signature from the guard key over exactly that call; anyone may submit it. The ECDSA key is refused (`OwnableUnauthorizedAccount`), and the guard key rotates without the admin changing.

## 1. The problem, and Opaque (0:00–0:38)

**Say this, as one paragraph:**

> Hi, I'm Swarnim from Opaque. We're building the quantum-safe layer for Ethereum. Every Ethereum account that has ever signed has put its public key on chain. A quantum computer turns that public key back into the private key. So wallets, Uniswap positions, ENS names and protocols' admin keys can all be taken. And privacy breaks backwards: stealth payments hidden with today's curves can be unmasked later, all at once. The data is already on chain. Opaque moves every one of these to hash-based keys, today, without a fork.

**On screen:**

| Time | Show |
|---|---|
| 0:00 | You on camera: no Opaque page on screen yet |
| 0:06 | Cut to GitHub: diagrams/q-day.svg, the quantum computer at the top |
| 0:16 | Same diagram: Wallets, Uniswap positions, ENS names, Protocol admin keys |
| 0:24 | Same diagram: Stealth payments, SNARK privacy pools |
| 0:32 | Same diagram: the orange Opaque box at the bottom |

## 2. The architecture (0:38–2:08)

**Say this, as one paragraph:**

> This is all of Opaque. At the bottom is the core: every orange box acts only on a FORS+C signature, a hash-based key checked in one registry. No key signs more than eight times. The Opaque wallet holds those keys. It signs EIP-8141 frame transactions on the devnet, ERC-4337 operations on Sepolia, and reads through EF's anon-rpc. Payments: a ring proof shows a note is one of eight, three relays carry it sealed with ML-KEM, our attester verifies and signs, and the pool pays. The payer's account sends nothing. Names: opaque.eth is held by a FORS+C-only controller, and name.opaque.eth goes only to post-quantum accounts. Paying a name pays a one-time account, hidden with ML-KEM. Nobody has to switch: MetaMask keeps funds in the Q-Day vault, protocols hand their admin keys to PQAdmin, and dapps list Opaque beside MetaMask. On EIP-8141, accounts verify themselves. On Uniswap v4, our hooks let only post-quantum accounts trade, and PQGuardHook protects any LP. And if Opaque disappears, every note still leaves its pool: announce, wait, reveal. One hash-based key under all of it: wallets, names, liquidity, admin keys and private payments.

**On screen:**

| Time | Show |
|---|---|
| 0:38 | GitHub: diagrams/opaque.svg, the README top: the PQ auth core at the bottom |
| 0:52 | Same diagram: Who, then How it's sent |
| 1:02 | Same diagram: Private payments, left to right |
| 1:16 | Same diagram: ENS, then Stealth addresses |
| 1:28 | Same diagram: Keep what you have, then EIP-8141 devnet |
| 1:41 | Same diagram: Uniswap v4, then Leave without Opaque |
| 1:55 | Same diagram, whole |

## 3. The demo (2:08–4:13)

**Say this, as one paragraph:**

> On the devnet, a deposit. Frame zero: the account checks its own FORS+C signature in 76,430 gas, under the 100,000 cap; we rewrote the verifier in assembly to fit. Seven frames follow. From the wallet's menu: this contract's beacon and three roles sit on my MetaMask. One button hands them all to my PQAdmin. The cracked key is refused on all four; a signed upgrade goes through. On Uniswap's own Sepolia v4, removing guarded liquidity pays only the recipient its FORS+C signature names. In our pools, an ordinary wallet's swap reverts. Keep MetaMask: put money in the Q-Day vault. A thief with the cracked MetaMask key is refused. Only the guard key's signature takes it out. Any dapp lists Opaque beside MetaMask. Each transaction is approved in Opaque and signed with a hash-based key. I pay five dollars privately. The proof is built in my browser, and my note's secret never leaves it. It crosses three relays as onion layers and arrives still sealed. Our attester verifies the ring proof and signs with its own hash-based key. The pool pays. On Etherscan, the sender is our settler: my account sent nothing. One signature claims a real ENSv2 name and publishes my ML-KEM key. Paying the name pays a fresh one-time account no quantum computer can link later. Now I block every Opaque server. The wallet still finds my notes, through EF's anon-rpc and a public bundler. It announces the exit, waits, then reveals the note. The contract recomputes it with AES-128 on chain and pays. No permission needed, not even ours.

**On screen:**

| Time | Show |
|---|---|
| 2:08 | opaque.credit/testnet/devnet → Activity → a Deposit transaction → Explorer ↗ (frames view) |
| 2:21 | Wallet's network drop-down → Keep what you have · Sepolia → Quantum-safe admin → Make a demo with roles → Make it quantum-safe → Take it back with the cracked key → Sign and upgrade |
| 2:41 | GitHub: diagrams/uniswap.svg, then the terminal output of uniswap-sepolia.ts |
| 2:52 | opaque.credit/sepolia/vault → Deposit → Withdraw with the cracked key → "Refused by the chain: BadSignature" |
| 3:03 | opaque.credit/connect-opaque: Opaque beside MetaMask → connect → Send 0.0001 ETH → approve in Opaque |
| 3:11 | Split screen. Left: opaque.credit/sepolia/app → Send 5 tUSDC. Right: railway logs --service opaque-sepolia |
| 3:18 | Right: "mesh exit  a payment came out of the mesh: 35 chunks through three relays…" |
| 3:24 | Right: "settler  opened payment…", then "ring proof verified in 2.0 s; attested with the attester's FORS+C key…" |
| 3:30 | Right: "egress  sent pool.spend: …etherscan…", then "chain  settled in block…". Click the link. |
| 3:37 | Sepolia wallet → Names → claim yourname.opaque.eth → Send → type the name |
| 3:49 | DevTools → Network → block *opaque* and *railway.app* → reload |
| 3:53 | Privacy → Leave without Opaque → Find my notes, without Opaque |
| 4:00 | The withdrawal step (cut the 300-second wait in the edit) |

## 4. The close (4:13–4:30)

**Say this, as one paragraph:**

> Opaque: the post-quantum security layer for Ethereum. Live on Sepolia and the EIP-8141 devnet, with 154 contract tests, 396 backend tests and eight browser suites. One operator today; multiple independent operators before mainnet.

**On screen:**

| Time | Show |
|---|---|
| 4:13 | The GitHub README's top: logo, badges, diagram |

## Before you record

- **Accounts and funds**
  - **Sepolia wallet:**
    - made, with tUSDC notes (**Get test funds**, auto-deposit on) and some Sepolia ETH;
    - keep about 0.004 ETH spare, because Pimlico's bundler prices gas at about 1.15 gwei.
  - **Devnet account:**
    - created already;
    - devnet ETH from **Get devnet ETH**;
    - pqUSDC deposited, so a Deposit transaction with eight frames is in Activity for 3.1.
  - **MetaMask:** on Sepolia, with a little ETH, for 3.2, 3.4 and 3.5. At Sepolia's fees, 0.01 ETH covers all three many times over.
    - For 3.2, either make the guard key and the demo with roles beforehand and record from **Find its admin keys**, or record straight through and cut the waits. The roles demo hands over in up to eight MetaMask transactions (one creates your PQAdmin if this address has none yet, one hands over the beacon, two for each of the three roles); cut between them.
    - **Copy the 12 words** when you make the guard key, and keep them: they're the only way to act as the contract's admin, and the page never offers a new key over a registered one.
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
- **The backend's logs, for 3.6.**
  - Deploy the services first, so they print one line per payment step (the user's step, below).
  - Then, in a terminal beside the browser: `railway logs --service opaque-sepolia`. Or open the Railway dashboard → the `opaque-sepolia` service → **Logs**.
  - Make the font large. The lines to look for start with `mesh exit`, `settler`, `egress` and `chain`.
  - The devnet's stack prints the same lines: `railway logs --service opaque-eth-devnet`.
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
| The quantum-safe page or the vault says "a different key: these words are not the ones this address registered" | Press **I have the words** and enter the copy you made. Each MetaMask address registers one guard key, once, and only its words drive it. Without them, record with another MetaMask account. |
| A page says the account can't pay, or a script says "insufficient funds" | The deployer that funds tests (`0x9cdb…40aA`) or your MetaMask is out of Sepolia ETH: send it some. |
| A private payment is slow to settle | Check Activity: it shows each note as it lands. Usually seconds. |
| anon-rpc reads are slow | They take about a second each. Say so, or cut. |
| Anything else | Show the recorded browser-test output: `scripts/e2e-sepolia.ts` (33 checks, including the exit with Opaque blocked), `e2e-devnet-private.ts`, `e2e-vault.ts`, `e2e-eth-connect.ts`. |

Never claim more than the page shows. The honest lines stay in, because judges trust them:
- the attester is trusted for whether a spend is valid;
- one operator runs everything today;
- the anonymity set is the ring of 8;
- the quantum-safe page hands over what the chain shows (owners, proxy and beacon admins, every AccessControl role, an AccessManager's admin role), not a Safe's owners or a contract's custom admin variables.
