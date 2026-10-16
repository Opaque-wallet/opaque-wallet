# Docs: Design and Operations

> **Why Opaque is built the way it is, and how to run it.**

The project overview is the [main README](../README.md). How each partner's technology is used is in [partner-docs/](../partner-docs/).

## Start Here

| Document | What it is |
|---|---|
| [interfaces.md](interfaces.md) | The frozen exports each module may depend on |
| [workspace.md](workspace.md) | Where each part of the code lives, and the boundaries between them |

## Design Notes

| Document | What it is |
|---|---|
| [settlement-paths.md](settlement-paths.md) | The two ways to settle a private payment, and why the attested ring path ships |
| [proof-transport.md](proof-transport.md) | How a 1.1 MiB proof crosses a mesh built for 64 KB messages |
| [cre-key-origin.md](cre-key-origin.md) | What Chainlink CRE supports for encrypted inputs, and the sealing path that needs no invented API |

## Running It

| Document | What it is |
|---|---|
| [hosting.md](hosting.md) | The Railway service, and the six-host layout |
| [deployment-arc-testnet.md](deployment-arc-testnet.md) | Every testnet address, explained. The data itself is `deployments/arc-testnet.json`; mainnet's is `deployments/arc-mainnet.json` |
| [testing-the-wallet.md](testing-the-wallet.md) | Running the wallet against real Arc, and what is real versus standing in |

## Current Design Decisions

| Question | Answer | Where |
|---|---|---|
| Can the ring proof be verified on chain? | No: 1.08 MiB and about 9 times an Arc block. It is verified off chain and attested | [backend/zk/README.md](../backend/zk/README.md) |
| Does the nullifier bind the recipient? | No. It binds the note secret and the pool only; binding the recipient would let one note be spent once per recipient. Spec §6.4 has it the wrong way round | [contracts/README.md](../contracts/README.md#privatepoolsol) |
| How many relays? | Six in the directory, three per payment. With three, every path visits every node and hop selection decides nothing | `MIN_POOL_RELAYS` in `backend/mesh/contracts.ts` |
| Can a relay tell a payment from a query? | No. The message kind is invisible until the last hop | [backend/mesh/protocol.md](../backend/mesh/protocol.md) |
| May the subgraph publish a funding cluster per member? | No. It publishes a coarse concentration bucket, only when five or more members share a funder | [graph/README.md](../graph/README.md) |
| Can a spend bypass the release decision? | Not through the executor: it cannot open a payment until the enclave releases that payment's key, and it refuses payments not sealed to the CRE key | [opaque-cre/README.md](../opaque-cre/README.md) |

## Superseded Scaffolds

`backend/opaque/{mesh,cre}` and `frontend/src/opaque/protocol` are the original plain-JS stubs. The working code is `backend/mesh`, `backend/cre` and `frontend/src/lib`.

## What Used to Be Here

This directory once held the design for nonce0, a cross-chain key-exposure scanner, and PQGuard, its authorisation layer. Both were dropped when the project narrowed to the payment stack. Nothing was lost:

```bash
git show 1dd4004:docs/<filename>      # read one file
git checkout 1dd4004 -- docs/         # restore the whole directory
```
