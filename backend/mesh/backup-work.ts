// The work a new passkey backup costs (mesh/backup-store.ts), computed by the
// wallet (frontend/src/lib/passkey-backup.ts). Anyone may keep a backup, so a
// new id must show a nonce whose hash, with the id, starts with enough zero
// bits; the bits needed rise as the store fills. A person pays it once, about
// a second; filling the store costs a stranger far more, and more as it fills.
// Browser-safe: noble's SHA-256, no Node APIs.

import { sha256 } from '@noble/hashes/sha2.js';

const DOMAIN = new TextEncoder().encode('opaque/backup/work/v1');
/** Bits of work a new backup needs in an empty store: about a million hashes. */
export const BASE_BITS = 20;
/** And at most this many more, as the store reaches its capacity. */
export const EXTRA_BITS = 8;

const bytesOf = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));

/** Bits needed for a new backup when `count` of `max` are kept. */
export const workBits = (count: number, max: number, base = BASE_BITS): number => base + Math.floor((EXTRA_BITS * Math.min(count, max)) / max);

const leading = (h: Uint8Array): number => {
  let bits = 0;
  for (const b of h) {
    if (b === 0) { bits += 8; continue; }
    return bits + Math.clz32(b) - 24;
  }
  return bits;
};

/** Leading zero bits of SHA-256(domain ‖ id ‖ work). */
export const zeroBits = (id: string, work: string): number => leading(sha256(new Uint8Array([...DOMAIN, ...bytesOf(id), ...bytesOf(work)])));

/** A nonce (8 bytes, hex) giving `id` at least `bits` of work; yields to the page as it goes. */
export async function findWork(id: string, bits: number): Promise<string> {
  // One buffer, domain ‖ id ‖ nonce, with only the nonce rewritten each try.
  const at = DOMAIN.length + id.length / 2;
  const buf = new Uint8Array(at + 8);
  buf.set(DOMAIN);
  buf.set(bytesOf(id), DOMAIN.length);
  const view = new DataView(buf.buffer);
  for (let n = 0; ; n++) {
    view.setUint32(at, Math.floor(n / 0x1_0000_0000));
    view.setUint32(at + 4, n >>> 0);
    if (leading(sha256(buf)) >= bits) return n.toString(16).padStart(16, '0');
    if (n % 20_000 === 19_999) await new Promise((r) => setTimeout(r, 0));
  }
}
