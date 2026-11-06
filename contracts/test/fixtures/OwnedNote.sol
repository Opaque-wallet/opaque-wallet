// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

/// What backend/scripts/e2e-arc-contracts.ts deploys from an Opaque account:
/// owned by the address its constructor names (through the CREATE2 factory,
/// msg.sender is the factory), with a blob in its constructor arguments so the
/// deploy is too large for one mesh message.
contract OwnedNote {
    address public immutable owner;
    uint256 public immutable blobSize;
    string public note;

    constructor(address owner_, bytes memory blob) {
        owner = owner_;
        blobSize = blob.length;
    }

    function setNote(string calldata note_) external {
        require(msg.sender == owner, "not the owner");
        note = note_;
    }
}
