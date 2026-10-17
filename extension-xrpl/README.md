# Opaque for XRPL: the browser extension

Dapps that support **GemWallet** or **Crossmark** open Opaque instead, with no
change on their side. Each dapp still gets an account of its own, funded
privately from your notes, and every signature is approved in Opaque's popup.
XRPL testnet only.

## Install (unpacked)

```bash
cd frontend && npm run ext:xrpl     # builds extension-xrpl/dist
```

Then `chrome://extensions` → Developer mode → **Load unpacked** →
`extension-xrpl/dist`. Open a dapp, choose GemWallet or Crossmark, and
Opaque's popup appears (https://opaque-xrpl.vercel.app). Try it on
https://opaque-xrpl-demo.vercel.app.

Fund the wallet first: open https://opaque-xrpl.vercel.app, **Deposit** →
**New deposit tag** → **Deposit 95 test XRP from the faucet**.

## How it works

One script, [inject.ts](inject.ts), runs in each page (`world: "MAIN"`). It sets
`window.gemWallet` and `window.xrpl.isCrossmark`, answers both wallets' page
messages, and passes each request to Opaque's adapter
([frontend/src/lib/opaque-adapter.ts](../frontend/src/lib/opaque-adapter.ts)).
The adapter opens the hosted wallet's connect page as a popup. That popup takes
the requesting site from `event.origin`, which the browser sets, so a page
can't pose as another. The extension holds no key, asks for no permission, and
approves nothing itself.

| GemWallet (`@gemwallet/api` 3) | Crossmark (`@crossmarkio/sdk`) | Opaque |
|---|---|---|
| `getAddress`, `getPublicKey` | `signIn` (a `SignIn` sign) | connect: the site's own account |
| `getNetwork` | `network` | XRPL Testnet, no popup |
| `submitTransaction`, `sendPayment` | `signAndSubmit` | Sign and submit |
| `signTransaction` | `sign` | Sign (the site submits it) |
| `signMessage` | none | Sign a message |

A site that has connected once gets its address back without a popup after a
reload, as a wallet's trusted sites do. Signatures always ask.

## Limits

- **Testnet only.** It answers as XRPL Testnet and opens the testnet wallet.
- **It answers as both wallets.** Next to a real GemWallet or Crossmark, both
  would answer the same request. Use one or the other.
- **No public key at connect.** A site account's only stable key is its
  original one, which signs messages. Opaque doesn't show it until a message
  is signed, so a dapp that checks a signed message against the key from
  connect has none to check against.
- GemWallet's other helpers (`setTrustline`, `createOffer`, NFT helpers and so
  on) are refused with a pointer to `submitTransaction`, which takes any
  transaction.

Tested by `cd backend && npm run xrpl:e2e:extension`: Playwright's Chromium
with the extension loaded, the hosted wallet and the hosted demo dapp, on
testnet.
