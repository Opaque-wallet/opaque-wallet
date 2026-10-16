// Single-use signing keys: quantum resistance by timing.
//
// An XRPL address is a hash of its public key, and the key is exposed only
// when it first signs. Every key in a chain signs (at most) one ledger's worth
// of transactions: the Batch that first reveals key i also installs key i+1,
// known on the ledger only by its address. An attacker with a quantum computer
// gets about one ledger close to break each key. That is a timing argument,
// not a mathematical one, and the wallet says so.
//
// A chain is derived from one seed, so its holder recovers its position from
// the ledger alone. The attesters' signer keys and each per-site account's
// regular keys are both chains. Browser-safe: ripple-keypairs, not xrpl.js.

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { deriveAddress, deriveKeypair, generateSeed } from 'ripple-keypairs';

const utf8 = (s: string) => new TextEncoder().encode(s);

export interface KeyPair {
  readonly address: string;
  readonly publicKey: string;
  /** Secret. Never stored: re-derived from the chain's seed when it signs. */
  readonly privateKey: string;
}

export interface KeyChain {
  keyAt(index: number): KeyPair;
  addressAt(index: number): string;
  /** The index of `address` in this chain, searching [from, from + window). */
  indexOf(address: string, from?: number, window?: number): number | undefined;
}

/** An Ed25519 key from 16 bytes of entropy, as xrpl.js Wallet.fromEntropy derives it. */
export function keyFromEntropy(entropy: Uint8Array): KeyPair {
  const { publicKey, privateKey } = deriveKeypair(generateSeed({ entropy, algorithm: 'ed25519' }));
  return { address: deriveAddress(publicKey), publicKey, privateKey };
}

export function keyChain(seed: Uint8Array, domain: string): KeyChain {
  if (seed.length < 32) throw new Error('a key chain seed must be at least 32 bytes');
  const addresses = new Map<number, string>();
  const keyAt = (index: number): KeyPair => {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('key index must be a non-negative integer');
    return keyFromEntropy(hmac(sha256, seed, utf8(`opaque/v1/xrpl/${domain}/${index}`)).subarray(0, 16));
  };
  const addressAt = (index: number): string => {
    let a = addresses.get(index);
    if (a === undefined) {
      a = keyAt(index).address;
      addresses.set(index, a);
    }
    return a;
  };
  return {
    keyAt,
    addressAt,
    indexOf(address, from = 0, window = 64) {
      for (let i = from; i < from + window; i++) if (addressAt(i) === address) return i;
      return undefined;
    },
  };
}
