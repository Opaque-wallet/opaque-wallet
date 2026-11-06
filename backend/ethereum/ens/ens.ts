// ENSv2 names a FORS+C key controls: what contracts/src/ethereum/ens/PQNameController.sol
// checks before it calls anything as the name's owner. The key signs the call
// (target, exact calldata, deadline) under PQKeyRegistry's digest, which binds
// the chain, the controller and the key's use count.

import { canonical, encodeSignature, forsSchemeId, keyGen, pkCommitment, pqDigest, sign, utf8 } from '@opaque/pq-wallet';
import type { Bytes32 } from '@opaque/protocol-types';
import { encodeAbiParameters, keccak256, parseAbi, parseAbiParameters, type Address, type Hex } from 'viem';

// Not in pq-wallet's pinned public API; imported from source, as cre/attester-keys.ts does.
import { rotationPayload, userActionPayload } from '../../../packages/pq-wallet/src/registry.ts';

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

/** The registry's digest of `payload` for `controller` at `useCount`, signed by `key`. */
function signFor(key: RegistryKey, chainId: bigint, controller: Address, useCount: bigint, payload: Hex): Hex {
  const digest = pqDigest({ chainId: chainId as never, walletAddress: controller.toLowerCase() as never, schemeId: forsSchemeId(key.publicKey.params), useCount, payload });
  return encodeSignature(key.publicKey, sign(key.secretKey, digest as Bytes32)) as Hex;
}

/**
 * Any PQKeyRegistry.consume(account, payload, signature) at the key's `useCount`: the
 * registry digests `payload` inside its user-action domain (the Q-Day vault's withdrawals,
 * the Uniswap guard's removals).
 */
export const signAction = (key: RegistryKey, chainId: bigint, account: Address, useCount: bigint, payload: Hex): Hex =>
  signFor(key, chainId, account, useCount, userActionPayload(payload));

/**
 * PQKeyRegistry.rotate(controller, next, maxUses, deadline, signature): the key in
 * force promotes the pre-committed next key and commits `next` after it.
 */
export const signRotation = (key: RegistryKey, chainId: bigint, controller: Address, useCount: bigint, next: Hex, maxUses: bigint, deadline: bigint): Hex =>
  signFor(key, chainId, controller, useCount, rotationPayload(next as Bytes32, maxUses, deadline));

/** Generation g of a key drawn from `master` under `label`: a name's controller keys. */
export const masterKey = (master: Uint8Array, label: string, g: number): RegistryKey =>
  keyGen(keccak256(canonical([utf8(label), master, utf8(String(g))]), 'bytes'));
export const commitmentOf = (key: RegistryKey): Hex => pkCommitment(key.publicKey) as Hex;

export const REGISTRY_ABI = parseAbi([
  'function stateOf(address) view returns ((bytes32 pkCommitment, bytes32 nextCommitment, uint64 useCount, uint64 maxUses, uint64 rotationDeadline, uint64 disableAfter))',
  'function rotate(address account, bytes32 newNextCommitment, uint64 newMaxUses, uint64 newRotationDeadline, bytes signature)',
]);
export const CONTROLLER_ABI = parseAbi(['function execute(address target, bytes data, uint256 deadline, bytes signature) returns (bytes)']);
