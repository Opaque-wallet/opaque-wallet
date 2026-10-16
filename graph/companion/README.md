# Opaque Privacy Sentinel — Graph Client Companion

This is the public privacy-context service for judges and developers. It is not
imported by Opaque's wallet, ring client, relay mesh, CRE workflow, contracts,
or settlement backend.

It composes two live Graph-provider sources through [The Graph Client](https://thegraph.com/docs/en/subgraphs/querying/graph-client/README/):

1. Opaque's live Arc testnet Studio subgraph: ring cohort and relay-mesh aggregates.
2. The Graph Network's pinned [Arbitrum USDC subgraph](https://thegraph.com/explorer/subgraphs/9J9RwHsMK3vNoZaoMcHJuCeuDhUZmJ5fqvS59c4ZSmEQ?chain=arbitrum-one&view=About): an intentional independent public settlement-liveness context.

## Safety boundary

The generated query asks only for public aggregates and public transfer records. It never queries or accepts a real note, recipient, selected decoys, final route, private key, proof witness, or sealed CRE intent.

`UNKNOWN` and `STALE` are companion display states only. They cannot delay, approve, route, sign, or settle a payment.

## Build generated Graph Client artifacts

Opaque's live Studio source needs **no key**; it is queried directly at its
public, rate-limited Studio endpoint. The intentional independent second
source—the Arbitrum USDC subgraph on **The Graph Network**—needs a gateway key.

To enable that external source, create `graph/.env` locally:

```bash
GRAPH_GATEWAY_API_KEY=...
```

Then run:

```bash
cd graph
/Users/adityamane/.bun/bin/bun run companion:build:live
```

The command produces ignored `.graphclient/` artifacts from the two pinned source schemas. It explicitly passes the local env file to Graph Client, whose Node CLI does not inherit Bun's automatic env loading. Without this key, the Sentinel continues to read Opaque Studio and reports the independent settlement context as `UNKNOWN`. Do not commit the key or generated credentials.

## Read-only MCP interface

After building the client, run:

```bash
cd graph
/Users/adityamane/.bun/bin/bun run sentinel:serve
```

The server exposes exactly three zero-argument, read-only tools:

| Tool | Result |
| --- | --- |
| `get_privacy_context` | current/stale/unknown public condition summary |
| `explain_privacy_readiness` | why the public ring or mesh condition is weak/strong |
| `list_public_privacy_signals` | the aggregate signals used by the companion |

It is deliberately **not** a payment API. No tool accepts a note, recipient, decoy list, route, proof, key, or CRE intent.

## Demo statement

> Opaque's operational privacy coordination continues to use its existing, tested Graph boundary. This companion composes live Graph data solely to make public privacy conditions inspectable and explainable.
