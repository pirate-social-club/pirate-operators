// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import "./CommunityFixture.sol";
import {
    NamespaceVerifierAuthorityV1 as VerifierAuthority
} from "../../../contracts/community/NamespaceVerifierAuthorityV1.sol";
import {
    CommunityListingAuthorityV1 as ListingAuthority
} from "../../../contracts/community/CommunityListingAuthorityV1.sol";

interface DiscoveryVm is CommunityVm {
    function snapshotState() external returns (uint256);
    function revertToState(uint256 snapshotId) external returns (bool);
    function deal(address account, uint256 balance) external;
}

/// @dev Deliberately counterfeit directory: role getters alone cannot prove code provenance.
contract DirectoryRoleFixture {
    address public namespaceVerifier;
    address public listingAuthority;

    constructor(address verifier, address listing) {
        namespaceVerifier = verifier;
        listingAuthority = listing;
    }
}

/// @dev Actual authority/directory/posts code, with simulated governance and registry identity.
/// This fixture establishes neither real Safe recovery nor the truth of HNS observations.
abstract contract DiscoveryAuthorityFixture {
    DiscoveryVm constant vm = DiscoveryVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant OWNER = address(0x1001);
    address constant PUBLISHER = address(0x2001);
    address constant SERVICE = address(0x3001);
    address constant NEXT_SERVICE = address(0x3002);
    address constant EMERGENCY = address(0x4001);
    address constant NEXT_EMERGENCY = address(0x4002);
    address constant VERIFIER_RECOVERY = address(0x5001);
    address constant LISTING_RECOVERY = address(0x5002);
    bytes32 constant DIGEST = keccak256("exact-content-bytes");
    string constant URI = "ipfs://bafkreigh2akiscaildc6c3bwi6f6t3kp34lwd77d5ppf2v3atx7q7hkwgy";
    GovernanceAccountFixture verifierGovernance;
    GovernanceAccountFixture listingGovernance;
    VerifierAuthority verifierAuthority;
    ListingAuthority listingAuthority;
    RegistryFactoryFixture factory;
    CommunityDirectoryV1 directory;
    CommunityPostsV1 posts;
    address registry;
    bytes32 communityId;

    function setUp() public virtual {
        vm.warp(1800000000);
        verifierGovernance = new GovernanceAccountFixture(address(this), VERIFIER_RECOVERY);
        listingGovernance = new GovernanceAccountFixture(address(this), LISTING_RECOVERY);
        verifierAuthority = new VerifierAuthority(address(verifierGovernance));
        listingAuthority = new ListingAuthority(address(listingGovernance));
        factory = new RegistryFactoryFixture();
        address[] memory factories = new address[](1);
        factories[0] = address(factory);
        directory = new CommunityDirectoryV1(factories, address(verifierAuthority), address(listingAuthority), 1 days);
        posts = new CommunityPostsV1(address(directory));
        registry = factory.deploy("sample", OWNER);
        vm.prank(OWNER);
        communityId = directory.registerCommunity(registry, configuration());
    }

    function configuration() internal pure returns (Directory.Configuration memory) {
        return Directory.Configuration(OWNER, PUBLISHER, address(0), address(0), DIGEST, URI);
    }

    function verifierAdmin(bytes memory data) internal returns (bytes memory) {
        return verifierGovernance.execute(address(verifierAuthority), data);
    }

    function listingAdmin(bytes memory data) internal returns (bytes memory) {
        return listingGovernance.execute(address(listingAuthority), data);
    }

    function bindBoth() internal {
        verifierAdmin(abi.encodeCall(VerifierAuthority.bindDirectory, (address(directory))));
        listingAdmin(abi.encodeCall(ListingAuthority.bindDirectory, (address(directory))));
    }

    function enable() internal {
        bindBoth();
        verifierAdmin(abi.encodeCall(VerifierAuthority.setOperator, (SERVICE)));
        listingAdmin(abi.encodeCall(ListingAuthority.setEmergencyKey, (EMERGENCY)));
    }

    function proof(uint64 lifetime) internal view returns (Directory.NamespaceVerification memory) {
        return Directory.NamespaceVerification(
            directory.getCommunity(communityId).configurationRevision,
            100,
            DIGEST,
            uint64(block.timestamp),
            uint64(block.timestamp) + lifetime,
            DIGEST
        );
    }

    function verify() internal {
        uint64 revision = directory.getCommunity(communityId).verificationRevision;
        Directory.NamespaceVerification memory verification = proof(1 hours);
        vm.prank(SERVICE);
        verifierAuthority.verifyNamespace(communityId, revision, verification);
    }

    function list(bool value, uint64 revision) internal {
        listingAdmin(abi.encodeCall(ListingAuthority.setListed, (communityId, revision, value, DIGEST)));
    }

    function delist() internal {
        vm.prank(EMERGENCY);
        listingAuthority.emergencyDelist(communityId, DIGEST);
    }

    function communityState() internal view returns (bytes32) {
        return keccak256(abi.encode(directory.getCommunity(communityId)));
    }
}
