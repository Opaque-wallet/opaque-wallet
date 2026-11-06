# The demo video: script

For recording the ETHGlobal Mumbai video. **Four and a half minutes at most**: the problem, the architecture, the demo. The same script, with a rehearsal timer and the architecture diagrams, is the Opaque Demo Script artifact. Every number is checked against the repo; read the voiceover as written, at about 2.5 words a second.

**Opaque is a layer, not a wallet.** Say "Opaque" for the layer, and "the Opaque wallet" only while that app is on screen.

## The one sentence

**Opaque is the post-quantum security layer for Ethereum.** It moves everything ECDSA guards today to hash-based keys (accounts, payments, ENS names, Uniswap liquidity and any protocol's admin keys) and makes payments private. The wallet is one way in; MetaMask users, LPs and any protocol plug in without switching.

## Timing

| Part | Time | Length |
|---|---|---|
| The problem | 0:00–0:25 | 25 s |
| The architecture | 0:25–1:55 | 90 s |
| The demo | 1:55–4:13 | 138 s |
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

## 1. The problem (0:00–0:25)

| Time | On screen | Voiceover |
|---|---|---|
| 0:00 | opaque.credit/ethglobal-mumbai, top of the page | "Every Ethereum account that has ever signed has published its public key. From a public key, a quantum computer derives the private key." |
| 0:10 | Scroll to "Why now" | "So on Q-Day, wallets, Uniswap positions, ENS names and protocols' admin keys can all be taken." |
| 0:18 | Stay on "Why now" | "And privacy built on elliptic curves can be unmasked later. On a public chain, everything is already harvested." |

## 2. The architecture (0:25–1:55)

| Time | On screen | Voiceover |
|---|---|---|
| 0:25 | Core: diagrams/ethereum.svg, the post-quantum core at the bottom | "Opaque is a post-quantum security layer. Every authorization is a FORS+C signature, built from hashes alone. A registry holds each key; only that key can replace it, and none signs more than eight times." |
| 0:40 | Core: diagrams/ethereum.svg: Path A, then Path B | "Two ways to send. On EIP-8141, the transaction itself is FORS+C, in 76,430 gas. On Sepolia, the key signs ERC-4337 operations." |
| 0:50 | Core: diagrams/ethereum.svg: the privacy layer | "Payments are private. Notes sit in fixed-size pools. A hash-based ring proof says a note is one of eight, not which. Three relays carry it, sealed with ML-KEM; our attester checks it, and the pool pays." |
| 1:06 | Any protocol: The "Any protocol" diagram on this page: before, then after | "Any protocol can plug in too. Its upgrade admin, owner and roles move to a PQAdmin, which acts only on a FORS+C signature the registry checks. A cracked ECDSA key then changes nothing." |
| 1:21 | Uniswap: diagrams/uniswap.svg: the 0xAA0 panel, then PQGuardHook | "For Uniswap: v4 hooks put this key in charge. Our pools admit only post-quantum accounts, and PQGuardHook gives any LP a hash-based second factor." |
| 1:32 | ENS: diagrams/ens.svg: PQNameController, then OpaqueNames | "For ENS: opaque.eth's token, and every role with it, sits in a contract obeying only FORS+C. Subnames are post-quantum, and pay stealth addresses." |
| 1:42 | EF: diagrams/ethereum-foundation.svg: stealth, anon-rpc, the exit | "For the Ethereum Foundation: ML-KEM stealth on the standard ERC-5564 contracts, reads through anon-rpc, and every note can leave its pool with all our servers off." |

## 3. The demo (1:55–4:13)

| Time | On screen | Voiceover |
|---|---|---|
| 1:55 | 3.1 The layer: opaque.credit/testnet/devnet → Activity → a Deposit transaction → Explorer ↗ (frames view) | "On the devnet, a deposit. Frame zero: the account checks its own FORS+C signature in 76,430 gas, under a 100,000 cap. The audited verifier needed 167,000, so we rewrote it in assembly. Seven frames follow, under that one signature." |
| 2:10 | 3.2 Any protocol: Wallet's network drop-down → Keep what you have · Sepolia → Quantum-safe admin → Make a demo with roles → Make it quantum-safe → Take it back with the cracked key → Sign and upgrade | "Here it is, from the wallet's menu. This contract's beacon and three roles all sit on my MetaMask. One button hands every one to my PQAdmin. The cracked MetaMask key is refused on all four; a signed upgrade goes through." |
| 2:32 | 3.3 Any LP: diagrams/uniswap.svg, then the terminal output of uniswap-sepolia.ts | "On Uniswap's own Sepolia v4, removing guarded liquidity pays only the recipient its FORS+C signature names. In our pools, an ordinary wallet's swap reverts." |
| 2:44 | 3.4 MetaMask: opaque.credit/sepolia/vault → Deposit → Withdraw with the cracked key → "Refused by the chain: BadSignature" | "Keep MetaMask: put money in the Q-Day vault. A thief with the cracked MetaMask key is refused. Only the guard key's signature takes it out." |
| 2:56 | 3.5 Any dapp: opaque.credit/connect-opaque: Opaque beside MetaMask → connect → Send 0.0001 ETH → approve in Opaque | "Any dapp lists Opaque beside MetaMask. Each transaction is approved in Opaque and signed with a hash-based key." |
| 3:05 | 3.6 Private payment: Split screen. Left: opaque.credit/sepolia/app → Send 5 tUSDC. Right: railway logs --service opaque-sepolia | "I pay five dollars privately. The proof is built in my browser, and my note's secret never leaves it." |
| 3:12 | 3.6 Private payment: Right: "mesh exit  a payment came out of the mesh: 35 chunks through three relays…" | "It crosses three relays as onion layers and arrives still sealed." |
| 3:19 | 3.6 Private payment: Right: "settler  opened payment…", then "ring proof verified in 2.0 s; attested with the attester's FORS+C key…" | "Our attester verifies the ring proof and signs with its own hash-based key." |
| 3:26 | 3.6 Private payment: Right: "egress  sent pool.spend: …etherscan…", then "chain  settled in block…". Click the link. | "The pool pays. On Etherscan, the sender is our settler: my account sent nothing." |
| 3:33 | 3.7 A name: Sepolia wallet → Names → claim yourname.opaque.eth → Send → type the name | "One signature claims a real ENSv2 name and publishes my ML-KEM key. Paying the name pays a fresh one-time account no quantum computer can link later." |
| 3:46 | 3.8 Leave: DevTools → Network → block *opaque* and *railway.app* → reload | "Now I block every Opaque server." |
| 3:51 | 3.8 Leave: Privacy → Leave without Opaque → Find my notes, without Opaque | "The wallet still finds my notes, through EF's anon-rpc and a public bundler." |
| 3:59 | 3.8 Leave: The withdrawal step (cut the 300-second wait in the edit) | "It announces the exit, waits, then reveals the note. The contract recomputes it with AES-128 on chain and pays. No permission needed, not even ours." |

## 4. The close (4:13–4:30)

| Time | On screen | Voiceover |
|---|---|---|
| 4:13 | The GitHub README's top: logo, badges, diagram | "Opaque: the post-quantum security layer for Ethereum. Live on Sepolia and the EIP-8141 devnet, with 154 contract tests, 396 backend tests and eight browser suites. One operator today; multiple independent operators before mainnet." |

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
