# Extension: The Wallet in the Side Panel

> **Chrome Manifest V3, version 0.6.0. Chrome, Brave and Edge. Arc mainnet, Arc testnet and XRPL testnet.**

**One Opaque extension for every chain.** The side panel shows the same wallet pages served at opaque.credit, from the same Vite build: `app.html` (Arc mainnet), `testnet/app.html` (Arc testnet) and `testnet/xrpl.html` (XRPL testnet). The header's network picker moves between them, and the panel reopens on the network used last. Each network keeps its own keys and notes. A new chain is a new page in `PAGES` (build.mjs) and an entry in the picker (`frontend/src/lib/network-picker.ts`), never a second extension. The side panel stays open while a deposit or payment runs, where a popup would close on the first click outside it.

On Arc it needs no other wallet: you fund your Opaque account by sending USDC to its address from anywhere, and the first deposit deploys the account and deposits in one operation its post-quantum key signs. On XRPL it holds notes from a 12-word recovery phrase, and XRPL sites reach it as described under [XRPL dapps](#xrpl-dapps).

**From 0.5.x (Arc only):** unzip 0.6.0 into the same folder and reload; the Arc wallets stay. **From the separate "Opaque for XRPL" extension (0.4.x):** that one is retired. It loaded from another folder, so its wallet is not in this one: import its recovery phrase here, then remove it.

## Install from the Zip

The Chrome Web Store listing is in review. Until it is live, install in Developer mode:

1. Download [opaque-extension.zip](https://www.opaque.credit/opaque-extension.zip).
2. Unzip it: double-click on a Mac, or right-click and choose **Extract All** on Windows. Keep the folder; the browser runs the extension from it.
3. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
4. Turn on **Developer mode**, top right.
5. Click **Load unpacked** and choose the unzipped folder, the one with `manifest.json` inside. The zip itself shows greyed out: the browser loads folders, not zips.
6. Pin Opaque from the puzzle-piece menu and click it. The wallet opens in the side panel.

**To update,** unzip the new download into the same folder and click the reload arrow on Opaque's card. The browser ties an unpacked extension's id, and so its wallet, to the folder. Loaded from a different folder, it opens as a new extension with an empty wallet. Move an account between installs with **Backup** and **Restore**.

## Build

```bash
cd frontend && npm install && npm run ext
```

That builds the page against the hosted backend (`VITE_STACK_URL`, by default the Railway stack) and writes:

| Output | What |
|---|---|
| `extension/dist/` | The folder to load unpacked |
| `extension/opaque-extension-<version>.zip` | The Chrome Web Store upload |
| `frontend/public/opaque-extension.zip` | The same zip under a stable name, for the landing page download |

`dist/` and the versioned zip are generated and git-ignored.

## Folder Structure

```
extension/
├── manifest.json       # Manifest V3; sidePanel, and the two content scripts below
├── background.js       # Opens the side panel on the toolbar click, or a tab where there is none
├── bridge.js           # Content script: tells inject.js the approval window's address
├── inject.ts           # Content script (world MAIN): answers XRPL sites as GemWallet and Crossmark
├── build.mjs           # Assembles dist/ from frontend/dist, with the checks below
├── make-icons.mjs      # Draws the icons
├── icons/              # 16, 32, 48 and 128 px
└── store/              # Chrome Web Store listing text, screenshots and promo tile
```

## What the Build Checks

- **The Manifest V3 CSP.** Inline `<script>` and inline handlers such as `onclick=` are banned, and the symptom of breaking the rule is a silently blank panel. `build.mjs` scans the built HTML and refuses to assemble `dist/` if it finds either.
- **Only what the pages load.** It copies each wallet page, then follows names from the HTML into the JS and CSS: the proof worker, viem's lazy chunks, the fonts. Nothing else from the site's build goes in.
- **A backend.** A page built without its stack URL would look for `stack.json` or `xrpl-stack.json` inside the extension and never start, so the build refuses it. `npm run ext` builds the same pages as the site (`build:site`), which name them.
- **No remote fonts.** A wallet that fetched fonts from a CDN on every open would tell that CDN each time someone reached for a private payment. The build strips the import and then fails if any reference survives.
- **Three rewrites.** It removes Vite's `crossorigin`, which turns same-origin loads into CORS requests on a `chrome-extension://` origin, points the links home at opaque.credit, and drops the home-screen app manifest.

## Permissions

`sidePanel`, and two content scripts on https pages (and localhost) for XRPL sites. They read nothing from the page and hold no key: they answer a site's wallet requests by opening Opaque's own approval window, and they store a connected site's address in that site's storage so a reload reconnects without a popup. The Arc wallet injects no provider.

## XRPL dapps

Sites that support **GemWallet** or **Crossmark** find Opaque without changing a line. In each page, [inject.ts](inject.ts) (`world: "MAIN"`) sets `window.gemWallet` and `window.xrpl.isCrossmark`, answers both wallets' page messages, and passes each request to Opaque's adapter ([frontend/src/lib/opaque-adapter.ts](../frontend/src/lib/opaque-adapter.ts)). The adapter opens the extension's approval window, `testnet/xrpl-connect.html`, whose address [bridge.js](bridge.js) reads from the browser (a page script can't). The window takes the requesting site from `event.origin`, which the browser sets, so a page can't pose as another. Each site gets an account of its own, funded privately from your notes.

| GemWallet (`@gemwallet/api` 3) | Crossmark (`@crossmarkio/sdk`) | Opaque |
|---|---|---|
| `getAddress`, `getPublicKey` | `signIn` (a `SignIn` sign) | connect: the site's own account |
| `getNetwork` | `network` | XRPL Testnet, no popup |
| `submitTransaction`, `sendPayment` | `signAndSubmit` | Sign and submit |
| `signTransaction` | `sign` | Sign (the site submits it) |
| `signMessage` | none | Sign a message |

A site that has connected once gets its address back without a popup after a reload. Signatures always ask. Limits:

- **Testnet only** on XRPL.
- **It answers as both wallets.** Next to a real GemWallet or Crossmark, both would answer the same request. Use one or the other.
- **No public key at connect.** A site account's stable key is its original one, which Opaque shows only once a message is signed.
- GemWallet's other helpers (`setTrustline`, `createOffer`, NFT helpers) are refused with a pointer to `submitTransaction`, which takes any transaction.

Tested by `cd backend && npm run xrpl:e2e:extension`: Playwright's Chromium with the extension loaded, its XRPL wallet funded from the faucet, a dapp using the stock GemWallet and Crossmark adapters, and both Arc pages booting in the same extension.

## Publish on the Chrome Web Store

Brave and Edge install from the Chrome Web Store too. Everything the listing asks for is in [`store/`](store/): [`listing.md`](store/listing.md) has the text for every field (description, single purpose, the `sidePanel` justification, data-use answers, reviewer test steps), next to the 1280×800 screenshots and the 440×280 promo tile. The privacy policy is [opaque.credit/privacy.html](https://www.opaque.credit/privacy.html).

Bump `version` in `manifest.json` for every upload, then `npm run ext`. Wallet extensions get a manual review, usually several days. A store install has a different extension id from an unpacked one, so it starts with empty storage: use **Backup** and **Restore**.

## Key Rotation

Each deposit or withdrawal uses one of the account key's 32 signatures, and the panel shows how many are left. Near the end of that budget the key rotates itself: the wallet signs the rotation with the current key and the mesh exit submits and pays for it, so there is no prompt and nothing to press. Two of the 32 signatures are reserved for exactly this. The extension needs no funding wallet for it, which is the point.

## Icons

`icons/*.png` are drawn by `make-icons.mjs`: the ring of eight in the wallet's orange, rendered into a pixel buffer and encoded with Node's built-in zlib.

```bash
node extension/make-icons.mjs
```
