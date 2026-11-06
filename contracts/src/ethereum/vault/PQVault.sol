// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {IPQKeyRegistry} from "../../opaque/interfaces/IPQKeyRegistry.sol";

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice A Q-Day vault for any wallet, MetaMask's included: what it holds for an
///         address comes out only on a FORS+C signature from the key that address
///         registered in PQKeyRegistry. The address's own ECDSA key can put money in;
///         it can never take it out alone, so the day that key falls to a quantum
///         computer, whoever broke it finds nothing to move.
/// @dev An address registers a FORS+C key once (PQKeyRegistry.register, an ordinary
///      transaction), then deposits ETH (token zero) or any ERC-20 here. A withdrawal
///      carries a signature over the owner, token, exact amount, recipient and a
///      deadline, which the registry checks at the key's use count and counts, so it
///      works once and pays only the recipient it names. Anyone may submit it: the
///      owner can still withdraw with the FORS+C key alone after losing the ECDSA one.
///      The key rotates through the registry as every FORS+C key there does.
///      Plain tokens only: a fee-on-transfer token would be credited more than arrived.
contract PQVault {
    string public constant DOMAIN = "opaque/v1/vault/withdraw";

    IPQKeyRegistry public immutable registry;

    /// owner => token (zero for ETH) => what the vault holds for them.
    mapping(address => mapping(address => uint256)) public balanceOf;

    event Deposited(address indexed owner, address indexed token, uint256 amount);
    event Withdrawn(address indexed owner, address indexed token, uint256 amount, address indexed to);

    error NoGuardKey();
    error WrongValue();
    error Expired();
    error TooMuch();
    error TransferFailed();

    constructor(IPQKeyRegistry registry_) {
        registry = registry_;
    }

    /// @notice Puts `amount` of `token` (zero: ETH, sent as value) in the vault for the caller.
    ///         The caller must hold a FORS+C key first: money in a vault no key can open is lost.
    function deposit(address token, uint256 amount) external payable {
        if (registry.stateOf(msg.sender).pkCommitment == bytes32(0)) revert NoGuardKey();
        if (token == address(0)) {
            if (msg.value != amount) revert WrongValue();
        } else {
            if (msg.value != 0) revert WrongValue();
            if (!IERC20Min(token).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        }
        balanceOf[msg.sender][token] += amount;
        emit Deposited(msg.sender, token, amount);
    }

    /// @notice What a withdrawal's FORS+C key signs, inside the registry's user-action domain.
    function payload(address owner, address token, uint256 amount, address to, uint256 deadline) public view returns (bytes memory) {
        return abi.encode(DOMAIN, block.chainid, address(this), owner, token, amount, to, deadline);
    }

    /// @notice Pays `amount` of `owner`'s `token` to `to`, on `owner`'s FORS+C signature. Anyone may send it.
    function withdraw(address owner, address token, uint256 amount, address to, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert Expired();
        if (amount > balanceOf[owner][token]) revert TooMuch();
        // Reverts unless the owner's key signed exactly this, at its use count; counts the use.
        registry.consume(owner, payload(owner, token, amount, to, deadline), signature);
        balanceOf[owner][token] -= amount;
        emit Withdrawn(owner, token, amount, to);
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else if (!IERC20Min(token).transfer(to, amount)) {
            revert TransferFailed();
        }
    }
}
