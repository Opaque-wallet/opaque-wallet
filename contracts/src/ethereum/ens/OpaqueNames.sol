// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

/// @notice name.opaque.eth for any Opaque wallet: first come, first served, one per wallet.
/// @dev opaque.eth's subregistry in ENSv2 (ETHRegistry.setSubregistry, signed through
///      PQNameController), and the resolver of every name in it: UniversalResolverV2
///      walks root → eth → opaque → here, and a claimed label's resolver is this
///      contract (getResolver). A name resolves to the wallet that claimed it.
///
///      Only an Opaque post-quantum account can claim: msg.sender's code must be the
///      EIP-1167 clone of the PQAccount implementation, which moves funds on a FORS+C
///      signature only. So every name here is held by an account no ECDSA key can
///      move, and a wallet paying one knows it.
contract OpaqueNames {
    /// IExtendedResolver.resolve(bytes,bytes), ERC-165, addr(bytes32), addr(bytes32,uint256).
    bytes4 private constant EXTENDED = 0x9061b923;
    bytes4 private constant ERC165 = 0x01ffc9a7;
    bytes4 private constant ADDR = 0x3b3b57de;
    bytes4 private constant ADDR_COIN = 0xf1cb7e06;
    uint256 private constant ETH_COIN = 60;

    /// ENSv2's .eth registry, this registry's canonical parent.
    address public immutable parent;
    /// keccak256 of a PQ account clone's code.
    bytes32 public immutable accountCodeHash;
    /// namehash("opaque.eth").
    bytes32 public immutable parentNode;

    mapping(bytes32 labelHash => address) public holderOf;
    mapping(address account => string) public nameOf;
    mapping(bytes32 node => address) private holderAt;

    event Claimed(string label, address indexed account);
    event Released(string label, address indexed account);

    error NotAnOpaqueAccount();
    error BadLabel();
    error Taken();
    error HasAName();
    error NoName();
    error UnsupportedResolverProfile(bytes4 selector);

    constructor(address parent_, address accountImplementation) {
        parent = parent_;
        accountCodeHash = keccak256(abi.encodePacked(hex"363d3d373d3d3d363d73", accountImplementation, hex"5af43d82803e903d91602b57fd5bf3"));
        parentNode = keccak256(abi.encodePacked(keccak256(abi.encodePacked(bytes32(0), keccak256("eth"))), keccak256("opaque")));
    }

    /// @notice `label`.opaque.eth for the calling wallet: 3 to 32 of a-z, 0-9 and
    ///         inner hyphens, unclaimed, and the wallet's first.
    function claim(string calldata label) external {
        if (msg.sender.codehash != accountCodeHash) revert NotAnOpaqueAccount();
        if (!_valid(bytes(label))) revert BadLabel();
        bytes32 labelHash = keccak256(bytes(label));
        if (holderOf[labelHash] != address(0)) revert Taken();
        if (bytes(nameOf[msg.sender]).length != 0) revert HasAName();
        holderOf[labelHash] = msg.sender;
        nameOf[msg.sender] = label;
        holderAt[_node(labelHash)] = msg.sender;
        emit Claimed(label, msg.sender);
    }

    /// @notice Gives the calling wallet's name up, for anyone (or it) to claim again.
    function release() external {
        string memory label = nameOf[msg.sender];
        if (bytes(label).length == 0) revert NoName();
        bytes32 labelHash = keccak256(bytes(label));
        delete holderOf[labelHash];
        delete nameOf[msg.sender];
        delete holderAt[_node(labelHash)];
        emit Released(label, msg.sender);
    }

    // ── IRegistry: what UniversalResolverV2 walks ──────────────────────────

    function getSubregistry(string calldata) external pure returns (address) {
        return address(0);
    }

    function getResolver(string calldata label) external view returns (address) {
        return holderOf[keccak256(bytes(label))] == address(0) ? address(0) : address(this);
    }

    function getParent() external view returns (address, string memory) {
        return (parent, "opaque");
    }

    // ── the resolver: a name's address is its wallet's ─────────────────────

    function addr(bytes32 node) public view returns (address) {
        return holderAt[node];
    }

    function addr(bytes32 node, uint256 coinType) public view returns (bytes memory) {
        address holder = holderAt[node];
        return coinType == ETH_COIN && holder != address(0) ? abi.encodePacked(holder) : bytes("");
    }

    /// @notice ENSIP-10: the two addr profiles; anything else is unsupported.
    function resolve(bytes calldata, bytes calldata data) external view returns (bytes memory) {
        bytes4 selector = bytes4(data[:4]);
        if (selector == ADDR) return abi.encode(addr(abi.decode(data[4:], (bytes32))));
        if (selector == ADDR_COIN) {
            (bytes32 node, uint256 coinType) = abi.decode(data[4:], (bytes32, uint256));
            return abi.encode(addr(node, coinType));
        }
        revert UnsupportedResolverProfile(selector);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == ERC165 || id == EXTENDED || id == ADDR || id == ADDR_COIN;
    }

    function _node(bytes32 labelHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked(parentNode, labelHash));
    }

    function _valid(bytes calldata label) private pure returns (bool) {
        uint256 n = label.length;
        if (n < 3 || n > 32 || label[0] == "-" || label[n - 1] == "-") return false;
        for (uint256 i; i < n; ++i) {
            bytes1 c = label[i];
            if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-")) return false;
        }
        return true;
    }
}
