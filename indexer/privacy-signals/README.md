# Opaque Privacy Signals

A reusable **aggregate-only EVM Substreams module** for payment pools and relay directories. It is a separate data product: it reads public events and cannot call Opaque, select a decoy, choose a route, release an intent, sign, or move USDC.

## Output contract

| Public event | Exported aggregate | Explicitly never exported |
| --- | --- | --- |
| `Deposited` | one pool-population increment | commitment, depositor |
| `RingUsed` | ring cardinality only | all ring members, real position, nullifier, recipient |
| `RelayAnnounced` | relay id and public operator | endpoint, KEM key commitment |
| `RelayHealth` | reliability, occupancy, selection count | a user route or message id |

This stable protobuf output can power a Subgraph, an analytics pipeline, or a privacy coordinator on any EVM chain that emits the same event ABI.

## Build and test

```bash
cargo test
rustup target add wasm32-unknown-unknown
cargo build --target wasm32-unknown-unknown --release
substreams pack substreams.yaml
```

`substreams pack` and publication require the Substreams CLI plus a target provider. Those deployment credentials are intentionally not part of this repository.
