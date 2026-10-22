// prover.ts's thread. The note secret arrives as a copy, is used once, and is
// zeroed here as the caller zeroes its own.

import { parentPort } from 'node:worker_threads';

import { buildRingSpend, verifyRingSpend } from '../../../backend/zk/index.ts';

type Request =
  | { readonly id: number; readonly op: 'prove'; readonly input: Parameters<typeof buildRingSpend>[0] }
  | { readonly id: number; readonly op: 'verify'; readonly input: Parameters<typeof verifyRingSpend>[0] };

parentPort!.on('message', ({ id, op, input }: Request) => {
  try {
    parentPort!.postMessage({ id, result: op === 'prove' ? buildRingSpend(input) : verifyRingSpend(input) });
  } catch (error) {
    const e = error as { code?: string; publicMessage?: string; message?: string; retryable?: boolean };
    parentPort!.postMessage({ id, error: { code: e.code ?? 'PROOF_REJECTED', message: e.publicMessage ?? e.message ?? 'the prover failed', retryable: e.retryable ?? false } });
  } finally {
    if (op === 'prove') input.noteSecret.fill(0);
  }
});
