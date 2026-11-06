// Post-quantum stealth payments: ERC-5564 with ML-KEM-768, paid to FORS+C accounts.
//
// A recipient publishes one ML-KEM-768 encapsulation key in the ERC-6538 registry,
// its stealth meta-address. To pay it, a sender encapsulates to that key. The shared
// secret, which only the two of them hold, draws both keys (active and next) of a
// fresh PQ account, so the sender can compute the account's address and the
// recipient can sign for it. The sender posts the ciphertext on the ERC-5564
// Announcer and pays the address. The recipient decapsulates each announcement
// (a one-byte view tag skips 255 in 256 without the rest), finds its payments, and
// sweeps each into pool notes only it knows.
//
// Why ML-KEM: secp256k1 stealth addresses (ERC-5564 scheme 1) hide the recipient from
// today's observers, but a quantum computer reading the announcements later recomputes
// every shared secret and links every payment to its recipient. With ML-KEM it cannot.
//
// What hash-based keys cost: an elliptic-curve stealth key is the recipient's own key
// plus a tweak, which the sender cannot spend with. FORS+C keys have no such algebra,
// so here the sender holds the stealth account's keys too, until the recipient sweeps
// it. A stealth payment is final once swept, and the wallet sweeps as soon as it finds
// one. Taking it back before then would need the sender to watch for its own payment
// and race the recipient's wallet; the recipient sees which payments are final.

import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { encodeFunctionData, keccak256, parseAbi, parseAbiItem, stringToHex, type Hex } from 'viem';

import { FORS_C_DEFAULT, keyGen, pkCommitment } from '@opaque/pq-wallet';
import type { Address } from '@opaque/protocol-types';

import { requireContract } from '../../deployments/index.ts';
import { ACCOUNT_MAX_USES, accountSalt, PHRASE_ROTATION_DEADLINE, predictAccount } from './pq-account.ts';

/** This scheme's id in ERC-5564 and ERC-6538: a hash, so it cannot collide with a numbered one. */
export const SCHEME_ID = BigInt(keccak256(stringToHex('opaque/v1/stealth/ml-kem-768/fors-c')));
/** ERC-5564's Announcer and ERC-6538's registry: one address on every chain they are deployed to. */
export const ANNOUNCER = '0x55649e01b5df198d18d95b5cc5051630cfd45564' as Address;
export const META_REGISTRY = '0x6538e6bf4b0ebd30a8ea093027ac2422ce5d6538' as Address;

export const ANNOUNCER_ABI = parseAbi(['function announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata)']);
export const ANNOUNCEMENT = parseAbiItem('event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)');
export const META_REGISTRY_ABI = parseAbi([
  'function registerKeys(uint256 schemeId, bytes stealthMetaAddress)',
  'function stealthMetaAddressOf(address registrant, uint256 schemeId) view returns (bytes)',
]);

export const META_ADDRESS_BYTES = 1184;
export const CIPHERTEXT_BYTES = 1088;

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
const bytes = (h: string): Uint8Array => Uint8Array.from((h.slice(2).match(/../g) ?? []).map((b) => parseInt(b, 16)));
const derive = (sharedSecret: Uint8Array, label: string) => keccak_256(new Uint8Array([...utf8(`opaque/v1/stealth/${label}`), ...sharedSecret]));

/** The recipient's ML-KEM-768 keys, from 64 secret bytes (drawn from its phrase, so they come back with it). */
export function stealthKeys(seed64: Uint8Array): { readonly metaAddress: Hex; readonly secretKey: Uint8Array } {
  const { publicKey, secretKey } = ml_kem768.keygen(seed64);
  return { metaAddress: hex(publicKey), secretKey };
}

/** The registry call that publishes `metaAddress`: made by the account it is for. */
export const registerCall = (metaAddress: Hex): { readonly to: Address; readonly data: Hex } => ({
  to: META_REGISTRY, data: encodeFunctionData({ abi: META_REGISTRY_ABI, functionName: 'registerKeys', args: [SCHEME_ID, metaAddress] }),
});

/** What one shared secret makes: the stealth account's key seeds, its address, and the view tag. */
export interface StealthAccount {
  readonly address: Address;
  readonly viewTag: number;
  /** Key seeds by epoch, as the wallet's `seedFor` takes them. Each call returns a new array. */
  readonly seedFor: (epoch: bigint) => Uint8Array;
  /** Hex of the shared secret: what the recipient keeps to sign for the account. */
  readonly secret: Hex;
}

export function stealthAccount(sharedSecret: Uint8Array): StealthAccount {
  const seedFor = (epoch: bigint) => derive(sharedSecret, `fors/${epoch}`);
  const commitment = (epoch: bigint) => pkCommitment(keyGen(seedFor(epoch), FORS_C_DEFAULT).publicKey);
  // The account a phrase wallet makes from these seeds (livePqWalletOptions): keys 0
  // and 1, 32 uses each, and the fixed deadline that keeps an address computable.
  const salt = accountSalt(commitment(0n), commitment(1n), ACCOUNT_MAX_USES, PHRASE_ROTATION_DEADLINE);
  return {
    address: predictAccount(requireContract('pqAccountFactory') as Address, requireContract('pqAccountImplementation') as Address, salt).toLowerCase() as Address,
    viewTag: derive(sharedSecret, 'view-tag')[0]!,
    seedFor,
    secret: hex(sharedSecret),
  };
}

/** The sender's side: a fresh address for `metaAddress`, and what to announce for it. */
export function stealthPayment(metaAddress: Hex): { readonly address: Address; readonly ephemeralPubKey: Hex; readonly metadata: Hex } {
  const key = bytes(metaAddress);
  if (key.length !== META_ADDRESS_BYTES) throw new Error('that is not an ML-KEM-768 stealth meta-address');
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(key);
  const account = stealthAccount(sharedSecret);
  return { address: account.address, ephemeralPubKey: hex(cipherText), metadata: hex(Uint8Array.of(account.viewTag)) };
}

export interface Announcement { readonly stealthAddress: `0x${string}`; readonly ephemeralPubKey: Hex; readonly metadata: Hex }

/**
 * The recipient's side: the account an announcement pays, if it is ours. ML-KEM
 * decapsulation never fails (a wrong ciphertext gives a pseudorandom secret), so
 * the address the secret makes is the check, after the view tag's cheap one.
 */
export function openAnnouncement(secretKey: Uint8Array, a: Announcement): StealthAccount | undefined {
  const ct = bytes(a.ephemeralPubKey);
  if (ct.length !== CIPHERTEXT_BYTES || a.metadata.length < 4) return undefined;
  const sharedSecret = ml_kem768.decapsulate(ct, secretKey);
  const account = stealthAccount(sharedSecret);
  if (account.viewTag !== parseInt(a.metadata.slice(2, 4), 16)) return undefined;
  return account.address === a.stealthAddress.toLowerCase() ? account : undefined;
}

/** A found account again, from the shared secret kept for it. */
export const stealthAccountOf = (secret: Hex): StealthAccount => stealthAccount(bytes(secret));
