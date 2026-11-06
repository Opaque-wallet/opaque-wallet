# contracts/test/uniswap

## Index

| Test | Tests | What it covers |
|---|---|---|
| [`PQGuardHook.t.sol`](PQGuardHook.t.sol) | 8 | `PQGuardHook`: v4's selectors; a position needs a guard key to be funded; nothing comes out without the FORS+C signature; a signed removal pays only its signed recipient, once; deadlines; only the PoolManager calls. Also `PQAccountPoolHook`: a PQ account swaps and an ECDSA wallet doesn't, and a proxy to another implementation isn't admitted. |
| [`PQPoolHook.t.sol`](PQPoolHook.t.sol) | 7 | `PQPoolHook`: v4's selectors; the permission bits in the address; only existing factory accounts; swaps and liquidity through Uniswap's periphery; an ECDSA wallet refused; another router counts as itself; only the PoolManager calls. |

```bash
cd contracts && forge test --match-path 'test/uniswap/*'
```

The contracts are in [`contracts/src/ethereum/uniswap/`](../../src/ethereum/uniswap/README.md).
