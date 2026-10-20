// Contracts an Arc account deploys and owns, signed by its post-quantum key.
//
// A deploy is one call from the account to the deterministic CREATE2 factory
// (Arachnid's, at the same address on every EVM chain, Arc's included):
// salt ‖ initcode, and the contract lands at an address known before it is
// sent. The factory reverts if the deploy fails, so the account's operation
// fails with it. No classical key signs anything, then or after.

import { keccak_256 } from '@noble/hashes/sha3';

import { checksummed } from './arc-keys.ts';

export const CREATE2_FACTORY = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
/** EIP-3860: the most initcode a chain takes. */
export const MAX_INITCODE = 49_152;

const bytesOf = (h: string): Uint8Array => Uint8Array.from(h.slice(2).match(/../g) ?? [], (b) => parseInt(b, 16));
const join = (...parts: Uint8Array[]): Uint8Array => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

/** Pasted hex (with or without 0x, any whitespace): the bytes it names, or why not. */
export function asHexBytes(text: string, what: string, max: number): `0x${string}` {
  const h = text.replace(/\s+/g, '').replace(/^0x/i, '').toLowerCase();
  if (h.length === 0) throw new Error(`paste the ${what}`);
  if (!/^[0-9a-f]*$/.test(h) || h.length % 2 !== 0) throw new Error(`the ${what} must be hex: two digits per byte`);
  if (h.length / 2 > max) throw new Error(`the ${what} is ${h.length / 2} bytes; a chain takes at most ${max}`);
  return `0x${h}`;
}

export const newSalt = (): `0x${string}` => `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

/** Where CREATE2 from `deployer` puts `initcode` under `salt` (EIP-1014). */
export const create2Address = (deployer: string, salt: `0x${string}`, initcode: `0x${string}`): `0x${string}` =>
  checksummed(keccak_256(join(Uint8Array.of(0xff), bytesOf(deployer), bytesOf(salt), keccak_256(bytesOf(initcode)))).slice(-20));

/** The account's one call that deploys it, and where it lands. */
export const deployment = (salt: `0x${string}`, initcode: `0x${string}`) => ({
  call: { to: CREATE2_FACTORY as `0x${string}`, data: `0x${salt.slice(2)}${initcode.slice(2)}` as `0x${string}` },
  address: create2Address(CREATE2_FACTORY, salt, initcode),
});
