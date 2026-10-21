// Contracts an Arc account deploys and owns, signed by its post-quantum key.
//
// A deploy is one call from the account to the deterministic CREATE2 factory
// (Arachnid's, at the same address on every EVM chain, Arc's included):
// salt ‖ initcode, and the contract lands at an address known before it is
// sent. The factory reverts if the deploy fails, so the account's operation
// fails with it. No classical key signs anything, then or after.

import { keccak_256 } from '@noble/hashes/sha3';

import { deployment as network } from '../../../deployments/index.ts';
import { checksummed } from './arc-keys.ts';

/** Pinned per network (deployments/*.json create2Factory), its code checked there: null where it isn't, and Contracts stays off. */
export const CREATE2_FACTORY = (network.contracts.create2Factory?.address ?? null) as `0x${string}` | null;
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
export function deployment(salt: `0x${string}`, initcode: `0x${string}`) {
  // A call to an address with no code succeeds and deploys nothing: never sent where the factory isn't pinned.
  if (CREATE2_FACTORY === null) throw new Error('contracts can\'t be deployed on this network yet');
  return {
    call: { to: CREATE2_FACTORY, data: `0x${salt.slice(2)}${initcode.slice(2)}` as `0x${string}` },
    address: create2Address(CREATE2_FACTORY, salt, initcode),
  };
}

const word = (data: string, i: number) => data.slice(10 + 64 * i, 74 + 64 * i);
const addressAt = (data: string, i: number) => `0x${word(data, i).slice(24)}`;
const amountAt = (data: string, i: number) => {
  const v = BigInt(`0x${word(data, i) || '0'}`);
  return v >= 2n ** 255n ? 'unlimited' : v.toString(10);
};

/**
 * What a call does with this account's tokens, in words, when it hands them
 * to someone: an approval, a transfer, a permit, an operator, or gas money
 * drawn out of the EntryPoint. null for anything else. The Contracts screen
 * asks before signing these: `cast calldata` makes them as easily as a
 * setFee, and a pasted approve(attacker, max) would empty the account later.
 */
export function riskOfCall(to: string, data: string, names: Readonly<Record<string, string>> = {}): string | null {
  const token = names[to.toLowerCase()] ?? to;
  switch (data.slice(0, 10).toLowerCase()) {
    case '0x095ea7b3': return `This lets ${addressAt(data, 0)} spend ${amountAt(data, 1)} units of ${token} from this account, now or any time later.`;
    case '0x39509351': return `This lets ${addressAt(data, 0)} spend ${amountAt(data, 1)} more units of ${token} from this account, now or any time later.`;
    case '0xa9059cbb': return `This sends ${amountAt(data, 1)} units of ${token} from this account to ${addressAt(data, 0)}, publicly.`;
    case '0x23b872dd': return `This moves ${amountAt(data, 2)} units of ${token} from ${addressAt(data, 0)} to ${addressAt(data, 1)}.`;
    case '0xd505accf': return `This signs a permit letting ${addressAt(data, 1)} spend ${amountAt(data, 2)} units of ${token}.`;
    case '0xa22cb465': return `This ${BigInt(`0x${word(data, 1) || '0'}`) === 0n ? 'removes' : 'gives'} ${addressAt(data, 0)} control of every token this account holds in ${token}.`;
    case '0x205c2878': return `This draws ${amountAt(data, 1)} of this account's gas money out of the EntryPoint, to ${addressAt(data, 0)}.`;
    default: return null;
  }
}
