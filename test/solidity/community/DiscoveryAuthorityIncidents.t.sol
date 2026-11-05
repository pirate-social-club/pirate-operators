// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import "./DiscoveryAuthorityFixture.sol";

contract DiscoveryAuthorityIncidentsTest is DiscoveryAuthorityFixture {
    function testAttestationForwardsExactFieldsAndDirectoryEvent() public {
        enable();
        Directory.NamespaceVerification memory verification = proof(1 days);
        vm.recordLogs();
        vm.prank(SERVICE);
        verifierAuthority.verifyNamespace(communityId, 0, verification);
        Directory.Community memory c = directory.getCommunity(communityId);
        require(
            c.verificationRevision == 1 && keccak256(abi.encode(c.verification)) == keccak256(abi.encode(verification))
        );
        CommunityVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].emitter == address(directory));
        require(
            logs[0].topics[0]
                == keccak256("NamespaceVerified(bytes32,uint64,(uint64,uint64,bytes32,uint64,uint64,bytes32))")
        );
        require(logs[0].topics[1] == communityId);
        (uint64 revision, Directory.NamespaceVerification memory emitted) =
            abi.decode(logs[0].data, (uint64, Directory.NamespaceVerification));
        require(revision == 1 && keccak256(abi.encode(emitted)) == keccak256(abi.encode(verification)));
    }

    function testOnlyCurrentServiceMayAttestEvenGovernanceCannotBypass() public {
        enable();
        Directory.NamespaceVerification memory verification = proof(60);
        vm.expectRevert(VerifierAuthority.Unauthorized.selector);
        verifierAdmin(abi.encodeCall(VerifierAuthority.verifyNamespace, (communityId, 0, verification)));
        vm.prank(EMERGENCY);
        vm.expectRevert(VerifierAuthority.Unauthorized.selector);
        verifierAuthority.verifyNamespace(communityId, 0, verification);
        verifierAdmin(abi.encodeCall(VerifierAuthority.setOperator, (NEXT_SERVICE)));
        vm.prank(SERVICE);
        vm.expectRevert(VerifierAuthority.Unauthorized.selector);
        verifierAuthority.verifyNamespace(communityId, 0, verification);
        vm.prank(NEXT_SERVICE);
        verifierAuthority.verifyNamespace(communityId, 0, verification);
        verifierAdmin(abi.encodeCall(VerifierAuthority.setOperator, (address(0))));
        vm.prank(NEXT_SERVICE);
        vm.expectRevert(VerifierAuthority.Unauthorized.selector);
        verifierAuthority.verifyNamespace(communityId, 1, verification);
    }

    function testDirectoryRejectsStaleOrChangedInputsWithoutConsumingRevision() public {
        enable();
        verify();
        Directory.NamespaceVerification memory verification = proof(60);
        bytes32 beforeState = communityState();
        vm.prank(SERVICE);
        vm.expectRevert(Directory.StaleRevision.selector);
        verifierAuthority.verifyNamespace(communityId, 0, verification);
        verification.configurationRevision = 2;
        vm.prank(SERVICE);
        vm.expectRevert(Directory.InvalidVerification.selector);
        verifierAuthority.verifyNamespace(communityId, 1, verification);
        verification = proof(1 days + 1);
        vm.prank(SERVICE);
        vm.expectRevert(Directory.InvalidVerification.selector);
        verifierAuthority.verifyNamespace(communityId, 1, verification);
        verification = proof(60);
        verification.evidenceSha256 = 0;
        vm.prank(SERVICE);
        vm.expectRevert(Directory.InvalidVerification.selector);
        verifierAuthority.verifyNamespace(communityId, 1, verification);
        require(communityState() == beforeState);
    }

    function testEmergencyCannotListAndCanDelistWithoutFreshVerification() public {
        enable();
        verify();
        list(true, 0);
        vm.prank(EMERGENCY);
        vm.expectRevert(ListingAuthority.Unauthorized.selector);
        listingAuthority.setListed(communityId, 1, true, DIGEST);
        vm.warp(block.timestamp + 1 hours);
        require(!directory.isDiscoverable(communityId));
        delist();
        Directory.Community memory c = directory.getCommunity(communityId);
        require(!c.listed && c.listingRevision == 2);
        verify();
        require(!directory.isDiscoverable(communityId));
        list(true, 2);
        require(directory.isDiscoverable(communityId));
    }

    function testEmergencyReasonAndUnknownCommunityRevertAtomically() public {
        enable();
        bytes32 beforeState = communityState();
        vm.prank(EMERGENCY);
        vm.expectRevert(ListingAuthority.InvalidReason.selector);
        listingAuthority.emergencyDelist(communityId, 0);
        vm.prank(EMERGENCY);
        vm.expectRevert(Directory.UnknownCommunity.selector);
        listingAuthority.emergencyDelist(bytes32(uint256(123)), DIGEST);
        Directory.NamespaceVerification memory verification = proof(60);
        vm.prank(SERVICE);
        vm.expectRevert(Directory.UnknownCommunity.selector);
        verifierAuthority.verifyNamespace(bytes32(uint256(123)), 0, verification);
        require(communityState() == beforeState);
    }

    function testDelistingConsumesCurrentRevisionAndInvalidatesQueuedRestoration() public {
        enable();
        verify();
        list(true, 0);
        delist();
        uint64 queuedRevision = directory.getCommunity(communityId).listingRevision;
        delist(); // Already unlisted, but the old restoration must still become stale.
        vm.expectRevert(Directory.StaleRevision.selector);
        list(true, queuedRevision);
        require(!directory.isDiscoverable(communityId));
        list(true, queuedRevision + 1);
        require(directory.isDiscoverable(communityId));
        delist(); // Restoration first, emergency second: emergency wins.
        require(!directory.isDiscoverable(communityId));
        require(directory.getCommunity(communityId).listingRevision == queuedRevision + 3);
    }

    function testVerifierRenewalsCannotRestoreEmergencyDelisting() public {
        enable();
        verify();
        list(true, 0);
        delist();
        vm.warp(block.timestamp + 10);
        verify();
        require(!directory.isDiscoverable(communityId));
        require(directory.getCommunity(communityId).verificationRevision == 2);
        require(directory.getCommunity(communityId).listingRevision == 2);
    }

    function testEmergencyRotationAndDisablePreserveGovernanceDelisting() public {
        enable();
        verify();
        list(true, 0);
        listingAdmin(abi.encodeCall(ListingAuthority.setEmergencyKey, (NEXT_EMERGENCY)));
        vm.prank(EMERGENCY);
        vm.expectRevert(ListingAuthority.Unauthorized.selector);
        listingAuthority.emergencyDelist(communityId, DIGEST);
        vm.prank(NEXT_EMERGENCY);
        listingAuthority.emergencyDelist(communityId, DIGEST);
        listingAdmin(abi.encodeCall(ListingAuthority.setEmergencyKey, (address(0))));
        vm.prank(NEXT_EMERGENCY);
        vm.expectRevert(ListingAuthority.Unauthorized.selector);
        listingAuthority.emergencyDelist(communityId, DIGEST);
        list(true, 2);
        list(false, 3); // Governance still works when the emergency key is unavailable.
        require(!directory.isDiscoverable(communityId));
    }

    function testStaleConfigurationBlocksListingButNotEmergencyDelisting() public {
        enable();
        verify();
        list(true, 0);
        vm.prank(OWNER);
        directory.configure(communityId, 1, configuration());
        vm.expectRevert(Directory.InvalidVerification.selector);
        list(true, 1);
        delist();
        verify();
        require(!directory.isDiscoverable(communityId));
        list(true, 2);
        require(directory.isDiscoverable(communityId));
    }

    function testFullAgeForgeryExpiresAfterRevocationAtExactBoundary() public {
        enable();
        Directory.NamespaceVerification memory forgery = proof(1 days);
        vm.prank(SERVICE);
        verifierAuthority.verifyNamespace(communityId, 0, forgery);
        list(true, 0);
        vm.warp(block.timestamp + 1 days - 1);
        require(directory.isDiscoverable(communityId));
        forgery = proof(1 days); // A still-authorized stolen key can extend false evidence.
        vm.prank(SERVICE);
        verifierAuthority.verifyNamespace(communityId, 1, forgery);
        verifierAdmin(abi.encodeCall(VerifierAuthority.setOperator, (address(0))));
        vm.warp(forgery.validUntil - 1);
        require(directory.isDiscoverable(communityId));
        vm.warp(forgery.validUntil);
        require(!directory.isDiscoverable(communityId));
    }

    function testSimulatedGovernanceRecoveryPreservesDeploymentAndCommunityControl() public {
        enable();
        verify();
        list(true, 0);
        bytes32 configHash = keccak256(abi.encode(directory.getCommunity(communityId).configuration));
        vm.prank(VERIFIER_RECOVERY);
        verifierGovernance.rotate(VERIFIER_RECOVERY);
        vm.expectRevert();
        verifierAdmin(abi.encodeCall(VerifierAuthority.setOperator, (NEXT_SERVICE)));
        vm.prank(VERIFIER_RECOVERY);
        verifierGovernance.execute(
            address(verifierAuthority), abi.encodeCall(VerifierAuthority.setOperator, (NEXT_SERVICE))
        );
        vm.prank(LISTING_RECOVERY);
        listingGovernance.rotate(LISTING_RECOVERY);
        vm.prank(LISTING_RECOVERY);
        listingGovernance.execute(
            address(listingAuthority), abi.encodeCall(ListingAuthority.setEmergencyKey, (NEXT_EMERGENCY))
        );
        Directory.NamespaceVerification memory verification = proof(60);
        vm.prank(SERVICE);
        vm.expectRevert(VerifierAuthority.Unauthorized.selector);
        verifierAuthority.verifyNamespace(communityId, 1, verification);
        vm.prank(NEXT_SERVICE);
        verifierAuthority.verifyNamespace(communityId, 1, verification);
        require(address(verifierAuthority.directory()) == address(directory));
        require(address(listingAuthority.directory()) == address(directory));
        require(address(posts.directory()) == address(directory));
        require(keccak256(abi.encode(directory.getCommunity(communityId).configuration)) == configHash);
    }

    function testSimulatedReorgRestoresKeyAndListingStateAndRequiresReconciliation() public {
        enable();
        verify();
        list(true, 0);
        uint256 beforeIncident = vm.snapshotState();
        delist();
        verifierAdmin(abi.encodeCall(VerifierAuthority.setOperator, (address(0))));
        require(!directory.isDiscoverable(communityId));
        require(vm.revertToState(beforeIncident));
        require(directory.isDiscoverable(communityId) && verifierAuthority.operator() == SERVICE);
        delist();
        verifierAdmin(abi.encodeCall(VerifierAuthority.setOperator, (address(0))));
        require(!directory.isDiscoverable(communityId));
        require(directory.getCommunity(communityId).listingRevision == 2);
    }

    function testDiscoveryIncidentCannotBlockDirectPublicationOrChangeItsAuthority() public {
        enable();
        verify();
        list(true, 0);
        bytes32 configHash = keccak256(abi.encode(directory.getCommunity(communityId).configuration));
        delist();
        verifierAdmin(abi.encodeCall(VerifierAuthority.setOperator, (address(0))));
        vm.prank(PUBLISHER);
        posts.publishRevision(communityId, DIGEST, 0, 1, DIGEST, Posts.Kind.Song, DIGEST, URI);
        require(posts.getPost(communityId, DIGEST).revision == 1);
        require(keccak256(abi.encode(directory.getCommunity(communityId).configuration)) == configHash);
        vm.prank(EMERGENCY);
        vm.expectRevert(Directory.Unauthorized.selector);
        directory.configure(communityId, 1, configuration());
        vm.prank(SERVICE);
        vm.expectRevert(Posts.UnauthorizedPublisher.selector);
        posts.publishRevision(communityId, DIGEST, 1, 1, DIGEST, Posts.Kind.Song, DIGEST, URI);
    }

    function testFuzzValidLifetimeExpiresWithoutRefresh(uint32 seconds_) public {
        enable();
        uint64 lifetime = uint64(uint256(seconds_) % 1 days + 1);
        Directory.NamespaceVerification memory verification = proof(lifetime);
        vm.prank(SERVICE);
        verifierAuthority.verifyNamespace(communityId, 0, verification);
        list(true, 0);
        vm.warp(verification.validUntil - 1);
        require(directory.isDiscoverable(communityId));
        vm.warp(verification.validUntil);
        require(!directory.isDiscoverable(communityId));
    }
}
