// The guard key a MetaMask address keeps in PQKeyRegistry: one FORS+C key, from 12 words of its
// own, for the Q-Day vault and for the quantum-safe admin alike. Never derived from anything the
// ECDSA key signs: whoever cracks that key could then rebuild this one.

import { masterKey, type RegistryKey } from '../../../backend/ethereum/ens/ens.ts';
import { accountKeys, stream } from '../lib/wallet-keys.ts';

/** Generation g of the guard key these words make: the keys rotate, one generation at a time. */
export const guardKeyAt = (phrase: string, g: number): RegistryKey =>
  masterKey(stream(accountKeys(phrase, 0).key, 'opaque/v1/vault/guard')(32), 'opaque/v1/vault/guard', g);

/** Where this browser keeps an address's guard words. */
export const guardPhraseKey = (address: string): string => `opaque:vault-phrase:${address.toLowerCase()}`;
