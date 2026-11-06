# ENSv2 names with post-quantum authority

opaque.eth on ENSv2 (Sepolia) is held by a contract that acts only on a FORS+C signature, and its subnames can be claimed only by post-quantum accounts. The partner write-up is [partner-docs/ethglobal-mumbai/ens.md](../../../../partner-docs/ethglobal-mumbai/ens.md).

## Index

| Contract | What it does | Sepolia |
|---|---|---|
| [`PQNameController.sol`](PQNameController.sol) | Holds opaque.eth's ERC-1155 token, and with it every ENSv2 role over the name. It's also the only admin of the name's PermissionedResolver. It calls out only through `execute(target, data, deadline, signature)`, on a signature from its key in `PQKeyRegistry` binding the contract, chain, target, exact calldata, deadline and use count. Anyone may submit. | `0x4d4df91933bb30640908f5cd4a42e2cac546c131` |
| [`OpaqueNames.sol`](OpaqueNames.sol) | opaque.eth's subregistry, and the resolver of every name in it. `claim(label)` only from an EIP-1167 clone of Opaque's `PQAccount`, one name per wallet. `release()` frees it. It answers `addr`, `addr(node, coinType)` and `resolve` for UniversalResolverV2. | `0x01f3419d2c8747f6b72032caf21a02fd0db44a28` |

## All the ENS code in this repo

| Where | What |
|---|---|
| here | `PQNameController`, `OpaqueNames` |
| [`contracts/test/ens/`](../../../test/ens/) | their 13 tests |
| [`backend/ethereum/ens/`](../../../../backend/ethereum/ens/) | the signed-call formats, the opaque.eth script |
| [`frontend/src/ethereum/ens/`](../../../../frontend/src/ethereum/ens/), [`frontend/src/app.ts`](../../../../frontend/src/app.ts) (`setupSubname`) | resolution in Send, and the Names tab |

## Why it works without changing ENS

ENSv2 gives every role over a name to whoever holds its token, and moves those roles with it (`PermissionedRegistry._update`). Transfer the token to `PQNameController`, and the name's only authority is its FORS+C key. There's no owner role left to route around.

## Tests

```bash
cd contracts
forge test --match-path test/ens/PQNameController.t.sol   # 7: a signature acts as the owner, once; another key gets nothing; binds target, data, deadline; takes the ERC-1155 token
forge test --match-path test/ens/OpaqueNames.t.sol        # 6: PQ-only claims, one per wallet, release, resolution
```

## Scripts

- `backend/ethereum/ens/ens-sepolia.ts deploy | adopt | records | status`: deploys, takes over the name, writes records in one signature, or reports where things stand.
- The signed-call format lives in `backend/ethereum/ens/ens.ts`.

Not audited. Testnet only.
