// ENSv2 names a FORS+C key controls: what contracts/src/ethereum/ens/PQNameController.sol
// checks before it calls anything as the name's owner. The key signs the call
// (target, exact calldata, deadline) under PQKeyRegistry's digest, which binds
// the chain, the controller and the key's use count.

import { encodeSignature, forsSchemeId, keyGen, pqDigest, sign } from '@opaque/pq-wallet';
import type { Bytes32 } from '@opaque/protocol-types';
import { encodeAbiParameters, keccak256, parseAbiParameters, type Address, type Hex } from 'viem';

// Not in pq-wallet's pinned public API; imported from source, as cre/attester-keys.ts does.
import { userActionPayload } from '../../packages/pq-wallet/src/registry.ts';

export type RegistryKey = ReturnType<typeof keyGen>;

/** PQNameController.payload: the bytes inside the registry's action domain. */
export const controllerPayload = (chainId: bigint, controller: Address, target: Address, data: Hex, deadline: bigint): Hex =>
  encodeAbiParameters(parseAbiParameters('string, uint256, address, uint256, address, bytes32'),
    ['opaque/v1/ens/execute', chainId, controller, deadline, target, keccak256(data)]);

/** The signature PQNameController.execute(target, data, deadline, signature) takes, at the key's `useCount`. */
export function signExecute(key: RegistryKey, chainId: bigint, controller: Address, useCount: bigint, target: Address, data: Hex, deadline: bigint): Hex {
  const digest = pqDigest({
    chainId: chainId as never, walletAddress: controller.toLowerCase() as never, schemeId: forsSchemeId(key.publicKey.params), useCount,
    payload: userActionPayload(controllerPayload(chainId, controller, target, data, deadline)),
  });
  return encodeSignature(key.publicKey, sign(key.secretKey, digest as Bytes32)) as Hex;
}
