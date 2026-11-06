# EIP-8141 devnet contracts

The contracts behind "Ethereum Devnet (Fully post-quantum)" at [opaque.credit/testnet/devnet](https://www.opaque.credit/testnet/devnet). Each frame transaction here is validated by a FORS+C signature, or by the contract that is its own sender. They need the frame opcodes, which `@forshtat/hegota-support` pins to solc 0.8.28, so they build on their own:

```bash
cd contracts && FOUNDRY_PROFILE=frame forge build
```

| Contract | What it does |
|---|---|
| [`FramePQAccount.sol`](FramePQAccount.sol) | The account. `verify()` is its VERIFY frame: it copies the signature out with `SIGDATACOPY`, recovers the FORS+C key with [`LeanFors`](../src/ethereum/frame/LeanFors.sol) and approves execution and payment. The protocol nonce counts the key's uses (8 per key at k=13, a=13), and `rotate(next)`, called from its own SENDER frame, hands over to the next key. |
| [`FramePQAccountFactory.sol`](FramePQAccountFactory.sol) | Creates accounts with no signature at all: it is the creating transaction's sender and pays for it, and its VERIFY approves only one `create(key)` frame to itself. The address is CREATE2 on the key, so it's known before the account exists. |
| [`DevnetFaucet.sol`](DevnetFaucet.sol) | Opaque's own devnet ETH faucet, for when the devnet's runs dry: it pays its own transaction, so a page asks with no key. Once an hour per address. |
| [`TokenFaucet.sol`](TokenFaucet.sol) | 100 test pqUSDC per address an hour, for the privacy pools, in the same shape. |
| [`TestToken.sol`](TestToken.sol) | A plain ERC-20: pqUSD for the Uniswap v4 pool, pqUSDC for the privacy pools. |
| [`CreateDeployer.sol`](CreateDeployer.sol) | CREATE by nonce, so a privacy pool's address is known before its verifier is deployed. |

## On chain

The addresses are in [`deployments/eth-devnet.json`](../../deployments/eth-devnet.json). [`backend/ethereum/frame-tx.ts`](../../backend/ethereum/frame-tx.ts) drives everything:

```bash
cd backend
node ethereum/frame-tx.ts create    # a new account, made by the factory, no signature
node ethereum/frame-tx.ts send      # a FORS+C-only frame transaction
node ethereum/frame-tx.ts attack    # another key's signature: refused at admission, BadSignature
node ethereum/frame-tx.ts pqpool    # the post-quantum Uniswap v4 pool, in one atomic transaction
node ethereum/frame-tx.ts privacy   # Opaque's privacy pools on the devnet
```
