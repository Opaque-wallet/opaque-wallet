# The demo video: script

For recording the ETHGlobal Mumbai video. **Four and a half minutes at most**: the problem, the architecture, the demo. The same script, with a rehearsal timer and the architecture diagrams, is the Opaque Demo Script artifact. Every number is checked against the repo; read the voiceover as written, at about 2.5 words a second.

**Opaque is a layer, not a wallet.** Say "Opaque" for the layer, and "the Opaque wallet" only while that app is on screen.

## The one sentence

**Opaque is the quantum-safe layer for Ethereum.** It moves everything ECDSA guards today to hash-based keys (accounts, payments, ENS names, Uniswap liquidity and any protocol's admin keys) and makes payments private. The wallet is one way in; MetaMask users, LPs and any protocol plug in without switching.

## Timing

| Part | Time | Length |
|---|---|---|
| The problem, and Opaque | 0:00–0:38 | 38 s |
| The architecture | 0:38–2:36 | 118 s |
| The demo | 2:36–4:13 | 97 s |
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

## 2. The architecture (0:38–2:36)

**Say this, as one paragraph:**

> Opaque runs on FORS+C keys. FORS+C is a signature made only from hashes, and hashes are something a quantum computer can't break. Every key is registered on chain, and each one is retired after eight signatures. The wallet holds these keys and sends transactions two ways: on the EIP-8141 devnet, where the transaction itself carries the hash-based signature, or on Sepolia, as an ERC-4337 smart-account transaction. Its reads go through a mixnet. Payments stay private too. Money sits in a pool as notes of fixed sizes, and to pay, the wallet proves you own one note out of eight without saying which. Three relays pass it along encrypted, our attester checks the proof, and the pool pays. For names, opaque.eth is owned by a contract that only obeys FORS+C, and subnames go only to post-quantum accounts. Paying a name sends money to a fresh one-time address that only its owner can find. And nobody has to switch. A MetaMask user can lock funds in our vault, which only a FORS+C signature opens. A protocol team hands its admin keys to PQAdmin. Any dapp can connect to Opaque, the way it connects to MetaMask. On the EIP-8141 devnet, accounts check their own signature and pay their own gas, with no bundler in between. On Uniswap v4, our hooks let only post-quantum accounts trade, and for any liquidity provider a withdrawal needs a FORS+C signature, so a cracked MetaMask key can't pull the funds. Finally, if Opaque ever goes offline, you can still take your money out of the pools yourself. Everything orange on this diagram answers to that one hash-based key.

**On screen:**

| Time | Show |
|---|---|
| 0:38 | diagrams/opaque.svg: the PQ AUTH CORE box at the bottom, then up to the Opaque wallet |
| 0:54 | Follow: signs → EIP-8141 frame tx → Alt mempool → devnet; signs → ERC-4337 UserOperation → Pimlico bundler → Sepolia; reads → anon-rpc → Public RPC |
| 1:09 | Follow the row: Ring proof → Three relays → Attester → Note pool → Recipient, and the "or" arrow down to One-time account |
| 1:27 | Follow: PQNameController → OpaqueNames ← UniversalResolverV2 → One-time account; then ERC-5564 and ERC-6538 |
| 1:44 | Follow: MetaMask user → deposits → Q-Day vault; Protocol team → admin keys → PQAdmin → acts on FORS+C → Your protocol; Any dapp → EIP-6963 → Connect with Opaque |
| 2:00 | The EIP-8141 devnet frame: FramePQAccount, Factory, pqUSDC pools |
| 2:10 | Follow: Uniswap LP → add · remove → v4 PoolManager → PQ pool hooks, and the arrow round to PQGuardHook |
| 2:24 | Follow: Exitable pools → AES-128 on chain; then back down to the PQ AUTH CORE |

## 3. The demo (2:36–4:13)

**Say this, as one paragraph:**

> On the devnet, a deposit. Frame zero verifies the FORS+C signature in 76,430 gas, under the 100,000 cap, and the account pays its own gas. Now, Q-Day itself. This wallet holds money, a protocol, a vault and stealth payments. I press Q-Day. The page plays the quantum computer: from the public key on chain, it recovers the private key. With that key, the attacker takes the wallet and the protocol it owned, and unmasks the old stealth payment. Everything behind Opaque is refused by the chain. Then the owner signs with the FORS+C key alone, and moves the vault and runs the protocol from a new wallet. I pay five dollars privately; the proof is built in my browser. It crosses three relays and arrives still sealed. Our attester verifies it and signs with its own FORS+C key. The pool pays; on Etherscan, the sender is our settler, not me. On Uniswap's own v4, an ordinary wallet's swap into our pool reverts. One signature claims a real ENSv2 name; paying it pays a fresh one-time account. I block every Opaque server. The wallet still finds my notes through anon-rpc. It announces the exit, waits, reveals the note, and AES-128 on chain recomputes it. No permission needed, not even ours.

**On screen:**

| Time | Show |
|---|---|
| 2:36 | opaque.credit/testnet/devnet → Activity → a Deposit transaction → Explorer ↗ (frames view) |
| 2:47 | opaque.credit/sepolia/q-day (set up before recording): the board, Without Opaque and With Opaque |
| 2:54 | Press Run Q-Day: the public key, then the private key scrolling in |
| 3:02 | The attack log filling in: TAKEN, TAKEN, LINKED; REFUSED with BadSignature and OwnableUnauthorizedAccount; open one refused transaction on Etherscan |
| 3:12 | Press Move it all with the guard key: the vault withdrawals and the fee change land |
| 3:20 | Split screen. Left: opaque.credit/sepolia/app → Send 5 tUSDC. Right: railway logs --service opaque-sepolia |
| 3:25 | Right: "mesh exit  a payment came out of the mesh: 35 chunks through three relays…" |
| 3:30 | Right: "settler … ring proof verified in 2.0 s; attested with the attester's FORS+C key…" |
| 3:35 | Right: "egress  sent pool.spend: …etherscan…", then "chain  settled in block…". Click the link. |
| 3:40 | The terminal output of uniswap-sepolia.ts: "an ECDSA wallet's swap … reverts with NotPostQuantum" |
| 3:47 | Sepolia wallet → Names → claim yourname.opaque.eth → Send → type the name |
| 3:55 | DevTools → Network → block *opaque* and *railway.app* → reload |
| 3:58 | Privacy → Leave without Opaque → Find my notes, without Opaque |
| 4:03 | The withdrawal step (cut the 300-second wait in the edit) |

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
  - **The Q-Day simulator, for 3.2:** open `/sepolia/q-day` and press **Set up the victim** a few minutes before recording. It needs nothing from you: the page makes its own wallets, and Opaque's faucet funds them. Record from the board; **Start over with a new victim** resets it for another take.
  - **A name:** claim it before recording, or have a fresh label ready to claim on camera.
- **The exit.** It waits 300 s between announcing and withdrawing:
  - either announce the exit before recording and show the withdrawal;
  - or record straight through and cut the wait.
- **Uniswap terminal output.** For 3.4, run `OPAQUE_NETWORK=sepolia node --use-system-ca ethereum/uniswap/uniswap-sepolia.ts` (in `backend/`) beforehand and keep the output on screen.
- **Tabs, open in order:**
  1. the Mumbai page;
  2. the README on GitHub;
  3. the devnet wallet;
  4. the devnet explorer;
  5. `/sepolia/q-day`, set up;
  6. `diagrams/uniswap.svg` and the terminal;
  9. the Sepolia wallet;
  10. Sepolia Etherscan.
- **The backend's logs, for 3.3.**
  - Deploy the services first, so they print one line per payment step (the user's step, below).
  - Then, in a terminal beside the browser: `railway logs --service opaque-sepolia`. Or open the Railway dashboard → the `opaque-sepolia` service → **Logs**.
  - Make the font large. The lines to look for start with `mesh exit`, `settler`, `egress` and `chain`.
  - The devnet's stack prints the same lines: `railway logs --service opaque-eth-devnet`.
- **DevTools request blocking** set up in advance for 3.6, but switched off until that beat.
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
