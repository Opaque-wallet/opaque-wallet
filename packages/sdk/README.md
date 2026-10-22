# @opaque/sdk

Opaque's private, post-quantum payments from Node 22.18+: Arc (USDC) and the
XRP Ledger, with the account key, the notes and the ring proofs in your
process. The full reference is at https://www.opaque.credit/developers.

```js
import { createWallet } from '@opaque/sdk';

const wallet = await createWallet({ dir: './.opaque', password: process.env.OPAQUE_PASSWORD, network: 'testnet' });
const arc = await wallet.arc();
await arc.deposit(10);                          // USDC at arc.address → private notes
const [payment] = await arc.send('0x…', 5);     // through a ring of 8, across the relays
console.log(await arc.status(payment.handle));
```

- A wallet is a folder: one account, sealed (scrypt, AES-256-GCM), opened by one process at a time.
- Give each app its own account: its post-quantum keys are few-time, and two hosts signing for one could reuse a key.
- `npm test` (unit), `npm run e2e:arc` (Arc testnet, from the funded contracts account; `-- --pay` also pays privately).

Licensed, not open source: see LICENSE.
