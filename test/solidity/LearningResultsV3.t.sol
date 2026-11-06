// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import "../../contracts/LearningResultsV3.sol";

interface ResultsVmV3 {
    function warp(uint256) external;
    function addr(uint256) external returns (address);
    function prank(address) external;
    function expectRevert(bytes calldata) external;
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
}

contract ResultsWalletV3 {
    bytes32 public digest;

    function approve(bytes32 value) external {
        digest = value;
    }

    function isValidSignature(bytes32 value, bytes calldata) external view returns (bytes4) {
        return value == digest ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract LearningResultsV3Test {
    ResultsVmV3 constant vm = ResultsVmV3(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant EPOCH = 1793552400;
    LearningResultsV3 records;
    address learner;
    address grader;

    function setUp() public {
        vm.warp(EPOCH + 86400);
        learner = vm.addr(21);
        grader = vm.addr(22);
        records = new LearningResultsV3(address(this), keccak256("community"), keccak256("publicity"));
        records.setGrader(grader, 1, true);
        records.setGrader(grader, 2, true);
        _enroll();
    }

    function _signature(bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(21, digest);
        return abi.encodePacked(r, s, v);
    }

    function _enrollment() private view returns (LearningResultsV3.Enrollment memory) {
        return LearningResultsV3.Enrollment(
            learner,
            records.communityId(),
            3,
            records.publicityPolicy(),
            uint64(block.timestamp + 30 days),
            records.nextNonce(learner)
        );
    }

    function _enroll() private {
        LearningResultsV3.Enrollment memory e = _enrollment();
        records.enroll(e, _signature(records.enrollmentDigest(e)));
    }

    function _result() private view returns (LearningResultsV3.Result memory r) {
        (bytes32 id,,,) = records.enrollments(learner);
        r.sessionId = keccak256("session");
        r.learner = learner;
        r.enrollmentId = id;
        r.song = LearningResultsV3.Song(6343, address(0xBEEF), records.communityId(), keccak256("post"));
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

    function _publish(LearningResultsV3.Result memory r) private {
        vm.prank(grader);
        records.publish(r, hex"0001011b580002050000");
    }

    function testOneTerminalCommitmentAndNoSecondPublication() public {
        LearningResultsV3.Result memory r = _result();
        _publish(r);
        require(records.commitments(r.sessionId) == records.commitmentOf(r, hex"0001011b580002050000"));
        vm.expectRevert(bytes("duplicate_or_revision"));
        _publish(r);
    }

    function testRevocationStopsPendingAndRenewalDoesNotReviveItsGrant() public {
        LearningResultsV3.Result memory r = _result();
        uint64 nonce = records.nextNonce(learner);
        vm.prank(learner);
        records.revoke(learner, nonce, "");
        vm.expectRevert(bytes("enrollment_inactive"));
        _publish(r);
        _enroll();
        vm.expectRevert(bytes("enrollment_inactive"));
        _publish(r);
    }

    function testEnrollmentSignatureCannotBeReplayed() public {
        LearningResultsV3.Enrollment memory e = _enrollment();
        bytes memory signature = _signature(records.enrollmentDigest(e));
        records.enroll(e, signature);
        vm.expectRevert(bytes("stale_nonce"));
        records.enroll(e, signature);
    }

    function testSignedRevocationCanBeSponsoredAndCannotReplay() public {
        uint64 nonce = records.nextNonce(learner);
        bytes memory signature = _signature(records.revocationDigest(learner, nonce));
        records.revoke(learner, nonce, signature);
        vm.expectRevert(bytes("stale_nonce"));
        records.revoke(learner, nonce, signature);
    }

    function testSmartAccountEnrollment() public {
        ResultsWalletV3 wallet = new ResultsWalletV3();
        LearningResultsV3.Enrollment memory e = _enrollment();
        e.learner = address(wallet);
        e.nonce = 0;
        wallet.approve(records.enrollmentDigest(e));
        records.enroll(e, hex"0102");
        (bytes32 id,,,) = records.enrollments(address(wallet));
        require(id != 0);
    }

    function testWrongContractAndCommunityRefused() public {
        LearningResultsV3.Enrollment memory e = _enrollment();
        bytes memory signature = _signature(records.enrollmentDigest(e));
        LearningResultsV3 other = new LearningResultsV3(address(this), records.communityId(), records.publicityPolicy());
        e.nonce = 0;
        vm.expectRevert(bytes("invalid_consent"));
        other.enroll(e, signature);
        e = _enrollment();
        e.communityId = keccak256("other");
        vm.expectRevert(bytes("invalid_enrollment"));
        records.enroll(e, signature);
    }

    function testExpiredEnrollmentRefused() public {
        LearningResultsV3.Result memory r = _result();
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(bytes("enrollment_inactive"));
        _publish(r);
    }

    function testAbandonedTerminalKeepsAssessedAndUnattemptedOutcomes() public {
        LearningResultsV3.Result memory r = _result();
        r.status = 2;
        _publish(r);
        require(records.commitments(r.sessionId) != 0);
    }

    function testIncompleteAndReorderedOutcomesRefused() public {
        LearningResultsV3.Result memory r = _result();
        vm.expectRevert(bytes("invalid_coverage"));
        vm.prank(grader);
        records.publish(r, hex"0001011b58");
        vm.expectRevert(bytes("invalid_order"));
        vm.prank(grader);
        records.publish(r, hex"0002011b580001050000");
    }

    function testMissingMeasurementsCannotCarryNumericScores() public {
        LearningResultsV3.Result memory r = _result();
        vm.expectRevert(bytes("invalid_grade"));
        vm.prank(grader);
        records.publish(r, hex"0001011b580002040001");
    }

    function testWrongExerciseHashRefused() public {
        LearningResultsV3.Result memory r = _result();
        r.exercisesHash = keccak256("different");
        vm.expectRevert(bytes("wrong_exercises"));
        _publish(r);
    }

    function testCannotPublishBeforeEnrollmentOrInFuture() public {
        LearningResultsV3.Result memory r = _result();
        r.startedAt--;
        vm.expectRevert(bytes("invalid_time"));
        _publish(r);
        r = _result();
        r.completedAt++;
        vm.expectRevert(bytes("invalid_time"));
        _publish(r);
    }

    function testCorrectionAfterRevocationPreservesContextAndRejectsStaleWriter() public {
        LearningResultsV3.Result memory r = _result();
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
        LearningResultsV3.Result memory r = _result();
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
        LearningResultsV3.Result memory r = _result();
        vm.warp(EPOCH + 3 * 86400);
        _publish(r);
        require(records.periodOf(r.completedAt) == 1 && r.qualificationPolicy == 0);
    }

    function testFortyLineBundle() public {
        LearningResultsV3.Result memory r = _result();
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

    function _study() private view returns (LearningResultsV3.Result memory r) {
        r = _result();
        r.activity = 2;
        r.linesTotal = 4;
        r.exercisesHash = keccak256(hex"0003000100080005");
    }

    function _publishStudy(LearningResultsV3.Result memory r, bytes memory outcomes) private {
        vm.prank(grader);
        records.publish(r, outcomes);
    }

    function testStudyUsesNoncontiguousSourceOrdinalsInSelectionOrder() public {
        LearningResultsV3.Result memory r = _study();
        _publishStudy(r, hex"000301000102000801000501");
        require(records.commitments(r.sessionId) == records.commitmentOf(r, hex"000301000102000801000501"));
        require(records.VERSION() == 3);
    }

    function testStudyCoverageRejectsDuplicateChangedReorderedAndOmittedExercises() public {
        LearningResultsV3.Result memory r = _study();
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
        LearningResultsV3.Result memory r = _study();
        vm.expectRevert(bytes("incomplete_study"));
        _publishStudy(r, hex"000301000102000801000505");
        vm.expectRevert(bytes("invalid_study_outcome"));
        _publishStudy(r, hex"000301000102000801000500");
        r.status = 2;
        _publishStudy(r, hex"000301000103000804000505");
        require(records.commitments(r.sessionId) != 0);
    }

    function testStudyCorrectionsCannotChangeSelectionAndKeepOriginalPeriod() public {
        LearningResultsV3.Result memory r = _study();
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
        LearningResultsV3.Result memory r = _study();
        r.qualificationPolicy = keccak256("karaoke");
        vm.expectRevert(bytes("wrong_policy"));
        _publishStudy(r, hex"000301000102000801000501");
        r.qualificationPolicy = keccak256("study");
        _publishStudy(r, hex"000301000102000801000501");
    }

    function testEnrollmentMasksDoNotGrantAnotherActivity() public {
        LearningResultsV3.Enrollment memory e = _enrollment();
        e.activities = 2;
        records.enroll(e, _signature(records.enrollmentDigest(e)));
        LearningResultsV3.Result memory r = _result();
        vm.expectRevert(bytes("unsupported_activity"));
        _publish(r);
        _publishStudy(_study(), hex"000301000102000801000501");
        e = _enrollment();
        e.activities = 4;
        bytes memory signature = _signature(records.enrollmentDigest(e));
        vm.expectRevert(bytes("invalid_scope"));
        records.enroll(e, signature);
        e.activities = 0;
        signature = _signature(records.enrollmentDigest(e));
        vm.expectRevert(bytes("invalid_scope"));
        records.enroll(e, signature);
    }

    function testVersionTwoSignatureCannotAuthorizeVersionThree() public {
        LearningResultsV3.Enrollment memory e = _enrollment();
        bytes32 oldDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Pirate Learning Results"),
                keccak256("2"),
                block.chainid,
                address(records)
            )
        );
        bytes32 oldDigest =
            keccak256(abi.encodePacked("\x19\x01", oldDomain, keccak256(abi.encode(records.ENROLLMENT_TYPEHASH(), e))));
        bytes memory signature = _signature(oldDigest);
        vm.expectRevert(bytes("invalid_consent"));
        records.enroll(e, signature);
    }

    function testStudyRevocationAndRenewalCannotRevivePendingGrant() public {
        LearningResultsV3.Result memory r = _study();
        uint64 nonce = records.nextNonce(learner);
        vm.prank(learner);
        records.revoke(learner, nonce, "");
        _enroll();
        vm.expectRevert(bytes("enrollment_inactive"));
        _publishStudy(r, hex"000301000102000801000501");
    }

    function testWrongSourceCommunityCannotPublish() public {
        LearningResultsV3.Result memory r = _study();
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
        LearningResultsV3.Result memory r = _study();
        r.linesTotal = count;
        r.exercisesHash = keccak256(ordinals);
        _publishStudy(r, outcomes);
        require(records.commitments(r.sessionId) == records.commitmentOf(r, outcomes));
    }
}
