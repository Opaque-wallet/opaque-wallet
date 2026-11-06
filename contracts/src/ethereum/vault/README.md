# The Q-Day vault

[`PQVault.sol`](PQVault.sol) is for people who keep MetaMask. Any address can put ETH or ERC-20 tokens in. Only a FORS+C signature from the key that address registered in `PQKeyRegistry` can take them out. So on the day the address's ECDSA key falls to a quantum computer, whoever breaks it finds nothing to move.

- **Deposit:** `deposit(token, amount)`, an ordinary transaction from the owner's wallet. ETH is token `0x0`. The owner must have registered a guard key first.
- **Withdraw:** `withdraw(owner, token, amount, to, deadline, signature)`. The signature covers `payload(owner, token, amount, to, deadline)`, which binds the domain, the chain and this vault. The registry consumes it once.
- **Anyone may submit a withdrawal.** So the owner gets their money out even if their ECDSA key is lost or stolen.
- **Deployed on Sepolia** at `0x0316a466f3e14850a016883aa46b3d5187b9aeb0`.
- **The page** is [opaque.credit/sepolia/vault](https://www.opaque.credit/sepolia/vault): connect MetaMask, make a guard key from 12 new words, register, deposit, withdraw, or try it as a thief.

## Tests and proofs

```bash
cd contracts && forge test --match-path test/PQVault.t.sol                    # 6 tests
cd backend && OPAQUE_NETWORK=sepolia node --use-system-ca ethereum/vault-sepolia.ts
cd backend && node --use-system-ca scripts/e2e-vault.ts                       # the page, with a stand-in MetaMask
```

`vault-sepolia.ts` checks three things on chain:

- a cracked ECDSA key with another FORS+C key's signature is refused (`BadSignature`);
- the owner's real signature replayed to a front-runner's address is refused;
- the signed withdrawal pays exactly its recipient.

Not audited. Testnet only.
