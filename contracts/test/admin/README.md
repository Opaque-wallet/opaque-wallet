# contracts/test/admin: the quantum-safe admin's tests

## Index

| File | Tests |
|---|---|
| [`PQAdmin.t.sol`](PQAdmin.t.sol) | 12 tests of [`PQAdmin`](../../src/ethereum/admin/PQAdmin.sol), against OpenZeppelin's own `ProxyAdmin`, `TransparentUpgradeableProxy`, `Ownable2Step`, `AccessControl`, `UpgradeableBeacon` and `BeaconProxy` |

They show:
- the demo protocol starts with two ECDSA admin keys;
- an admin is refused for a guardian with no key;
- its address is known before it exists;
- after the handover, the ECDSA key alone changes nothing;
- a signed upgrade goes through, whoever sends it;
- a signature runs once, and only the call it names;
- one admin's signature can't drive another;
- an expired signature is refused;
- a failed call reverts and keeps the signature unspent;
- `Ownable2Step` hands over with a signed accept;
- an AccessControl admin role hands over;
- every role and a beacon hand over in the order the page uses, after which the ECDSA key alone can't upgrade, set the fee, pause or take a role back.

A stand-in registry marks payloads as signed. The real `PQKeyRegistry` and real FORS+C signatures are checked on Sepolia by [`backend/ethereum/admin-sepolia.ts`](../../../backend/ethereum/admin-sepolia.ts).

```bash
cd contracts && forge test --match-path test/admin/PQAdmin.t.sol
```
