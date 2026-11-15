// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {PublicationFixture, ConsentVm} from "../PublicationConsentV1.t.sol";
import {
    ICommunityPublicationConsentV1 as C
} from "../../../contracts/interfaces/community/ICommunityPublicationConsentV1.sol";
import {ICommunityDirectoryV1 as Directory} from "../../../contracts/interfaces/community/ICommunityDirectoryV1.sol";
import {ICommunityPostsV1 as Posts} from "../../../contracts/interfaces/community/ICommunityPostsV1.sol";
import {DanceVerdictAuthorityV2} from "../../../contracts/dance/DanceVerdictAuthorityV2.sol";
import {DanceVerdictWireV2 as Wire} from "../../../contracts/dance/DanceVerdictWireV2.sol";
import {DanceCapturePolicyV2} from "../../../contracts/dance/DanceCapturePolicyV2.sol";
import {DanceVerdictsV2} from "../../../contracts/dance/DanceVerdictsV2.sol";

abstract contract DanceV2Fixture is PublicationFixture {
    bytes32 constant POST = keccak256("song");
    bytes32 constant DIGEST = bytes32(0x05b3abf2579a5eb66403cd78be557fd860633a1fe2103c7642030defe32c657f);
    bytes32 constant LEARNER_POLICY = bytes32(0xbd7908e80078a1748df0da8bbc84573d4b56fca5ce50e95f54a41c6ff68419e6);
    bytes32 constant REVIEWER_POLICY = bytes32(0x7e1afa457e69eaf6b632882558ec054008a1519a767d4cb368dffa223a7e9628);
    bytes32 constant CAPTURE = keccak256("fixture-capture");
    bytes32 constant RECORDING = bytes32(0x3019142fc566b86f6b31099bcb5a40d3a16b5adb13ce8021a8ab18be55e2dd1a);
    uint64 constant REVIEW_MS = 604_800_000;
    DanceCapturePolicyV2 policy;
    DanceVerdictsV2 dance;
    Wire.Policy documents;
    address reviewer;
    bytes32 learnerAccount;
    bytes32 reviewerAccount;
    bytes32 learnerAuth;
    bytes32 reviewerAuth;
    uint256 private commandSequence;

    function setUp() public virtual override {
        super.setUp();
        vm.prank(PUBLISHER);
        posts.publishRevision(communityId, POST, 0, 1, keccak256("author"), Posts.Kind.Song, DIGEST, URI);
        policy = DanceCapturePolicyV2(deployArtifact("out/DanceCapturePolicyV2.sol/DanceCapturePolicyV2.json", ""));
        documents = Wire.Policy(
            bytes32(0x6c621d1a05138a7888d37d9269a9da8e2e11e4aced2f6cfd24b05ab1b9e61bb0),
            bytes32(0x51d2361f4faea3bc8f9facdbc7d99abb555596a2e51f7b25fd3b41c93587e616),
            bytes32(0x49672f0ef3b3a542b3b86b475936cc9adf1ddf60369e9b120ba33900294c99d8),
            bytes32(0x721c9525ade2ea8903d343ef25cf68b9bf4ab0aad56bb7b01fbe48d09bc7fcf4),
            bytes32(0x8187135faead318892553b6d7ee48321c4d00ac028e88d17a02f05de9162863f),
            bytes32(0xa4cc6bc01a927e2a78fd3bec51e865ac0d85e4daab6f988d5d33d056e125b1c3)
        );
        DanceVerdictAuthorityV2.Deployment memory pins = DanceVerdictAuthorityV2.Deployment(
            communityId,
            address(directory),
            address(directory).codehash,
            address(learning),
            address(learning).codehash,
            address(posts),
            address(posts).codehash,
            LEARNER_POLICY,
            REVIEWER_POLICY
        );
        dance = DanceVerdictsV2(
            deployArtifact(
                "out/DanceVerdictsV2.sol/DanceVerdictsV2.json",
                abi.encode(pins, documents, policy, address(policy).codehash)
            )
        );
        configure(0, 1, OWNER, OWNER);
        descriptor("dance-verdict", address(dance), LEARNER_POLICY);
        descriptor("dance-review-attribution", address(dance), REVIEWER_POLICY);
        reviewer = vm.addr(REVIEWER_KEY);
        learnerAuth =
            authorize(LEARNER_KEY, "dance-verdict", address(dance), LEARNER_POLICY, keccak256("learner-grant"));
        reviewerAuth = authorize(
            REVIEWER_KEY, "dance-review-attribution", address(dance), REVIEWER_POLICY, keccak256("reviewer-grant")
        );
        vm.warp(block.timestamp + 3);
        learnerAccount = accountCommitment(learner, "fixture-learner");
        reviewerAccount = accountCommitment(reviewer, "fixture-reviewer");
        bind(learnerAccount, learner, true);
        bind(reviewerAccount, reviewer, true);
        grant(0, uint64(block.timestamp + 10 days));
    }

    function domain() internal view returns (Wire.Domain memory) {
        return Wire.Domain(block.chainid, address(dance), communityId);
    }

    function id() internal returns (bytes32) {
        return bytes32(++commandSequence);
    }

    function hash(Wire.Operation operation, address caller, bytes32 command, bytes memory encoded)
        internal
        view
        returns (bytes32)
    {
        return Wire.commandHash(domain(), operation, caller, command, encoded);
    }

    function accountCommitment(address wallet, string memory account) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("pirate.dance-account/2"),
                block.chainid,
                address(dance),
                communityId,
                keccak256(bytes(account)),
                wallet
            )
        );
    }

    function configure(uint64 ownerEpoch, uint64 revision, address controller, address ownerWallet) internal {
        Wire.ConfigureOwner memory p = Wire.ConfigureOwner(
            ownerEpoch,
            revision,
            controller,
            PUBLISHER,
            address(learning),
            ownerWallet,
            uint64(block.timestamp),
            uint64(block.timestamp + 14 days),
            dance.publicityPolicyHash()
        );
        bytes32 command = id();
        bytes32 digest = hash(Wire.Operation.ConfigureOwner, controller, command, abi.encode(p));
        vm.prank(controller);
        dance.configureOwner(command, digest, p);
    }

    function bind(bytes32 account, address wallet, bool active) internal {
        mutateBinding(
            Wire.BindIdentity(1, 1, account, wallet, 0, 0, 0, 0, Wire.singletonId(domain(), account), 0, true, active)
        );
    }

    function mutateBinding(Wire.BindIdentity memory p) internal {
        bytes32 command = id();
        bytes32 digest = hash(Wire.Operation.BindIdentity, PUBLISHER, command, abi.encode(p));
        vm.prank(PUBLISHER);
        dance.bindIdentity(command, digest, p);
    }

    function grant(uint64 priorEpoch, uint64 expires) internal returns (bytes32 command, bytes32 digest) {
        Wire.GrantReviewer memory p = Wire.GrantReviewer(1, 1, reviewer, priorEpoch, expires);
        command = id();
        digest = hash(Wire.Operation.GrantReviewer, OWNER, command, abi.encode(p));
        vm.prank(OWNER);
        dance.grantReviewer(command, digest, p);
    }

    function revoke(uint64 priorEpoch) internal {
        Wire.RevokeReviewer memory p = Wire.RevokeReviewer(1, 1, reviewer, priorEpoch);
        bytes32 command = id();
        bytes32 digest = hash(Wire.Operation.RevokeReviewer, OWNER, command, abi.encode(p));
        vm.prank(OWNER);
        dance.revokeReviewer(command, digest, p);
    }

    function nowMs() internal view returns (uint64) {
        return uint64(block.timestamp) * 1000;
    }

    function registration(bytes32 captureId, bytes32 recording, uint64 opens, uint64 cutoff)
        internal
        view
        returns (Wire.RegisterSubmission memory p)
    {
        Wire.Domain memory d = domain();
        Wire.Capture memory cap;
        cap.captureId = captureId;
        cap.accountCommitment = learnerAccount;
        cap.learner = learner;
        cap.identityEpoch = 1;
        cap.groupId = Wire.singletonId(d, learnerAccount);
        cap.groupEpoch = 1;
        cap.publicationGrantId = learnerAuth;
        cap.reservedAtMs = nowMs() - 2000;
        cap.song = Wire.Song(
            block.chainid,
            address(posts),
            communityId,
            POST,
            1,
            DIGEST,
            bytes32(0x6ed8919ce20490a5e3ad8630a4fab69475297abd07db73918dd5f36fcfaeb11b)
        );
        cap.rulesSha256 = documents.rulesSha256;
        cap.termsSha256 = documents.termsSha256;
        cap.rubricSha256 = documents.rubricSha256;
        cap.mediaPolicySha256 = documents.mediaPolicySha256;
        cap.referenceSelection.durationSamples = 288_000;
        if (opens != 0) {
            cap.offer = Wire.Offer(
                true,
                keccak256("offer-id"),
                bytes32(0xeae88cf8897024f748f042324bad6dffd4f0f69bdd4f7bea1cd6e6f21bef5610),
                dance.sourceHash(),
                opens,
                cutoff
            );
        }
        p.capture = cap;
        p.consent = Wire.Consent(true, nowMs() - 1000, 0, documents.termsSha256, dance.publicityPolicyHash());
        p.submission.trustedSubmittedAtMs = nowMs();
        p.submission.reviewDeadlineMs = nowMs() + REVIEW_MS;
        p.submission.mediaExpiresAtMs = p.submission.reviewDeadlineMs;
        p.submission.mediaGeneration = 2;
        p.submission.mediaIdCommitment = keccak256(
            abi.encode(
                keccak256("pirate.dance-media-id/2"), d.chainId, d.verifier, d.communityId, keccak256("fixture-media")
            )
        );
        p.recordingSha256 = recording;
        p.expectedOwnerEpoch = 1;
        p.expectedConfigurationRevision = 1;
        return seal(p);
    }

    function seal(Wire.RegisterSubmission memory p) internal view returns (Wire.RegisterSubmission memory) {
        Wire.Domain memory d = domain();
        p.submission.submissionId = Wire.submissionId(d, p.capture.learner, p.capture.captureId);
        p.submission.captureHash = Wire.captureHash(d, p.capture);
        p.consent.captureHash = p.submission.captureHash;
        p.submission.consentHash = Wire.consentHash(d, p.consent);
        p.submission.mediaBindingHash = Wire.mediaBindingHash(
            d, p.submission.captureHash, p.submission.mediaIdCommitment, p.submission.mediaGeneration, p.recordingSha256
        );
        p.submission.recordingReplayKey = Wire.recordingReplayKey(d, p.recordingSha256);
        p.submission.recordingBindingHash =
            Wire.recordingBindingHash(d, p.recordingSha256, p.submission.mediaBindingHash);
        return p;
    }

    function submit(Wire.RegisterSubmission memory p) internal returns (DanceVerdictAuthorityV2.Receipt memory) {
        bytes memory encoded = abi.encode(p);
        bytes32 command = id();
        bytes32 digest = hash(Wire.Operation.RegisterSubmission, PUBLISHER, command, encoded);
        vm.prank(PUBLISHER);
        return dance.registerSubmission(command, digest, encoded);
    }

    function decision(bytes32 submission, uint8 category) internal view returns (Wire.CommitVerdict memory p) {
        p.decision = Wire.Decision(
            submission,
            category,
            reviewerAccount,
            reviewer,
            reviewerAuth,
            1,
            Wire.singletonId(domain(), reviewerAccount),
            1,
            1,
            1,
            1,
            nowMs(),
            1,
            0,
            0
        );
        p.decision.reviewerConsentHash = Wire.reviewerConsentHash(domain(), p.decision, dance.publicityPolicyHash());
    }

    function review(Wire.CommitVerdict memory p) internal returns (DanceVerdictAuthorityV2.Receipt memory) {
        bytes memory encoded = abi.encode(p);
        bytes32 command = id();
        bytes32 digest = hash(Wire.Operation.CommitVerdict, PUBLISHER, command, encoded);
        vm.prank(PUBLISHER);
        return dance.commitVerdict(command, digest, encoded);
    }

    function invalidate(bytes32 captureId, address wallet, address caller, uint64 expectedMedia)
        internal
        returns (DanceVerdictAuthorityV2.Receipt memory)
    {
        Wire.InvalidateSubmission memory p = Wire.InvalidateSubmission(captureId, wallet, expectedMedia, 1);
        bytes32 command = id();
        bytes32 digest = hash(Wire.Operation.InvalidateSubmission, caller, command, abi.encode(p));
        vm.prank(caller);
        return dance.invalidateSubmission(command, digest, p);
    }
}

contract DanceVerdictsV2Test is DanceV2Fixture {
    function testDanceRuntimeEvidenceAndAllConstructorPins() public {
        require(dance.communityId() == communityId && address(dance.directory()) == address(directory));
        require(dance.directoryRuntimeHash() == address(directory).codehash);
        require(
            address(dance.consentRegistry()) == address(learning)
                && dance.consentRegistryRuntimeHash() == address(learning).codehash
        );
        require(address(dance.posts()) == address(posts) && dance.postsRuntimeHash() == address(posts).codehash);
        require(
            dance.learnerConsentPolicyHash() == LEARNER_POLICY && dance.reviewerConsentPolicyHash() == REVIEWER_POLICY
        );
        require(
            dance.publicityPolicyHash() == Wire.policyHash(documents) && dance.rulesSha256() == documents.rulesSha256
        );
        require(dance.termsSha256() == documents.termsSha256 && dance.rubricSha256() == documents.rubricSha256);
        require(
            dance.mediaPolicySha256() == documents.mediaPolicySha256
                && dance.consentDisclosureSha256() == documents.consentDisclosureSha256
        );
        require(dance.privacySha256() == documents.privacySha256 && dance.deploymentBlock() == block.number);
        require(
            address(dance.capturePolicy()) == address(policy)
                && dance.capturePolicyRuntimeHash() == address(policy).codehash
        );
        require(
            dance.EXECUTION_RULE() == keccak256("directory-current-publisher/1") && dance.VERSION() == 2
                && policy.VERSION() == 2
        );
        DanceVerdictAuthorityV2.Deployment memory pins = DanceVerdictAuthorityV2.Deployment(
            communityId,
            address(directory),
            address(directory).codehash,
            address(learning),
            address(learning).codehash,
            address(posts),
            address(posts).codehash,
            LEARNER_POLICY,
            REVIEWER_POLICY
        );
        emit RuntimeEvidence(
            "DanceVerdictsV2", address(dance).code, abi.encode(pins, documents, policy, address(policy).codehash)
        );
        emit RuntimeEvidence("DanceCapturePolicyV2", address(policy).code, "");
    }

    function testDistinctGrantsPublishAndExactReplaySurvivesWithdrawals() public {
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        submit(p);
        Wire.CommitVerdict memory v = decision(p.submission.submissionId, 1);
        bytes memory encoded = abi.encode(v);
        bytes32 command = id();
        bytes32 digest = hash(Wire.Operation.CommitVerdict, PUBLISHER, command, encoded);
        vm.recordLogs();
        vm.prank(PUBLISHER);
        DanceVerdictAuthorityV2.Receipt memory first = dance.commitVerdict(command, digest, encoded);
        ConsentVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 2);
        withdraw(learner, "dance-verdict");
        withdraw(reviewer, "dance-review-attribution");
        vm.warp(block.timestamp + 31 days);
        vm.recordLogs();
        vm.prank(PUBLISHER);
        DanceVerdictAuthorityV2.Receipt memory replay = dance.commitVerdict(command, digest, encoded);
        require(keccak256(abi.encode(first)) == keccak256(abi.encode(replay)) && vm.getRecordedLogs().length == 0);
        (,,,, uint64 at, uint8 verdict,) = dance.verdicts(p.submission.submissionId);
        require(at == first.committedAtSeconds && verdict == 1);
    }

    function testLearnerWithdrawalBetweenCaptureAndRegistrationRefuses() public {
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        withdraw(learner, "dance-verdict");
        vm.expectRevert(DanceCapturePolicyV2.AuthorizationChanged.selector);
        submit(p);
    }

    function testLearnerWithdrawalAfterRegistrationCannotBeReplacedByNewGrant() public {
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        submit(p);
        withdraw(learner, "dance-verdict");
        authorize(LEARNER_KEY, "dance-verdict", address(dance), LEARNER_POLICY, keccak256("new"));
        Wire.CommitVerdict memory v = decision(p.submission.submissionId, 1);
        vm.expectRevert(DanceCapturePolicyV2.AuthorizationChanged.selector);
        review(v);
    }

    function testReviewerWithdrawalAfterIntentRefusesAndNewGrantCannotBackdate() public {
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        submit(p);
        Wire.CommitVerdict memory v = decision(p.submission.submissionId, 1);
        withdraw(reviewer, "dance-review-attribution");
        vm.expectRevert(DanceCapturePolicyV2.AuthorizationChanged.selector);
        review(v);
        vm.warp(block.timestamp + 1);
        v.decision.reviewerPublicationGrantId =
            authorize(REVIEWER_KEY, "dance-review-attribution", address(dance), REVIEWER_POLICY, keccak256("new"));
        vm.expectRevert(DanceCapturePolicyV2.AuthorizationChanged.selector);
        review(v);
    }

    function testDifferentAdmittedConsentPolicyCannotSatisfyPinnedDancePolicy() public {
        bytes32 different = bytes32(0xcc089738b55bd7bed6aa696e1acefb84edde89247720879627f255bfdc73551d);
        descriptor("dance-verdict", address(dance), different);
        learnerAuth = authorize(LEARNER_KEY, "dance-verdict", address(dance), different, keccak256("different"));
        vm.warp(block.timestamp + 3);
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        vm.expectRevert(DanceCapturePolicyV2.AuthorizationChanged.selector);
        submit(p);
    }

    function testPrivateMediaConsentRemainsSeparateFromPublicGrant() public {
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        p.consent.accepted = false;
        p = seal(p);
        vm.expectRevert(DanceCapturePolicyV2.InvalidConsent.selector);
        submit(p);
    }

    function testRegistryReplacementCannotWrite() public {
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        submit(p);
        vm.prank(OWNER);
        directory.configure(communityId, 1, config(PUBLISHER, address(0)));
        Wire.CommitVerdict memory v = decision(p.submission.submissionId, 1);
        vm.expectRevert(DanceVerdictAuthorityV2.InvalidSource.selector);
        review(v);
    }

    function testDifferentCommandIdCannotCreateSecondVerdict() public {
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        submit(p);
        review(decision(p.submission.submissionId, 1));
        Wire.CommitVerdict memory v = decision(p.submission.submissionId, 2);
        vm.expectRevert(DanceVerdictsV2.VerdictAlreadyCommitted.selector);
        review(v);
    }

    function executeVerdictAs(address publisher, Wire.CommitVerdict memory p) private {
        bytes32 command = id();
        bytes memory encoded = abi.encode(p);
        bytes32 digest = hash(Wire.Operation.CommitVerdict, publisher, command, encoded);
        vm.prank(publisher);
        dance.commitVerdict(command, digest, encoded);
    }

    function testPublisherRotationRequiresRefreshedOwnerAndReviewerButKeepsGrants() public {
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        submit(p);
        Wire.CommitVerdict memory v = decision(p.submission.submissionId, 1);
        address b = address(0x222);
        vm.prank(OWNER);
        directory.configure(communityId, 1, config(b, address(learning)));
        vm.expectRevert(DanceVerdictAuthorityV2.Unauthorized.selector);
        executeVerdictAs(PUBLISHER, v);
        vm.expectRevert(DanceVerdictAuthorityV2.StaleContext.selector);
        executeVerdictAs(b, v);
        Wire.ConfigureOwner memory owner = Wire.ConfigureOwner(
            1,
            2,
            OWNER,
            b,
            address(learning),
            OWNER,
            uint64(block.timestamp),
            uint64(block.timestamp + 14 days),
            dance.publicityPolicyHash()
        );
        bytes32 command = id();
        bytes32 digest = hash(Wire.Operation.ConfigureOwner, OWNER, command, abi.encode(owner));
        vm.prank(OWNER);
        dance.configureOwner(command, digest, owner);
        v.decision.expectedOwnerEpoch = 2;
        v.decision.expectedConfigurationRevision = 2;
        vm.expectRevert(DanceVerdictAuthorityV2.Unauthorized.selector);
        executeVerdictAs(b, v);
        Wire.GrantReviewer memory reviewerRole = Wire.GrantReviewer(
            2, 2, reviewer, 1, uint64(block.timestamp + 10 days)
        );
        command = id();
        digest = hash(Wire.Operation.GrantReviewer, OWNER, command, abi.encode(reviewerRole));
        vm.prank(OWNER);
        dance.grantReviewer(command, digest, reviewerRole);
        v.decision.expectedReviewerRoleEpoch = 2;
        require(v.decision.reviewerPublicationGrantId == reviewerAuth && p.capture.publicationGrantId == learnerAuth);
        executeVerdictAs(b, v);
        (,,,,, uint8 category,) = dance.verdicts(p.submission.submissionId);
        require(category == 1);
    }

    function testSameCommandIdChangedPayloadConflictsBeforeAnyNewEffect() public {
        Wire.RegisterSubmission memory p = registration(CAPTURE, RECORDING, 0, 0);
        bytes memory encoded = abi.encode(p);
        bytes32 command = id();
        bytes32 digest = hash(Wire.Operation.RegisterSubmission, PUBLISHER, command, encoded);
        vm.prank(PUBLISHER);
        dance.registerSubmission(command, digest, encoded);
        p.recordingSha256 = keccak256("changed");
        encoded = abi.encode(p);
        digest = hash(Wire.Operation.RegisterSubmission, PUBLISHER, command, encoded);
        vm.prank(PUBLISHER);
        vm.expectRevert(DanceVerdictAuthorityV2.CommandConflict.selector);
        dance.registerSubmission(command, digest, encoded);
    }

    function testChangedPublicationTargetCodeDeniesOriginalGrant() public {
        vm.etch(address(dance), hex"00");
        (bool ok, uint8 reason) = learning.checkGrant(
            learnerAuth, learner, keccak256("dance-verdict"), address(dance), LEARNER_POLICY, uint64(block.timestamp)
        );
        require(!ok && reason == uint8(C.Denial.ChangedTargetCode));
    }

    function testFixedV2CommandCaptureAndSourcePreimages() public pure {
        Wire.Domain memory d = Wire.Domain(
            31337,
            0x2222222222222222222222222222222222222222,
            0x3333333333333333333333333333333333333333333333333333333333333333
        );
        Wire.GrantReviewer memory p = Wire.GrantReviewer(
            1, 1, 0x1111111111111111111111111111111111111111, 0, 1800003600
        );
        require(
            Wire.commandHash(
                d,
                Wire.Operation.GrantReviewer,
                0x1111111111111111111111111111111111111111,
                0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,
                abi.encode(p)
            ) == 0x4d91e59cb0398012c2d5217ee1b841e5a1517ce9e64f5b3f7ebcd3a61f3c66ee
        );
        Wire.Capture memory cap;
        cap.captureId = bytes32(uint256(11));
        cap.accountCommitment = bytes32(uint256(12));
        cap.learner = address(uint160(13));
        cap.identityEpoch = 14;
        cap.groupId = bytes32(uint256(15));
        cap.groupEpoch = 16;
        cap.publicationGrantId = bytes32(uint256(17));
        cap.reservedAtMs = 18;
        cap.song.chainId = 19;
        cap.song.posts = address(uint160(20));
        cap.song.communityId = bytes32(uint256(21));
        cap.song.postId = bytes32(uint256(22));
        cap.song.revision = 23;
        cap.song.manifestSha256 = bytes32(uint256(24));
        cap.song.audioSha256 = bytes32(uint256(25));
        cap.rulesSha256 = bytes32(uint256(26));
        cap.termsSha256 = bytes32(uint256(27));
        cap.rubricSha256 = bytes32(uint256(28));
        cap.mediaPolicySha256 = bytes32(uint256(29));
        cap.referenceSelection.present = false;
        cap.referenceSelection.id = bytes32(uint256(31));
        cap.referenceSelection.revision = 32;
        cap.referenceSelection.epoch = 33;
        cap.referenceSelection.segmentLayoutSha256 = bytes32(uint256(34));
        cap.referenceSelection.segmentId = bytes32(uint256(35));
        cap.referenceSelection.startSample = 36;
        cap.referenceSelection.durationSamples = 37;
        cap.offer.present = false;
        cap.offer.offerIdCommitment = bytes32(uint256(39));
        cap.offer.inputHash = bytes32(uint256(40));
        cap.offer.sourceHash = bytes32(uint256(41));
        cap.offer.opensAtMs = 42;
        cap.offer.cutoffAtMs = 43;
        require(Wire.captureHash(d, cap) == 0xfc029f11733ad947f0673c277f4e72489a1bc8de185561471f3d0f7f2651e3f0);
        Wire.SourcePin memory source;
        source.directory = address(uint160(11));
        source.directoryRuntimeHash = bytes32(uint256(12));
        source.consentRegistry = address(uint160(13));
        source.consentRegistryRuntimeHash = bytes32(uint256(14));
        source.posts = address(uint160(15));
        source.postsRuntimeHash = bytes32(uint256(16));
        source.executionRule = bytes32(uint256(17));
        source.learnerConsentPolicyHash = bytes32(uint256(18));
        source.reviewerConsentPolicyHash = bytes32(uint256(19));
        source.publicityPolicyHash = bytes32(uint256(20));
        source.rulesSha256 = bytes32(uint256(21));
        source.termsSha256 = bytes32(uint256(22));
        source.rubricSha256 = bytes32(uint256(23));
        source.mediaPolicySha256 = bytes32(uint256(24));
        source.deploymentBlock = 25;
        source.runtimeCodeHash = bytes32(uint256(26));
        require(Wire.sourceHash(d, source) == 0x201fee527872f0ad873918fbf89ddd330c5d259b633d727e7b58886ffe014170);
    }
}
