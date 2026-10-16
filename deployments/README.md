# Deployments: Every Public Address

> **One JSON file, read by the backend, the wallet, the deploy scripts and the subgraph renderer.**

[`arc-testnet.json`](arc-testnet.json) is the single source of truth for every public address and endpoint on Arc testnet: the network, USDC, every contract, every pool, the ERC-4337 EntryPoints and bundler, the relay directory's trust root and the service URLs. Public values only; never a private key, API key or MAC.

## Files

| File | Purpose |
|---|---|
| `arc-testnet.json` | The data |
| `arc-mainnet.json` | Arc mainnet, loaded when the network is `mainnet` |
| `index.ts` | The typed loader: `deployment`, `requireContract`, `requireService`, `poolFor`, `meshTrustRoot`, `entryPoint` |

## Choosing the network

`index.ts` loads `arc-testnet.json` unless told otherwise, and the choice is made at build or boot time, never by a server:

| Where | Variable | Values |
|---|---|---|
| Backend, scripts, subgraph renderer (Node/Bun) | `OPAQUE_NETWORK` | `testnet` (default), `mainnet` |
| Wallet (Vite build) | `VITE_NETWORK` | `testnet` (default), `mainnet` |
| Forge scripts | `DEPLOYMENTS` | `arc-testnet.json` (default), `arc-mainnet.json` |

Mainnet has its own attester, mesh master and egress key (`backend/mainnet.env`, gitignored). Nothing signs on both networks: FORS keys are few-time.

## Rules

- **`null` means not deployed.** The loader refuses it wherever a value is required. A zero address would fail silently on chain instead.
- **The wallet compiles this file in.** Pools and the relay trust root come from here, never from a server. A server that could name the pools could take the deposits.
- **Checked against the chain.** `backend/chain/test/deployments.test.ts` confirms every address has code and every pool reports the mode listed.

```bash
cd backend && node --test chain/test/deployments.test.ts
```

Human-readable notes on each address are in [docs/deployment-arc-testnet.md](../docs/deployment-arc-testnet.md).
