<div align="center">

# ENSv2: names held by a post-quantum key

### opaque.eth is owned by a contract that acts only on a FORS+C signature, and every name.opaque.eth is held by a post-quantum account.

[![Sepolia](https://img.shields.io/badge/ENSv2-Sepolia%20live-FF7A18?style=flat-square)](https://sepolia.etherscan.io/address/0x4d4df91933bb30640908f5cd4a42e2cac546c131)
[![Contracts](https://img.shields.io/badge/contracts-2-FF7A18?style=flat-square)](../contracts/src/ethereum/ens/)
[![Tests](https://img.shields.io/badge/forge-13%20tests-FF7A18?style=flat-square)](../contracts/test/)

</div>

## Why this matters

A name outlives every wallet behind it, which is the point of a name. If one ECDSA key holds that name, the name is exactly as safe as the key. And an ECDSA key that has signed has published its public key: the input a quantum computer needs. The day that key can be derived, whoever derives it can re-point the name and take every payment sent to it. The people paying won't notice anything.

ENSv2 gives every role over a name to whoever holds its ERC-1155 token, and moves those roles with the token (`PermissionedRegistry._update`). So a contract can hold all of them. We put a post-quantum key in charge of a real ENSv2 name with no fork of ENS and no change to its contracts.

## What we built

### `PQNameController`: opaque.eth, owned by FORS+C

- **Holds the name.** It holds opaque.eth's token, so it holds every role ENSv2 gives an owner: subregistry, resolver, renewal, transfer and records. It's also the only admin of the name's PermissionedResolver.
- **One way to act:** `execute(target, data, deadline, signature)`. It calls out only when the signature comes from its key in `PQKeyRegistry`. The signature binds:
  - this contract and the chain;
  - the target and the exact calldata;
  - a deadline and the key's use count.
- **Anyone may submit a signed call.** Paying for the transaction authorizes nothing.
- **Checked on chain:**
  - an ECDSA write to the resolver reverts, and so does the previous owner's `setResolver`;
  - the resolver was set (`0x621bfed7…a3b1`), and all records were written in one signature (`0x23aa1a10…1791`).

### `OpaqueNames`: name.opaque.eth for any Opaque wallet

- **Both registry and resolver:** opaque.eth's subregistry in ENSv2, and the resolver of every name in it. UniversalResolverV2 walks root → eth → opaque → here, as any ENS client does.
- **Only post-quantum accounts can claim.** `claim(label)` requires the caller's code to be the EIP-1167 clone of Opaque's `PQAccount`, which moves funds on a FORS+C signature only. So every name.opaque.eth is held by an account only a hash-based key can move, and a payer can check that.
- **Fair use:** first come, first served, one name per wallet, and `release()` frees it.

### In the wallet

- **Claiming is the whole Names tab.** One FORS+C signature claims `name.opaque.eth`. The same signature publishes the wallet's ML-KEM-768 stealth key in ERC-6538's registry, so payments to the name land at one-time addresses only the wallet can find.
- **The name labels the account.** Once claimed, it replaces "Account 1" in the header and the account list, with the address under it.
- **Send takes ENS names:**
  - through ENSv2's UniversalResolverV2: coin 60 on Sepolia, and ENSIP-11 coin `0x80000539` for the EIP-8141 devnet;
  - every lookup goes through EF's anon-rpc, so the RPC never learns who asked;
  - a name held by a FORS+C key is marked as such in Send.

## What a judge can check

| What | Sepolia address |
|---|---|
| `PQNameController` (holds opaque.eth) | [`0x4d4df91933bb30640908f5cd4a42e2cac546c131`](https://sepolia.etherscan.io/address/0x4d4df91933bb30640908f5cd4a42e2cac546c131) |
| Its PermissionedResolver | [`0x9320d93186255e122214bd22270d168d5d8f676f`](https://sepolia.etherscan.io/address/0x9320d93186255e122214bd22270d168d5d8f676f) |
| `OpaqueNames` (name.opaque.eth) | [`0x01f3419d2c8747f6b72032caf21a02fd0db44a28`](https://sepolia.etherscan.io/address/0x01f3419d2c8747f6b72032caf21a02fd0db44a28) |
| `PQKeyRegistry` (the FORS+C keys) | [`0x8b47560d32bcda788ab5233ab2bda55204cacca3`](https://sepolia.etherscan.io/address/0x8b47560d32bcda788ab5233ab2bda55204cacca3) |
| ENSv2 ETHRegistry / UniversalResolverV2 | `0xd4eb…a8b4` / `0x24e1…2d72` |

- **Try it:** open [opaque.credit/sepolia/app](https://www.opaque.credit/sepolia/app), make a wallet, get test funds, then open **Names** and claim a name. Pay it from another wallet by typing `yourname.opaque.eth`.
- **The end-to-end test, [`e2e-sepolia.ts`](../backend/scripts/e2e-sepolia.ts):**
  - claims a name from the page;
  - checks UniversalResolverV2 resolves it to the wallet, and that a PQ account holds it;
  - reloads and checks the header reads the name;
  - pays the name and checks the pool paid a one-time address while the wallet's own address received nothing;
  - sweeps that payment into the wallet's notes, then releases the name.

```bash
cd contracts && forge test --match-path 'test/{PQNameController,OpaqueNames}.t.sol'   # 7 + 6 tests
cd backend && OPAQUE_NETWORK=sepolia node --use-system-ca ethereum/ens-sepolia.ts status
```

## Where the code is

| File | What |
|---|---|
| [`contracts/src/ethereum/ens/`](../contracts/src/ethereum/ens/) | `PQNameController`, `OpaqueNames` ([folder README](../contracts/src/ethereum/ens/README.md)) |
| [`backend/ethereum/ens.ts`](../backend/ethereum/ens.ts) | The signed-call format the controller checks |
| [`backend/ethereum/ens-sepolia.ts`](../backend/ethereum/ens-sepolia.ts) | Deploy, adopt, records, status |
| [`frontend/src/ethereum/ens-name.ts`](../frontend/src/ethereum/ens-name.ts) | Resolution in the wallet, through UniversalResolverV2 and anon-rpc |
| [`backend/chain/stealth.ts`](../backend/chain/stealth.ts) | The stealth meta-address a claim publishes |

## The boundary

- **What it hides:**
  - a name is public by design: anyone can read who holds it and where it points;
  - with stealth on, payments **to** the name are not linkable to its holder, and the wallet's lookups don't reveal who asked;
  - holding a name ties it to the account's address in public.
- **The resolver we use** is the ENS app's published PermissionedResolver build on Sepolia, which is older than contracts-v2 main (name-based setters, `resolve()` reads).
- **Status:** tested with forge, not audited. Testnet only.

[Back to partner evidence](README.md) · [Main README](../README.md)
