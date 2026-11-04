// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import "../../contracts/LearningRecords.sol";

interface RecordsVm {
    function warp(uint256) external;
    function addr(uint256) external returns (address);
    function prank(address) external;
    function expectRevert(bytes calldata) external;
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
}

/// @dev A contract wallet that accepts exactly one approved digest.
contract SmartWallet {
    bytes32 public approved;

    function approve(bytes32 digest) external {
        approved = digest;
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return digest == approved ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract LearningRecordsTest {
    RecordsVm constant vm = RecordsVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant LEARNER_KEY = 21;
    bytes32 constant KARAOKE = keccak256("karaoke");
    uint256 constant EPOCH = 1793552400;
    LearningRecords records;
    address grader;
    address learner;
    bytes32[4] leaves;
    bytes32 root;
    LearningRecords.SongKey song;

    function setUp() public {
        vm.warp(EPOCH + 2 * 86400 + 3600); // inside period 2
        records = new LearningRecords(address(this));
        grader = vm.addr(12);
        learner = vm.addr(LEARNER_KEY);
        records.setGrader(grader, KARAOKE, true);
        for (uint256 i = 0; i < 4; i++)
            leaves[i] = keccak256(abi.encode(i + 1, keccak256(bytes(string.concat("line-0", _digit(i + 1)))), uint256(1)));
        root = _pair(_pair(leaves[0], leaves[1]), _pair(leaves[2], leaves[3]));
        song = LearningRecords.SongKey({ chainId: 6343, posts: address(0xBEEF), communityId: keccak256("c"), postId: keccak256("p") });
    }

    function _digit(uint256 n) internal pure returns (string memory) {
        return string(abi.encodePacked(bytes1(uint8(48 + n))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = leaves[i ^ 1];
        p[1] = i < 2 ? _pair(leaves[2], leaves[3]) : _pair(leaves[0], leaves[1]);
    }

    function _consent(bytes32 attemptId, address who) internal view returns (LearningRecords.Consent memory) {
        return LearningRecords.Consent({
            learner: who,
            attemptId: attemptId,
            songKey: records.songKeyOf(song),
            contentRevision: keccak256("manifest"),
            linesRoot: root,
            linesTotal: 4,
            activity: KARAOKE,
            grader: grader,
            scoringPolicy: keccak256("karaoke-scoring/5"),
            expiresAt: uint64(block.timestamp + 3600)
        });
    }

    function _signed(LearningRecords.Consent memory c, uint256 key) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, records.consentDigest(c));
        return abi.encodePacked(r, s, v);
    }

    function _open(bytes32 attemptId) internal {
        LearningRecords.Consent memory c = _consent(attemptId, learner);
        bytes memory sig = _signed(c, LEARNER_KEY);
        vm.prank(grader);
        records.openAttempt(c, sig, song);
    }

    function _line(uint16 ordinal, uint8 status, uint16 score, bool final_) internal view returns (LearningRecords.LineInput memory) {
        return LearningRecords.LineInput({
            ordinal: ordinal,
            lineKey: keccak256(bytes(string.concat("line-0", _digit(ordinal)))),
            lineVersion: 1,
            status: status,
            scoreBps: score,
            final_: final_,
            proof: _proof(ordinal - 1)
        });
    }

    function _assessAll(bytes32 attemptId) internal {
        LearningRecords.LineInput[] memory batch = new LearningRecords.LineInput[](4);
        batch[0] = _line(1, 1, 9000, true);
        batch[1] = _line(2, 3, 0, true); // unpaid
        batch[2] = _line(3, 2, 0, true); // silent
        batch[3] = _line(4, 5, 0, true); // unattempted
        vm.prank(grader);
        records.assessLines(attemptId, batch);
    }

    function _completion(uint64 completedAt) internal pure returns (LearningRecords.Completion memory) {
        return LearningRecords.Completion({
            completedAt: completedAt,
            status: 1,
            unmeasuredCount: 0,
            hasRewardScore: true,
            rewardScoreBps: 2250
        });
    }

    function testFullAttemptBindsCompletionAndCoveringPolicy() public {
        records.activatePolicy(keccak256("policy-1"), "ipfs://policy-1", 3);
        vm.warp(EPOCH + 3 * 86400 + 60); // period 3
        bytes32 id = keccak256("attempt-1");
        _open(id);
        _assessAll(id);
        vm.prank(grader);
        records.completeAttempt(id, _completion(uint64(EPOCH + 3 * 86400 + 30)));
        LearningRecords.Attempt memory a = records.attempt(id);
        require(a.finalCount == 4 && a.completionRevision == 1, "completed");
        require(a.qualificationPolicy == keccak256("policy-1"), "covering policy");
        bytes memory packed;
        for (uint16 o = 1; o <= 4; o++) {
            (, , bytes32 h) = records.lines(id, o);
            packed = bytes.concat(packed, h);
        }
        require(a.recordsHash == keccak256(packed), "records hash");
    }

    function testConsentMustBeTheLearnersAndTheGradersOwn() public {
        bytes32 id = keccak256("attempt-2");
        LearningRecords.Consent memory c = _consent(id, learner);
        bytes memory wrong = _signed(c, 22);
        vm.prank(grader);
        vm.expectRevert(bytes("invalid_consent"));
        records.openAttempt(c, wrong, song);
        bytes memory sig = _signed(c, LEARNER_KEY);
        vm.prank(vm.addr(13));
        vm.expectRevert(bytes("not_grader"));
        records.openAttempt(c, sig, song);
        vm.prank(grader);
        records.openAttempt(c, sig, song);
        vm.prank(grader);
        vm.expectRevert(bytes("attempt_exists"));
        records.openAttempt(c, sig, song);
        LearningRecords.Consent memory late = _consent(keccak256("attempt-3"), learner);
        late.expiresAt = uint64(block.timestamp);
        bytes memory lateSig = _signed(late, LEARNER_KEY);
        vm.prank(grader);
        vm.expectRevert(bytes("consent_expired"));
        records.openAttempt(late, lateSig, song);
    }

    function testLinesMustBelongToTheManifestAndScoresMatchStatus() public {
        bytes32 id = keccak256("attempt-4");
        _open(id);
        LearningRecords.LineInput[] memory batch = new LearningRecords.LineInput[](1);
        batch[0] = _line(1, 1, 9000, true);
        batch[0].lineKey = keccak256("line-99");
        vm.prank(grader);
        vm.expectRevert(bytes("not_in_manifest"));
        records.assessLines(id, batch);
        batch[0] = _line(2, 3, 5000, true); // unpaid with a score
        vm.prank(grader);
        vm.expectRevert(bytes("invalid_score"));
        records.assessLines(id, batch);
        batch[0] = _line(1, 1, 10001, true);
        vm.prank(grader);
        vm.expectRevert(bytes("invalid_score"));
        records.assessLines(id, batch);
    }

    function testRevisionsSupersedeAndCorrectionsKeepTheBoundCompletion() public {
        bytes32 id = keccak256("attempt-5");
        _open(id);
        LearningRecords.LineInput[] memory one = new LearningRecords.LineInput[](1);
        one[0] = _line(1, 1, 6000, false); // provisional
        vm.prank(grader);
        records.assessLines(id, one);
        _assessAll(id); // finals, line 1 at revision 2
        (uint32 revision, bool final_, ) = records.lines(id, 1);
        require(revision == 2 && final_, "final supersedes provisional");
        one[0] = _line(1, 1, 7000, false);
        vm.prank(grader);
        vm.expectRevert(bytes("final_already_recorded"));
        records.assessLines(id, one);
        uint64 completedAt = uint64(block.timestamp - 10);
        vm.prank(grader);
        records.completeAttempt(id, _completion(completedAt));
        one[0] = _line(1, 1, 9500, true); // correction
        vm.prank(grader);
        records.assessLines(id, one);
        vm.prank(grader);
        vm.expectRevert(bytes("completion_time_fixed"));
        records.completeAttempt(id, _completion(completedAt + 1));
        vm.prank(grader);
        records.completeAttempt(id, _completion(completedAt));
        LearningRecords.Attempt memory a = records.attempt(id);
        require(a.completionRevision == 2 && a.completedAt == completedAt && a.finalCount == 4, "correction kept binding");
    }

    function testCompletionNeedsEveryLineFinal() public {
        bytes32 id = keccak256("attempt-6");
        _open(id);
        LearningRecords.LineInput[] memory one = new LearningRecords.LineInput[](1);
        one[0] = _line(1, 1, 9000, true);
        vm.prank(grader);
        records.assessLines(id, one);
        vm.prank(grader);
        vm.expectRevert(bytes("lines_not_final"));
        records.completeAttempt(id, _completion(uint64(block.timestamp)));
    }

    function testPolicyActivationIsProspectiveAndIncreasing() public {
        vm.expectRevert(bytes("activation_not_prospective"));
        records.activatePolicy(keccak256("p"), "ipfs://p", 2);
        records.activatePolicy(keccak256("p3"), "ipfs://p3", 3);
        vm.expectRevert(bytes("activation_not_increasing"));
        records.activatePolicy(keccak256("p3b"), "ipfs://p3b", 3);
        records.activatePolicy(keccak256("p5"), "ipfs://p5", 5);
        require(records.policyFor(2) == bytes32(0), "no policy before activation");
        require(records.policyFor(3) == keccak256("p3") && records.policyFor(4) == keccak256("p3"), "p3 covers 3 and 4");
        require(records.policyFor(9) == keccak256("p5"), "p5 covers later");
        vm.prank(vm.addr(13));
        vm.expectRevert(bytes("not_controller"));
        records.activatePolicy(keccak256("p6"), "ipfs://p6", 6);
    }

    function testPeriodBoundariesMatchTheSharedClock() public view {
        require(records.periodOf(uint64(EPOCH + 3 * 86400 - 1)) == 2, "16:59:59 on 11-04 is period 2");
        require(records.periodOf(uint64(EPOCH + 3 * 86400)) == 3, "17:00:00 on 11-04 is period 3");
    }

    function testContractWalletConsentUsesErc1271() public {
        SmartWallet wallet = new SmartWallet();
        bytes32 id = keccak256("attempt-7");
        LearningRecords.Consent memory c = _consent(id, address(wallet));
        vm.prank(grader);
        vm.expectRevert(bytes("invalid_consent"));
        records.openAttempt(c, hex"00", song);
        wallet.approve(records.consentDigest(c));
        vm.prank(grader);
        records.openAttempt(c, hex"00", song);
        require(records.attempt(id).learner == address(wallet), "opened");
    }

    /// Review finding: a revoked grader can no longer change existing attempts.
    function testRevokedGraderCannotAssessCompleteOrCorrect() public {
        bytes32 id = keccak256("attempt-8");
        _open(id);
        _assessAll(id);
        records.setGrader(grader, KARAOKE, false);
        vm.prank(grader);
        vm.expectRevert(bytes("not_attempt_grader"));
        records.completeAttempt(id, _completion(uint64(block.timestamp)));
        records.setGrader(grader, KARAOKE, true);
        vm.prank(grader);
        records.completeAttempt(id, _completion(uint64(block.timestamp)));
        records.setGrader(grader, KARAOKE, false);
        LearningRecords.LineInput[] memory one = new LearningRecords.LineInput[](1);
        one[0] = _line(1, 1, 9500, true);
        vm.prank(grader);
        vm.expectRevert(bytes("not_attempt_grader"));
        records.assessLines(id, one);
    }

    /// Frozen encodings: fixtures/learning-records-v1.json, computed with cast.
    function testFrozenEncodingVectors() public {
        require(root == 0x307f78ef4bd386a2dec53316e75f678f689bb009e935b531f2f0fe44ae632c07, "lines root");
        LearningRecords.SongKey memory vectorSong = LearningRecords.SongKey({
            chainId: 6343,
            posts: address(0),
            communityId: 0x5962ebcfbac306c856b583ed5dcb74c5e873f37f407ab0c1c1269c7d37a9b082,
            postId: 0x1e7b5e81875ce71d2f823fbc16592b5c3b83e7ab0ada5fd3cb21bc7172cca479
        });
        require(records.songKeyOf(vectorSong) == 0xc85c5c3e7f9b79f5aaa327aa2ee018d17f249e71799b228e6c09360fec82f30a, "song key");
        bytes32 id = 0x09f53dc283d107cf9719fdbf201f7025424dbe697813f1d5c9feb0b53f5ba0db;
        _open(id);
        _assessAll(id);
        bytes32[4] memory expected = [
            bytes32(0xaa4144f9cbe11dad0155e5578413ab422701333ba377a416176f485a27079521),
            0xde0da6e4308648c14f3a854ccaed86162bec760ce8f1fe3675dc9bd2c48807fe,
            0xf38ef0f4234cb7ce1b4b2e6b04131421c4d32301b609090e05607e4e9bbb5715,
            0x399f7620bc0d415463b888f58d743a83258e0167c413e60513577ced3cd24644
        ];
        for (uint16 o = 1; o <= 4; o++) {
            (, , bytes32 h) = records.lines(id, o);
            require(h == expected[o - 1], "record hash");
        }
        vm.prank(grader);
        records.completeAttempt(id, _completion(uint64(block.timestamp)));
        require(records.attempt(id).recordsHash == 0x1c8fffc397653a54d6f38265005f5c732b677b1247e0826a22ae64a0b8452bc7, "records hash");
    }
}
