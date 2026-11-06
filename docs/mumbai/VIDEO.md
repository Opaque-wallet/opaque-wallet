# The demo video: script

For recording the ETHGlobal Mumbai video. **Four and a half minutes at most**: the problem, the architecture, the demo. The same script, with a rehearsal timer and the architecture diagrams, is the Opaque Demo Script artifact. Every number is checked against the repo; read the voiceover as written, at about 2.5 words a second.

**Opaque is a layer, not a wallet.** Say "Opaque" for the layer, and "the Opaque wallet" only while that app is on screen.

## The one sentence

**Opaque is the quantum-safe layer for Ethereum.** It moves everything ECDSA guards today to hash-based keys (accounts, payments, ENS names, Uniswap liquidity and any protocol's admin keys) and makes payments private. The wallet is one way in; MetaMask users, LPs and any protocol plug in without switching.

## Timing

| Part | Time | Length |
|---|---|---|
| Hi guys, this is Opaque | 0:00–0:35 | 35 s |
| What the demo shows | 0:35–0:47 | 12 s |
| The demo | 0:47–2:15 | 88 s |
| The architecture | 2:15–4:13 | 118 s |
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

## 1. Hi guys, this is Opaque (0:00–0:35)

**Say this, as one paragraph:**

> Hi guys, this is Opaque, the post-quantum security layer for Ethereum. Every account that has signed has put its public key on chain, and a quantum computer turns that key back into the private key. Opaque moves everything that key guards to hash-based FORS+C keys: accounts, payments, ENS names, Uniswap liquidity and any protocol's admin keys. And it keeps payments private with cryptography a quantum computer has nothing to attack. It's more than a wallet, and it's live today on Sepolia and Ethereum's EIP-8141 devnet.

**On screen:**

| Time | Show |
|---|---|
| 0:00 | The autopilot on opaque.credit/?demo=swarnim: press Play; the front page's opening plays, the ring and the title |
| 0:05 | The page starts scrolling by itself: the hero, then how a private payment works |
| 0:15 | Still scrolling: Spend unseen, the phone tour |
| 0:24 | Still scrolling: Connect anywhere, Built for Q-Day, Nothing leads back, to the end |

## 2. What the demo shows (0:35–0:47)

**Say this, as one paragraph:**

> In this demo, I'll make a wallet, pay privately, swap on Uniswap, claim and pay an ENS name, sign on the devnet, leave without Opaque, and run Q-Day.

**On screen:**

| Time | Show |
|---|---|
| 0:35 | The wallet opens by itself; the caption reads The demo: A wallet · a private payment · Uniswap v4 · an ENS name · the EIP-8141 devnet · leaving without Opaque · Q-Day |

## 3. The demo (0:47–2:15)

**Say this, as one paragraph:**

> Nothing here is mocked: a script types into the real wallet. Twelve words make it, and every FORS+C key comes from them. The faucet funds it, and the deposit is one ERC-4337 operation its FORS+C key signs. I pay five dollars privately; the ring proof is built in my browser. It crosses three relays and arrives still sealed. Our attester verifies it and signs with its own FORS+C key. The pool pays; on Etherscan, the sender is our settler, not me. A swap in Uniswap v4's post-quantum pool: its hook lets in only FORS+C accounts. One signature claims swarnim.opaque.eth on ENSv2, and the wallet takes the name. Paying it pays a one-time address that only my ML-KEM key can find. On the EIP-8141 devnet, the account itself is FORS+C only: frame zero verifies its signature in 76,430 gas, thanks to LeanFors. Now every Opaque server is down. The wallet still finds my notes through anon-rpc, and after the pool's delay withdraws them, with no one's permission. Last, Q-Day. The page hands an attacker this wallet's private key: it takes the wallet and its protocol, and the chain refuses everything behind Opaque. Then the owner moves it all with the FORS+C key alone.

**On screen:**

| Time | Show |
|---|---|
| 0:47 | Create a wallet, the 12 words, three typed back, a password |
| 0:56 | Get test funds; the balance turns into 100 tUSDC of notes (cut the wait) |
| 1:02 | Split screen. Left: Send 5 tUSDC typed in. Right: railway logs --service opaque-sepolia |
| 1:07 | Right: "mesh exit  a payment came out of the mesh: 35 chunks through three relays…" |
| 1:11 | Right: "settler … ring proof verified; attested with the attester's FORS+C key…" |
| 1:16 | Right: "egress  sent pool.spend: …etherscan…", then "chain  settled in block…" |
| 1:21 | Swap: 0.001 ETH quoted, then Swapped on Uniswap v4 |
| 1:27 | Names: the label typed, claimed; after a reload the header reads swarnim.opaque.eth |
| 1:33 | Send 2 tUSDC to the name; Home: the payment found and swept into the notes (cut the wait) |
| 1:39 | The devnet wallet: funded, created by its factory, a send through its signature request, a v4 swap |
| 1:49 | Back on Sepolia, every Opaque server down: the exit card, Find my notes, announced, then Withdrawn (cut the delay) |
| 2:00 | The Q-Day page: the victim set up (cut the wait), Run Q-Day, the attack log |
| 2:10 | Move it all with the guard key: Done |

## 4. The architecture (2:15–4:13)

**Say this, as one paragraph:**

> Opaque runs on FORS+C keys. FORS+C is a signature made only from hashes, and hashes are something a quantum computer can't break. Every key is registered on chain, and each one is retired after eight signatures. The wallet holds these keys and sends transactions two ways: on the EIP-8141 devnet, where the transaction itself carries the hash-based signature, or on Sepolia, as an ERC-4337 smart-account transaction. Its reads go through a mixnet. Payments stay private too. Money sits in a pool as notes of fixed sizes, and to pay, the wallet proves you own one note out of eight without saying which. Three relays pass it along encrypted, our attester checks the proof, and the pool pays. For names, opaque.eth is owned by a contract that only obeys FORS+C, and subnames go only to post-quantum accounts. Paying a name sends money to a fresh one-time address that only its owner can find. And nobody has to switch. A MetaMask user can lock funds in our vault, which only a FORS+C signature opens. A protocol team hands its admin keys to PQAdmin. Any dapp can connect to Opaque, the way it connects to MetaMask. On the EIP-8141 devnet, accounts check their own signature and pay their own gas, with no bundler in between. On Uniswap v4, our hooks let only post-quantum accounts trade, and for any liquidity provider a withdrawal needs a FORS+C signature, so a cracked MetaMask key can't pull the funds. Finally, if Opaque ever goes offline, you can still take your money out of the pools yourself. Everything orange on this diagram answers to that one hash-based key.

**On screen:**

| Time | Show |
|---|---|
| 2:15 | diagrams/opaque.svg: the PQ AUTH CORE box at the bottom, then up to the Opaque wallet |
| 2:31 | Follow: signs → EIP-8141 frame tx → Alt mempool → devnet; signs → ERC-4337 UserOperation → Pimlico bundler → Sepolia; reads → anon-rpc → Public RPC |
| 2:46 | Follow the row: Ring proof → Three relays → Attester → Note pool → Recipient, and the "or" arrow down to One-time account |
| 3:04 | Follow: PQNameController → OpaqueNames ← UniversalResolverV2 → One-time account; then ERC-5564 and ERC-6538 |
| 3:21 | Follow: MetaMask user → deposits → Q-Day vault; Protocol team → admin keys → PQAdmin → acts on FORS+C → Your protocol; Any dapp → EIP-6963 → Connect with Opaque |
| 3:37 | The EIP-8141 devnet frame: FramePQAccount, Factory, pqUSDC pools |
| 3:47 | Follow: Uniswap LP → add · remove → v4 PoolManager → PQ pool hooks, and the arrow round to PQGuardHook |
| 4:01 | Follow: Exitable pools → AES-128 on chain; then back down to the PQ AUTH CORE |

## 5. The close (4:13–4:30)

**Say this, as one paragraph:**

> Opaque: the post-quantum security layer for Ethereum. Live on Sepolia and the EIP-8141 devnet, with 154 contract tests, 396 backend tests and eight browser suites. One operator today; multiple independent operators before mainnet.

**On screen:**

| Time | Show |
|---|---|
| 4:13 | The GitHub README's top: logo, badges, diagram |

## Before you record

- **The autopilot plays the demo, in the real site.**
  - It's on now (`npm run demo:on` was deployed). Open a private window, so the wallet is a fresh one, and go to `opaque.credit/?demo=swarnim`. It claims `swarnim.opaque.eth`; `?demo` alone claims `mumbai-<4 hex>`.
  - Start the screen recording, then press **Play**. The front page's opening plays and the page scrolls to the end by itself (0:00 to 0:35). The wallet opens and holds 12 seconds on the demo's aims (0:35). Then it types and clicks through 3.1 to 3.7, across the Sepolia wallet, the devnet and the Q-Day page, with a cursor and a caption. Every transaction is real, and Opaque's faucet funds the new wallets.
  - While the chain works, a **Waiting · cut** tag shows in the corner: cut those stretches. Uncut, a run takes about 30 minutes.
  - **Esc** or **Stop** ends a run. If a step fails, the caption says why; reload the page to try that step again.
  - Record the architecture (2:15) and the close (4:13) separately, over `diagrams/opaque.svg` and the README.
  - When the video is done: `cd frontend && npm run demo:off`. The site is deployed again with no demo code in it.
- **The backend's logs, for 3.2.**
  - In a terminal beside the browser: `railway logs --service opaque-sepolia`. Or open the Railway dashboard → the `opaque-sepolia` service → **Logs**.
  - Make the font large. The lines to look for start with `mesh exit`, `settler`, `egress` and `chain`.
- **Tabs for the rest of the video:** the Mumbai page, the README on GitHub, `diagrams/opaque.svg`.
- **Make sure each stack answers:** `opaque-sepolia-production.up.railway.app` and `opaque-eth-devnet-production.up.railway.app`.
- **Screen:** an Incognito window (no extensions, a fresh wallet); notifications off.

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
| The autopilot stops | The caption says why. Reload to try that step again, or finish it by hand; a new Incognito window starts a fresh run. |
| A payment says "MESH_UNAVAILABLE" | The autopilot presses Send again, up to three times; nothing was spent. |
| Anything else | Show the recorded browser-test output: `scripts/e2e-sepolia.ts` (33 checks, including the exit with Opaque blocked), `e2e-devnet-private.ts`, `e2e-vault.ts`, `e2e-eth-connect.ts`. |

Never claim more than the page shows. The honest lines stay in, because judges trust them:
- the attester is trusted for whether a spend is valid;
- one operator runs everything today;
- the anonymity set is the ring of 8;
- the quantum-safe page hands over what the chain shows (owners, proxy and beacon admins, every AccessControl role, an AccessManager's admin role), not a Safe's owners or a contract's custom admin variables.
