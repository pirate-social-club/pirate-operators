// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {CommunityFixture} from "../community/CommunityFixture.sol";
import {ICommunityDirectoryV1 as Directory} from "../../../contracts/interfaces/community/ICommunityDirectoryV1.sol";
import {ICommunityPostsV1 as Posts} from "../../../contracts/interfaces/community/ICommunityPostsV1.sol";
import {LearningResultsV4} from "../../../contracts/LearningResultsV4.sol";
import {DanceVerdictAuthority} from "../../../contracts/dance/DanceVerdictAuthority.sol";
import {DanceVerdictWire as Wire} from "../../../contracts/dance/DanceVerdictWire.sol";
import {DanceCapturePolicyV1} from "../../../contracts/dance/DanceCapturePolicyV1.sol";
import {DanceVerdictsV1} from "../../../contracts/dance/DanceVerdictsV1.sol";

interface DanceVm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function getCode(string calldata artifactPath) external view returns (bytes memory);
}

abstract contract DanceFixture is CommunityFixture {
    DanceVm constant dv = DanceVm(address(vm));
    uint256 constant LEARNER_KEY = 0x123ab;
    uint256 constant REVIEWER_KEY = 0x456ab;
    bytes32 constant CAPTURE = keccak256("fixture-capture");
    bytes32 constant RECORDING = sha256("fixture-recording");
    uint64 constant REVIEW_MS = 604_800_000;
    LearningResultsV4 learning;
    DanceCapturePolicyV1 policy;
    DanceVerdictsV1 dance;
    Wire.Policy documents;
    address learner;
    address reviewer;
    bytes32 learnerAccount;
    bytes32 reviewerAccount;
    bytes32 learnerAuth;
    bytes32 reviewerAuth;
    uint256 private commandSequence;

    function deployArtifact(string memory artifact, bytes memory args) private returns (address result) {
        bytes memory init = bytes.concat(dv.getCode(artifact), args);
        assembly ("memory-safe") { result := create(0, add(init, 32), mload(init)) }
        require(result != address(0), "fixture_deployment_failed");
    }

    function setUp() public virtual override {
        super.setUp();
        learning = LearningResultsV4(
            deployArtifact(
                "LearningResultsV4.sol:LearningResultsV4",
                abi.encode(OWNER, communityId, keccak256("fixture-v4-policy"), "https://community.example")
            )
        );
        Directory.Configuration memory c = config(OWNER, PUBLISHER);
        c.learningRecords = address(learning);
        vm.prank(OWNER);
        directory.registerCommunity(registry, c);
        vm.prank(PUBLISHER);
        publish(communityId, POST, 0, 1, AUTHOR, Posts.Kind.Song);
        policy = DanceCapturePolicyV1(deployArtifact("DanceCapturePolicyV1.sol:DanceCapturePolicyV1", ""));
        documents = Wire.Policy(
            sha256("rules"), sha256("terms"), sha256("rubric"), sha256("media"), sha256("disclosure"), sha256("privacy")
        );
        DanceVerdictAuthority.Deployment memory pins = DanceVerdictAuthority.Deployment(
            communityId,
            address(directory),
            address(directory).codehash,
            address(learning),
            address(learning).codehash,
            address(posts),
            address(posts).codehash,
            PUBLISHER
        );
        dance = DanceVerdictsV1(
            deployArtifact(
                "DanceVerdictsV1.sol:DanceVerdictsV1", abi.encode(pins, documents, policy, address(policy).codehash)
            )
        );
        configure(0, 1, OWNER, OWNER);
        learner = dv.addr(LEARNER_KEY);
        reviewer = dv.addr(REVIEWER_KEY);
        learnerAuth = authorize(LEARNER_KEY, keccak256("learner-sign-in"), uint64(block.timestamp - 10));
        reviewerAuth = authorize(REVIEWER_KEY, keccak256("reviewer-sign-in"), uint64(block.timestamp - 10));
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
                keccak256("pirate.dance-account/1"),
                block.chainid,
                address(dance),
                communityId,
                keccak256(bytes(account)),
                wallet
            )
        );
    }

    function authorize(uint256 key, bytes32 nonce, uint64 issued) internal returns (bytes32 auth) {
        LearningResultsV4.SignIn memory signIn = LearningResultsV4.SignIn(dv.addr(key), nonce, issued);
        auth = learning.signInDigest(signIn);
        (uint8 v, bytes32 r, bytes32 s) = dv.sign(key, auth);
        learning.authorize(signIn, abi.encodePacked(r, s, v));
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
        cap.authorizationId = learnerAuth;
        cap.reservedAtMs = nowMs() - 2000;
        cap.song = Wire.Song(block.chainid, address(posts), communityId, POST, 1, DIGEST, sha256("audio"));
        cap.rulesSha256 = documents.rulesSha256;
        cap.termsSha256 = documents.termsSha256;
        cap.rubricSha256 = documents.rubricSha256;
        cap.mediaPolicySha256 = documents.mediaPolicySha256;
        cap.referenceSelection.durationSamples = 288_000;
        if (opens != 0) {
            cap.offer =
                Wire.Offer(true, keccak256("offer-id"), sha256("frozen-offer"), dance.sourceHash(), opens, cutoff);
        }
        p.capture = cap;
        p.consent = Wire.Consent(true, nowMs() - 1000, 0, documents.termsSha256, dance.publicityPolicyHash());
        p.submission.trustedSubmittedAtMs = nowMs();
        p.submission.reviewDeadlineMs = nowMs() + REVIEW_MS;
        p.submission.mediaExpiresAtMs = p.submission.reviewDeadlineMs;
        p.submission.mediaGeneration = 2;
        p.submission.mediaIdCommitment = keccak256(
            abi.encode(
                keccak256("pirate.dance-media-id/1"), d.chainId, d.verifier, d.communityId, keccak256("fixture-media")
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

    function submit(Wire.RegisterSubmission memory p) internal returns (DanceVerdictAuthority.Receipt memory) {
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

    function review(Wire.CommitVerdict memory p) internal returns (DanceVerdictAuthority.Receipt memory) {
        bytes memory encoded = abi.encode(p);
        bytes32 command = id();
        bytes32 digest = hash(Wire.Operation.CommitVerdict, PUBLISHER, command, encoded);
        vm.prank(PUBLISHER);
        return dance.commitVerdict(command, digest, encoded);
    }

    function invalidate(bytes32 captureId, address wallet, address caller, uint64 expectedMedia)
        internal
        returns (DanceVerdictAuthority.Receipt memory)
    {
        Wire.InvalidateSubmission memory p = Wire.InvalidateSubmission(captureId, wallet, expectedMedia, 1);
        bytes32 command = id();
        bytes32 digest = hash(Wire.Operation.InvalidateSubmission, caller, command, abi.encode(p));
        vm.prank(caller);
        return dance.invalidateSubmission(command, digest, p);
    }
}
