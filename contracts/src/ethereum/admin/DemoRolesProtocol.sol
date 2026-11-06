// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

/// @notice A second stand-in protocol, with the admin keys real protocols spread around: an
///         OpenZeppelin UpgradeableBeacon whose owner decides upgrades, and AccessControl roles:
///         the admin role, one that sets the fee and one that pauses. All start with the creator's
///         ECDSA address, so the quantum-safe admin page has to find every one.
contract DemoRolesV1 is AccessControl {
    bytes32 public constant FEE_ROLE = keccak256("FEE_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public fee;
    bool public paused;
    bool private initialized;

    error AlreadyInitialized();

    function initialize(address admin) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FEE_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    function setFee(uint256 fee_) external onlyRole(FEE_ROLE) {
        fee = fee_;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        paused = true;
    }

    function version() external pure virtual returns (uint256) {
        return 1;
    }
}

/// @notice The same protocol, upgraded through its beacon.
contract DemoRolesV2 is DemoRolesV1 {
    function version() external pure override returns (uint256) {
        return 2;
    }
}

/// @notice A beacon-proxied DemoRolesV1 for whoever asks: the caller owns the beacon and holds every role.
contract DemoRolesFactory {
    address public immutable implementation;

    event Created(address indexed owner, address protocol);

    constructor(address implementation_) {
        implementation = implementation_;
    }

    function create() external returns (address protocol) {
        UpgradeableBeacon beacon = new UpgradeableBeacon(implementation, msg.sender);
        protocol = address(new BeaconProxy(address(beacon), abi.encodeCall(DemoRolesV1.initialize, (msg.sender))));
        emit Created(msg.sender, protocol);
    }
}
