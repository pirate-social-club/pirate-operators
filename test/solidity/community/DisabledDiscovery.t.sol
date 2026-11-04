// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import "./CommunityFixture.sol";
import {DisabledDiscoveryAuthority} from "../../../contracts/testnet/DisabledDiscoveryAuthority.sol";

contract DisabledDiscoveryTest is CommunityFixture {
    address private disabledVerifier;
    address private disabledListing;

    function setUp() public override {
        super.setUp();
        disabledVerifier = address(new DisabledDiscoveryAuthority());
        disabledListing = address(new DisabledDiscoveryAuthority());
        address[] memory factories = new address[](1);
        factories[0] = address(factory);
        directory = new CommunityDirectoryV1(factories, disabledVerifier, disabledListing, 1 days);
        posts = new CommunityPostsV1(address(directory));
        register();
    }

    function testUnlistedPublicationAndPublisherRotation() public {
        require(disabledVerifier != disabledListing);
        require(directory.namespaceVerifier() == disabledVerifier);
        require(directory.listingAuthority() == disabledListing);
        vm.prank(PUBLISHER);
        publish(communityId, POST, 0, 1, AUTHOR, Posts.Kind.Song);
        vm.prank(OWNER);
        directory.configure(communityId, 1, config(OWNER, OTHER_PUBLISHER));
        vm.prank(OTHER_PUBLISHER);
        publish(communityId, POST, 1, 2, AUTHOR, Posts.Kind.Song);
        vm.warp(block.timestamp + 365 days);
        require(posts.getPost(communityId, POST).revision == 2);
        require(!directory.isDiscoverable(communityId));
    }

    function testControllerHandoffCannotEnableDiscovery() public {
        Directory.Configuration memory c = config(NEXT, OTHER_PUBLISHER);
        vm.prank(OWNER);
        uint64 proposal = directory.proposeControllerTransfer(communityId, 1, c, uint64(block.timestamp + 30));
        vm.prank(NEXT);
        directory.acceptControllerTransfer(communityId, proposal, c);
        vm.prank(NEXT);
        vm.expectRevert(Directory.Unauthorized.selector);
        directory.setListed(communityId, 0, true, DIGEST);
        vm.prank(OTHER_PUBLISHER);
        publish(communityId, POST, 0, 2, AUTHOR, Posts.Kind.Song);
        require(!directory.isDiscoverable(communityId));
    }

    function testFuzzNoCallerCanAcquireEitherAuthority(address caller) public {
        vm.assume(caller != disabledVerifier && caller != disabledListing);
        Directory.NamespaceVerification memory proof = Directory.NamespaceVerification(
            1, 100, DIGEST, uint64(block.timestamp), uint64(block.timestamp + 1 hours), DIGEST
        );
        vm.prank(caller);
        vm.expectRevert(Directory.Unauthorized.selector);
        directory.verifyNamespace(communityId, 0, proof);
        vm.prank(caller);
        vm.expectRevert(Directory.Unauthorized.selector);
        directory.setListed(communityId, 0, true, DIGEST);
        require(!directory.isDiscoverable(communityId));
    }

    function testFuzzAuthoritiesRejectEveryCall(bytes memory payload) public {
        // Includes empty calldata and arbitrary would-be execute/bind/initialize calls.
        (bool verified,) = disabledVerifier.call(payload);
        (bool listed,) = disabledListing.call(payload);
        require(!verified && !listed);
        require(!directory.isDiscoverable(communityId));
    }
}
