# frontend/src/ethereum/ens

## Index

| File | What |
|---|---|
| [`ens-name.ts`](ens-name.ts) | ENS in the wallet: `resolveName` (UniversalResolverV2, coin 60 on Sepolia, ENSIP-11 `0x80000539` on the devnet), whether a FORS+C key holds the name, `opaqueNameOf`, `opaqueNameFree` and `opaqueClaimOf` (the claim's transaction, for Activity). In the browser, every lookup goes through EF's anon-rpc. |

The Names tab that uses it is in [`src/app.ts`](../../app.ts) (`setupSubname`), and the full write-up is [partner-docs/ethglobal-mumbai/ens.md](../../../../partner-docs/ethglobal-mumbai/ens.md).
