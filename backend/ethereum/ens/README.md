# backend/ethereum/ens

ENSv2 from TypeScript.

## Index

| File | What |
|---|---|
| [`ens.ts`](ens.ts) | The FORS+C signed-call formats `PQKeyRegistry` checks: `signExecute` (a `PQNameController` call), `signAction` (any registry user action: the Q-Day vault, the v4 guard), `signRotation`, plus `masterKey` and `commitmentOf`. Node and the browser alike. |
| [`ens-sepolia.ts`](ens-sepolia.ts) | opaque.eth on Sepolia: `deploy` (the controller, its key and its resolver), `adopt` (set the resolver), `records` (every record in one signature), `names` (deploy `OpaqueNames`, set it as the subregistry) and `status` (every role, and an ECDSA write refused). Run: `OPAQUE_NETWORK=sepolia node --use-system-ca ethereum/ens/ens-sepolia.ts status`. |

The contracts are in [`contracts/src/ethereum/ens/`](../../../contracts/src/ethereum/ens/README.md), and the full write-up is [partner-docs/ethglobal-mumbai/ens.md](../../../partner-docs/ethglobal-mumbai/ens.md).
