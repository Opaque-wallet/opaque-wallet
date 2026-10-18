# Chrome Web Store listing, field by field

Upload `extension/opaque-extension-<version>.zip` (`cd frontend && npm run ext`),
then fill in each tab of the item in the developer dashboard with the text below.

## Store listing

**Description**

> Opaque is one private wallet for every chain it runs on, in your browser's
> side panel: Arc mainnet (real USDC), Arc testnet and XRPL testnet (no value).
> A picker in the header switches between them, and each keeps its own account.
> XRPL sites that support GemWallet or Crossmark can connect to it.
>
> Deposit USDC and it becomes notes of 1, 2, 5, 10, 20, 50 or 100 USDC. Each
> note sits in a pool with others of its size. When you pay, the wallet proves
> on your device that you own one note out of a ring of eight, without saying
> which one. The payment is sealed, then sent through three relays, so no single
> party links your device to what you paid. Anyone can see deposits and
> settlements on chain, but not which deposit paid which recipient.
>
> Your account is secured by a post-quantum, hash-based (FORS+C) key that never
> leaves your browser. Deposits and withdrawals are signed by that key, and no
> other wallet is needed: fund your Opaque address from any wallet or exchange.
>
> - Private sends of any whole amount, using the fewest notes
> - Post-quantum account key, with a visible signature budget and key rotation
> - Payments and account reads routed through a three-hop relay mesh
> - Encrypted backup and restore
> - No accounts, no analytics, no trackers
>
> Early software, stated plainly: the mainnet contracts are not yet audited,
> one attester signs spends, and all six relays are run by one operator. Sealed
> payments are opened only inside a Chainlink CRE enclave. Use small amounts on
> mainnet, or try it first on testnet.
>

**Category:** Privacy & Security (or Tools, if that is not offered)

**Language:** English

**Store icon:** `extension/icons/128.png`

**Screenshots** (1280×800): `extension/store/1-home.png`, `2-send.png`,
`3-privacy.png`, `4-activity.png`

**Small promo tile** (440×280): `extension/store/promo-440x280.png`

**Marquee promo tile** (1400×560): `extension/store/marquee-1400x560.png`

**Global promo video:** leave empty.

**Official URL:** leave as None (it needs a site verified in Search Console).

**Mature content:** No.

**Homepage URL:** https://www.opaque.credit

**Support URL:** https://x.com/Opaquecredit

## Privacy practices

**Single purpose**

> A private payments wallet (Arc and XRPL), opened in the browser's side
> panel, that websites can ask to connect and sign.

**Permission justification: sidePanel**

> Opens the wallet in the browser's side panel when the toolbar icon is
> clicked.

**Permission justification: host permissions (content scripts)**

> XRPL websites look for a wallet by the page APIs GemWallet and Crossmark
> define. Two content scripts answer those requests on https pages, so a site
> can ask Opaque to connect or sign. They read no page content and hold no
> key: each request opens Opaque's own approval window, where the user
> approves or rejects it. The only thing they write is the connected address,
> in that site's own storage, so a reload reconnects without asking again.

**Remote code:** No, I am not using remote code.

> All JavaScript ships in the package. The extension fetches configuration
> (the relay list and public keys) and data as JSON, never code.

**Data usage.** Tick:

- **Financial and payment information.** Payments, balances and recipient
  addresses. Payments are sealed to the service; the recipient is sent to its
  credential authority.
- **Personally identifiable information.** The conservative reading: the
  service and its host see IP addresses, and account addresses are
  identifiers.

Leave the rest unticked. Keys, note secrets and the backup passphrase never
leave the device.

Then certify all three:

- I do not sell or transfer user data to third parties, outside of the
  approved use cases
- I do not use or transfer user data for purposes that are unrelated to my
  item's single purpose
- I do not use or transfer user data to determine creditworthiness or for
  lending purposes

**Privacy policy URL:** https://www.opaque.credit/privacy.html

## Test instructions (for the reviewer)

> No login or account is needed. Click the toolbar icon: the wallet opens in
> the side panel and creates a local account.
>
> To see a payment end to end without real funds, pick Arc Testnet in the
> header first:
> 1. Get testnet USDC at https://faucet.circle.com (network: Arc testnet).
> 2. In the wallet, press Receive, and send about 2 USDC to the address shown.
> 3. Set Deposit amount to 1 and press Deposit. The first deposit also sets up
>    the account on chain. About a minute.
> 4. Open Send, enter any Arc address and 1 USDC, and press Review private
>    transfer. It settles in under a minute. Activity links the settlement on
>    testnet.arcscan.app.
>
> XRPL testnet, no funds needed: pick XRPL Testnet in the header, create a
> wallet, and press "Get 95 test XRP". Then Send any amount to an XRPL testnet
> address.

## Distribution

Unlisted until the mainnet contracts are audited, then Public.
Brave and Edge users install from the Chrome Web Store too.
