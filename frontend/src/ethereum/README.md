# frontend/src/ethereum: the Ethereum-only wallet code

The Sepolia wallet is the shared EVM wallet (`frontend/app.html`, `src/app.ts`), built with `VITE_NETWORK=sepolia`. This folder holds what only Ethereum has.

| File | What it does |
|---|---|
| [`devnet.ts`](devnet.ts) | "Ethereum Devnet (Fully post-quantum)" at [/testnet/devnet](https://www.opaque.credit/testnet/devnet): the EIP-8141 wallet. Private pqUSDC by default, with Deposit, Send, Swap (the post-quantum v4 pool), Privacy, Receive and Activity tabs and an Accounts picker. Every transaction is a FORS+C frame transaction, and gas is topped up from the faucet when the account has none. |
| [`devnet-private.ts`](devnet-private.ts) | The devnet's privacy layer in the page: notes in seven pools, ring proofs built in a worker, sealed and carried by three relays. |
| [`connect.ts`](connect.ts) | "Connect with Opaque": the window a dapp opens through [`lib/opaque-eth-provider.ts`](../lib/opaque-eth-provider.ts). It names the site from `event.origin`, shows each call, and sends it as one ERC-4337 operation the account's FORS+C key signs. |
| [`ens-name.ts`](ens-name.ts) | ENS names in Send: UniversalResolverV2 on Sepolia, coin 60 or ENSIP-11 for the devnet, every lookup through EF's anon-rpc, and whether a FORS+C key holds the name. |

## Related, in `src/lib/`

| File | What it does |
|---|---|
| [`opaque-eth-provider.ts`](../lib/opaque-eth-provider.ts) | An EIP-1193 provider announced with EIP-6963, so dapps list Opaque beside MetaMask (`rdns: credit.opaque`). The extension's `inject.ts` announces it. It never sets `window.ethereum`. |
| [`stealth.ts`](../lib/stealth.ts) | Post-quantum stealth payments in the wallet: publish the ML-KEM-768 key, pay a one-time address, scan announcements, sweep. |
| [`anon-rpc.ts`](../lib/anon-rpc.ts) | EF's anon-rpc (the Nox mixnet), for ENS always, and for the whole account with the Privacy switch. |
| [`without-opaque.ts`](../lib/without-opaque.ts) | The exit: a note leaves its pool through anon-rpc and a public bundler, with no Opaque server in the path. |

## Pages

| Page | URL |
|---|---|
| [`app.html`](../../app.html) (Sepolia build) | [/sepolia/app](https://www.opaque.credit/sepolia/app) |
| [`devnet.html`](../../devnet.html) | [/testnet/devnet](https://www.opaque.credit/testnet/devnet) |
| [`eth-connect.html`](../../eth-connect.html) | /sepolia/eth-connect: the dapp approval window |
| [`vault.html`](../../vault.html) | [/sepolia/vault](https://www.opaque.credit/sepolia/vault): the Q-Day vault, for MetaMask users |
| [`public/connect-opaque.html`](../../public/connect-opaque.html) | [/connect-opaque](https://www.opaque.credit/connect-opaque): a dapp to try Connect with Opaque on |
| [`public/ethglobal-mumbai.html`](../../public/ethglobal-mumbai.html) | [/ethglobal-mumbai](https://www.opaque.credit/ethglobal-mumbai) |
