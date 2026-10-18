# Opaque for XRPL: the browser extension

A private XRPL wallet in Chrome's side panel, and the wallet dapps find when
they look for **GemWallet** or **Crossmark**. Each dapp gets an account of its
own, funded privately from your notes, and every signature is approved in
Opaque's own window. XRPL testnet only.

## Install (unpacked)

Download https://opaque-xrpl.vercel.app/testnet/opaque-xrpl-extension.zip and
unzip it, or build it:

```bash
cd frontend && npm run ext:xrpl     # builds extension-xrpl/dist and the zip
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → the
`opaque-xrpl-extension` folder (or `extension-xrpl/dist`). Pin Opaque and click
it: the wallet opens in the side panel. Create a wallet (a 12-word recovery
phrase), or import the phrase of one you already have on the website or in
another browser. **Get 95 test XRP** fills it from the testnet faucet. Then open a dapp, for example https://opaque-xrpl-demo.vercel.app,
and choose GemWallet or Crossmark.

## How it works

The side panel is the hosted wallet page itself ([frontend/xrpl.html](../frontend/xrpl.html)),
built for testnet and packed by [build.mjs](build.mjs). Its notes and keys live
in the extension, as a wallet extension's do; the hosted wallet at
opaque-xrpl.vercel.app keeps its own. One recovery phrase opens the same
accounts, notes and app accounts in both (see docs/xrpl.md, "The recovery
phrase and accounts").

In each page, [inject.ts](inject.ts) (`world: "MAIN"`) sets `window.gemWallet`
and `window.xrpl.isCrossmark`, answers both wallets' page messages, and passes
each request to Opaque's adapter ([frontend/src/lib/opaque-adapter.ts](../frontend/src/lib/opaque-adapter.ts)).
The adapter opens the extension's approval window, `xrpl-connect.html`, whose
address [bridge.js](bridge.js) reads from the browser (a page script can't). The
window takes the requesting site from `event.origin`, which the browser sets, so
a page can't pose as another. The page scripts hold no key and approve nothing.

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

- **Testnet only.** It answers as XRPL Testnet and holds a testnet wallet.
- **Its own storage.** The extension's wallet and the hosted one are separate
  until the same recovery phrase is imported in both.
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
with the extension loaded, its own wallet funded from the faucet, and the
hosted demo dapp, on testnet.
