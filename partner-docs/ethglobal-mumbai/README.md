<div align="center">

# ETHGlobal Mumbai: partner evidence

### Opaque on Ethereum: what we built with each partner, how it works, where it's deployed, and how to check it.

</div>

## Index

| Partner | Page | What's in it |
|---|---|---|
| **Uniswap** | [uniswap.md](uniswap.md) | The three v4 hooks; every flag and every callback (`beforeSwap`, and why there's no `afterSwap`); the guard's signature, transient storage and delta; the flows; errors and events; deployment addresses; tests |
| **ENS** | [ens.md](ens.md) | How ENSv2 lets a contract hold every role; `PQNameController` and `OpaqueNames` function by function; how opaque.eth was handed to the key, step by step; how a name resolves; the wallet; deployment addresses; tests |
| **Ethereum Foundation** | [ethereum-foundation.md](ethereum-foundation.md) | anon-rpc in the wallet; the exit that needs nobody (AES-128 on chain); ML-KEM-768 stealth payments; the private path; EIP-8141 frame transactions, `LeanFors` and the 100k budget; CROPS; deployment addresses |

## The diagrams

Each is drawn in Excalidraw; edit the `.excalidraw` file on excalidraw.com, or change [`backend/scripts/diagram-partners.ts`](../../backend/scripts/diagram-partners.ts) and run it again.

| Partner | Diagram | What it shows |
|---|---|---|
| Uniswap | [`diagrams/uniswap.svg`](../../diagrams/uniswap.svg) | Who calls the PoolManager, which callbacks each hook's flags turn on, the `actor` and post-quantum check behind every callback, and the guard's signed removal |
| ENS | [`diagrams/ens.svg`](../../diagrams/ens.svg) | Who controls opaque.eth, who can hold `name.opaque.eth`, and how a payer resolves one through anon-rpc |
| Ethereum Foundation | [`diagrams/ethereum-foundation.svg`](../../diagrams/ethereum-foundation.svg) | The FORS+C frame transaction, the exit with every Opaque server down, and post-quantum stealth payments |
| Any protocol | [`diagrams/any-protocol.svg`](../../diagrams/any-protocol.svg) | A protocol's admin keys before (one ECDSA key) and after one button (`PQAdmin`, which acts only on a FORS+C signature), with the cracked key refused |

## Where each partner's code is

| Partner | Contracts | Tests | Backend | Wallet |
|---|---|---|---|---|
| Uniswap | [`contracts/src/ethereum/uniswap/`](../../contracts/src/ethereum/uniswap/) | [`contracts/test/uniswap/`](../../contracts/test/uniswap/) | [`backend/ethereum/uniswap/`](../../backend/ethereum/uniswap/) | Swap tab in [`frontend/src/app.ts`](../../frontend/src/app.ts), devnet swap in [`frontend/src/ethereum/devnet.ts`](../../frontend/src/ethereum/devnet.ts) |
| ENS | [`contracts/src/ethereum/ens/`](../../contracts/src/ethereum/ens/) | [`contracts/test/ens/`](../../contracts/test/ens/) | [`backend/ethereum/ens/`](../../backend/ethereum/ens/) | [`frontend/src/ethereum/ens/`](../../frontend/src/ethereum/ens/), Names tab in [`frontend/src/app.ts`](../../frontend/src/app.ts) |
| Ethereum Foundation | [`contracts/frame/`](../../contracts/frame/), [`contracts/src/ethereum/frame/`](../../contracts/src/ethereum/frame/), [`ExitableRingVerifier`](../../contracts/src/opaque/pool/ExitableRingVerifier.sol) | [`contracts/test/LeanFors.t.sol`](../../contracts/test/LeanFors.t.sol), [`ExitableRingVerifier.t.sol`](../../contracts/test/ExitableRingVerifier.t.sol) | [`backend/ethereum/frame.ts`](../../backend/ethereum/frame.ts), [`frame-tx.ts`](../../backend/ethereum/frame-tx.ts), [`backend/chain/stealth.ts`](../../backend/chain/stealth.ts) | [`anon-rpc.ts`](../../frontend/src/lib/anon-rpc.ts), [`without-opaque.ts`](../../frontend/src/lib/without-opaque.ts), [`stealth.ts`](../../frontend/src/lib/stealth.ts) |

[All partner evidence](../README.md) · [ETHGlobal Mumbai submission](../../docs/mumbai/README.md) · [Main README](../../README.md)
