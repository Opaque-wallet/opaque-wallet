// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/// @notice A stand-in for any protocol, to try PQAdmin on. It has two admin keys, as real
///         protocols do: OpenZeppelin's ProxyAdmin decides upgrades, and the implementation's
///         owner sets the fee. Both start as the creator's ECDSA address.
contract DemoProtocolV1 {
    address public owner;
    uint256 public fee;
    bool private initialized;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FeeSet(uint256 fee);

    error OwnableUnauthorizedAccount(address account);
    error AlreadyInitialized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OwnableUnauthorizedAccount(msg.sender);
        _;
    }

    function initialize(address owner_) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setFee(uint256 fee_) external onlyOwner {
        fee = fee_;
        emit FeeSet(fee_);
    }

    function version() external pure virtual returns (uint256) {
        return 1;
    }
}

/// @notice The same protocol, upgraded: what a signed upgrade switches to.
contract DemoProtocolV2 is DemoProtocolV1 {
    function version() external pure override returns (uint256) {
        return 2;
    }
}

/// @notice A demo protocol for whoever asks: an OpenZeppelin TransparentUpgradeableProxy over
///         DemoProtocolV1, whose ProxyAdmin and owner are both the caller.
contract DemoProtocolFactory {
    address public immutable implementation;

    event Created(address indexed owner, address protocol);

    constructor(address implementation_) {
        implementation = implementation_;
    }

    function create() external returns (address protocol) {
        protocol = address(
            new TransparentUpgradeableProxy(implementation, msg.sender, abi.encodeCall(DemoProtocolV1.initialize, (msg.sender)))
        );
        emit Created(msg.sender, protocol);
    }
}
