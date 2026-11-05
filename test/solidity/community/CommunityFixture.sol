// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {CommunityDirectoryV1} from "../../../contracts/community/CommunityDirectoryV1.sol";
import {CommunityPostsV1} from "../../../contracts/community/CommunityPostsV1.sol";
import {ICommunityDirectoryV1 as Directory} from "../../../contracts/interfaces/community/ICommunityDirectoryV1.sol";
import {ICommunityPostsV1 as Posts} from "../../../contracts/interfaces/community/ICommunityPostsV1.sol";

interface CommunityVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function etch(address, bytes calldata) external;
    function assume(bool) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

/// @dev Identity fixture only: not the SLD registry, HNS verifier or wallet SDK.
contract RegistryIdentityFixture {
    address public factory;
    address public admin;
    string public tld;

    function initialize(string calldata label, address controller) external {
        require(factory == address(0) && controller != address(0) && bytes(label).length != 0);
        factory = msg.sender;
        admin = controller;
        tld = label;
    }

    function changeAdmin(address next) external {
        require(msg.sender == admin);
        admin = next;
    }
}

/// @dev Real standard ERC-1167 runtime; simplified registry/factory semantics.
contract RegistryFactoryFixture {
    address public immutable implementation = address(new RegistryIdentityFixture());
    mapping(address => bool) public isRegistry;

    function deploy(string calldata label, address controller) external returns (address registry) {
        bytes memory init = abi.encodePacked(
            hex"3d602d80600a3d3981f3", hex"363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"
        );
        assembly ("memory-safe") { registry := create(0, add(init, 32), mload(init)) }
        require(registry != address(0));
        RegistryIdentityFixture(registry).initialize(label, controller);
        isRegistry[registry] = true;
    }

    // Deliberately hostile fixture hook for membership validation tests.
    function mark(address registry, bool value) external {
        isRegistry[registry] = value;
    }
}

contract GovernanceAccountFixture {
    address public signer;
    address public immutable recovery;

    constructor(address initialSigner, address recoverySigner) {
        signer = initialSigner;
        recovery = recoverySigner;
    }

    function rotate(address next) external {
        require((msg.sender == signer || msg.sender == recovery) && next != address(0));
        signer = next;
    }

    function execute(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == signer);
        (bool ok, bytes memory result) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        }
        return result;
    }
}

contract ForgedRegistryFixture {
    address public immutable factory;
    address public immutable admin;
    string public tld = "sample";

    constructor(address factory_, address admin_) {
        factory = factory_;
        admin = admin_;
    }
}

contract HostileRegistryFixture {
    address public immutable target;

    constructor(address target_) {
        target = target_;
    }

    // The directory's STATICCALL must prevent a mutation even if the getter tries.
    function factory() external returns (address) {
        Directory(target).setListed(bytes32(uint256(1)), 0, false, bytes32(0));
        return address(this);
    }
}

abstract contract CommunityFixture {
    CommunityVm constant vm = CommunityVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant OWNER = address(0x1001);
    address constant NEXT = address(0x1002);
    address constant PUBLISHER = address(0x2001);
    address constant OTHER_PUBLISHER = address(0x2002);
    bytes32 constant POST = keccak256("post");
    bytes32 constant AUTHOR = keccak256("community-author");
    bytes32 constant DIGEST = keccak256("exact-content-bytes");
    string constant URI = "ipfs://bafkreigh2akiscaildc6c3bwi6f6t3kp34lwd77d5ppf2v3atx7q7hkwgy";
    RegistryFactoryFixture factory;
    GovernanceAccountFixture verifier;
    GovernanceAccountFixture listing;
    CommunityDirectoryV1 directory;
    CommunityPostsV1 posts;
    address registry;
    bytes32 communityId;

    function setUp() public virtual {
        vm.warp(1800000000);
        factory = new RegistryFactoryFixture();
        verifier = new GovernanceAccountFixture(address(this), NEXT);
        listing = new GovernanceAccountFixture(address(this), NEXT);
        address[] memory factories = new address[](1);
        factories[0] = address(factory);
        directory = new CommunityDirectoryV1(factories, address(verifier), address(listing), 1 days);
        posts = new CommunityPostsV1(address(directory));
        registry = factory.deploy("sample", OWNER);
        communityId = directory.communityIdFor(registry);
    }

    function config(address controller, address publisher) internal pure returns (Directory.Configuration memory) {
        return Directory.Configuration(controller, publisher, address(0), address(0), DIGEST, URI);
    }

    function register() internal {
        vm.prank(OWNER);
        directory.registerCommunity(registry, config(OWNER, PUBLISHER));
    }

    function verify(uint64 configRevision, uint64 revision) internal {
        Directory.NamespaceVerification memory proof = Directory.NamespaceVerification(
            configRevision, 100, DIGEST, uint64(block.timestamp), uint64(block.timestamp + 1 hours), DIGEST
        );
        verifier.execute(address(directory), abi.encodeCall(Directory.verifyNamespace, (communityId, revision, proof)));
    }

    function list(bool value, uint64 revision) internal {
        listing.execute(address(directory), abi.encodeCall(Directory.setListed, (communityId, revision, value, DIGEST)));
    }

    function publish(
        bytes32 id,
        bytes32 postId,
        uint64 revision,
        uint64 configRevision,
        bytes32 author,
        Posts.Kind kind
    ) internal {
        posts.publishRevision(id, postId, revision, configRevision, author, kind, DIGEST, URI);
    }

    function stateHash() internal view returns (bytes32) {
        return keccak256(abi.encode(directory.getCommunity(communityId), directory.getControllerTransfer(communityId)));
    }
}
