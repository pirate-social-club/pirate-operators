// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import {CommunityDirectoryV3} from "../../../contracts/community/CommunityDirectoryV3.sol";
import {ICommunityDirectoryV3 as D} from "../../../contracts/interfaces/community/ICommunityDirectoryV3.sol";
import {ICommunityDirectoryV1 as V1} from "../../../contracts/interfaces/community/ICommunityDirectoryV1.sol";
import {CommunityPostsV1} from "../../../contracts/community/CommunityPostsV1.sol";
import {ICommunityPostsV1 as P} from "../../../contracts/interfaces/community/ICommunityPostsV1.sol";
import {SharedDirectoryVm as Vm, SharedRegistryCodeFixture} from "./CommunityDirectoryV2.t.sol";

/// @dev The attester and registry below are stand-ins, not an HNS proof producer.
contract CommunityDirectoryV3Test {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    CommunityDirectoryV3 d;
    address constant REGISTRAR = address(0x100);
    address constant CONTROLLER = address(0x101);
    address constant PUBLISHER = address(0x102);
    address constant OTHER = address(0x103);
    address constant WEB2 = address(0x104);
    address constant HNS = address(0x105);
    address constant LISTING = address(0x106);
    bytes32 constant KEY = keccak256("portable-key");
    bytes32 constant INSTALL = keccak256("installation");
    bytes32 constant ORIGIN = bytes32(0xd5ca8d7b1a8a2610f5310eebf9c920f2a92cf20c9b884dd7d725040a3648b4e0);
    string constant URI = "ipfs://bafkreigh2akiscaildc6c3bwi6f6t3kp34lwd77d5ppf2v3atx7q7hkwgy";

    function setUp() public {
        vm.chainId(31337);
        vm.warp(10000);
        d = new CommunityDirectoryV3(address(this));
        d.setVerificationRoles(WEB2, HNS, LISTING);
        d.configureRegistrar(REGISTRAR, 20000, 2, 0);
    }

    function config(address c, address p) internal pure returns (V1.Configuration memory) {
        return V1.Configuration(c, p, address(0), address(0), keccak256("config"), URI);
    }

    function enroll(bytes32 key) internal returns (bytes32) {
        vm.prank(REGISTRAR);
        return d.registerHostedCommunity(D.HostingBinding(key, INSTALL), config(CONTROLLER, PUBLISHER), ORIGIN, 1);
    }

    function webProof(bytes32 id) internal view returns (D.Web2Verification memory) {
        D.OriginState memory o = d.getOrigin(id);
        return D.Web2Verification(
            o.revision,
            o.controllerRevision,
            uint64(block.timestamp),
            uint64(block.timestamp + 30 days),
            keccak256("real-proof-required")
        );
    }

    function verify(bytes32 id) internal {
        (uint64 rev,) = d.getWeb2Verification(id);
        D.Web2Verification memory proof = webProof(id);
        vm.prank(WEB2);
        d.verifyWeb2(id, rev, proof);
    }

    function listing(bytes32 id, bool value) internal {
        uint64 rev = d.getCommunity(id).listingRevision;
        vm.prank(LISTING);
        d.setListed(id, rev, value, keccak256("reason"));
    }

    function attach(bytes32 id) internal returns (D.HnsAttachment memory proof) {
        address registry = address(new SharedRegistryCodeFixture());
        d.admitRegistry(registry, D.RegistrySource(registry.codehash, bytes20(uint160(1)), keccak256("stand-in-abi")));
        proof = D.HnsAttachment(
            registry,
            d.namespaceIdFor("fixture"),
            keccak256("authorization"),
            1,
            d.getOrigin(id).controllerRevision,
            100,
            keccak256("hns-block"),
            uint64(block.timestamp),
            uint64(block.timestamp + 1 days),
            keccak256("stand-in-evidence")
        );
        (uint64 rev,) = d.getHnsAttachment(id);
        vm.prank(HNS);
        d.attachHns(id, "fixture", rev, proof);
    }

    function transfer(bytes32 id, address from, address to) internal {
        uint64 rev = d.getCommunity(id).configurationRevision;
        V1.Configuration memory next = config(to, PUBLISHER);
        vm.prank(from);
        uint64 proposal = d.proposeControllerTransfer(id, rev, next, uint64(block.timestamp + 100));
        vm.prank(to);
        d.acceptControllerTransfer(id, proposal, next);
    }

    function testCreateWithoutHnsAndPreserveIdentityFormula() public {
        bytes32 id = enroll(KEY);
        require(id == keccak256(abi.encode(keccak256("pirate.community/2"), uint256(31337), KEY)));
        V1.Community memory c = d.getCommunity(id);
        require(c.registry == address(0) && c.tldHash == bytes32(0) && c.configurationRevision == 1);
        require(c.configuration.learningRecords == address(0) && !c.listed && !d.isDiscoverable(id));
        require(
            d.getBinding(id).installationId == INSTALL && d.getOrigin(id).revision == 1
                && d.getOrigin(id).controllerRevision == 1
        );
    }

    function testRegistrationEmitsExactBindingOriginAndConsumedCount() public {
        vm.recordLogs();
        bytes32 id = enroll(KEY);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 5);
        require(logs[1].topics[0] == keccak256("CommunityBound(bytes32,(bytes32,bytes32))") && logs[1].topics[1] == id);
        D.HostingBinding memory b = abi.decode(logs[1].data, (D.HostingBinding));
        require(b.communityKey == KEY && b.installationId == INSTALL);
        (uint64 revision, D.OriginState memory o) = abi.decode(logs[2].data, (uint64, D.OriginState));
        require(revision == 1 && o.sha256Digest == ORIGIN && o.controllerRevision == 1);
        require(logs[4].topics[0] == keccak256("RegistrarConsumed(bytes32,uint64,uint64)"));
        (uint64 roleRevision, uint64 consumed) = abi.decode(logs[4].data, (uint64, uint64));
        require(roleRevision == 1 && consumed == 1);
    }

    function testUnknownAndDuplicateKeyCannotBeConfusedWithPendingHns() public {
        vm.expectRevert(V1.UnknownCommunity.selector);
        d.getCommunity(KEY);
        enroll(KEY);
        vm.expectRevert(V1.AlreadyRegistered.selector);
        enroll(KEY);
        require(d.registrarPermission().totalRegistered == 1);
    }

    function testRegistrarIsRequiredAndCapNeverRefillsOnRotation() public {
        vm.expectRevert(D.RegistrarUnavailable.selector);
        d.registerHostedCommunity(D.HostingBinding(KEY, INSTALL), config(CONTROLLER, PUBLISHER), ORIGIN, 1);
        enroll(KEY);
        enroll(keccak256("second"));
        vm.expectRevert(D.RegistrarUnavailable.selector);
        enroll(keccak256("third"));
        d.configureRegistrar(OTHER, 30000, 2, 1);
        require(d.registrarPermission().totalRegistered == 2);
        vm.prank(OTHER);
        vm.expectRevert(D.RegistrarUnavailable.selector);
        d.registerHostedCommunity(
            D.HostingBinding(keccak256("third"), INSTALL), config(CONTROLLER, PUBLISHER), ORIGIN, 2
        );
    }

    function testRegistrarExactExpiryAndRevisionAndDisable() public {
        vm.prank(REGISTRAR);
        vm.expectRevert(V1.StaleRevision.selector);
        d.registerHostedCommunity(D.HostingBinding(KEY, INSTALL), config(CONTROLLER, PUBLISHER), ORIGIN, 0);
        vm.warp(20000);
        vm.expectRevert(D.RegistrarUnavailable.selector);
        enroll(KEY);
        d.configureRegistrar(address(0), 0, 2, 1);
        require(d.registrarPermission().account == address(0));
        vm.expectRevert(D.RegistrarUnavailable.selector);
        enroll(KEY);
    }

    function testRegistrarCannotGainGovernanceVerificationOrExistingConfiguration() public {
        bytes32 id = enroll(KEY);
        vm.prank(REGISTRAR);
        vm.expectRevert(V1.Unauthorized.selector);
        d.setVerificationRoles(REGISTRAR, REGISTRAR, REGISTRAR);
        vm.prank(REGISTRAR);
        vm.expectRevert(V1.Unauthorized.selector);
        d.configureRegistrar(OTHER, 30000, 5, 1);
        vm.prank(REGISTRAR);
        vm.expectRevert(V1.Unauthorized.selector);
        d.proposeAdmin(REGISTRAR);
        D.Web2Verification memory proof = webProof(id);
        vm.prank(REGISTRAR);
        vm.expectRevert(V1.Unauthorized.selector);
        d.verifyWeb2(id, 0, proof);
        vm.prank(REGISTRAR);
        vm.expectRevert(V1.Unauthorized.selector);
        d.setListed(id, 0, true, bytes32(0));
        vm.prank(REGISTRAR);
        vm.expectRevert(V1.Unauthorized.selector);
        d.configure(id, 1, config(CONTROLLER, PUBLISHER));
        vm.prank(REGISTRAR);
        vm.expectRevert(V1.Unauthorized.selector);
        d.admitRegistry(OTHER, D.RegistrySource(bytes32(0), bytes20(0), bytes32(0)));
    }

    function testRoleSeparationSurvivesBothDirectionsOfRotation() public {
        vm.expectRevert(V1.InvalidConfiguration.selector);
        d.setVerificationRoles(REGISTRAR, HNS, LISTING);
        vm.expectRevert(V1.InvalidConfiguration.selector);
        d.configureRegistrar(WEB2, 30000, 2, 1);
        vm.expectRevert(V1.InvalidConfiguration.selector);
        d.configureRegistrar(address(this), 30000, 2, 1);
        vm.expectRevert(V1.InvalidConfiguration.selector);
        d.proposeAdmin(REGISTRAR);
        d.proposeAdmin(OTHER);
        vm.expectRevert(V1.InvalidConfiguration.selector);
        d.configureRegistrar(OTHER, 30000, 2, 1);
        vm.prank(OTHER);
        d.acceptAdmin();
        require(d.admin() == OTHER && d.pendingAdmin() == address(0));
    }

    function testRegistrationRejectsIncompleteIdentityAndBadConfiguration() public {
        vm.prank(REGISTRAR);
        vm.expectRevert(D.InvalidBinding.selector);
        d.registerHostedCommunity(D.HostingBinding(KEY, bytes32(0)), config(CONTROLLER, PUBLISHER), ORIGIN, 1);
        vm.prank(REGISTRAR);
        vm.expectRevert(D.InvalidBinding.selector);
        d.registerHostedCommunity(D.HostingBinding(KEY, INSTALL), config(CONTROLLER, PUBLISHER), bytes32(0), 1);
        vm.prank(REGISTRAR);
        vm.expectRevert(V1.InvalidConfiguration.selector);
        d.registerHostedCommunity(D.HostingBinding(KEY, INSTALL), config(address(0), PUBLISHER), ORIGIN, 1);
        require(d.registrarPermission().totalRegistered == 0);
    }

    function testIndependentListingVerificationAndExactThirtyDayBoundary() public {
        bytes32 id = enroll(KEY);
        listing(id, true);
        require(!d.isDiscoverable(id));
        verify(id);
        require(d.isDiscoverable(id));
        (uint64 revision, D.Web2Verification memory proof) = d.getWeb2Verification(id);
        require(revision == 1);
        vm.warp(proof.validUntil - 1);
        require(d.isDiscoverable(id));
        vm.warp(proof.validUntil);
        require(!d.isDiscoverable(id) && d.getCommunity(id).listed);
        require(d.getCommunity(id).configurationRevision == 1);
    }

    function testProofBoundAndFutureObservationRefuse() public {
        bytes32 id = enroll(KEY);
        D.Web2Verification memory proof = webProof(id);
        proof.validUntil++;
        vm.prank(WEB2);
        vm.expectRevert(V1.InvalidVerification.selector);
        d.verifyWeb2(id, 0, proof);
        proof = webProof(id);
        proof.observedAt++;
        vm.prank(WEB2);
        vm.expectRevert(V1.InvalidVerification.selector);
        d.verifyWeb2(id, 0, proof);
        proof = webProof(id);
        proof.originRevision++;
        vm.prank(WEB2);
        vm.expectRevert(V1.InvalidVerification.selector);
        d.verifyWeb2(id, 0, proof);
        proof = webProof(id);
        proof.evidenceSha256 = bytes32(0);
        vm.prank(WEB2);
        vm.expectRevert(V1.InvalidVerification.selector);
        d.verifyWeb2(id, 0, proof);
    }

    function testRevocationRejectsOldProofEvenWithNewExpectedRevision() public {
        bytes32 id = enroll(KEY);
        D.Web2Verification memory proof = webProof(id);
        verify(id);
        listing(id, true);
        vm.prank(WEB2);
        d.revokeWeb2(id, 1, keccak256("confirmed-loss"));
        require(!d.isDiscoverable(id));
        vm.prank(WEB2);
        vm.expectRevert(V1.StaleRevision.selector);
        d.verifyWeb2(id, 0, proof);
        vm.prank(WEB2);
        vm.expectRevert(V1.InvalidVerification.selector);
        d.verifyWeb2(id, 2, proof);
        vm.warp(block.timestamp + 1);
        verify(id);
        require(d.isDiscoverable(id));
    }

    function testRenewalNeverRelistsAndOnlyListingRoleCanRestore() public {
        bytes32 id = enroll(KEY);
        verify(id);
        listing(id, true);
        listing(id, false);
        vm.warp(block.timestamp + 1);
        verify(id);
        require(!d.isDiscoverable(id));
        vm.prank(WEB2);
        vm.expectRevert(V1.Unauthorized.selector);
        d.setListed(id, 2, true, bytes32(0));
        listing(id, true);
        require(d.isDiscoverable(id));
    }

    function testOriginChangeNeedsFreshProofAndRoundTripCannotRevive() public {
        bytes32 id = enroll(KEY);
        verify(id);
        listing(id, true);
        vm.prank(CONTROLLER);
        d.configureHostedCommunity(
            id,
            1,
            config(CONTROLLER, PUBLISHER),
            bytes32(0x89f058e71b7bd65f1818bf8178f63fdbeeb23a42ca4a79859c2d89be92600da7)
        );
        require(!d.isDiscoverable(id) && d.getOrigin(id).revision == 2);
        vm.prank(CONTROLLER);
        d.configureHostedCommunity(id, 2, config(CONTROLLER, PUBLISHER), ORIGIN);
        require(!d.isDiscoverable(id) && d.getOrigin(id).revision == 3);
        vm.warp(block.timestamp + 1);
        verify(id);
        require(d.isDiscoverable(id));
        require(d.getBinding(id).communityKey == KEY);
    }

    function testPublisherChangeDoesNotInvalidateAddressProof() public {
        bytes32 id = enroll(KEY);
        verify(id);
        listing(id, true);
        vm.prank(CONTROLLER);
        d.configure(id, 1, config(CONTROLLER, OTHER));
        require(d.isDiscoverable(id) && d.getOrigin(id).revision == 1 && d.getCommunity(id).configurationRevision == 2);
    }

    function testControllerRoundTripCannotReviveWeb2OrHnsProof() public {
        bytes32 id = enroll(KEY);
        verify(id);
        attach(id);
        listing(id, true);
        D.Web2Verification memory old = webProof(id);
        transfer(id, CONTROLLER, OTHER);
        require(!d.isDiscoverable(id));
        transfer(id, OTHER, CONTROLLER);
        require(!d.isDiscoverable(id));
        require(d.getOrigin(id).controllerRevision == 3);
        vm.prank(WEB2);
        vm.expectRevert(V1.InvalidVerification.selector);
        d.verifyWeb2(id, 1, old);
    }

    function testHnsExpiryCannotRemoveValidWeb2DiscoveryOrRelist() public {
        bytes32 id = enroll(KEY);
        verify(id);
        listing(id, true);
        D.HnsAttachment memory proof = attach(id);
        require(d.isHnsVerified(id));
        vm.warp(proof.validUntil);
        require(!d.isHnsVerified(id) && d.isDiscoverable(id));
        listing(id, false);
        vm.warp(block.timestamp + 1);
        attach(id);
        require(!d.isDiscoverable(id));
    }

    function testHnsMayQualifyDiscoveryWithoutWeb2ButDoesNotCreateMintAuthority() public {
        bytes32 id = enroll(KEY);
        attach(id);
        require(!d.isDiscoverable(id));
        listing(id, true);
        require(d.isDiscoverable(id) && !d.isWeb2Verified(id));
        vm.prank(HNS);
        d.revokeHns(id, 1, keccak256("confirmed-transfer"));
        require(!d.isDiscoverable(id));
        require(d.getCommunity(id).configurationRevision == 1);
    }

    function testHnsSourceEpochControllerAndLabelRefuse() public {
        bytes32 id = enroll(KEY);
        D.HnsAttachment memory proof = attach(id);
        vm.warp(block.timestamp + 1);
        proof.observedAt = uint64(block.timestamp);
        proof.validUntil = uint64(block.timestamp + 1 days);
        vm.prank(OTHER);
        vm.expectRevert(V1.Unauthorized.selector);
        d.attachHns(id, "fixture", 1, proof);
        proof.controllerRevision = 2;
        vm.prank(HNS);
        vm.expectRevert(V1.InvalidVerification.selector);
        d.attachHns(id, "fixture", 1, proof);
        proof.controllerRevision = 1;
        proof.namespaceAuthorizationRevision = 0;
        vm.prank(HNS);
        vm.expectRevert(V1.InvalidVerification.selector);
        d.attachHns(id, "fixture", 1, proof);
        proof.namespaceAuthorizationRevision = 1;
        vm.prank(HNS);
        vm.expectRevert(D.InvalidBinding.selector);
        d.attachHns(id, "ab--cd", 1, proof);
        vm.etch(proof.registry, hex"60006000fd");
        require(!d.isHnsVerified(id));
        vm.prank(HNS);
        vm.expectRevert(V1.InvalidRegistry.selector);
        d.attachHns(id, "fixture", 1, proof);
    }

    function testCanonicalSongAndDanceReferencesSurviveOriginAndHnsLifecycle() public {
        bytes32 id = enroll(KEY);
        CommunityPostsV1 posts = new CommunityPostsV1(address(d));
        bytes32 song = keccak256("song");
        bytes32 dance = keccak256("dance");
        bytes32 author = keccak256("author");
        vm.prank(PUBLISHER);
        posts.publishRevision(id, song, 0, 1, author, P.Kind.Song, keccak256("audio"), URI);
        // The Dance manifest commits to this canonical tuple, not an origin URL.
        bytes32 songReference =
            keccak256(abi.encode(block.chainid, address(posts), id, song, uint64(1), keccak256("audio")));
        vm.prank(PUBLISHER);
        posts.publishRevision(id, dance, 0, 1, author, P.Kind.Video, songReference, URI);
        vm.prank(CONTROLLER);
        d.configureHostedCommunity(
            id,
            1,
            config(CONTROLLER, PUBLISHER),
            bytes32(0x89f058e71b7bd65f1818bf8178f63fdbeeb23a42ca4a79859c2d89be92600da7)
        );
        verify(id);
        listing(id, true);
        D.HnsAttachment memory proof = attach(id);
        vm.warp(proof.validUntil);
        require(
            d.isDiscoverable(id) && posts.getPost(id, song).revision == 1
                && posts.getPost(id, dance).manifestSha256 == songReference
        );
        vm.prank(PUBLISHER);
        vm.expectRevert(P.StaleConfiguration.selector);
        posts.publishRevision(id, song, 1, 1, author, P.Kind.Song, keccak256("audio2"), URI);
        vm.prank(PUBLISHER);
        posts.publishRevision(id, song, 1, 2, author, P.Kind.Song, keccak256("audio2"), URI);
        require(posts.getPost(id, song).revision == 2);
    }

    function testWeb2ReapprovalMustPostdateRevocationNotJustPreviousObservation() public {
        bytes32 id = enroll(KEY);
        verify(id);
        vm.warp(10100);
        vm.prank(WEB2);
        d.revokeWeb2(id, 1, keccak256("loss"));
        D.Web2Verification memory proof = webProof(id);
        proof.observedAt = 10050;
        proof.validUntil = 10050 + 30 days;
        vm.prank(WEB2);
        vm.expectRevert(V1.InvalidVerification.selector);
        d.verifyWeb2(id, 2, proof);
        proof.observedAt = 10100;
        vm.prank(WEB2);
        vm.expectRevert(V1.InvalidVerification.selector);
        d.verifyWeb2(id, 2, proof);
        vm.warp(10101);
        verify(id);
        require(d.isWeb2Verified(id));
    }

    function testHnsReapprovalMustPostdateRevocation() public {
        bytes32 id = enroll(KEY);
        D.HnsAttachment memory proof = attach(id);
        vm.warp(10100);
        vm.prank(HNS);
        d.revokeHns(id, 1, keccak256("loss"));
        proof.observedAt = 10050;
        proof.validUntil = 10050 + 1 days;
        vm.prank(HNS);
        vm.expectRevert(V1.InvalidVerification.selector);
        d.attachHns(id, "fixture", 2, proof);
        proof.observedAt = 10100;
        vm.prank(HNS);
        vm.expectRevert(V1.InvalidVerification.selector);
        d.attachHns(id, "fixture", 2, proof);
        vm.warp(10101);
        proof.observedAt = 10101;
        proof.validUntil = 10101 + 1 days;
        vm.prank(HNS);
        d.attachHns(id, "fixture", 2, proof);
        require(d.isHnsVerified(id));
    }

    function testVerifierRotationPreservesBoundedProofButRefusesOldRoles() public {
        bytes32 id = enroll(KEY);
        verify(id);
        D.HnsAttachment memory proof = attach(id);
        listing(id, true);
        d.setVerificationRoles(OTHER, OTHER, OTHER);
        require(d.isDiscoverable(id));
        vm.prank(WEB2);
        vm.expectRevert(V1.Unauthorized.selector);
        d.revokeWeb2(id, 1, bytes32(0));
        vm.prank(HNS);
        vm.expectRevert(V1.Unauthorized.selector);
        d.revokeHns(id, 1, bytes32(0));
        vm.prank(LISTING);
        vm.expectRevert(V1.Unauthorized.selector);
        d.setListed(id, 1, false, bytes32(0));
        vm.warp(block.timestamp + 1);
        D.Web2Verification memory next = webProof(id);
        vm.prank(WEB2);
        vm.expectRevert(V1.Unauthorized.selector);
        d.verifyWeb2(id, 1, next);
        proof.observedAt++;
        proof.validUntil++;
        vm.prank(HNS);
        vm.expectRevert(V1.Unauthorized.selector);
        d.attachHns(id, "fixture", 1, proof);
        vm.prank(OTHER);
        d.revokeWeb2(id, 1, bytes32(0));
        vm.prank(OTHER);
        d.revokeHns(id, 1, bytes32(0));
        require(!d.isDiscoverable(id));
    }

    function testObservationCannotPredateAddressOrControllerBinding() public {
        bytes32 id = enroll(KEY);
        verify(id);
        D.HnsAttachment memory hnsProof = attach(id);
        vm.warp(10100);
        vm.prank(CONTROLLER);
        d.configureHostedCommunity(id, 1, config(CONTROLLER, PUBLISHER), bytes32(uint256(9)));
        D.Web2Verification memory proof = webProof(id);
        proof.observedAt = 10050;
        proof.validUntil = 10050 + 30 days;
        vm.prank(WEB2);
        vm.expectRevert(V1.InvalidVerification.selector);
        d.verifyWeb2(id, 1, proof);
        transfer(id, CONTROLLER, OTHER);
        hnsProof.controllerRevision = d.getOrigin(id).controllerRevision;
        hnsProof.observedAt = 10050;
        hnsProof.validUntil = 10050 + 1 days;
        vm.prank(HNS);
        vm.expectRevert(V1.InvalidVerification.selector);
        d.attachHns(id, "fixture", 1, hnsProof);
    }

    function testLegacySelectorsAndWrongChainRefuse() public {
        vm.expectRevert(D.LegacyEntryPoint.selector);
        d.communityIdFor(OTHER);
        vm.expectRevert(D.LegacyEntryPoint.selector);
        d.registerCommunity(OTHER, config(CONTROLLER, PUBLISHER));
        V1.NamespaceVerification memory proof;
        vm.expectRevert(D.LegacyEntryPoint.selector);
        d.verifyNamespace(KEY, 0, proof);
        vm.chainId(1);
        vm.expectRevert(D.InvalidDeploymentProfile.selector);
        new CommunityDirectoryV3(address(this));
    }
}
