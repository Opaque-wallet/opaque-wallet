<div align="center">

# Opaque partner evidence

### Three integrations. One end-to-end private settlement rail.

[![Arc](https://img.shields.io/badge/Arc-USDC%20settlement-FF7A18?style=flat-square)](arc.md)
[![Chainlink](https://img.shields.io/badge/Chainlink-confidential%20policy%20release-375BD2?style=flat-square)](chainlink.md)
[![The Graph](https://img.shields.io/badge/The%20Graph-privacy%20coordination-6747ED?style=flat-square)](the-graph.md)

</div>

![Opaque partner architecture](../diagrams/e2e.svg)

| Partner | The role it plays in Opaque | Judge-ready evidence |
|---|---|---|
| **[Arc + Circle](arc.md)** | Settlement chain, USDC money and gas, ERC-4337 accounts, denomination pools, CCTP V2 onboarding. | Live Arc addresses, USDC flow, CCTP transaction, deployment and source map. |
| **[Chainlink CRE](chainlink.md)** | Confidential authority for sealed privacy thresholds, deadlines, and payment-release decisions. | Active AWS Nitro workflow, Vault DON secrets, release flow, deployment evidence. |
| **[The Graph](the-graph.md)** | Privacy coordination layer: public conditions powering local decoys, Markov paths, and CRE readiness. | Live Arc subgraph, schema, mappings, score formula, trust boundaries. |

Each page answers the same four questions:

~~~text
What did Opaque build with this partner?
Why is it load-bearing rather than decorative?
What can a judge inspect live or in source?
What privacy boundary does the integration preserve?
~~~

[Back to the main README](../README.md) · [Module interfaces](../docs/interfaces.md) · Deployment map: [mainnet](../deployments/arc-mainnet.json) · [testnet](../deployments/arc-testnet.json)
