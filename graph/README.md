# Graph: The Opaque Subgraph

> **The Graph, Subgraph Studio, networks `arc` (mainnet) and `arc-testnet`. AssemblyScript mappings, TypeScript clients.**

Indexes the public side of Opaque on Arc: which deposits exist in each pool, how often each has been used in a ring, and how healthy each relay is. The Graph is Opaque's privacy coordination layer: it turns those public conditions into shared inputs for local decoy ranking, local Markov route selection, and Chainlink CRE's privacy score. The schema indexes pools and aggregates only, never which member or relay a payment used. The partner write-up is [partner-docs/the-graph.md](../partner-docs/the-graph.md).

## Deployed

| | Mainnet | Testnet |
|---|---|---|
| **Query URL** | [`…/opaque-mainnet/v0.3.0`](https://api.studio.thegraph.com/query/1760100/opaque-mainnet/v0.3.0) | [`…/opaque/v0.3.0`](https://api.studio.thegraph.com/query/1760100/opaque/v0.3.0) |
| **Slug** | `opaque-mainnet` | `opaque` |
| **Network** | `arc` | `arc-testnet` |
| **Manifest** | `subgraph.mainnet.yaml` | `subgraph.yaml` |
| **Data sources** | 7 RING_8 `PrivatePool`s and `RelayDirectory` | 8 `PrivatePool`s (7 RING_8 and the first single-note pool) and `RelayDirectory` |

Each URL is also `services.graphUrl` in that network's deployment file ([mainnet](../deployments/arc-mainnet.json), [testnet](../deployments/arc-testnet.json)). The wallet never queries it directly: its questions go through the relay mesh, and the exit asks on its behalf.

## Folder Structure

```
graph/
├── schema.graphql              # Entities, and what they must never hold
├── subgraph.template.yaml      # Manifest template; one data source per pool
├── scripts/render-manifest.ts  # Renders subgraph.yaml from the deployment file
├── abis/                       # PrivatePool, RelayDirectory
├── src/
│   ├── mapping.ts              #   Event handlers (AssemblyScript)
│   ├── client.ts               #   Typed client, checked against the pinned relay directory
│   ├── path-policy.ts          #   Markov relay hop selection
│   ├── privacy-score.ts        #   The readiness score the enclave and the exit share
│   └── index.ts                #   Exports
├── companion/                  # Read-only Graph Client composition
├── sentinel/                   # Read-only MCP server + Agent0 descriptor
└── test/                       # Client, policy, companion, and Sentinel tests
```

## Events and Entities

| Contract | Event | Handler | Updates |
|---|---|---|---|
| `PrivatePool` | `Deposited` | `handleDeposited` | `RingMember`, `RingPool.poolSize` |
| `PrivatePool` | `DepositFrom` | `handleDepositFrom` | `FundingCluster`, `RingMember.fundingConcentrationBucket` |
| `PrivatePool` | `RingUsed` | `handleRingUsed` | `RingMember.timesUsedInRing`, `lastUsedAt` |
| `RelayDirectory` | `RelayAnnounced` | `handleRelayAnnounced` | `RelayNode`, `RelayDirectory` |
| `RelayDirectory` | `RelayHealth` | `handleRelayHealth` | `RelayNode` reliability, occupancy, selection count |

| Entity | Holds |
|---|---|
| `RingMember` | A note commitment, its pool, enrolment time, use count, last use, funding bucket, other activity |
| `RingPool` | Deposits per pool and denomination |
| `RelayNode` | Endpoint, key commitment, operator, reliability, batch occupancy, recent selections, last seen |
| `RelayDirectory` | The directory version and node count |
| `FundingCluster` | Notes per depositor per pool; bookkeeping only, never linked from `RingMember` |

## What the Schema Refuses to Hold

Nothing may record which ring member or relay a given payment used. Publishing that would undo the ring and the mesh from the indexing side.

An earlier version published a funding-cluster id per member, which groups notes by their common funder: the linkage the ring exists to destroy. It was replaced by `fundingConcentrationBucket`, a coarse 0 to 3 share of the pool, emitted only when at least five members share the funder. Null means unknown and must never be read as zero.

## The Client's Rules

- **`getRingSnapshot(scope)`** returns the public members of one denomination bucket. The wallet selects decoys locally; nothing ever asks a remote service to exclude or locate the real note.
- **`getRelaySnapshot()`** returns health only for relays in the signed, pinned directory, and only after the key commitments match. The Graph cannot add a relay.
- **`getPrivacyConditions(scope)`** recomputes the score locally with a versioned formula:

```
ring  = min(10000, poolSize × 10000 / 8)
mesh  = 0 if fewer than 3 operators, else min(relay capacity, mean reliability)
score = min(ring, mesh)
```

An index with errors, or one that is stale, gives no score, so payments wait for their deadlines rather than go early.

## Setup

### Build and deploy a new version

```bash
cd graph
bun install --frozen-lockfile
bun run subgraph:render      # subgraph.yaml from deployments/arc-testnet.json
bun run subgraph:codegen
bun run subgraph:build
graph auth <deploy key>      # once, in your own terminal
graph deploy opaque subgraph.yaml --version-label v0.3.1

# mainnet: renders subgraph.mainnet.yaml from deployments/arc-mainnet.json
OPAQUE_NETWORK=mainnet bun scripts/render-manifest.ts
graph codegen subgraph.mainnet.yaml && graph build subgraph.mainnet.yaml
graph deploy opaque-mainnet subgraph.mainnet.yaml --version-label v0.3.1
```

Then point `services.graphUrl` at the new version. `render-manifest.ts` passes each pool's canonical `poolId` in as data-source context, so the mapping never reimplements protocol hashing in AssemblyScript.

### Test

```bash
bun test
bun run typecheck
```

## Composed Privacy Context

[`companion/`](./companion) uses **The Graph Client** to compose Opaque’s live
Arc Studio data with a pinned Graph Network Arbitrum USDC source. The sidecar
is intentional: it adds an independent public settlement-liveness signal while
Arc remains Opaque’s operational privacy source of truth. [`sentinel/`](./sentinel)
exposes the combined context via three zero-argument MCP tools for agents,
developers, and judges.

```bash
bun run companion:build:live
bun run sentinel:serve
```

Opaque’s own Studio subgraph is public and rate-limited—**no API key is used**.
Only the independent Arbitrum Graph Network USDC source needs
`GRAPH_GATEWAY_API_KEY` in a local `graph/.env`. Without it, Opaque’s
operational subgraph remains separate and the companion reports external
settlement context as `UNKNOWN`.

### What the composition contributes

```text
Opaque Studio on Arc ──────┐
                            ├─ Graph Client → public, aggregate-only privacy context
Graph Network USDC source ─┘
                                      ├─ Privacy Sentinel (judge/MCP inspection)
                                      └─ never the payment path
```

The client combines two live Graph-provider sources without making either one
a source of private payment data. It reports only public aggregate conditions:
pool/relay readiness from Opaque Studio and independent recent Arbitrum USDC
context from The Graph Network. It never receives the real note, recipient,
chosen decoys, route, proof, sealed intent, or authorization.

The wallet uses Opaque Studio's public candidate attributes to **rank the
strongest eligible decoys locally**: low ring reuse, low coarse funding
concentration, healthy activity, and age diversity. Graph informs that local
ranking; it never chooses a payer's final ring or route.

### Public MCP contract

| Tool | Returns | Inputs / authority |
|---|---|---|
| `get_privacy_context` | Aggregate ring freshness, mesh health, and external context state. | Zero inputs; cannot inspect a payment. |
| `explain_privacy_readiness` | A human-readable explanation of the current aggregate condition. | Zero inputs; cannot release or delay an intent. |
| `list_public_privacy_signals` | The signal families used by the public model. | Zero inputs; cannot choose decoys or a route. |

The MCP service makes the same aggregate privacy context inspectable without
requiring a user to disclose a payment, recipient, route, or selected ring.

### Public Privacy Sentinel deployment

The judge-facing Sentinel is a separate, read-only Railway service. It exposes
`/healthz` and Streamable HTTP MCP at `/mcp`; it cannot access the payment
stack or accept payment inputs. Follow the [Sentinel deployment guide](./sentinel/README.md#deploy-as-an-isolated-railway-service) and set only `GRAPH_GATEWAY_API_KEY` in that Railway service.

Its Agent0 descriptor can be pointed at the public `/mcp` URL after Railway
deployment.

## Reusable EVM Privacy Signals Substreams

[`../indexer/privacy-signals`](../indexer/privacy-signals) is a standalone
Substreams EVM package. It decodes the same public `Deposited`, `RingUsed`,
`RelayAnnounced`, and `RelayHealth` event ABI surface and emits one
aggregate-only `PrivacySignalBlock` per block. It deliberately omits
commitments, depositors, recipients, ring members, chosen routes, endpoints,
and KEM material.

This gives the privacy coordination model a reusable EVM indexing product:
another deployment can consume the same typed aggregate output without
depending on Opaque's wallet, mesh, CRE, contracts, or database.

## Tech Stack

| Technology | Purpose |
|---|---|
| **The Graph** | Indexing, Subgraph Studio hosting |
| **AssemblyScript** | Mappings |
| **TypeScript** | Clients, path policy, score |
| **Bun** | Manifest rendering |
