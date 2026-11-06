// The Q-Day simulator's chain and curve work (frontend/q-day.html), browser-safe like frame.ts.
//
// Shor's algorithm turns a public key back into its private key. We can't run it, so the simulator
// plays its result: the attacker is handed the victim's private key, the one thing a quantum
// computer would give them, and tries everything that key could take.
//
// Stealth payments are worked out here, not sent: ERC-5564's secp256k1 scheme (scheme 1), whose
// shared secret anyone holding the viewing key recomputes, beside Opaque's ML-KEM-768 one, whose
// key is a lattice key that Shor's algorithm doesn't touch.

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { createPublicClient, createWalletClient, fallback, http, keccak256, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, publicKeyToAddress } from 'viem/accounts';
import { sepolia } from 'viem/chains';

export { generatePrivateKey, privateKeyToAccount };

// Sepolia's base fee is a few wei, and a 2-wei tip can sit unmined for minutes: 0.01 gwei is picked up.
export const FEES = { maxPriorityFeePerGas: 10_000_000n, maxFeePerGas: 50_000_000n } as const;

export function clients(rpcUrls: readonly string[], key?: Hex) {
  const transport = fallback(rpcUrls.map((u) => http(u, { retryCount: 3, retryDelay: 1_200 })));
  const pub = createPublicClient({ chain: sepolia, transport });
  const wallet = key === undefined ? undefined : createWalletClient({ account: privateKeyToAccount(key), chain: sepolia, transport });
  return { pub, wallet };
}

const N = secp256k1.Point.CURVE().n;
const bytes = (h: Hex) => Uint8Array.from(h.slice(2).match(/../g)!.map((b) => parseInt(b, 16)));

/** The uncompressed public key a private key published with its first signature. */
export const publicKeyOf = (key: Hex): Hex => toHex(secp256k1.getPublicKey(bytes(key), false));
const scalarOf = (h: Hex) => BigInt(h) % N;

/** A secp256k1 stealth meta-address (ERC-5564 scheme 1): a spending key and a viewing key. */
export function scheme1Keys(): { spend: Hex; view: Hex; spendPub: Hex; viewPub: Hex } {
  const spend = generatePrivateKey(), view = generatePrivateKey();
  return { spend, view, spendPub: toHex(secp256k1.getPublicKey(bytes(spend), true)), viewPub: toHex(secp256k1.getPublicKey(bytes(view), true)) };
}

/** A payer's side: an ephemeral key R, the shared secret with the viewing key, and the stealth address. */
export function scheme1Pay(spendPub: Hex, viewPub: Hex): { ephemeral: Hex; viewTag: Hex; stealth: Address } {
  const r = generatePrivateKey();
  const shared = secp256k1.getSharedSecret(bytes(r), bytes(viewPub), true);
  const h = keccak256(shared);
  const P = secp256k1.Point.fromBytes(bytes(spendPub)).add(secp256k1.Point.BASE.multiply(scalarOf(h)));
  return { ephemeral: toHex(secp256k1.getPublicKey(bytes(r), true)), viewTag: h.slice(0, 4) as Hex, stealth: publicKeyToAddress(toHex(P.toBytes(false))) };
}

/** Whoever holds the viewing key, the owner or a quantum attacker: the stealth address an announcement pays. */
export function scheme1Find(view: Hex, spendPub: Hex, ephemeral: Hex): Address {
  const shared = secp256k1.getSharedSecret(bytes(view), bytes(ephemeral), true);
  const P = secp256k1.Point.fromBytes(bytes(spendPub)).add(secp256k1.Point.BASE.multiply(scalarOf(keccak256(shared))));
  return publicKeyToAddress(toHex(P.toBytes(false)));
}

/** Opaque's scheme: an ML-KEM-768 encapsulation, whose sizes the page shows; nothing in it is a curve point. */
export function mlKemPay(): { keyBytes: number; ciphertextBytes: number } {
  const { publicKey } = ml_kem768.keygen();
  const { cipherText } = ml_kem768.encapsulate(publicKey);
  return { keyBytes: publicKey.length, ciphertextBytes: cipherText.length };
}
