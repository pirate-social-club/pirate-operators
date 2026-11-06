// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import "../../contracts/LearningResultsV2.sol";

interface ResultsVm {
    function warp(uint256) external;
    function addr(uint256) external returns (address);
    function prank(address) external;
    function expectRevert(bytes calldata) external;
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
}
contract ResultsWallet {
    bytes32 public digest;
    function approve(bytes32 value) external { digest = value; }
    function isValidSignature(bytes32 value, bytes calldata) external view returns (bytes4) {
        return value == digest ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
contract LearningResultsV2Test {
    ResultsVm constant vm = ResultsVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant EPOCH = 1793552400;
    LearningResultsV2 records;
    address learner;
    address grader;
    function setUp() public {
        vm.warp(EPOCH + 86400);
        learner = vm.addr(21);
        grader = vm.addr(22);
        records = new LearningResultsV2(address(this), keccak256("community"), keccak256("publicity"));
        records.setGrader(grader, 1, true);
        _enroll();
    }
    function _signature(bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(21, digest);
        return abi.encodePacked(r, s, v);
    }
    function _enrollment() private view returns (LearningResultsV2.Enrollment memory) {
        return LearningResultsV2.Enrollment(learner, records.communityId(), 1, records.publicityPolicy(),
            uint64(block.timestamp + 30 days), records.nextNonce(learner));
    }
    function _enroll() private {
        LearningResultsV2.Enrollment memory e = _enrollment();
        records.enroll(e, _signature(records.enrollmentDigest(e)));
    }
    function _result() private view returns (LearningResultsV2.Result memory r) {
        (bytes32 id,,,) = records.enrollments(learner);
        r.sessionId = keccak256("session"); r.learner = learner; r.enrollmentId = id;
        r.song = LearningResultsV2.Song(6343, address(0xBEEF), keccak256("source"), keccak256("post"));
        r.contentRevision = keccak256("manifest"); r.exercisesHash = keccak256(hex"00010002");
        r.linesTotal = 2; r.activity = 1; r.grader = grader; r.scoringPolicy = keccak256("scoring");
        r.startedAt = uint64(block.timestamp); r.completedAt = uint64(block.timestamp);
        r.status = 1; r.revision = 1;
    }
    function _publish(LearningResultsV2.Result memory r) private {
        vm.prank(grader); records.publish(r, hex"0001011b580002050000");
    }
    function testOneTerminalCommitmentAndNoSecondPublication() public {
        LearningResultsV2.Result memory r = _result(); _publish(r);
        require(records.commitments(r.sessionId) == records.commitmentOf(r, hex"0001011b580002050000"));
        vm.expectRevert(bytes("duplicate_or_revision")); _publish(r);
    }
    function testRevocationStopsPendingAndRenewalDoesNotReviveItsGrant() public {
        LearningResultsV2.Result memory r = _result();
        uint64 nonce = records.nextNonce(learner); vm.prank(learner); records.revoke(learner, nonce, "");
        vm.expectRevert(bytes("enrollment_inactive")); _publish(r);
        _enroll(); vm.expectRevert(bytes("enrollment_inactive")); _publish(r);
    }
    function testEnrollmentSignatureCannotBeReplayed() public {
        LearningResultsV2.Enrollment memory e = _enrollment();
        bytes memory signature = _signature(records.enrollmentDigest(e)); records.enroll(e, signature);
        vm.expectRevert(bytes("stale_nonce")); records.enroll(e, signature);
    }
    function testSignedRevocationCanBeSponsoredAndCannotReplay() public {
        uint64 nonce = records.nextNonce(learner);
        bytes memory signature = _signature(records.revocationDigest(learner, nonce));
        records.revoke(learner, nonce, signature);
        vm.expectRevert(bytes("stale_nonce")); records.revoke(learner, nonce, signature);
    }
    function testSmartAccountEnrollment() public {
        ResultsWallet wallet = new ResultsWallet();
        LearningResultsV2.Enrollment memory e = _enrollment(); e.learner = address(wallet); e.nonce = 0;
        wallet.approve(records.enrollmentDigest(e)); records.enroll(e, hex"0102");
        (bytes32 id,,,) = records.enrollments(address(wallet)); require(id != 0);
    }
    function testWrongContractAndCommunityRefused() public {
        LearningResultsV2.Enrollment memory e = _enrollment();
        bytes memory signature = _signature(records.enrollmentDigest(e));
        LearningResultsV2 other = new LearningResultsV2(address(this), records.communityId(), records.publicityPolicy());
        e.nonce = 0; vm.expectRevert(bytes("invalid_consent")); other.enroll(e, signature);
        e = _enrollment(); e.communityId = keccak256("other");
        vm.expectRevert(bytes("invalid_enrollment")); records.enroll(e, signature);
    }
    function testExpiredEnrollmentRefused() public {
        LearningResultsV2.Result memory r = _result(); vm.warp(block.timestamp + 30 days);
        vm.expectRevert(bytes("enrollment_inactive")); _publish(r);
    }
    function testAbandonedTerminalKeepsAssessedAndUnattemptedOutcomes() public {
        LearningResultsV2.Result memory r = _result(); r.status = 2; _publish(r);
        require(records.commitments(r.sessionId) != 0);
    }
    function testIncompleteAndReorderedOutcomesRefused() public {
        LearningResultsV2.Result memory r = _result();
        vm.expectRevert(bytes("invalid_coverage")); vm.prank(grader); records.publish(r, hex"0001011b58");
        vm.expectRevert(bytes("invalid_order")); vm.prank(grader); records.publish(r, hex"0002011b580001050000");
    }
    function testMissingMeasurementsCannotCarryNumericScores() public {
        LearningResultsV2.Result memory r = _result();
        vm.expectRevert(bytes("invalid_grade")); vm.prank(grader); records.publish(r, hex"0001011b580002040001");
    }
    function testWrongExerciseHashRefused() public {
        LearningResultsV2.Result memory r = _result(); r.exercisesHash = keccak256("different");
        vm.expectRevert(bytes("wrong_exercises")); _publish(r);
    }
    function testCannotPublishBeforeEnrollmentOrInFuture() public {
        LearningResultsV2.Result memory r = _result(); r.startedAt--;
        vm.expectRevert(bytes("invalid_time")); _publish(r);
        r = _result(); r.completedAt++;
        vm.expectRevert(bytes("invalid_time")); _publish(r);
    }
    function testCorrectionAfterRevocationPreservesContextAndRejectsStaleWriter() public {
        LearningResultsV2.Result memory r = _result(); _publish(r);
        uint64 nonce = records.nextNonce(learner); vm.prank(learner); records.revoke(learner, nonce, "");
        vm.prank(grader); records.correct(r, hex"0001011b580002050000", hex"00010127100002050000", 2);
        vm.expectRevert(bytes("stale_result")); vm.prank(grader);
        records.correct(r, hex"0001011b580002050000", hex"00010100000002050000", 1);
    }
    function testControllerInvalidationCannotBeUndoneByGrader() public {
        LearningResultsV2.Result memory r = _result(); _publish(r);
        bytes32 previous = records.commitments(r.sessionId);
        records.invalidate(r, hex"0001011b580002050000", keccak256("compromised"));
        r.revision = 2; r.supersedes = previous; r.status = 5;
        vm.expectRevert(bytes("not_corrector")); vm.prank(grader);
        records.correct(r, hex"0001011b580002050000", hex"00010127100002050000", 1);
    }
    function testLatePublicationKeepsOriginalPeriodAndPolicy() public {
        records.activatePolicy(keccak256("next"), "ipfs://policy", 2);
        LearningResultsV2.Result memory r = _result(); vm.warp(EPOCH + 3 * 86400); _publish(r);
        require(records.periodOf(r.completedAt) == 1 && r.qualificationPolicy == 0);
    }
    function testFortyLineBundle() public {
        LearningResultsV2.Result memory r = _result();
        bytes memory outcomes; bytes memory ordinals;
        for (uint16 i = 1; i <= 40; ++i) {
            outcomes = bytes.concat(outcomes, abi.encodePacked(i, uint8(1), uint16(7000)));
            ordinals = bytes.concat(ordinals, abi.encodePacked(i));
        }
        r.linesTotal = 40; r.exercisesHash = keccak256(ordinals);
        vm.prank(grader); records.publish(r, outcomes);
        require(records.commitments(r.sessionId) != 0);
    }
}
