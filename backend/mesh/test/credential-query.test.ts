// The policy credential, asked across the mesh: the exit decodes only a
// lower-case address, and answers the credential the CRE will accept.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Address, UnixSeconds } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { checkCredential, credentialJson, type RecipientCredential } from '../../cre/credential.ts';
import { createQueryAnswerer, decodeMeshQuery } from '../queries.ts';

const secret = new Uint8Array(32).fill(9);
const recipient = `0x${'ab'.repeat(20)}` as Address;
const now = 1_800_000_000n as UnixSeconds;

test('the exit decodes CREDENTIAL for a lower-case address, and nothing else', () => {
  assert.deepEqual(decodeMeshQuery({ kind: 'CREDENTIAL', recipient }), { kind: 'CREDENTIAL', recipient });
  assert.throws(() => decodeMeshQuery({ kind: 'CREDENTIAL', recipient: recipient.toUpperCase() }), /lower-case address/);
  assert.throws(() => decodeMeshQuery({ kind: 'CREDENTIAL' }), /lower-case address/);
});

test('its answer is a credential the CRE accepts for that recipient', async () => {
  const answer = createQueryAnswerer({
    graph: {} as never, intentStatus: async () => { throw new Error('unused'); },
    credential: async (r) => toHex(new TextEncoder().encode(credentialJson(r, 'opaque-policy-v1', secret, now))),
  });
  const result = await answer({ kind: 'CREDENTIAL', recipient });
  assert.equal(result.kind, 'CREDENTIAL');
  const raw = JSON.parse(new TextDecoder().decode(fromHex(result.value as `0x${string}`))) as Record<string, string>;
  const credential = { ...raw, expiresAt: BigInt(raw['expiresAt']!) } as unknown as RecipientCredential;
  assert.deepEqual(checkCredential({ recipient, credential, policyVersion: 'opaque-policy-v1', now, secret }), { kind: 'APPROVED' });

  const without = createQueryAnswerer({ graph: {} as never, intentStatus: async () => { throw new Error('unused'); } });
  await assert.rejects(without({ kind: 'CREDENTIAL', recipient }), /does not answer CREDENTIAL/);
});
