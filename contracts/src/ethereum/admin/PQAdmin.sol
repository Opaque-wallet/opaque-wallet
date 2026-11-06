// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {IPQKeyRegistry} from "../../opaque/interfaces/IPQKeyRegistry.sol";

/// @notice A post-quantum admin for any contract. Hand it what an ECDSA key holds today:
///         an Ownable owner, an OpenZeppelin ProxyAdmin, an AccessControl admin role.
///         From then on it calls out only on a FORS+C signature from the key `guardian`
///         holds in PQKeyRegistry. The day the guardian's ECDSA key falls to a quantum
///         computer, whoever broke it can't upgrade, pause or reconfigure anything.
/// @dev The signature covers this admin, the chain, the target, the exact calldata and a
///      deadline. The registry checks it at the key's use count and counts it, so it runs
///      once and only the call it names. Anyone may submit it: paying authorises nothing.
///      This contract names the guardian, not a key, so the guardian's key rotates through
///      the registry, as every FORS+C key there does, and nothing here changes.
contract PQAdmin {
    string public constant DOMAIN = "opaque/v1/admin/execute";
    IPQKeyRegistry public immutable registry;
    /// The address whose FORS+C key in the registry authorises every call: the MetaMask
    /// address that used to be the admin, so its guard key is the one it already has.
    address public immutable guardian;

    event Executed(address indexed target, bytes4 selector);

    error Expired();
    error CallFailed(bytes reason);

    constructor(IPQKeyRegistry registry_, address guardian_) {
        registry = registry_;
        guardian = guardian_;
    }

    /// @notice What the guardian's FORS+C key signs, inside the registry's user-action domain.
    function payload(address target, bytes calldata data, uint256 deadline) public view returns (bytes memory) {
        return abi.encode(DOMAIN, block.chainid, address(this), deadline, target, keccak256(data));
    }

    /// @notice Calls `target` with `data`, as this admin, if the guardian's key signed exactly that.
    function execute(address target, bytes calldata data, uint256 deadline, bytes calldata signature)
        external
        returns (bytes memory out)
    {
        if (block.timestamp > deadline) revert Expired();
        // Reverts unless the guardian's current key signed this payload at its use count; counts the use.
        registry.consume(guardian, payload(target, data, deadline), signature);
        bool ok;
        (ok, out) = target.call(data);
        if (!ok) revert CallFailed(out);
        emit Executed(target, bytes4(data));
    }
}

/// @notice One PQAdmin per guardian, at a CREATE2 address known before it exists.
contract PQAdminFactory {
    IPQKeyRegistry public immutable registry;

    event Created(address indexed guardian, address admin);

    error NoGuardKey();

    constructor(IPQKeyRegistry registry_) {
        registry = registry_;
    }

    function adminOf(address guardian) public view returns (address) {
        bytes32 code = keccak256(abi.encodePacked(type(PQAdmin).creationCode, abi.encode(registry, guardian)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(guardian), code)))));
    }

    /// @notice Anyone may create a guardian's admin: it obeys only that guardian's key. Refused
    ///         while the guardian has none, because a contract handed to an admin no key can
    ///         drive would be locked for good.
    function create(address guardian) external returns (PQAdmin admin) {
        if (registry.stateOf(guardian).pkCommitment == bytes32(0)) revert NoGuardKey();
        admin = new PQAdmin{salt: _salt(guardian)}(registry, guardian);
        emit Created(guardian, address(admin));
    }

    function _salt(address guardian) private pure returns (bytes32) {
        return bytes32(uint256(uint160(guardian)));
    }
}
