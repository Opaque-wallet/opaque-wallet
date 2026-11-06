// The guard key a MetaMask address keeps in PQKeyRegistry: one FORS+C key, from 12 words of its
// own, for the Q-Day vault and for the quantum-safe admin alike. Never derived from anything the
// ECDSA key signs: whoever cracks that key could then rebuild this one.

import { masterKey, type RegistryKey } from '../../../backend/ethereum/ens/ens.ts';
import { accountKeys, stream } from '../lib/wallet-keys.ts';

/** New guard keys are registered with this many uses, so the registry itself refuses a 9th signature. */
export { SIGNATURES_PER_KEY } from '../../../packages/pq-wallet/src/fors.ts';

/** Generation g of the guard key these words make: the keys rotate, one generation at a time. */
export const guardKeyAt = (phrase: string, g: number): RegistryKey =>
  masterKey(stream(accountKeys(phrase, 0).key, 'opaque/v1/vault/guard')(32), 'opaque/v1/vault/guard', g);

/** Where this browser keeps an address's guard words. */
export const guardPhraseKey = (address: string): string => `opaque:vault-phrase:${address.toLowerCase()}`;

/**
 * Keeps the words in this browser, but never over the ones the address registered: a new phrase,
 * or words mistyped into "I have the words", would otherwise replace the only copy of the key that
 * opens the vault and drives the admin. `matches` is whether these words make the registered key
 * (true when nothing is registered yet).
 */
export function keepPhrase(address: string, phrase: string, matches: boolean): void {
  if (!matches) return;
  try { localStorage.setItem(guardPhraseKey(address), phrase); } catch { /* private window: kept in this page only */ }
}

/** Shows the words in `list`, numbered by the page's CSS. */
export function showWords(phrase: string, list: HTMLElement): void {
  list.replaceChildren(...phrase.split(' ').map((w) => Object.assign(document.createElement('li'), { textContent: w })));
}

/** Copies the words; if the browser refuses, selects them to copy by hand. Call it from the click itself. */
export async function copyWords(phrase: string, list: HTMLElement, status: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(phrase);
    status.textContent = 'Copied. Paste them somewhere safe and offline, then copy something else over them.';
  } catch {
    const range = document.createRange();
    range.selectNodeContents(list);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    status.textContent = "Couldn't copy here: the words are selected, so copy them by hand.";
  }
}
