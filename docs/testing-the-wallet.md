# Testing the wallet

The wallet at `frontend/app.html` is wired to the real protocol and settles
real private payments on Arc testnet. This is how to run it.

## What is real, and what is standing in

| | In this build |
|---|---|
| Pool | **Real.** `PrivatePool` + `AttestedRingVerifier` on Arc, RING_8 |
| Ring proof | **Real.** 219-rep ZKBoo, built in your browser; the note secret never leaves the page |
| Attestation | **Real.** FORS+C, verified on chain by `PQKeyRegistry` |
| Mesh | **Real onions, one operator.** Six relays on one machine collude by construction. The directory's trust root is compiled into the wallet |
| CRE | **Simulated.** An ordinary process holds `INTENT_KEY`; nothing it opens is confidential |
| Credential authority | **Test.** Issues for any recipient |
| PQ account | **Real.** FORS keys in IndexedDB, an ERC-4337 account from `PQAccountFactory`. Its deposits and withdrawals are UserOperations only its FORS key signs, sent to the bundler through the mesh |
| Ring source | **Real deposits** from the pool's events, weighed by the subgraph's use counts and funding buckets |
| Relay health | **Real, one operator.** Reported on chain to `RelayDirectory`, indexed by the subgraph, clamped before it weighs a path |

The wallet shows this line at the bottom of the page, read from the pool and
the stack rather than hardcoded.

## Run it

Three terminals.

```bash
# 1 — the backend: six relays, the exit, the CRE stand-in, the egress
cd backend && set -a && . ./.env && set +a && node stack.ts

# 2 — the wallet
cd frontend && npx vite

# 3 — open it
open http://127.0.0.1:5173/app.html
```

`stack.ts` writes `frontend/public/stack.json` each time it starts. Reload the
wallet after restarting the stack.

## Pay someone

1. **A wallet.** The page opens on onboarding: create a 12-word recovery
   phrase, or import one (the same phrase the XRPL page uses: one wallet, every
   chain). Then send USDC to the account's *Receive* address from any wallet or
   exchange; Opaque never connects to one. On testnet, get it from
   [faucet.circle.com](https://faucet.circle.com) (Arc Testnet). It pays gas
   too, so nothing else needs funding.
2. **Deposit.** On testnet, USDC that reaches the address becomes notes by
   itself, as much as one deposit holds; a deposit that fails is not retried
   until the page reloads, since each try signs with the few-time key. On
   mainnet, which is not audited yet, it waits: set *Deposit amount* in whole
   USDC and press *Deposit*. Either way it becomes the fewest notes of 1, 2,
   5, 10, 20, 50 and 100 USDC: 123 is 100 + 20 + 2 + 1.
   Each size has its own pool, because a ring is formed only among notes of
   one size (spec §6.6), and a pool fills from anyone's deposits. A note can
   be sent once its pool holds 8; the field says when part of a deposit will
   wait for that, and the balance shows how much is waiting.

   Deposits come from your **PQ account**, as one UserOperation its FORS key
   signs however many notes and pools it covers; a public bundler submits it.
   The first one also deploys the account. It is paid from USDC at the
   account's address. Each deposit keeps 0.2 USDC in the account for gas, and
   what gas does not use pays for the next one. Each deposit uses one of the
   key's 32 signatures, shown under *Signing key*.

   The deposit is public by design — it is the *spend* that is private. A
   note shows as spendable once the chain confirms it, never before.
3. **Send.** Set the amount in whole USDC, enter a recipient, and press
   *Review private transfer*. It is paid with the fewest of your notes that
   make it exactly, one payment each, so 100 USDC is one payment and 123 is
   four. A note is spent whole, with no change: holding one 100-USDC note, you
   can send 100 but not 30. Each payment's proof is built in a worker (a few
   seconds), sealed, and sent across the mesh as ~35 chunks. Several to one
   address are easier to link to each other than one. Amounts like 2.37 are
   not possible: hiding them needs elliptic-curve range proofs, which this
   design rules out.
4. **Watch Activity.** A payment usually settles within seconds. It goes as
   soon as the privacy score (the lower of pool coverage and relay health)
   reaches 70/100, and waits only while the relays look unhealthy or their
   health is unknown — for an hour at most, then it goes anyway. The wallet
   sets both; there is nothing to tune. A *view settlement* link appears when
   it lands.

The network tab shows a stream of `204`s from `/v1/status/…` while a payment is
in flight. Those are the wallet polling for an answer that has not arrived yet.
A relay gives the same empty `204` for "not yet", "no such drop" and "already
collected": answering them differently would tell anyone probing which drops
are live.

## Run it without clicking

```bash
cd backend && set -a && . ./.env && set +a
node scripts/e2e-wallet-browser.ts      # drives the real page in headless Chrome
node chain/e2e-ring-payment.ts          # the same payment path, from Node
node chain/e2e-pq-account.ts            # a PQ account: deploy, fund, deposit by UserOperation
```

The first two spend a real seeded note and burn one attester index; the third
costs about 1.2 USDC. They are scripts you run on purpose, not tests that run
themselves. `E2E_PQ=1` (with `E2E_WALLET_KEY`) makes the browser run deposit
from the page's PQ account.

## Two budgets to watch

- **The attester's FORS key has 32 signatures.** Each settled payment uses one.
  The stack rotates to the next key when 4 are left, and an exhausted key
  hands over to its pre-committed successor. The registry refuses a 33rd
  signature rather than letting forgery odds climb.
- **Your account's FORS key has 32 too,** two of them held back for rotation
  and disable.
- **Seeded notes.** `backend/chain/seed-ring.ts` put 8 in the pool; the two
  e2e runs spent two of them. Deposit more, or seed more, to keep a full ring.

## What the page never sends directly

The page opens no connection to an RPC, a bundler, the subgraph or a font CDN. Every read
it makes, and every UserOperation, goes through the mesh as a `WALLET_RPC`
query. The exit answers it against a strict allowlist
(`backend/chain/wallet-rpc.ts`). Neither the RPC nor the bundler learns which
wallet asked, and nobody learns which nullifier is yours before it is spent.
The browser e2e fails if the page sends any such request itself.

The one exception is the **funding wallet**: deposits made before activation,
and a disable. Those transactions, and the reads they need, go through the
wallet's own provider (MetaMask's RPC). They name that wallet on chain
whatever route they take. A content blocker that blocks `rpc.testnet.arc.io`
in the page no longer breaks anything.

## Swap

**Swap** trades tokens at the account's address on Arc (USDC and EURC; cirBTC too on mainnet) through [LI.FI](https://li.fi), which picks the best route across exchanges (KyberSwap on mainnet, Fly on testnet). It is **public**, like a deposit: the account swaps what its address holds, in one UserOperation its post-quantum key signs (approve LI.FI's contract exactly the amount, then its call). Arc's private pools hold only USDC, so a swap cannot pass through them; what you get becomes private once it is USDC in your notes.

- Routes are asked through the mesh: the exit calls LI.FI (`SWAP_QUOTE`, chain/wallet-rpc.ts), so LI.FI sees Opaque's server, never the browser. Previews are quoted for a placeholder address; the account is named only when Swap is pressed.
- The wallet checks every route before signing: it must call LI.FI's contract pinned in `deployments/` (`swap.router`), ask for no USDC on top, and pay the account itself.
- On testnet, USDC at the address becomes notes by itself; switch that off on Home to keep USDC for a swap.
- Nothing is left over on Arc: a swap is at the address, in any amount, and a deposit's fraction of a USDC stays there, paying gas and joining the next deposit (Home says how much).
- e2e: `npm run arc:e2e:swap [-- <origin>] [--fund]` (a quote with no funds; with `--fund`, 1 USDC → EURC and back).

## Accounts and the recovery phrase

One phrase holds every account on every chain: the account list on the Arc
page is the XRPL page's, and opening an account on one opens it on the other.
Each Arc account is a PQ account at one address, which you can share as often
as you like; the list shows it under each account, with a copy button. Code:
[frontend/src/lib/arc-keys.ts](../frontend/src/lib/arc-keys.ts).

- **Everything comes from the phrase.** An account's PQ key at each epoch
  draws its seed from the account's key under `arc/<chain id>/fors/<epoch>`,
  and its i-th note in a pool under `arc/<chain id>/note/<pool>/<i>`. The
  address is CREATE2 of the first two keys and a fixed first deadline
  (2100-01-01), so the words alone give it back. Each chain id has keys of its
  own: mainnet and testnet addresses differ, and no key signs on two chains.
  The known-answer test pins this.
- **Importing finds it all again.** The key in force is found on chain, however
  many rotations later (`adoptWallet` in packages/pq-wallet), with a signing log
  as long as the chain's use count plus two, for signatures another device may
  have made that never landed. Notes are found among each pool's deposits, by
  index, until 40 in a row are absent. An imported phrase's Account 1 then
  looks for its other accounts (registered, or holding USDC). **Rescan Arc** in
  the account menu looks again.
- **Before each deposit** the wallet catches up with deposits another device
  made, so no note index is used twice. If another device rotated the key, the
  page rebuilds its copy of the keys from the chain once.
- **One device at a time** for signing: a few-time key is weakened by every
  signature, and two devices each count only their own.
- **The browser account.** An Arc account from before phrases stays as
  **Browser account**, backed up by file, and opens first on the first visit.

## The wallet password

Everything secret the wallet stores is sealed under a password, as MetaMask's
vault is. Code: [frontend/src/lib/lock.ts](../frontend/src/lib/lock.ts).

- **Set once:** made in onboarding, right after the phrase (or an import, or a
  passkey restore). A wallet from before passwords (a phrase, an imported key,
  notes or Arc keys, and no password) opens on **Set a password** and goes no
  further until it has one; setting it seals what is already there.
- **Shown again only with it:** **Show recovery phrase** and **Show account
  key** ask for the password first, even while unlocked.
- **What is sealed:** a random data key seals, with AES-256-GCM, every
  local-storage record that is secret or says what you hold or paid (the
  `SECRET` pattern: phrase, imported keys, notes, app accounts, the passkey
  backup's keys, balances, activity), and adds a keyed layer to each Arc
  signing key's ciphertext in IndexedDB (the same length, so the signing
  package's own checks pass). The password, through PBKDF2-SHA256 (600,000
  rounds), only wraps the data key: **Change password** re-wraps one value.
- **How:** lock.ts replaces localStorage's getItem and setItem, so every reader
  stays as it was; locked, they throw for those records, and each page awaits
  `unlockGate()` before it opens anything.
- **Unlocked:** the data key stays for the tab (sessionStorage; in the
  extension, `chrome.storage.session`, memory only), until 15 idle minutes, the
  tab closing, or **Lock now**. A dapp's popup on the website is a tab of its
  own, so it asks too.
- **Forgotten:** the lock screen's Reset removes the wallet from this browser;
  the phrase or the passkey brings it back. Another tab that still holds the
  old key locks at once (the stored key's `id` changed).
- **Test:** `npm run e2e:lock [-- <origin>]`: 20 checks, including a wallet
  from before passwords and the reveal prompts. The origin can be a vite dev
  server (`http://127.0.0.1:5199`, with `VITE_STACK_URL` and
  `VITE_XRPL_STACK_URL` pointed at the hosted services). Every browser test gives its wallets the password
  `PASSWORD` (scripts/xrpl-wallet-page.ts).

## The passkey backup

Clearing the browser deletes the phrase with everything else; a passkey backup
brings it back without typing it. Code:
[frontend/src/lib/passkey-backup.ts](../frontend/src/lib/passkey-backup.ts),
store [backend/mesh/backup-store.ts](../backend/mesh/backup-store.ts).

- **Offered once** right after a wallet is made or imported, then from a card
  on Home and in **Accounts → Passkey backup**. Touch ID, Face ID, a phone or a
  password manager makes the passkey; it syncs where that manager syncs.
- **What it holds:** the phrase, imported account keys, and the XRPL Browser
  account's unspent notes, tags and app accounts. Not Arc's Browser account: its
  few-time key must never come back from a copy older than its last signature.
- **How:** the passkey's PRF secret gives the backup's id, its write token and
  the key that wraps the backup's own key. The page seals the backup, then it
  crosses the relays (mesh query `BACKUP`); the store keeps ciphertext under an
  id it cannot link to anyone. The data key stays in the browser, so changes are
  re-sealed within a minute without the passkey.
- **Restore:** on the first screen, **Restore with a passkey**. Works on the Arc
  and XRPL pages alike: one store serves every chain.
- **Remove backup** deletes Opaque's copy and asks the password manager to drop
  the passkey (Chrome 132+).
- **Test:** `npm run e2e:passkey [-- <origin>]` (Chrome's virtual authenticator,
  with PRF): 9 checks.

## Deployers (Arc)

Accounts → **Deployers** gives a phrase account plain Arc addresses for
contracts and scripts. Code: `deployerKey` in
[frontend/src/lib/arc-keys.ts](../frontend/src/lib/arc-keys.ts).

- **New deployer:** the i-th key is drawn from the account key
  (`arc/<chain id>/deployer/<i>`), so the phrase brings every deployer back. One
  another browser already funded is skipped.
- **Fund privately:** opens Send with the deployer's address. It is an ordinary
  private send, so on chain the pool paid the deployer. Arc pays gas in USDC,
  so the deployer can deploy straight away.
- **Show key:** asks for the password, then shows `PRIVATE_KEY=0x…` for a
  project's `.env` (forge, hardhat, viem). That key only holds what you sent
  it; the account key never leaves the wallet.
- **Keep it unlinked:** use one deployer per project. Leftover USDC sent back
  to your account would link the two, so leave it, or deposit it into the pool
  from the deployer.
- **Test:** `npm run arc:e2e:deployer [-- <origin>]`: 8 checks, no USDC needed,
  including that the credential a send to it needs comes across the mesh.

## Contracts (Arc)

The **Contracts** tab deploys and calls contracts from the account itself, so
its FORS+C key signs everything and no classical key ever controls them. Code:
[frontend/src/lib/contracts.ts](../frontend/src/lib/contracts.ts).

- **Deploy:** one call from the account to the CREATE2 factory
  (`0x4e59b448…956C`, on Arc mainnet and testnet): salt ‖ initcode. The screen
  shows the address before it is sent. A constructor's `msg.sender` is the
  factory, so contracts take their owner as an argument: the account address.
- **Call:** an address and calldata (`cast calldata …`), as one operation.
- **Large bytecode:** a query too big for one mesh message (over 28 KB, which
  a deploy with its 9 KB signature reaches at about 5 KB of bytecode) crosses
  as chunks: the payment chunk upload, with a commit marked `query`
  (mesh/client.ts, cre/executor-server.ts). Up to EIP-3860's 48 KB.
- **Unlinked:** use an account funded only by private sends; turn testnet
  auto-deposit off (the screen offers it), or its gas becomes notes.
- **Test:** `npm run arc:e2e:contracts [-- <origin>] [--fund]`. Without
  `--fund`, 5 checks and no USDC (the unfunded deploy stops at AA21, after its
  chunked estimate). With it, send 2 testnet USDC to the printed address; it
  deploys `contracts/test/fixtures/OwnedNote.sol` (17.8 KB with its blob) and
  makes an owner-only call, checked on chain.

The public docs are at [opaque.credit/docs](https://www.opaque.credit/docs)
(`frontend/public/docs.html`).

## Your account's controls

Under *Accounts* and *Signing key*:

- **Key rotation.** Automatic, with nothing to press. Once a quarter of the
  budget is left the wallet signs a rotation with the current key and the mesh
  exit submits it and pays for it, promoting the pre-committed next key, which
  starts with a fresh budget of 32, and committing another. Two signatures are
  held back so a key can always afford to rotate. The account cannot pay for
  this itself: a UserOperation spends a signature while it validates, so a
  rotation carried inside one would be signed for the wrong use count.
- **Withdraw.** Sends everything the account holds, less the gas for the
  withdrawal itself, to your funding wallet or any address you type. A few
  cents of prepaid gas stay with the EntryPoint and pay for the account's
  next operation.
- **Backup / Restore** (the browser account). One file holds the account's keys, with their signing
  logs, and your private notes, encrypted under a passphrase (PBKDF2, then
  AES-GCM). Restore writes into a fresh key store and never overwrites one.
  - A backup older than the account's chain state restores, but the wallet
    then refuses to sign with it: its signing log is behind, and signing
    could reuse an index.
  - Use a backup on one device at a time.

## Known gaps in this build

- Notes, and the phrase, live in `localStorage`. Any script on the origin can
  read them. Clearing site data destroys the browser account's unless you took
  a backup; a phrase account's come back from the phrase. A password lock is next.
  See `frontend/src/lib/note-storage.ts`.
- CRE is simulated: an ordinary process on the Railway box holds the key that
  opens sealed payments. It moves into a Chainlink enclave once deploy access
  is granted.
