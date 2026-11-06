---
title: Unconditional Exit for Privacy Pools
description: A delayed, operator-free withdrawal path for privacy pools whose private path depends on an operator
author: Swarnim Raj
status: Draft (not submitted)
type: Standards Track
category: ERC
requires: none
---

## Abstract

Many privacy pools can only be withdrawn from with an operator's help: an attester, a relayer, a sequencer, or a prover service that holds a key. This standard adds a second path that needs nobody. The note's owner announces the note's nullifier, bound to a payout. After a public delay they reveal the note's secret, and the pool's verifier recomputes the note's commitment and nullifier on chain and pays. The note loses its privacy, because its secret becomes public, but the funds always come back.

## Motivation

A pool whose withdrawals need an operator is custodial in practice: if the operator goes away, is captured, or refuses a user, the user's funds stay in the contract. The usual answer is "run your own operator", but an attester's key or a proving service cannot be run by anyone. Ethereum's CROPS goals ask for the opposite: users keep control without trusting a third party.

The exit gives every note a way out that depends only on Ethereum. The private path stays exactly as it was, and the exit sits beside it.

## Specification

The key words "MUST", "MUST NOT", "SHOULD" and "MAY" are to be read as in RFC 2119.

A pool's notes MUST be derivable from a secret by a function the verifier can compute on chain: `(commitment, nullifier) = noteOf(secret)`. (In the reference implementation, `noteOf` is AES-128 with the secret as key, over two per-pool constant blocks.)

```solidity
interface IExitableVerifier {
    event ExitAnnounced(bytes32 indexed nullifier, bytes32 claim, uint256 payableAt);
    event Exited(bytes32 indexed nullifier, bytes32 commitment);

    /// Seconds between an announcement and the exit it allows.
    function exitDelay() external view returns (uint256);

    /// Step 1. claim = keccak256(abi.encode(secret, paymentContext(recipient))).
    /// Callable by anyone. Reveals nothing about which deposit the note is.
    function announceExit(bytes32 nullifier, bytes32 claim) external;

    /// When (nullifier, claim) was announced; 0 if it was not.
    function announcedAt(bytes32 nullifier, bytes32 claim) external view returns (uint256);
}
```

Step 2 is the pool's ordinary spend, with a proof that marks it as an exit and carries the secret (in the reference implementation, `EXIT_TAG ‖ secret`). The verifier MUST:

1. compute `(commitment, nullifier) = noteOf(secret)`;
2. require `commitment` to be a member of the spend's ring (or of the pool's deposits);
3. require `announcedAt(nullifier, keccak256(abi.encode(secret, paymentContext))) != 0` for the spend's own payment context;
4. require that announcement to be at least `exitDelay` old;
5. return `nullifier`, so the pool's normal double-spend check applies.

Once a nullifier has been announced, the verifier MUST refuse that nullifier on the private path. A repeated announcement of the same `(nullifier, claim)` MUST revert, so an announcement's time cannot be moved.

## Rationale

- **Why announce first:** the secret is revealed only in step 2. If the exit were one step, anyone who saw the secret in the mempool could race it through the private path to their own address. Announcing the nullifier closes the private path for that note before the secret is out, and the claim binds the payout to a recipient.
- **Why a delay:** it is the window in which an operator-backed pool's own mechanisms can still act on a note (a compliance freeze, for instance) before it leaves. A pool with no such mechanism MAY set the delay to a few blocks.
- **Griefing:** announcing someone else's note needs its nullifier, which stays secret until the note is spent.
- **The privacy cost is the user's choice:** the exit reveals one note's secret and links its deposit to its withdrawal. It is a way out when the private path fails, not a replacement for it.

## Reference implementation

- [`ExitableRingVerifier.sol`](../../contracts/src/opaque/pool/ExitableRingVerifier.sol), wrapping an attested ring verifier, with [`AES128.sol`](../../contracts/src/opaque/lib/AES128.sol) (FIPS-197, checked against the wallet's own derivation).
- Tests: [`ExitableRingVerifier.t.sol`](../../contracts/test/ExitableRingVerifier.t.sol). They cover a full exit through a real pool, too early, the wrong recipient, a secret not in the ring, a race through the attester, a repeated announcement and a double spend.
- Deployed on Sepolia with a 300-second delay: the seven pools in [`deployments/eth-sepolia.json`](../../deployments/eth-sepolia.json).
- Client: [`ring-exit.ts`](../../backend/chain/ring-exit.ts), and [`without-opaque.ts`](../../frontend/src/lib/without-opaque.ts), which runs the whole exit in a browser over EF's anon-rpc.

## Security considerations

- `noteOf` MUST be the exact derivation the private path uses. A mismatch locks notes out of the exit, and the reference tests check it byte for byte against the wallet.
- On-chain AES-128 makes the exit cost about 665k gas on Sepolia (an announcement costs about 68k), paid by whoever submits it.
- The delay is a trade-off: longer gives operator mechanisms time, shorter returns funds sooner. A pool SHOULD publish its delay and MUST NOT be able to change it for notes already deposited.
