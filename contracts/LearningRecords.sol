// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

interface IERC1271 {
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4);
}

/// @notice A community's public learning records on MegaETH
/// (docs/learning-records-contract.md). Authorized graders publish per-line
/// assessments and attempt completions for learners who consented to that
/// attempt; the controller activates qualification policies and publishes
/// eligibility changes. Storage holds only what the rules need; events carry
/// the full public history from which indexers rebuild boards.
contract LearningRecords {
    uint256 public constant EPOCH_START = 1793552400; // 2026-11-01 17:00 UTC
    uint256 public constant PERIOD_SECONDS = 86400;
    uint8 public constant CLOCK_VERSION = 1;
    uint16 public constant MAX_LINES = 500;

    uint8 public constant ASSESSED = 1;
    uint8 public constant SILENT = 2;
    uint8 public constant UNPAID = 3;
    uint8 public constant UNMEASURED = 4;
    uint8 public constant UNATTEMPTED = 5;

    bytes32 public constant CONSENT_TYPEHASH = keccak256(
        "Consent(address learner,bytes32 attemptId,bytes32 songKey,bytes32 contentRevision,bytes32 linesRoot,uint16 linesTotal,bytes32 activity,address grader,bytes32 scoringPolicy,uint64 expiresAt)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;

    struct Consent {
        address learner;
        bytes32 attemptId;
        bytes32 songKey;
        bytes32 contentRevision;
        bytes32 linesRoot;
        uint16 linesTotal;
        bytes32 activity;
        address grader;
        bytes32 scoringPolicy;
        uint64 expiresAt;
    }
    struct SongKey {
        uint256 chainId;
        address posts;
        bytes32 communityId;
        bytes32 postId;
    }
    struct Attempt {
        address learner;
        address grader;
        bytes32 activity;
        bytes32 songKey;
        bytes32 contentRevision;
        bytes32 linesRoot;
        bytes32 scoringPolicy;
        uint16 linesTotal;
        uint16 finalCount;
        uint32 completionRevision;
        uint64 completedAt;
        bytes32 qualificationPolicy;
        bytes32 linesHash;
    }
    struct LineState {
        uint32 revision;
        bool final_;
        bytes32 recordHash;
    }
    struct LineInput {
        uint16 ordinal;
        bytes32 lineKey;
        uint32 lineVersion;
        uint8 status;
        uint16 scoreBps;
        bool final_;
        bytes32[] proof;
    }
    struct Completion {
        uint64 completedAt;
        uint8 status;
        uint16 unmeasuredCount;
        bool hasRewardScore;
        uint16 rewardScoreBps;
    }
    struct Activation {
        bytes32 policyHash;
        uint64 effectivePeriod;
    }

    address public controller;
    mapping(address grader => mapping(bytes32 activity => bool)) public graders;
    mapping(bytes32 attemptId => Attempt) internal attempts;
    mapping(bytes32 attemptId => mapping(uint16 ordinal => LineState)) public lines;
    Activation[] public activations;

    event ControllerChanged(address controller);
    event GraderSet(address indexed grader, bytes32 indexed activity, bool allowed);
    event AttemptOpened(
        bytes32 indexed attemptId,
        address indexed learner,
        bytes32 indexed songKey,
        SongKey song,
        bytes32 activity,
        address grader,
        bytes32 scoringPolicy,
        bytes32 contentRevision,
        bytes32 linesRoot,
        uint16 linesTotal
    );
    event LineAssessed(
        bytes32 indexed attemptId,
        address indexed learner,
        uint16 indexed ordinal,
        bytes32 lineKey,
        uint32 lineVersion,
        uint8 status,
        uint16 scoreBps,
        bool hasScore,
        bool final_,
        uint32 revision,
        bytes32 supersedes,
        bytes32 recordHash
    );
    event AttemptCompleted(
        bytes32 indexed attemptId,
        address indexed learner,
        bytes32 indexed songKey,
        bytes32 activity,
        uint64 completedAt,
        uint64 periodId,
        bytes32 qualificationPolicy,
        uint8 status,
        bytes32 linesHash,
        uint16 linesTotal,
        uint16 unmeasuredCount,
        bool hasRewardScore,
        uint16 rewardScoreBps,
        uint32 revision
    );
    event PolicyActivated(bytes32 indexed policyHash, string policyURI, uint64 effectivePeriod, uint8 clockVersion);
    event EligibilityChanged(address indexed learner, bool eligible, uint64 effectiveAt, bytes32 reasonCode);

    modifier onlyController() {
        require(msg.sender == controller, "not_controller");
        _;
    }

    constructor(address controller_) {
        require(controller_ != address(0), "invalid_controller");
        controller = controller_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Pirate Learning Records"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
        emit ControllerChanged(controller_);
    }

    function setController(address next) external onlyController {
        require(next != address(0), "invalid_controller");
        controller = next;
        emit ControllerChanged(next);
    }

    function setGrader(address grader, bytes32 activity, bool allowed) external onlyController {
        graders[grader][activity] = allowed;
        emit GraderSet(grader, activity, allowed);
    }

    function setEligibility(address learner, bool eligible, uint64 effectiveAt, bytes32 reasonCode) external onlyController {
        emit EligibilityChanged(learner, eligible, effectiveAt, reasonCode);
    }

    /// @notice Activations must land before their period begins and only move forward.
    function activatePolicy(bytes32 policyHash, string calldata policyURI, uint64 effectivePeriod) external onlyController {
        require(policyHash != bytes32(0), "invalid_policy");
        require(effectivePeriod > currentPeriod(), "activation_not_prospective");
        uint256 count = activations.length;
        require(count == 0 || effectivePeriod > activations[count - 1].effectivePeriod, "activation_not_increasing");
        activations.push(Activation(policyHash, effectivePeriod));
        emit PolicyActivated(policyHash, policyURI, effectivePeriod, CLOCK_VERSION);
    }

    function currentPeriod() public view returns (uint64) {
        return block.timestamp < EPOCH_START ? 0 : uint64((block.timestamp - EPOCH_START) / PERIOD_SECONDS);
    }

    function periodOf(uint64 timestamp) public pure returns (uint64) {
        require(timestamp >= EPOCH_START, "before_epoch");
        return uint64((timestamp - EPOCH_START) / PERIOD_SECONDS);
    }

    /// @notice The policy covering a period: the latest activation at or before it, or zero.
    function policyFor(uint64 periodId) public view returns (bytes32) {
        for (uint256 i = activations.length; i > 0; i--)
            if (activations[i - 1].effectivePeriod <= periodId) return activations[i - 1].policyHash;
        return bytes32(0);
    }

    function activationCount() external view returns (uint256) {
        return activations.length;
    }

    function attempt(bytes32 attemptId) external view returns (Attempt memory) {
        return attempts[attemptId];
    }

    function songKeyOf(SongKey calldata song) public pure returns (bytes32) {
        return keccak256(abi.encode(song.chainId, song.posts, song.communityId, song.postId));
    }

    function consentDigest(Consent calldata c) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(
                    abi.encode(
                        CONSENT_TYPEHASH,
                        c.learner,
                        c.attemptId,
                        c.songKey,
                        c.contentRevision,
                        c.linesRoot,
                        c.linesTotal,
                        c.activity,
                        c.grader,
                        c.scoringPolicy,
                        c.expiresAt
                    )
                )
            )
        );
    }

    /// @notice The first record for an attempt: the learner's consent, checked here once.
    function openAttempt(Consent calldata c, bytes calldata signature, SongKey calldata song) external {
        require(msg.sender == c.grader && graders[c.grader][c.activity], "not_grader");
        require(c.expiresAt > block.timestamp, "consent_expired");
        require(c.linesTotal > 0 && c.linesTotal <= MAX_LINES && c.linesRoot != bytes32(0), "invalid_lines");
        require(songKeyOf(song) == c.songKey, "song_key_mismatch");
        require(attempts[c.attemptId].learner == address(0), "attempt_exists");
        require(_validSignature(c.learner, consentDigest(c), signature), "invalid_consent");
        attempts[c.attemptId] = Attempt({
            learner: c.learner,
            grader: c.grader,
            activity: c.activity,
            songKey: c.songKey,
            contentRevision: c.contentRevision,
            linesRoot: c.linesRoot,
            scoringPolicy: c.scoringPolicy,
            linesTotal: c.linesTotal,
            finalCount: 0,
            completionRevision: 0,
            completedAt: 0,
            qualificationPolicy: bytes32(0),
            linesHash: bytes32(0)
        });
        emit AttemptOpened(
            c.attemptId, c.learner, c.songKey, song, c.activity, c.grader, c.scoringPolicy, c.contentRevision, c.linesRoot, c.linesTotal
        );
    }

    /// @notice One or more line records. Provisional records may be superseded
    /// by a final one; a final record only by a final correction.
    function assessLines(bytes32 attemptId, LineInput[] calldata inputs) external {
        Attempt storage a = attempts[attemptId];
        require(a.learner != address(0), "unknown_attempt");
        require(msg.sender == a.grader, "not_attempt_grader");
        for (uint256 i = 0; i < inputs.length; i++) _assess(attemptId, a, inputs[i]);
    }

    function _assess(bytes32 attemptId, Attempt storage a, LineInput calldata l) internal {
        require(l.ordinal >= 1 && l.ordinal <= a.linesTotal, "invalid_ordinal");
        require(
            _verify(l.proof, a.linesRoot, keccak256(abi.encode(uint256(l.ordinal), l.lineKey, uint256(l.lineVersion)))),
            "not_in_manifest"
        );
        require(l.status >= ASSESSED && l.status <= UNATTEMPTED, "invalid_status");
        bool hasScore = l.status == ASSESSED;
        require(hasScore ? l.scoreBps <= 10000 : l.scoreBps == 0, "invalid_score");
        LineState storage previous = lines[attemptId][l.ordinal];
        require(!(previous.final_ && !l.final_), "final_already_recorded");
        uint32 revision = previous.revision + 1;
        bytes32 recordHash = keccak256(
            abi.encode(attemptId, l.ordinal, l.lineKey, l.lineVersion, l.status, l.scoreBps, l.final_, revision)
        );
        bytes32 supersedes = previous.recordHash;
        if (l.final_ && !previous.final_) a.finalCount += 1;
        lines[attemptId][l.ordinal] = LineState(revision, l.final_, recordHash);
        emit LineAssessed(
            attemptId, a.learner, l.ordinal, l.lineKey, l.lineVersion, l.status, l.scoreBps, hasScore, l.final_, revision, supersedes, recordHash
        );
    }

    /// @notice Requires a final record for every manifest line. The first
    /// completion binds completedAt and the covering policy; later ones follow
    /// corrections and keep both.
    function completeAttempt(bytes32 attemptId, Completion calldata c) external {
        Attempt storage a = attempts[attemptId];
        require(a.learner != address(0), "unknown_attempt");
        require(msg.sender == a.grader, "not_attempt_grader");
        require(a.finalCount == a.linesTotal, "lines_not_final");
        require(c.status >= 1 && c.status <= 4, "invalid_completion_status");
        require(c.hasRewardScore ? c.rewardScoreBps <= 10000 : c.rewardScoreBps == 0, "invalid_reward_score");
        require(c.unmeasuredCount <= a.linesTotal, "invalid_unmeasured");
        if (a.completionRevision == 0) {
            require(c.completedAt <= block.timestamp, "completion_in_future");
            a.completedAt = c.completedAt;
            a.qualificationPolicy = policyFor(periodOf(c.completedAt));
        } else {
            require(c.completedAt == a.completedAt, "completion_time_fixed");
        }
        bytes memory packed;
        for (uint16 ordinal = 1; ordinal <= a.linesTotal; ordinal++)
            packed = bytes.concat(packed, lines[attemptId][ordinal].recordHash);
        a.linesHash = keccak256(packed);
        a.completionRevision += 1;
        emit AttemptCompleted(
            attemptId,
            a.learner,
            a.songKey,
            a.activity,
            a.completedAt,
            periodOf(a.completedAt),
            a.qualificationPolicy,
            c.status,
            a.linesHash,
            a.linesTotal,
            c.unmeasuredCount,
            c.hasRewardScore,
            c.rewardScoreBps,
            a.completionRevision
        );
    }

    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 node = leaf;
        for (uint256 i = 0; i < proof.length; i++)
            node = node < proof[i] ? keccak256(abi.encodePacked(node, proof[i])) : keccak256(abi.encodePacked(proof[i], node));
        return node == root;
    }

    function _validSignature(address learner, bytes32 digest, bytes calldata signature) internal view returns (bool) {
        if (learner.code.length > 0) {
            try IERC1271(learner).isValidSignature(digest, signature) returns (bytes4 magic) {
                return magic == IERC1271.isValidSignature.selector;
            } catch {
                return false;
            }
        }
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0 || (v != 27 && v != 28)) return false;
        address recovered = ecrecover(digest, v, r, s);
        return recovered != address(0) && recovered == learner;
    }
}
