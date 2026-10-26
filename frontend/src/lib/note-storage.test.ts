// The note map is one localStorage record, read, changed and written whole.
// Two tabs doing that at once would each write back what the other had not
// yet seen, and a note made in one (its secret) could vanish under the other.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { localNoteStorage } from './note-storage.ts';

// ── overlord F-67 (2026-10-26) ──────────────────────────────────────────────

test('F-67: the note map is read, changed and written under its Web Lock, so tabs take turns', async () => {
  let held = 0;
  const outside: string[] = [];
  const items = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => { if (held === 0) outside.push(`read ${k}`); return items.get(k) ?? null; },
      setItem: (k: string, v: string) => { if (held === 0) outside.push(`write ${k}`); items.set(k, v); },
    },
  });
  const asked: string[] = [];
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: { request: async <T>(name: string, run: () => Promise<T>) => { asked.push(name); held++; try { return await run(); } finally { held--; } } },
  });
  try {
    const storage = localNoteStorage('opaque:notes:v1');
    await storage.write({ id: 'n1', state: 'CREATED' } as never);
    await storage.write({ id: 'n2', state: 'CREATED' } as never);
    assert.deepEqual(Object.keys(JSON.parse(items.get('opaque:notes:v1')!)), ['n1', 'n2']);
  } finally {
    delete (globalThis.navigator as { locks?: unknown }).locks;
  }
  assert.deepEqual(outside, [], 'the map was read or written outside the lock');
  assert.deepEqual(asked, ['opaque:notes:v1', 'opaque:notes:v1']);
});
