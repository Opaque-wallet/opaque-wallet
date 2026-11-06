// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {IPQKeyRegistry} from "../../opaque/interfaces/IPQKeyRegistry.sol";

/// @notice Owns an ENSv2 name and acts on it only when a FORS+C signature says so.
/// @dev Made the name's owner at registration (ETHRegistrar.register's `owner`)
///      and the admin of its PermissionedResolver, so every role ENS gives a
///      name's owner (subregistry, resolver, renewal, transfer, records) sits
///      here, from the first block the name exists. This contract calls out only
///      with a signature from the key it registered in PQKeyRegistry, which
///      counts that key's uses and refuses past its few-time bound. No ECDSA key
///      ever holds the name, so there is no owner's role to route around and
///      nothing to revoke afterwards.
///
///      Anyone may submit a signed call: who pays for the transaction authorises
///      nothing. The signature binds this contract, the chain (through the
///      registry's digest), the target, the exact calldata and a deadline, and
///      the registry's use count makes each one good once.
contract PQNameController {
    string internal constant DOMAIN = "opaque/v1/ens/execute";

    IPQKeyRegistry public immutable registry;

    event Executed(address indexed target, bytes4 selector, uint64 useCount);

    error Expired(uint256 deadline);
    error CallFailed(bytes reason);

    /// @param pkCommitment the FORS key that signs from now; `nextCommitment` the
    ///        one rotation promotes. Registered under this contract's address:
    ///        the registry binds a key to msg.sender, and only here.
    constructor(IPQKeyRegistry registry_, bytes32 pkCommitment, bytes32 nextCommitment, uint64 maxUses, uint64 rotationDeadline) {
        registry = registry_;
        registry_.register(pkCommitment, nextCommitment, maxUses, rotationDeadline);
    }

    /// @notice The bytes the key signs. PQKeyRegistry wraps them in its own
    ///         domain with the chain id, this contract's address and the use count.
    function payload(address target, bytes calldata data, uint256 deadline) public view returns (bytes memory) {
        return abi.encode(DOMAIN, block.chainid, address(this), deadline, target, keccak256(data));
    }

    /// @notice Calls `target` with `data`, as this contract, if the FORS key signed exactly that.
    function execute(address target, bytes calldata data, uint256 deadline, bytes calldata signature)
        external
        returns (bytes memory)
    {
        if (block.timestamp > deadline) revert Expired(deadline);
        uint64 useCount = registry.stateOf(address(this)).useCount;
        // Reverts unless the signature holds under the key in force and its budget has room.
        registry.consume(address(this), payload(target, data, deadline), signature);
        (bool ok, bytes memory out) = target.call(data);
        if (!ok) revert CallFailed(out);
        emit Executed(target, bytes4(data), useCount);
        return out;
    }

    // ENSv2 registries are ERC-1155: a name is minted to its owner with an acceptance check.
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        // ERC-165 itself, and IERC1155Receiver.
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x4e2312e0;
    }
}
