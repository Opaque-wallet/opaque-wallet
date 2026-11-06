# Quantum-safe admin: any protocol, one button

## Index

| File | What |
|---|---|
| [`PQAdmin.sol`](PQAdmin.sol) | `PQAdmin`, which calls out only on a FORS+C signature from its guardian's key in `PQKeyRegistry`, and `PQAdminFactory`, which makes one per guardian at a CREATE2 address known before it exists |
| [`DemoProtocol.sol`](DemoProtocol.sol) | A protocol to try it on: an OpenZeppelin `TransparentUpgradeableProxy` with two admin keys, its `ProxyAdmin` (upgrades) and an owner (the fee) |

- **Tests:** [`contracts/test/admin/PQAdmin.t.sol`](../../../test/admin/PQAdmin.t.sol).
- **On-chain proof:** [`backend/ethereum/admin-sepolia.ts`](../../../../backend/ethereum/admin-sepolia.ts).
- **The page:** [`frontend/quantum-safe.html`](../../../../frontend/quantum-safe.html), live at [opaque.credit/sepolia/quantum-safe](https://www.opaque.credit/sepolia/quantum-safe).

## Why

The largest Q-Day risk across Ethereum is admin keys: proxy admins, `owner()` roles and Safe signers, nearly all of them ECDSA. Whoever cracks one upgrades the protocol and drains it. A protocol doesn't need a new chain to fix that. It needs its admin to be something only a post-quantum key can drive.

## How it works

- **The handover.** The admin's wallet hands what it holds to its `PQAdmin`, in ordinary transactions:
  - an Ownable owner: `transferOwnership(pqAdmin)`. With `Ownable2Step`, the `PQAdmin` then accepts with a signed `acceptOwnership()`;
  - an OpenZeppelin `ProxyAdmin`: its `transferOwnership`;
  - an EIP-1967 admin held by the wallet itself: `changeAdmin`;
  - an AccessControl admin role: `grantRole` to the `PQAdmin`, then `renounceRole`.
- **Every admin call after that** is `execute(target, data, deadline, signature)`.
  - The signature covers `("opaque/v1/admin/execute", chainid, this admin, deadline, target, keccak(data))`.
  - `PQKeyRegistry.consume(guardian, …)` checks it at the key's use count and counts it. So it runs once, and only the call it names.
- **Anyone may submit a signed call.** Paying for it authorizes nothing.
- **The guardian is the wallet's own address**, and its key is the guard key the wallet registered. That's the same key the [Q-Day vault](../vault/README.md) and [`PQGuardHook`](../uniswap/README.md) use.
- **Rotation changes nothing here.** `PQAdmin` names the guardian, not a key, so when the key rotates the admin keeps working.
- **`PQAdminFactory.create` refuses a guardian with no key.** A contract handed to an admin no key can drive would be locked for good.

## On Sepolia

| Contract | Address |
|---|---|
| `PQAdminFactory` | [`0xd5fd1bed7558d1cdad40461547aec57d43d0b490`](https://sepolia.etherscan.io/address/0xd5fd1bed7558d1cdad40461547aec57d43d0b490) |
| `DemoProtocolFactory` / V1 / V2 | [`0xe093275c213795bf2689d02a86bd8fe92d53aa70`](https://sepolia.etherscan.io/address/0xe093275c213795bf2689d02a86bd8fe92d53aa70) / [`0x1c21de8c…3d52`](https://sepolia.etherscan.io/address/0x1c21de8c4ec284860ecd9df5d2d5b2e954943d52) / [`0x93d1d359…349f`](https://sepolia.etherscan.io/address/0x93d1d3593d1607d61a91a0509fc49cb6ccbb349f) |
| The example protocol, and its `PQAdmin` | [`0xbc8f8ff74223696dd76287330466d8d24f1687a0`](https://sepolia.etherscan.io/address/0xbc8f8ff74223696dd76287330466d8d24f1687a0), [`0x0833a5525ecf0df46d69c8eb1a9a7f5e53d7dcfb`](https://sepolia.etherscan.io/address/0x0833a5525ecf0df46d69c8eb1a9a7f5e53d7dcfb) |

What `admin-sepolia.ts` showed on chain, with the real registry and real FORS+C signatures:
1. the team wallet's ECDSA key alone can neither upgrade nor change the fee (`OwnableUnauthorizedAccount`);
2. another key's FORS+C signature is refused (`BadSignature`);
3. the real signature for one fee, replayed for another, is refused;
4. the signed fee change and the signed upgrade go through, sent by a different wallet:
   - fee change: [`0x78ae7501…`](https://sepolia.etherscan.io/tx/0x78ae75010d08fbd38b07f8054922b4069f620968a0955e88cf0ed40606d3f188);
   - upgrade, version 1 → 2: [`0x89c48132…`](https://sepolia.etherscan.io/tx/0x89c481322c702dc8e85406ce3d2b95f95b2c91f5a179e148c693bf3175bcdc09);
5. the guard key rotates ([`0x93175…`](https://sepolia.etherscan.io/tx/0x931750c9a47661ba7f30e709e730eb4f7ff715f65157016c8b1ddaeb5625e221)), and the next signed change goes through the same `PQAdmin` ([`0xd5f08dd9…`](https://sepolia.etherscan.io/tx/0xd5f08dd91e9a05b1da2787dcd4f5a8f55be6f7920589966d9726ab43b24090eb)).

## Run it

```bash
cd contracts && forge test --match-path test/admin/PQAdmin.t.sol                 # 11 tests
cd backend && OPAQUE_NETWORK=sepolia node --use-system-ca ethereum/admin-sepolia.ts
cd backend && node --use-system-ca scripts/e2e-admin.ts                           # the page, with a stand-in MetaMask
```

## The boundary

- **Gas:** each signed call carries a 9,251-byte signature and its on-chain check, about 430k gas.
- **The guardian's own address stays exposed,** like every ECDSA address. Only what it handed to the `PQAdmin` is protected.
- **Not covered:** Safe multisigs. A `PQAdmin` can be a Safe owner through `approveHash`, but this page doesn't do that yet.
- **Testnet only.** Tested, not audited.
