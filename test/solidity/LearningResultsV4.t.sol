// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import "../../contracts/LearningResultsV4.sol";
import "../../contracts/test/ReplaySafeAccount.sol";
import "./SignInVectorsV4.sol";

interface ResultsVmV4 {
    function warp(uint256) external;
    function addr(uint256) external returns (address);
    function prank(address) external;
    function expectRevert(bytes calldata) external;
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function chainId(uint256) external;
    function expectEmit(bool, bool, bool, bool) external;
}

contract ResultsWalletV4 {
    bytes32 public digest;

    function approve(bytes32 value) external {
        digest = value;
    }

    function isValidSignature(bytes32 value, bytes calldata) external view returns (bytes4) {
        return value == digest ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/// Shared result rules are V3's tests unchanged; permission tests are V4's own.
contract LearningResultsV4Test {
    ResultsVmV4 constant vm = ResultsVmV4(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant EPOCH = 1793552400;
    string constant ORIGIN = "https://community.example";
    LearningResultsV4 records;
    address learner;
    address grader;

    function setUp() public {
        vm.warp(EPOCH + 86400);
        learner = vm.addr(21);
        grader = vm.addr(22);
        records = new LearningResultsV4(address(this), keccak256("community"), keccak256("publicity"), ORIGIN);
        records.setGrader(grader, 1, true);
        records.setGrader(grader, 2, true);
        _enroll();
    }

    function _signature(bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(21, digest);
        return abi.encodePacked(r, s, v);
    }

    bytes32 authorizationId;
    uint256 signIns;

    function _signIn(address who, uint64 issuedAt) private returns (LearningResultsV4.SignIn memory) {
        return LearningResultsV4.SignIn(who, keccak256(abi.encode("login", ++signIns)), issuedAt);
    }

    /// The EIP-191 personal-sign hash of a text, computed here independently.
    function _personal(bytes memory text) private pure returns (bytes32) {
        bytes memory length;
        for (uint256 n = text.length; n > 0; n /= 10) {
            length = abi.encodePacked(bytes1(uint8(48 + n % 10)), length);
        }
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n", length, text));
    }

    function _authorizeAt(uint64 issuedAt) private returns (bytes32 id) {
        LearningResultsV4.SignIn memory a = _signIn(learner, issuedAt);
        id = records.signInDigest(a);
        require(id == _personal(bytes(records.signInMessage(a))));
        records.authorize(a, _signature(id));
    }

    function _enroll() private {
        authorizationId = _authorizeAt(uint64(block.timestamp));
    }

    function _result() private view returns (LearningResultsV4.Result memory r) {
        bytes32 id = authorizationId;
        r.sessionId = keccak256("session");
        r.learner = learner;
        r.enrollmentId = id;
        r.song = LearningResultsV4.Song(6343, address(0xBEEF), records.communityId(), keccak256("post"));
        r.contentRevision = keccak256("manifest");
        r.exercisesHash = keccak256(hex"00010002");
        r.linesTotal = 2;
        r.activity = 1;
        r.grader = grader;
        r.scoringPolicy = keccak256("scoring");
        r.startedAt = uint64(block.timestamp);
        r.completedAt = uint64(block.timestamp);
        r.status = 1;
        r.revision = 1;
    }

    function _publish(LearningResultsV4.Result memory r) private {
        vm.prank(grader);
        records.publish(r, hex"0001011b580002050000");
    }

    function testOneTerminalCommitmentAndNoSecondPublication() public {
        LearningResultsV4.Result memory r = _result();
        _publish(r);
        require(records.commitments(r.sessionId) == records.commitmentOf(r, hex"0001011b580002050000"));
        vm.expectRevert(bytes("duplicate_or_revision"));
        _publish(r);
    }

    function testSignedRevocationCanBeSponsoredAndCannotReplay() public {
        uint64 nonce = records.nextNonce(learner);
        bytes memory signature = _signature(records.revocationDigest(learner, nonce));
        records.revoke(learner, nonce, signature);
        vm.expectRevert(bytes("stale_nonce"));
        records.revoke(learner, nonce, signature);
    }

    function testAbandonedTerminalKeepsAssessedAndUnattemptedOutcomes() public {
        LearningResultsV4.Result memory r = _result();
        r.status = 2;
        _publish(r);
        require(records.commitments(r.sessionId) != 0);
    }

    function testIncompleteAndReorderedOutcomesRefused() public {
        LearningResultsV4.Result memory r = _result();
        vm.expectRevert(bytes("invalid_coverage"));
        vm.prank(grader);
        records.publish(r, hex"0001011b58");
        vm.expectRevert(bytes("invalid_order"));
        vm.prank(grader);
        records.publish(r, hex"0002011b580001050000");
    }

    function testMissingMeasurementsCannotCarryNumericScores() public {
        LearningResultsV4.Result memory r = _result();
        vm.expectRevert(bytes("invalid_grade"));
        vm.prank(grader);
        records.publish(r, hex"0001011b580002040001");
    }

    function testWrongExerciseHashRefused() public {
        LearningResultsV4.Result memory r = _result();
        r.exercisesHash = keccak256("different");
        vm.expectRevert(bytes("wrong_exercises"));
        _publish(r);
    }

    function testCorrectionAfterRevocationPreservesContextAndRejectsStaleWriter() public {
        LearningResultsV4.Result memory r = _result();
        _publish(r);
        uint64 nonce = records.nextNonce(learner);
        vm.prank(learner);
        records.revoke(learner, nonce, "");
        vm.prank(grader);
        records.correct(r, hex"0001011b580002050000", hex"00010127100002050000", 2);
        vm.expectRevert(bytes("stale_result"));
        vm.prank(grader);
        records.correct(r, hex"0001011b580002050000", hex"00010100000002050000", 1);
    }

    function testControllerInvalidationCannotBeUndoneByGrader() public {
        LearningResultsV4.Result memory r = _result();
        _publish(r);
        bytes32 previous = records.commitments(r.sessionId);
        records.invalidate(r, hex"0001011b580002050000", keccak256("compromised"));
        r.revision = 2;
        r.supersedes = previous;
        r.status = 5;
        vm.expectRevert(bytes("not_corrector"));
        vm.prank(grader);
        records.correct(r, hex"0001011b580002050000", hex"00010127100002050000", 1);
    }

    function testLatePublicationKeepsOriginalPeriodAndPolicy() public {
        records.activatePolicy(1, keccak256("next"), "ipfs://policy", 2);
        LearningResultsV4.Result memory r = _result();
        vm.warp(EPOCH + 3 * 86400);
        _publish(r);
        require(records.periodOf(r.completedAt) == 1 && r.qualificationPolicy == 0);
    }

    function testFortyLineBundle() public {
        LearningResultsV4.Result memory r = _result();
        bytes memory outcomes;
        bytes memory ordinals;
        for (uint16 i = 1; i <= 40; ++i) {
            outcomes = bytes.concat(outcomes, abi.encodePacked(i, uint8(1), uint16(7000)));
            ordinals = bytes.concat(ordinals, abi.encodePacked(i));
        }
        r.linesTotal = 40;
        r.exercisesHash = keccak256(ordinals);
        vm.prank(grader);
        records.publish(r, outcomes);
        require(records.commitments(r.sessionId) != 0);
    }

    function _study() private view returns (LearningResultsV4.Result memory r) {
        r = _result();
        r.activity = 2;
        r.linesTotal = 4;
        r.exercisesHash = keccak256(hex"0003000100080005");
    }

    function _publishStudy(LearningResultsV4.Result memory r, bytes memory outcomes) private {
        vm.prank(grader);
        records.publish(r, outcomes);
    }

    function testStudyUsesNoncontiguousSourceOrdinalsInSelectionOrder() public {
        LearningResultsV4.Result memory r = _study();
        _publishStudy(r, hex"000301000102000801000501");
        require(records.commitments(r.sessionId) == records.commitmentOf(r, hex"000301000102000801000501"));
        require(records.VERSION() == 4);
    }

    function testStudyCoverageRejectsDuplicateChangedReorderedAndOmittedExercises() public {
        LearningResultsV4.Result memory r = _study();
        vm.expectRevert(bytes("duplicate_exercise"));
        _publishStudy(r, hex"000301000102000301000501");
        vm.expectRevert(bytes("wrong_exercises"));
        _publishStudy(r, hex"000101000302000801000501");
        vm.expectRevert(bytes("wrong_exercises"));
        _publishStudy(r, hex"000301000102000901000501");
        vm.expectRevert(bytes("invalid_coverage"));
        _publishStudy(r, hex"000301000102000801");
        vm.expectRevert(bytes("invalid_source_ordinal"));
        _publishStudy(r, hex"07d101000102000801000501");
        vm.expectRevert(bytes("invalid_source_ordinal"));
        _publishStudy(r, hex"000001000102000801000501");
    }

    function testStudyCompletedCannotHideMissingFirstPasses() public {
        LearningResultsV4.Result memory r = _study();
        vm.expectRevert(bytes("incomplete_study"));
        _publishStudy(r, hex"000301000102000801000505");
        vm.expectRevert(bytes("invalid_study_outcome"));
        _publishStudy(r, hex"000301000102000801000500");
        r.status = 2;
        _publishStudy(r, hex"000301000103000804000505");
        require(records.commitments(r.sessionId) != 0);
    }

    function testStudyCorrectionsCannotChangeSelectionAndKeepOriginalPeriod() public {
        LearningResultsV4.Result memory r = _study();
        _publishStudy(r, hex"000301000102000801000501");
        bytes32 original = records.commitments(r.sessionId);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(bytes("wrong_exercises"));
        vm.prank(grader);
        records.correct(r, hex"000301000102000801000501", hex"000301000101000901000501", 1);
        vm.prank(grader);
        records.correct(r, hex"000301000102000801000501", hex"000301000101000801000501", 1);
        r.revision = 2;
        r.supersedes = original;
        // The supplied old context (including original timestamps) is the only
        // context the contract can copy into the correction.
        require(records.periodOf(r.completedAt) == 1);
        require(records.commitments(r.sessionId) == records.commitmentOf(r, hex"000301000101000801000501"));
    }

    function testPoliciesAreIndependentByActivityAndProspective() public {
        records.activatePolicy(1, keccak256("karaoke"), "ipfs://karaoke", 2);
        records.activatePolicy(2, keccak256("study"), "ipfs://study", 2);
        require(records.policyFor(1, 2) == keccak256("karaoke"));
        require(records.policyFor(2, 2) == keccak256("study"));
        require(records.policyFor(2, 1) == 0);
        vm.expectRevert(bytes("activation_not_prospective"));
        records.activatePolicy(2, keccak256("retroactive"), "ipfs://bad", 1);
        vm.expectRevert(bytes("unsupported_activity"));
        records.activatePolicy(3, keccak256("unsupported"), "ipfs://bad", 2);
        vm.warp(EPOCH + 2 days);
        LearningResultsV4.Result memory r = _study();
        r.qualificationPolicy = keccak256("karaoke");
        vm.expectRevert(bytes("wrong_policy"));
        _publishStudy(r, hex"000301000102000801000501");
        r.qualificationPolicy = keccak256("study");
        _publishStudy(r, hex"000301000102000801000501");
    }

    function testWrongSourceCommunityCannotPublish() public {
        LearningResultsV4.Result memory r = _study();
        r.song.communityId = keccak256("another community");
        vm.expectRevert(bytes("invalid_context"));
        _publishStudy(r, hex"000301000102000801000501");
    }

    function testFuzzStudyCountAndFullOrderedBinding(uint8 countSeed, uint16 sourceSeed, uint16 answers) public {
        uint16 count = 4 + uint16(countSeed % 7);
        bytes memory ordinals;
        bytes memory outcomes;
        for (uint16 i; i < count; ++i) {
            uint16 ordinal = uint16((uint256(sourceSeed) + uint256(i) * 101) % 2000 + 1);
            ordinals = bytes.concat(ordinals, abi.encodePacked(ordinal));
            outcomes = bytes.concat(outcomes, abi.encodePacked(ordinal, uint8(1 + ((answers >> i) & 1))));
        }
        LearningResultsV4.Result memory r = _study();
        r.linesTotal = count;
        r.exercisesHash = keccak256(ordinals);
        _publishStudy(r, outcomes);
        require(records.commitments(r.sessionId) == records.commitmentOf(r, outcomes));
    }

    // ---- V4 permission: one sign-in, no expiry, unbroken since the start ----

    function _revoke() private {
        uint64 nonce = records.nextNonce(learner);
        vm.prank(learner);
        records.revoke(learner, nonce, "");
    }

    function testLaterSignInNeverStrandsALessonStartedEarlier() public {
        LearningResultsV4.Result memory r = _result();
        vm.warp(block.timestamp + 2 hours);
        bytes32 later = _authorizeAt(uint64(block.timestamp));
        require(later != authorizationId);
        require(records.authorizedSince(learner) == r.startedAt);
        _publish(r);
    }

    function testPermissionHasNoExpiry() public {
        LearningResultsV4.Result memory r = _result();
        vm.warp(block.timestamp + 400 days);
        _publish(r);
    }

    function testOutOfOrderRelayKeepsEarliestStart() public {
        _revoke();
        vm.warp(block.timestamp + 1 hours);
        uint64 first = uint64(block.timestamp);
        LearningResultsV4.SignIn memory early = _signIn(learner, first);
        bytes memory earlySignature = _signature(records.signInDigest(early));
        vm.warp(block.timestamp + 1 hours);
        bytes32 later = _authorizeAt(uint64(block.timestamp));
        require(records.authorizedSince(learner) == block.timestamp);
        records.authorize(early, earlySignature);
        require(records.authorizedSince(learner) == first);
        LearningResultsV4.Result memory r = _result();
        r.enrollmentId = records.signInDigest(early);
        r.startedAt = first;
        _publish(r);
        require(later != r.enrollmentId);
    }

    function testWithdrawalStopsPendingAndALaterSignInCannotRevivePreWithdrawalWork() public {
        LearningResultsV4.Result memory r = _result();
        _revoke();
        vm.expectRevert(bytes("authorization_inactive"));
        _publish(r);
        vm.warp(block.timestamp + 1);
        _enroll();
        // The lesson started before the withdrawal; permission now starts later.
        vm.expectRevert(bytes("authorization_inactive"));
        _publish(r);
        r.enrollmentId = authorizationId;
        vm.expectRevert(bytes("authorization_inactive"));
        _publish(r);
        LearningResultsV4.Result memory fresh = _result();
        fresh.sessionId = keccak256("after");
        _publish(fresh);
    }

    function testStudyWithdrawalAndRenewalCannotRevivePendingResult() public {
        LearningResultsV4.Result memory r = _study();
        _revoke();
        vm.warp(block.timestamp + 1);
        _enroll();
        vm.expectRevert(bytes("authorization_inactive"));
        _publishStudy(r, hex"000301000102000801000501");
    }

    function testSignInMadeAtOrBeforeWithdrawalCannotRestorePermission() public {
        LearningResultsV4.SignIn memory a = _signIn(learner, uint64(block.timestamp));
        bytes memory signature = _signature(records.signInDigest(a));
        _revoke();
        vm.expectRevert(bytes("revoked_sign_in"));
        records.authorize(a, signature);
        require(records.authorizedSince(learner) == 0);
    }

    function testSignInCannotBeReplayedOrRelayedLate() public {
        LearningResultsV4.SignIn memory a = _signIn(learner, uint64(block.timestamp));
        bytes memory signature = _signature(records.signInDigest(a));
        records.authorize(a, signature);
        vm.expectRevert(bytes("replayed_sign_in"));
        records.authorize(a, signature);
        a = _signIn(learner, uint64(block.timestamp));
        signature = _signature(records.signInDigest(a));
        vm.warp(block.timestamp + 30 days + 1);
        vm.expectRevert(bytes("stale_sign_in"));
        records.authorize(a, signature);
        a = _signIn(learner, uint64(block.timestamp + 1));
        signature = _signature(records.signInDigest(a));
        vm.expectRevert(bytes("stale_sign_in"));
        records.authorize(a, signature);
    }

    function testSameTextSignedTwiceIsOneAuthorization() public {
        // The id covers learner, nonce and time: a second relay of the same
        // sign-in, with a fresh signature, is still a replay.
        LearningResultsV4.SignIn memory a = _signIn(learner, uint64(block.timestamp));
        bytes32 id = records.signInDigest(a);
        records.authorize(a, _signature(id));
        (uint8 v, bytes32 r, bytes32 sv) = vm.sign(21, id);
        vm.expectRevert(bytes("replayed_sign_in"));
        records.authorize(a, abi.encodePacked(r, sv, v));
        // The same second with another nonce is a different sign-in.
        LearningResultsV4.SignIn memory b = _signIn(learner, uint64(block.timestamp));
        require(records.signInDigest(b) != id);
        records.authorize(b, _signature(records.signInDigest(b)));
    }

    function testFutureSignInRefusedAndNotBeforeIsIssuedAt() public {
        LearningResultsV4.SignIn memory a = _signIn(learner, uint64(block.timestamp + 1));
        bytes memory signature = _signature(records.signInDigest(a));
        vm.expectRevert(bytes("stale_sign_in"));
        records.authorize(a, signature);
        vm.warp(block.timestamp + 1);
        records.authorize(a, signature);
        require(records.authorizationIssuedAt(records.signInDigest(a)) == block.timestamp);
    }

    function testSignInBeforeAWithdrawalNeverRestoresAndTheNextSecondDoes() public {
        uint64 before = uint64(block.timestamp);
        LearningResultsV4.SignIn memory early = _signIn(learner, before);
        bytes memory earlySignature = _signature(records.signInDigest(early));
        vm.warp(block.timestamp + 10);
        _revoke();
        uint64 withdrawn = records.revokedAt(learner);
        LearningResultsV4.SignIn memory at = _signIn(learner, withdrawn);
        bytes memory atSignature = _signature(records.signInDigest(at));
        vm.expectRevert(bytes("revoked_sign_in"));
        records.authorize(early, earlySignature);
        vm.expectRevert(bytes("revoked_sign_in"));
        records.authorize(at, atSignature);
        vm.warp(block.timestamp + 1);
        LearningResultsV4.SignIn memory next = _signIn(learner, withdrawn + 1);
        records.authorize(next, _signature(records.signInDigest(next)));
        require(records.authorizedSince(learner) == withdrawn + 1);
        require(records.revokedAt(learner) == withdrawn);
    }

    function testRelayWindowIsTheThirtyDaySession() public {
        require(records.RELAY_WINDOW() == 30 days);
        // A sign-in first relayed at the learner's first practice, late in
        // the thirty-day session, is still accepted.
        LearningResultsV4.SignIn memory a = _signIn(learner, uint64(block.timestamp));
        bytes memory signature = _signature(records.signInDigest(a));
        vm.warp(block.timestamp + 30 days);
        records.authorize(a, signature);
        require(records.authorizationLearner(records.signInDigest(a)) == learner);
    }

    function testLiveLearnerCannotPublishUnderAnotherLearnersAuthorization() public {
        // A second learner signs in at the same time, so their permission is
        // live and every time rule of the first learner's authorization holds.
        address other = vm.addr(23);
        LearningResultsV4.SignIn memory a = _signIn(other, uint64(block.timestamp));
        (uint8 v, bytes32 rs, bytes32 ss) = vm.sign(23, records.signInDigest(a));
        records.authorize(a, abi.encodePacked(rs, ss, v));
        require(records.authorizedSince(other) == records.authorizationIssuedAt(authorizationId));
        LearningResultsV4.Result memory r = _result();
        r.learner = other;
        // Only authorizationLearner[r.enrollmentId] == r.learner refuses this.
        vm.expectRevert(bytes("authorization_inactive"));
        _publish(r);
        r.enrollmentId = records.signInDigest(a);
        _publish(r);
    }

    function testOnlyTheLearnersOwnSignatureAuthorizes() public {
        address other = vm.addr(23);
        LearningResultsV4.SignIn memory a = _signIn(other, uint64(block.timestamp));
        bytes memory signature = _signature(records.signInDigest(a));
        vm.expectRevert(bytes("invalid_consent"));
        records.authorize(a, signature);
        // A result naming someone else's authorization cannot publish.
        LearningResultsV4.Result memory r = _result();
        r.learner = other;
        vm.expectRevert(bytes("authorization_inactive"));
        _publish(r);
        r = _result();
        r.enrollmentId = keccak256("unknown");
        vm.expectRevert(bytes("authorization_inactive"));
        _publish(r);
    }

    /// A text signed for one deployment authorizes nowhere else: each of
    /// these differs from `records` in exactly one rendered field.
    function testWrongContractChainCommunityPolicyAndHostRefused() public {
        LearningResultsV4.SignIn memory a = _signIn(learner, uint64(block.timestamp));
        bytes memory signature = _signature(records.signInDigest(a));
        LearningResultsV4[4] memory others = [
            new LearningResultsV4(address(this), records.communityId(), records.publicityPolicy(), ORIGIN),
            new LearningResultsV4(address(this), keccak256("elsewhere"), records.publicityPolicy(), ORIGIN),
            new LearningResultsV4(address(this), records.communityId(), keccak256("old policy"), ORIGIN),
            new LearningResultsV4(address(this), records.communityId(), records.publicityPolicy(), "https://phish.example")
        ];
        for (uint256 i; i < others.length; ++i) {
            require(others[i].signInDigest(a) != records.signInDigest(a));
            vm.expectRevert(bytes("invalid_consent"));
            others[i].authorize(a, signature);
        }
        // The same contract on another chain renders another Chain ID and
        // eip155 resource.
        vm.chainId(6343);
        vm.expectRevert(bytes("invalid_consent"));
        records.authorize(a, signature);
        vm.chainId(31337);
        records.authorize(a, signature);
    }

    function testAuthorizedNamesTheCommunityOrigin() public {
        LearningResultsV4.SignIn memory a = _signIn(learner, uint64(block.timestamp));
        bytes32 id = records.signInDigest(a);
        vm.expectEmit(true, true, false, true);
        emit LearningResultsV4.Authorized(learner, id, ORIGIN, a.issuedAt, records.authorizedSince(learner));
        records.authorize(a, _signature(id));
        require(keccak256(bytes(records.communityOrigin())) == keccak256(bytes(ORIGIN)));
    }

    function testOldTypedSignInAndPlainLoginCannotAuthorize() public {
        LearningResultsV4.SignIn memory a = _signIn(learner, uint64(block.timestamp));
        // The former EIP-712 SignIn, under this contract's own domain.
        bytes32 typed = keccak256(
            abi.encodePacked(
                "\x19\x01",
                records.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256(
                            "SignIn(address learner,bytes32 communityId,string origin,bytes32 publicationPolicy,bytes32 nonce,uint64 issuedAt,uint64 expiresAt)"
                        ),
                        a.learner,
                        records.communityId(),
                        keccak256(bytes(ORIGIN)),
                        records.publicityPolicy(),
                        a.nonce,
                        a.issuedAt,
                        a.issuedAt + 300
                    )
                )
            )
        );
        vm.expectRevert(bytes("invalid_consent"));
        records.authorize(a, _signature(typed));
        // The deployed plain SIWE login for this learner and community.
        (address who, string memory login) = SignInVectorsV4.plainLogin();
        require(who == learner);
        vm.expectRevert(bytes("invalid_consent"));
        records.authorize(a, _signature(_personal(bytes(login))));
        // Signing the digest itself, rather than the text, is not the text.
        bytes memory overDigest = _signature(_personal(abi.encodePacked(records.signInDigest(a))));
        vm.expectRevert(bytes("invalid_consent"));
        records.authorize(a, overDigest);
        records.authorize(a, _signature(records.signInDigest(a)));
    }

    function testV3EnrollmentAndPersonalSignLoginCannotAuthorize() public {
        LearningResultsV4.SignIn memory a = _signIn(learner, uint64(block.timestamp));
        bytes32 v3Domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Pirate Learning Results"),
                keccak256("3"),
                block.chainid,
                address(records)
            )
        );
        bytes32 inner = keccak256(
            abi.encode(
                keccak256(
                    "SignIn(address learner,bytes32 communityId,string origin,bytes32 publicationPolicy,bytes32 nonce,uint64 issuedAt,uint64 expiresAt)"
                ),
                a.learner,
                records.communityId(),
                keccak256(bytes(ORIGIN)),
                records.publicityPolicy(),
                a.nonce,
                a.issuedAt,
                a.issuedAt + 300
            )
        );
        bytes memory v3Signature = _signature(keccak256(abi.encodePacked("\x19\x01", v3Domain, inner)));
        vm.expectRevert(bytes("invalid_consent"));
        records.authorize(a, v3Signature);
        bytes32 personal = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", records.signInDigest(a)));
        bytes memory personalSignature = _signature(personal);
        vm.expectRevert(bytes("invalid_consent"));
        records.authorize(a, personalSignature);
    }

    function testSmartAccountSignIn() public {
        ResultsWalletV4 wallet = new ResultsWalletV4();
        LearningResultsV4.SignIn memory a = _signIn(address(wallet), uint64(block.timestamp));
        wallet.approve(records.signInDigest(a));
        records.authorize(a, hex"0102");
        require(records.authorizedSince(address(wallet)) == block.timestamp);
    }

    /// An IthacaAccount-style account signs the ERC1271Sign wrapper of the
    /// EIP-191 digest; the contract passes it the digest itself.
    function testReplaySafeAccountSignIn() public {
        ReplaySafeAccount account = new ReplaySafeAccount(vm.addr(24));
        ReplaySafeAccount sibling = new ReplaySafeAccount(vm.addr(24));
        LearningResultsV4.SignIn memory a = _signIn(address(account), uint64(block.timestamp));
        bytes32 id = records.signInDigest(a);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(24, id);
        vm.expectRevert(bytes("invalid_consent"));
        records.authorize(a, abi.encodePacked(r, s, v));
        // The same key's wrapper for another account is bound to that account.
        (v, r, s) = vm.sign(24, sibling.wrapped(id));
        vm.expectRevert(bytes("invalid_consent"));
        records.authorize(a, abi.encodePacked(r, s, v));
        (v, r, s) = vm.sign(24, account.wrapped(id));
        records.authorize(a, abi.encodePacked(r, s, v));
        require(records.authorizationLearner(id) == address(account));
        require(records.authorizedSince(address(account)) == block.timestamp);
    }

    /// Informative bounds; `forge test --gas-report` gives the exact figures.
    function testGasAuthorizeEoa() public {
        LearningResultsV4.SignIn memory a = _signIn(learner, uint64(block.timestamp));
        bytes memory signature = _signature(records.signInDigest(a));
        uint256 start = gasleft();
        records.authorize(a, signature);
        require(start - gasleft() < 250000, "authorize_gas");
    }

    function testGasAuthorizeReplaySafeAccount() public {
        ReplaySafeAccount account = new ReplaySafeAccount(vm.addr(24));
        LearningResultsV4.SignIn memory a = _signIn(address(account), uint64(block.timestamp));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(24, account.wrapped(records.signInDigest(a)));
        bytes memory signature = abi.encodePacked(r, s, v);
        uint256 start = gasleft();
        records.authorize(a, signature);
        require(start - gasleft() < 260000, "authorize_gas");
    }

    function testCannotPublishBeforePermissionOrInFuture() public {
        LearningResultsV4.Result memory r = _result();
        r.startedAt--;
        vm.expectRevert(bytes("authorization_inactive"));
        _publish(r);
        r = _result();
        r.completedAt++;
        vm.expectRevert(bytes("invalid_time"));
        _publish(r);
    }
}
