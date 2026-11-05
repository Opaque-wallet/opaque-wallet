// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @notice Deploys init code with CREATE, for its owner only, so each address
///         follows from this contract's nonce alone.
/// @dev The devnet's privacy pools need that. An AttestedRingVerifier binds
///      its pool's id, which the pool derives from its own address, and the
///      pool binds the verifier's address: under CREATE2 each address would
///      depend on the other's init code. A FramePQAccount cannot CREATE itself
///      (a frame calls a target), so it deploys through this. Owner-only, so
///      nobody can spend a nonce between the prediction and the deploy.
contract CreateDeployer {
    address public immutable owner;

    error NotOwner();
    error CreateFailed();

    constructor(address owner_) {
        owner = owner_;
    }

    function deploy(bytes memory initCode) external returns (address at) {
        if (msg.sender != owner) revert NotOwner();
        assembly {
            at := create(0, add(initCode, 0x20), mload(initCode))
        }
        if (at == address(0)) revert CreateFailed();
    }
}
