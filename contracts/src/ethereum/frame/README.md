# LeanFors: FORS+C verification that fits a public mempool

## Index

| File | What |
|---|---|
| [`LeanFors.sol`](LeanFors.sol) | The verifier. Its test is [`contracts/test/LeanFors.t.sol`](../../../test/LeanFors.t.sol); its user is [`contracts/frame/FramePQAccount.sol`](../../../frame/FramePQAccount.sol) |

## Why it exists

[`LeanFors.sol`](LeanFors.sol) is `ForsVerifier.recoverCommitment` with its hot loop in assembly, reading the signature from memory, where EIP-8141's `SIGDATACOPY` puts it.

The EIP-8141 devnet caps validation at `MAX_VERIFY_GAS` = 100,000 gas for every sender, staked or not. The audited verifier can't fit under it:

| Parameters | `ForsVerifier` | `LeanFors` |
|---|---|---|
| k=13, a=13 | 167k | **53.6k** |
| k=32, a=8 | 260k | 83k |

A whole VERIFY frame of [`FramePQAccount`](../../../frame/FramePQAccount.sol) uses 76,430 gas, under the public limit with room to spare. No private mempool or whitelisting is needed.

It's a second implementation of one function, so it is held to the first: [`test/LeanFors.t.sol`](../../../test/LeanFors.t.sol) checks the same commitment on both fixtures, the same verdict on 1,024 fuzzed tamperings, and the same reverts.

```bash
cd contracts && forge test --match-path test/LeanFors.t.sol
```
