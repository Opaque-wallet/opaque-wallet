// The ring proof on a worker thread: 219 ZKBoo repetitions take seconds, and
// a server's event loop should not stop for them. The page does the same with
// a Web Worker (frontend/src/lib/prover.ts).

import { Worker } from 'node:worker_threads';

import { ProtocolFailure, type PrivateSpend } from '@opaque/protocol-types';

import type { RingProver } from '../../ring-client/src/ring-client.ts';

export function nodeProver(): RingProver {
  let worker: Worker | undefined;
  const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  let next = 0;

  const start = (): Worker => {
    // Beside this file: .ts from source, .js from the built package (scripts/build-dist.ts).
    const w = new Worker(new URL(`./prover-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url));
    w.on('message', ({ id, result, error }: { id: number; result?: unknown; error?: { code: string; message: string; retryable: boolean } }) => {
      const waiting = pending.get(id);
      pending.delete(id);
      if (pending.size === 0) w.unref();
      if (error !== undefined) waiting?.reject(new ProtocolFailure(error.code as never, error.message, error.retryable));
      else waiting?.resolve(result as never);
    });
    // A worker that dies fails every call waiting on it; the next call starts another.
    w.on('error', (e) => {
      for (const waiting of pending.values()) waiting.reject(new Error(`the prover failed: ${e.message}`));
      pending.clear();
      worker = undefined;
    });
    return w;
  };

  const call = <T>(op: 'prove' | 'verify', input: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      worker ??= start();
      worker.ref();
      const id = next++;
      pending.set(id, { resolve: resolve as (value: never) => void, reject });
      worker.postMessage({ id, op, input });
    });

  return {
    prove: (input) => call<PrivateSpend>('prove', input),
    verify: (spend) => call<boolean>('verify', spend),
    // The wallet's close(): its thread goes, and whatever waits on it fails rather than hangs.
    close: async () => {
      const w = worker;
      worker = undefined;
      for (const waiting of pending.values()) waiting.reject(new Error('the wallet was closed'));
      pending.clear();
      await w?.terminate();
    },
  };
}
