# contracts/test/ens

## Index

| Test | Tests | What it covers |
|---|---|---|
| [`PQNameController.t.sol`](PQNameController.t.sol) | 7 | Its key is registered under the controller itself; a FORS+C signature acts as the name's owner, once; another key gets nothing; the signature binds target, data and deadline; a late signature is refused; it accepts the name as an ERC-1155 token. Signatures come from [`test/fixtures/ens-controller-vectors.json`](../fixtures/), made by `backend/scripts/ens-vectors.ts`. |
| [`OpaqueNames.t.sol`](OpaqueNames.t.sol) | 6 | A wallet claims its name and it resolves to the wallet; only an Opaque PQ account can claim; a name is claimed once and a wallet holds one; labels are plain lowercase; a released name resolves to nothing and can be claimed again; other resolver profiles are unsupported. |

```bash
cd contracts && forge test --match-path 'test/ens/*'
```

The contracts are in [`contracts/src/ethereum/ens/`](../../src/ethereum/ens/README.md).
