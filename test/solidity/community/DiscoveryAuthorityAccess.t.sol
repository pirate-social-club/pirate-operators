// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import "./DiscoveryAuthorityFixture.sol";

contract DiscoveryAuthorityAccessTest is DiscoveryAuthorityFixture {
    function testGovernanceMustHaveCode() public {
        vm.expectRevert(VerifierAuthority.InvalidGovernance.selector);
        new VerifierAuthority(address(0));
        vm.expectRevert(VerifierAuthority.InvalidGovernance.selector);
        new VerifierAuthority(OWNER);
        vm.expectRevert(ListingAuthority.InvalidGovernance.selector);
        new ListingAuthority(address(0));
        vm.expectRevert(ListingAuthority.InvalidGovernance.selector);
        new ListingAuthority(OWNER);
    }

    function testInitialStateIsUnboundAndDisabled() public view {
        require(verifierAuthority.governance() == address(verifierGovernance));
        require(listingAuthority.governance() == address(listingGovernance));
        require(address(verifierAuthority.directory()) == address(0) && verifierAuthority.operator() == address(0));
        require(address(listingAuthority.directory()) == address(0) && listingAuthority.emergencyKey() == address(0));
    }

    function testBindingOnlyByEachGovernanceAndOnlyOnce() public {
        vm.expectRevert(VerifierAuthority.Unauthorized.selector);
        verifierAuthority.bindDirectory(address(directory));
        vm.expectRevert(ListingAuthority.Unauthorized.selector);
        listingAuthority.bindDirectory(address(directory));
        bindBoth();
        vm.expectRevert(VerifierAuthority.AlreadyBound.selector);
        verifierAdmin(abi.encodeCall(VerifierAuthority.bindDirectory, (address(directory))));
        vm.expectRevert(ListingAuthority.AlreadyBound.selector);
        listingAdmin(abi.encodeCall(ListingAuthority.bindDirectory, (address(directory))));
        require(address(verifierAuthority.directory()) == address(directory));
        require(address(listingAuthority.directory()) == address(directory));
    }

    function testEitherAuthorityCanBindFirst() public {
        listingAdmin(abi.encodeCall(ListingAuthority.bindDirectory, (address(directory))));
        verifierAdmin(abi.encodeCall(VerifierAuthority.bindDirectory, (address(directory))));
        require(address(verifierAuthority.directory()) == address(directory));
        require(address(listingAuthority.directory()) == address(directory));
    }

    function testBindingEmitsEachDirectoryIdentity() public {
        vm.recordLogs();
        bindBoth();
        CommunityVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 2);
        for (uint256 i; i < logs.length; ++i) {
            require(logs[i].topics[0] == keccak256("DirectoryBound(address)"));
            require(address(uint160(uint256(logs[i].topics[1]))) == address(directory));
            require(logs[i].emitter == (i == 0 ? address(verifierAuthority) : address(listingAuthority)));
        }
    }

    function testVerifierRejectsInvalidTargetsAndRoleAliases() public {
        address[4] memory targets = [address(0), OWNER, address(verifierAuthority), address(verifierGovernance)];
        for (uint256 i; i < targets.length; ++i) {
            vm.expectRevert(VerifierAuthority.InvalidDirectory.selector);
            verifierAdmin(abi.encodeCall(VerifierAuthority.bindDirectory, (targets[i])));
        }
        address[4] memory peers = [address(0), OWNER, address(verifierAuthority), address(verifierGovernance)];
        for (uint256 i; i < peers.length; ++i) {
            address target = address(new DirectoryRoleFixture(address(verifierAuthority), peers[i]));
            vm.expectRevert(VerifierAuthority.InvalidDirectory.selector);
            verifierAdmin(abi.encodeCall(VerifierAuthority.bindDirectory, (target)));
        }
        address wrongRole = address(new DirectoryRoleFixture(address(listingAuthority), address(listingAuthority)));
        vm.expectRevert(VerifierAuthority.InvalidDirectory.selector);
        verifierAdmin(abi.encodeCall(VerifierAuthority.bindDirectory, (wrongRole)));
        require(address(verifierAuthority.directory()) == address(0));
    }

    function testListingRejectsInvalidTargetsAndRoleAliases() public {
        address[4] memory targets = [address(0), OWNER, address(listingAuthority), address(listingGovernance)];
        for (uint256 i; i < targets.length; ++i) {
            vm.expectRevert(ListingAuthority.InvalidDirectory.selector);
            listingAdmin(abi.encodeCall(ListingAuthority.bindDirectory, (targets[i])));
        }
        address[4] memory peers = [address(0), OWNER, address(listingAuthority), address(listingGovernance)];
        for (uint256 i; i < peers.length; ++i) {
            address target = address(new DirectoryRoleFixture(peers[i], address(listingAuthority)));
            vm.expectRevert(ListingAuthority.InvalidDirectory.selector);
            listingAdmin(abi.encodeCall(ListingAuthority.bindDirectory, (target)));
        }
        address wrongRole = address(new DirectoryRoleFixture(address(verifierAuthority), address(verifierAuthority)));
        vm.expectRevert(ListingAuthority.InvalidDirectory.selector);
        listingAdmin(abi.encodeCall(ListingAuthority.bindDirectory, (wrongRole)));
        require(address(listingAuthority.directory()) == address(0));
    }

    function testMatchingCounterfeitGettersStillNeedDeploymentReview() public {
        address counterfeit = address(new DirectoryRoleFixture(address(verifierAuthority), address(listingAuthority)));
        verifierAdmin(abi.encodeCall(VerifierAuthority.bindDirectory, (counterfeit)));
        listingAdmin(abi.encodeCall(ListingAuthority.bindDirectory, (counterfeit)));
        require(address(verifierAuthority.directory()) == counterfeit);
        require(address(listingAuthority.directory()) == counterfeit);
        require(verifierAuthority.operator() == address(0) && listingAuthority.emergencyKey() == address(0));
    }

    function testMissingGettersFailWithoutBinding() public {
        vm.expectRevert();
        verifierAdmin(abi.encodeCall(VerifierAuthority.bindDirectory, (address(factory))));
        vm.expectRevert();
        listingAdmin(abi.encodeCall(ListingAuthority.bindDirectory, (address(factory))));
        require(address(verifierAuthority.directory()) == address(0));
        require(address(listingAuthority.directory()) == address(0));
    }

    function testUnboundOperationsCannotEnableOrForward() public {
        vm.expectRevert(VerifierAuthority.Unbound.selector);
        verifierAdmin(abi.encodeCall(VerifierAuthority.setOperator, (SERVICE)));
        vm.expectRevert(ListingAuthority.Unbound.selector);
        listingAdmin(abi.encodeCall(ListingAuthority.setEmergencyKey, (EMERGENCY)));
        vm.expectRevert(ListingAuthority.Unbound.selector);
        list(false, 0);
        Directory.NamespaceVerification memory verification = proof(60);
        vm.prank(SERVICE);
        vm.expectRevert(VerifierAuthority.Unauthorized.selector);
        verifierAuthority.verifyNamespace(communityId, 0, verification);
        vm.prank(EMERGENCY);
        vm.expectRevert(ListingAuthority.Unauthorized.selector);
        listingAuthority.emergencyDelist(communityId, DIGEST);
        verifierAdmin(abi.encodeCall(VerifierAuthority.setOperator, (address(0))));
        listingAdmin(abi.encodeCall(ListingAuthority.setEmergencyKey, (address(0))));
    }

    function testKeysCannotRotateOrBindThemselves() public {
        enable();
        vm.prank(SERVICE);
        vm.expectRevert(VerifierAuthority.Unauthorized.selector);
        verifierAuthority.setOperator(NEXT_SERVICE);
        vm.prank(SERVICE);
        vm.expectRevert(VerifierAuthority.Unauthorized.selector);
        verifierAuthority.bindDirectory(address(directory));
        vm.prank(EMERGENCY);
        vm.expectRevert(ListingAuthority.Unauthorized.selector);
        listingAuthority.setEmergencyKey(NEXT_EMERGENCY);
        vm.prank(EMERGENCY);
        vm.expectRevert(ListingAuthority.Unauthorized.selector);
        listingAuthority.bindDirectory(address(directory));
    }

    function testInvalidKeyAliasesAreRejected() public {
        bindBoth();
        address[3] memory services = [address(verifierGovernance), address(verifierAuthority), address(directory)];
        for (uint256 i; i < services.length; ++i) {
            vm.expectRevert(VerifierAuthority.InvalidOperator.selector);
            verifierAdmin(abi.encodeCall(VerifierAuthority.setOperator, (services[i])));
        }
        address[4] memory emergencies =
            [address(listingGovernance), address(listingAuthority), address(directory), address(verifierAuthority)];
        for (uint256 i; i < emergencies.length; ++i) {
            vm.expectRevert(ListingAuthority.InvalidEmergencyKey.selector);
            listingAdmin(abi.encodeCall(ListingAuthority.setEmergencyKey, (emergencies[i])));
        }
    }

    function testRotationEventsIdentifyOldAndNewKeys() public {
        enable();
        vm.recordLogs();
        verifierAdmin(abi.encodeCall(VerifierAuthority.setOperator, (NEXT_SERVICE)));
        listingAdmin(abi.encodeCall(ListingAuthority.setEmergencyKey, (NEXT_EMERGENCY)));
        CommunityVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 2);
        require(logs[0].topics[0] == keccak256("OperatorChanged(address,address)"));
        require(address(uint160(uint256(logs[0].topics[1]))) == SERVICE);
        require(address(uint160(uint256(logs[0].topics[2]))) == NEXT_SERVICE);
        require(logs[1].topics[0] == keccak256("EmergencyKeyChanged(address,address)"));
        require(address(uint160(uint256(logs[1].topics[1]))) == EMERGENCY);
        require(address(uint160(uint256(logs[1].topics[2]))) == NEXT_EMERGENCY);
    }

    function testServiceAndEmergencyHaveNoGeneralExecutionOrFundingPath() public {
        enable();
        bytes32 beforeState = communityState();
        Directory.NamespaceVerification memory verification = proof(60);
        vm.prank(SERVICE);
        (bool execute,) = address(verifierAuthority)
            .call(
                abi.encodeWithSignature(
                    "execute(address,bytes)",
                    address(directory),
                    abi.encodeCall(Directory.setListed, (communityId, 0, false, DIGEST))
                )
            );
        vm.prank(EMERGENCY);
        (bool publish,) = address(listingAuthority)
            .call(
                abi.encodeCall(Posts.publishRevision, (communityId, DIGEST, 0, 1, DIGEST, Posts.Kind.Song, DIGEST, URI))
            );
        vm.prank(EMERGENCY);
        (bool attest,) =
            address(listingAuthority).call(abi.encodeCall(Directory.verifyNamespace, (communityId, 0, verification)));
        vm.deal(SERVICE, 1 ether);
        vm.prank(SERVICE);
        (bool fundVerifier,) = address(verifierAuthority).call{value: 1}("");
        vm.prank(SERVICE);
        (bool fundListing,) = address(listingAuthority).call{value: 1}("");
        require(!execute && !publish && !attest && !fundVerifier && !fundListing);
        require(communityState() == beforeState);
    }

    function testFuzzUntrustedCallerCannotAdminister(address caller) public {
        vm.assume(caller != address(verifierGovernance) && caller != address(listingGovernance));
        vm.prank(caller);
        vm.expectRevert(VerifierAuthority.Unauthorized.selector);
        verifierAuthority.setOperator(SERVICE);
        vm.prank(caller);
        vm.expectRevert(ListingAuthority.Unauthorized.selector);
        listingAuthority.setEmergencyKey(EMERGENCY);
        vm.prank(caller);
        vm.expectRevert(ListingAuthority.Unauthorized.selector);
        listingAuthority.setListed(communityId, 0, true, DIGEST);
    }
}
