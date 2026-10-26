// The password lock, over a stand-in Storage it patches as it patches the
// browser's. A change of password re-seals every record under a new key; a
// tab that has not yet seen the change may still seal one under the old key.

import assert from 'node:assert/strict';
import { test } from 'node:test';

/** localStorage's shape, on a prototype lock.ts can patch. */
class FakeStorage {
  readonly #items = new Map<string, string>();
  getItem(k: string): string | null { return this.#items.get(k) ?? null; }
  setItem(k: string, v: string): void { this.#items.set(k, String(v)); }
  removeItem(k: string): void { this.#items.delete(k); }
  key(i: number): string | null { return [...this.#items.keys()][i] ?? null; }
  get length(): number { return this.#items.size; }
}
const rawSet = FakeStorage.prototype.setItem;
let duringMove: (() => void) | undefined;
Object.assign(globalThis, {
  Storage: FakeStorage, localStorage: new FakeStorage(), sessionStorage: new FakeStorage(), addEventListener: () => undefined,
  // Arc's key stores: none here. Asked for while records move, which is when the other tab's write lands.
  indexedDB: { databases: async () => { duringMove?.(); duringMove = undefined; return []; } },
});
const lock = await import('./lock.ts');

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ── overlord F-67 (2026-10-26) ──────────────────────────────────────────────

test('F-67: a record another tab sealed under the old key as the password changed can still be read', async () => {
  localStorage.setItem('opaque:sent:v1', '["before"]');
  await lock.setPassword('first password');
  const oldKey = unb64((JSON.parse(sessionStorage.getItem('opaque:unlocked:v1')!) as { key: string }).key);
  // The other tab wrote before it saw the new password: sealed under the old key, landing mid-move.
  duringMove = () => rawSet.call(localStorage, 'opaque:sent:v1', `sealed:v1:${b64(lock.sealWith(oldKey, new TextEncoder().encode('["late"]')))}`);
  await lock.changePassword('first password', 'second password');
  assert.equal(duringMove, undefined, 'the move never reached the key stores');
  assert.equal(localStorage.getItem('opaque:sent:v1'), '["late"]');
});
