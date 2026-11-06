# Opaque in anon-rpc's adopters list

A PR against [`ethereum/anon-rpc`](https://github.com/ethereum/anon-rpc), changing `adopters.json5` alone (its header says that is how a project is added). It goes into `walletsAndApps`, which today holds two apps and no wallet.

## The entry

```json5
    {
      id: "opaque",
      label: "Opaque",
      kind: "wallet",
      url: "https://www.opaque.credit/sepolia/app",
      note: "A post-quantum private-payments wallet: FORS+C accounts, payments hidden in rings of eight notes, and post-quantum stealth addresses. On Sepolia, ENS lookups always go through anon-rpc. A Privacy switch sends all of the account's reads and ERC-4337 UserOperations through it too, to a public RPC and the public bundler. Its exit uses it as well: with every Opaque server down, a note still leaves its pool, every read and bundler call over Nox.",
      workers: ["nox"],
    },
```

## The PR

**Title:** Add Opaque (wallet, Nox)

**Body:**

> Opaque is an open-source (Apache-2.0) private-payments wallet with post-quantum accounts. It uses `@anon-rpc/browser-harness` 0.4.0 with the Nox worker (specifier `0x3513…7A9A` on Sepolia) in three places:
>
> - **ENS:** every name lookup in the wallet (ENSv2's UniversalResolver on Sepolia).
> - **Reads and UserOperations, when the user turns it on:** the account's chain reads (viem's `http` transport with the harness's `fetch`, concurrent calls batched through Multicall3 to save round trips) and its ERC-4337 bundler calls.
> - **The exit path:** if Opaque's servers are down or refuse the user, a note leaves its pool (an announce, then a withdrawal, signed by the account's own key) with every read and bundler call through Nox.
>
> What we measured on Sepolia: about 4.5 s for the first call (bootstrap included) and about 1.3 s for each call after. Bundler JSON-RPC (Pimlico) works through it unchanged.
>
> Code: https://github.com/Opaque-wallet/opaque-wallet, in `frontend/src/lib/anon-rpc.ts`, `frontend/src/lib/runtime.ts` and `frontend/src/lib/without-opaque.ts`.

## Before posting

- Post it only once opaque.credit has the build with the Privacy switch, so the link shows what the note says.
- Feedback worth sending the anon-rpc team separately:
  - The bootstrap provider reads the specifier contract directly: one request from the user's own IP, before anything is anonymized.
  - The tor-js demonstration gateway timed out in our tests, so we use Nox.
