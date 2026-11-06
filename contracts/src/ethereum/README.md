# contracts/src/ethereum: Ethereum-only contracts

New behavior for Ethereum lives here, as adapters. The audited contracts in [`../opaque/`](../opaque/) deploy unchanged.

## Index

| Folder | What | README |
|---|---|---|
| [`uniswap/`](uniswap/) | Three Uniswap v4 hooks: `PQGuardHook`, `PQAccountPoolHook`, `PQPoolHook` | [README](uniswap/README.md) |
| [`ens/`](ens/) | ENSv2: `PQNameController` (holds opaque.eth), `OpaqueNames` (name.opaque.eth) | [README](ens/README.md) |
| [`vault/`](vault/) | `PQVault`, the Q-Day vault for MetaMask users | [README](vault/README.md) |
| [`admin/`](admin/) | `PQAdmin`: any protocol's admin keys, moved to a FORS+C key with one button | [README](admin/README.md) |
| [`frame/`](frame/) | `LeanFors`, FORS+C verification that fits EIP-8141's 100k validation budget | [README](frame/README.md) |

The EIP-8141 account itself (`FramePQAccount` and its factory) is in [`contracts/frame/`](../../frame/README.md), which builds on its own (solc 0.8.28).

The tests are in `contracts/test/`, one folder per partner: [`test/uniswap/`](../../test/uniswap/) and [`test/ens/`](../../test/ens/).
