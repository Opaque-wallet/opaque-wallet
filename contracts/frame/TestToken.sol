// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

/// @notice A plain ERC-20 for the devnet: pqUSD for the Uniswap v4 pool (18
///         decimals), pqUSDC for the privacy pools (6, as their note sizes
///         assume). No owner and no minting after the constructor: the whole
///         supply goes to `to`.
/// @dev Deployed through the CREATE2 deployer by a FramePQAccount's SENDER
///      frame, so the deployer that runs this constructor is not the holder:
///      hence `to`.
contract TestToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address to, uint256 supply) {
        name = name_;
        decimals = decimals_;
        symbol = symbol_;
        totalSupply = supply;
        balanceOf[to] = supply;
        emit Transfer(address(0), to, supply);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
        return true;
    }

    /// Checked arithmetic is the balance check: a transfer of more than is held reverts.
    function _move(address from, address to, uint256 value) private {
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
