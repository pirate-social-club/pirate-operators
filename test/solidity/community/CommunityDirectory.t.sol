// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import "./CommunityFixture.sol";

contract CommunityDirectoryTest is CommunityFixture {
    function testAdminRegistersUnverifiedAndCannotOverwrite() public {
        register();
        Directory.Community memory c = directory.getCommunity(communityId);
        require(communityId == keccak256(abi.encode(block.chainid, registry)));
        require(c.registry == registry && c.tldHash == sha256(bytes("sample")));
        require(c.configurationRevision == 1 && c.configuration.controller == OWNER);
        require(c.verificationRevision == 0 && c.listingRevision == 0 && !directory.isDiscoverable(communityId));
        vm.prank(OWNER);
        vm.expectRevert(Directory.AlreadyRegistered.selector);
        directory.registerCommunity(registry, config(OWNER, PUBLISHER));
    }

    function testWrongAdminAndControllerRefused() public {
        vm.prank(NEXT);
        vm.expectRevert(Directory.Unauthorized.selector);
        directory.registerCommunity(registry, config(NEXT, PUBLISHER));
        vm.prank(OWNER);
        vm.expectRevert(Directory.Unauthorized.selector);
        directory.registerCommunity(registry, config(NEXT, PUBLISHER));
        register();
    }

    function testForgedRegistryCannotClaimApprovedFactoryEvenIfMarked() public {
        address forged = address(new ForgedRegistryFixture(address(factory), OWNER));
        factory.mark(forged, true);
        vm.prank(OWNER);
        vm.expectRevert(Directory.InvalidRegistry.selector);
        directory.registerCommunity(forged, config(OWNER, PUBLISHER));
    }

    function testUnapprovedFactoryAndMissingFactoryMembershipRefused() public {
        RegistryFactoryFixture unapproved = new RegistryFactoryFixture();
        address unknown = unapproved.deploy("sample", OWNER);
        vm.prank(OWNER);
        vm.expectRevert(Directory.InvalidRegistry.selector);
        directory.registerCommunity(unknown, config(OWNER, PUBLISHER));
        factory.mark(registry, false);
        vm.prank(OWNER);
        vm.expectRevert(Directory.InvalidRegistry.selector);
        directory.registerCommunity(registry, config(OWNER, PUBLISHER));
    }

    function testChangedFactoryOrImplementationCodeRefused() public {
        address implementation = factory.implementation();
        bytes memory original = address(factory).code;
        vm.etch(address(factory), hex"60006000fd");
        vm.prank(OWNER);
        vm.expectRevert(Directory.InvalidRegistry.selector);
        directory.registerCommunity(registry, config(OWNER, PUBLISHER));
        vm.etch(address(factory), original);
        vm.etch(implementation, hex"60006000fd");
        vm.prank(OWNER);
        vm.expectRevert();
        directory.registerCommunity(registry, config(OWNER, PUBLISHER));
    }

    function testHostileGetterAndNonContractRefused() public {
        address hostile = address(new HostileRegistryFixture(address(directory)));
        vm.prank(OWNER);
        vm.expectRevert();
        directory.registerCommunity(hostile, config(OWNER, PUBLISHER));
        vm.prank(OWNER);
        vm.expectRevert(Directory.InvalidRegistry.selector);
        directory.registerCommunity(NEXT, config(OWNER, PUBLISHER));
        require(!directory.isDiscoverable(directory.communityIdFor(hostile)));
        register();
    }

    function testRegistryAdminChangeCannotSeizeDirectory() public {
        register();
        vm.prank(OWNER);
        RegistryIdentityFixture(registry).changeAdmin(NEXT);
        vm.prank(NEXT);
        vm.expectRevert(Directory.Unauthorized.selector);
        directory.configure(communityId, 1, config(NEXT, OTHER_PUBLISHER));
        vm.prank(OWNER);
        directory.configure(communityId, 1, config(OWNER, OTHER_PUBLISHER));
    }

    function testInvalidConfigurationCannotChangeState() public {
        register();
        bytes32 beforeState = stateHash();
        Directory.Configuration memory c = config(OWNER, address(0));
        vm.prank(OWNER);
        vm.expectRevert(Directory.InvalidConfiguration.selector);
        directory.configure(communityId, 1, c);
        c = config(OWNER, PUBLISHER);
        c.operatorPayments = NEXT;
        vm.prank(OWNER);
        vm.expectRevert(Directory.InvalidConfiguration.selector);
        directory.configure(communityId, 1, c);
        c = config(OWNER, PUBLISHER);
        c.learningRecords = NEXT;
        vm.prank(OWNER);
        vm.expectRevert(Directory.InvalidConfiguration.selector);
        directory.configure(communityId, 1, c);
        c = config(OWNER, PUBLISHER);
        c.sha256Digest = 0;
        vm.prank(OWNER);
        vm.expectRevert(Directory.InvalidConfiguration.selector);
        directory.configure(communityId, 1, c);
        c = config(OWNER, PUBLISHER);
        c.uri = "https://example.invalid/config";
        vm.prank(OWNER);
        vm.expectRevert(Directory.InvalidConfiguration.selector);
        directory.configure(communityId, 1, c);
        c = config(NEXT, PUBLISHER);
        vm.prank(OWNER);
        vm.expectRevert(Directory.InvalidConfiguration.selector);
        directory.configure(communityId, 1, c);
        require(stateHash() == beforeState);
    }

    function testTransferBindsEveryFieldAndAcceptsAtDeadlineOnce() public {
        register();
        Directory.Configuration memory c = config(NEXT, OTHER_PUBLISHER);
        uint64 deadline = uint64(block.timestamp + 60);
        vm.prank(OWNER);
        uint64 id = directory.proposeControllerTransfer(communityId, 1, c, deadline);
        Directory.ControllerTransfer memory p = directory.getControllerTransfer(communityId);
        require(p.proposalId == 1 && p.configurationHash == keccak256(abi.encode(c)));
        bytes32 beforeState = stateHash();
        vm.prank(OWNER);
        vm.expectRevert(Directory.InvalidControllerTransfer.selector);
        directory.acceptControllerTransfer(communityId, id, c);
        c.publisher = PUBLISHER;
        vm.prank(NEXT);
        vm.expectRevert(Directory.InvalidControllerTransfer.selector);
        directory.acceptControllerTransfer(communityId, id, c);
        require(stateHash() == beforeState);
        c.publisher = OTHER_PUBLISHER;
        vm.warp(deadline);
        vm.prank(NEXT);
        directory.acceptControllerTransfer(communityId, id, c);
        require(directory.getCommunity(communityId).configuration.controller == NEXT);
        require(directory.getCommunity(communityId).configurationRevision == 2);
        require(directory.getControllerTransfer(communityId).proposalId == 0);
        vm.prank(NEXT);
        vm.expectRevert(Directory.InvalidControllerTransfer.selector);
        directory.acceptControllerTransfer(communityId, id, c);
        vm.prank(OWNER);
        vm.expectRevert(Directory.Unauthorized.selector);
        directory.configure(communityId, 2, config(OWNER, PUBLISHER));
    }

    function testReplacementCancellationAndConfigureInvalidateProposals() public {
        register();
        Directory.Configuration memory c = config(NEXT, OTHER_PUBLISHER);
        uint64 deadline = uint64(block.timestamp + 60);
        vm.prank(OWNER);
        uint64 first = directory.proposeControllerTransfer(communityId, 1, c, deadline);
        vm.prank(OWNER);
        uint64 second = directory.proposeControllerTransfer(communityId, 1, c, deadline);
        require(second == first + 1);
        vm.prank(NEXT);
        vm.expectRevert(Directory.InvalidControllerTransfer.selector);
        directory.acceptControllerTransfer(communityId, first, c);
        vm.prank(NEXT);
        vm.expectRevert(Directory.Unauthorized.selector);
        directory.cancelControllerTransfer(communityId, second);
        vm.prank(OWNER);
        directory.cancelControllerTransfer(communityId, second);
        vm.prank(NEXT);
        vm.expectRevert(Directory.InvalidControllerTransfer.selector);
        directory.acceptControllerTransfer(communityId, second, c);
        vm.prank(OWNER);
        uint64 third = directory.proposeControllerTransfer(communityId, 1, c, deadline);
        require(third == second + 1);
        vm.prank(OWNER);
        directory.configure(communityId, 1, config(OWNER, PUBLISHER));
        vm.prank(NEXT);
        vm.expectRevert(Directory.InvalidControllerTransfer.selector);
        directory.acceptControllerTransfer(communityId, third, c);
    }

    function testFuzzExpiredHandoffRetainsOwner(uint32 delay) public {
        register();
        Directory.Configuration memory c = config(NEXT, OTHER_PUBLISHER);
        uint64 deadline = uint64(block.timestamp + 10);
        vm.prank(OWNER);
        uint64 id = directory.proposeControllerTransfer(communityId, 1, c, deadline);
        vm.warp(uint256(deadline) + 1 + delay);
        bytes32 beforeState = stateHash();
        vm.prank(NEXT);
        vm.expectRevert(Directory.InvalidControllerTransfer.selector);
        directory.acceptControllerTransfer(communityId, id, c);
        require(stateHash() == beforeState);
        vm.prank(OWNER);
        directory.configure(communityId, 1, config(OWNER, PUBLISHER));
    }

    function testGovernanceRolesCannotChangeConfigOrTransferControl() public {
        register();
        vm.prank(address(verifier));
        vm.expectRevert(Directory.Unauthorized.selector);
        directory.configure(communityId, 1, config(OWNER, OTHER_PUBLISHER));
        vm.prank(address(listing));
        vm.expectRevert(Directory.Unauthorized.selector);
        directory.proposeControllerTransfer(communityId, 1, config(NEXT, OTHER_PUBLISHER), uint64(block.timestamp + 60));
        vm.prank(OWNER);
        vm.expectRevert(Directory.Unauthorized.selector);
        directory.setListed(communityId, 0, true, DIGEST);
    }

    function testListingRequiresFreshVerificationAndDoesNotReturnAfterDelisting() public {
        register();
        vm.expectRevert(Directory.InvalidVerification.selector);
        list(true, 0);
        verify(1, 0);
        require(!directory.isDiscoverable(communityId));
        list(true, 0);
        require(directory.isDiscoverable(communityId));
        list(false, 1);
        verify(1, 1);
        require(!directory.isDiscoverable(communityId));
        list(true, 2);
        vm.warp(block.timestamp + 1 hours);
        require(!directory.isDiscoverable(communityId));
        vm.expectRevert(Directory.StaleRevision.selector);
        list(false, 2);
    }

    function testConfigurationStalesVerificationUntilRefreshed() public {
        register();
        verify(1, 0);
        list(true, 0);
        vm.prank(OWNER);
        directory.configure(communityId, 1, config(OWNER, OTHER_PUBLISHER));
        require(!directory.isDiscoverable(communityId));
        vm.expectRevert(Directory.InvalidVerification.selector);
        verify(1, 1);
        verify(2, 1);
        require(directory.isDiscoverable(communityId));
    }

    function testInvalidVerificationIsAtomic() public {
        register();
        verify(1, 0);
        bytes32 beforeState = stateHash();
        Directory.NamespaceVerification memory p = Directory.NamespaceVerification(
            1, 100, DIGEST, uint64(block.timestamp), uint64(block.timestamp + 1 days + 1), DIGEST
        );
        vm.prank(address(verifier));
        vm.expectRevert(Directory.InvalidVerification.selector);
        directory.verifyNamespace(communityId, 1, p);
        p.validUntil = uint64(block.timestamp);
        vm.prank(address(verifier));
        vm.expectRevert(Directory.InvalidVerification.selector);
        directory.verifyNamespace(communityId, 1, p);
        p.validUntil = uint64(block.timestamp + 60);
        p.observedAt = uint64(block.timestamp + 1);
        vm.prank(address(verifier));
        vm.expectRevert(Directory.InvalidVerification.selector);
        directory.verifyNamespace(communityId, 1, p);
        p.observedAt = uint64(block.timestamp - 1);
        vm.prank(address(verifier));
        vm.expectRevert(Directory.InvalidVerification.selector);
        directory.verifyNamespace(communityId, 1, p);
        p.observedAt = uint64(block.timestamp);
        p.hnsBlockHash = 0;
        vm.prank(address(verifier));
        vm.expectRevert(Directory.InvalidVerification.selector);
        directory.verifyNamespace(communityId, 1, p);
        p.hnsBlockHash = DIGEST;
        p.evidenceSha256 = 0;
        vm.prank(address(verifier));
        vm.expectRevert(Directory.InvalidVerification.selector);
        directory.verifyNamespace(communityId, 1, p);
        require(stateHash() == beforeState);
    }

    function testGovernanceRecoveryRotatesSignersWithoutIdentityChanges() public {
        register();
        verify(1, 0);
        list(true, 0);
        vm.prank(PUBLISHER);
        publish(communityId, POST, 0, 1, AUTHOR, Posts.Kind.Song);
        vm.prank(NEXT);
        verifier.rotate(NEXT);
        vm.prank(NEXT);
        listing.rotate(NEXT);
        vm.expectRevert();
        verify(1, 1);
        vm.expectRevert();
        list(false, 1);
        vm.prank(NEXT);
        listing.execute(address(directory), abi.encodeCall(Directory.setListed, (communityId, 1, false, DIGEST)));
        Directory.NamespaceVerification memory proof = Directory.NamespaceVerification(
            1, 101, DIGEST, uint64(block.timestamp), uint64(block.timestamp + 60), DIGEST
        );
        vm.prank(NEXT);
        verifier.execute(address(directory), abi.encodeCall(Directory.verifyNamespace, (communityId, 1, proof)));
        require(directory.namespaceVerifier() == address(verifier) && directory.listingAuthority() == address(listing));
        require(directory.communityIdFor(registry) == communityId && posts.getPost(communityId, POST).revision == 1);
    }

    function testFuzzStaleConfigurationCannotWrite(uint64 revision) public {
        vm.assume(revision != 1);
        register();
        bytes32 beforeState = stateHash();
        vm.prank(OWNER);
        vm.expectRevert(Directory.StaleRevision.selector);
        directory.configure(communityId, revision, config(OWNER, OTHER_PUBLISHER));
        require(stateHash() == beforeState);
    }

    function testDeploymentRejectsEOARolesDuplicateFactoriesAndZeroAge() public {
        address[] memory factories = new address[](1);
        factories[0] = address(factory);
        vm.expectRevert(CommunityDirectoryV1.InvalidDeploymentProfile.selector);
        new CommunityDirectoryV1(factories, OWNER, address(listing), 1 days);
        vm.expectRevert(CommunityDirectoryV1.InvalidDeploymentProfile.selector);
        new CommunityDirectoryV1(factories, address(verifier), address(verifier), 1 days);
        vm.expectRevert(CommunityDirectoryV1.InvalidDeploymentProfile.selector);
        new CommunityDirectoryV1(factories, address(verifier), address(listing), 0);
        factories = new address[](2);
        factories[0] = address(factory);
        factories[1] = address(factory);
        vm.expectRevert(CommunityDirectoryV1.InvalidDeploymentProfile.selector);
        new CommunityDirectoryV1(factories, address(verifier), address(listing), 1 days);
    }
}
