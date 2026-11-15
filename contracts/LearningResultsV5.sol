// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {PublicationConsentV1} from "./learning/PublicationConsentV1.sol";

/// @notice Terminal learning evidence with explicit purpose-scoped consent.
/// @dev Scoring/coverage adapted from retained LearningResultsV4; no login or origin authority.
contract LearningResultsV5 is PublicationConsentV1 {
    uint256 public constant EPOCH_START = 1793552400;
    uint256 public constant PERIOD_SECONDS = 86400;
    uint16 public constant MAX_LINES = 500;
    uint16 public constant MAX_SOURCE_LINES = 2000;
    uint8 public constant VERSION = 5;
    uint8 public constant KARAOKE = 1;
    uint8 public constant STUDY = 2;
    bytes32 public constant RESULT_DOMAIN = keccak256("pirate.learning-result/5");

    struct Song {
        uint256 chainId;
        address posts;
        bytes32 communityId;
        bytes32 postId;
    }

    struct Result {
        bytes32 sessionId;
        address learner;
        bytes32 grantId;
        Song song;
        bytes32 contentRevision;
        bytes32 exercisesHash;
        uint16 linesTotal;
        uint8 activity;
        address grader;
        bytes32 scoringPolicy;
        bytes32 qualificationPolicy;
        uint64 startedAt;
        uint64 completedAt;
        uint8 status;
        uint32 revision;
        bytes32 supersedes;
    }

    struct Activation {
        bytes32 policy;
        uint64 period;
    }
    mapping(address => mapping(uint8 => bool)) public graders;
    mapping(bytes32 => bytes32) public commitments;
    mapping(uint8 => Activation[]) private activations;
    event GraderSetV5(address indexed grader, uint8 indexed activity, bool allowed, uint64 configurationRevision);
    event PolicyActivatedV5(
        uint8 indexed activity,
        bytes32 indexed policyHash,
        string policyURI,
        uint64 effectivePeriod,
        uint8 clockVersion,
        uint64 configurationRevision
    );
    event EligibilityChangedV5(address indexed learner, bool eligible, uint64 effectiveAt, bytes32 reasonCode);
    event ResultPublishedV5(
        bytes32 indexed sessionId,
        address indexed learner,
        uint32 indexed revision,
        Result result,
        bytes outcomes,
        bytes32 commitment,
        address publisher,
        uint64 configurationRevision
    );
    event ResultCorrectedV5(
        bytes32 indexed sessionId,
        bytes32 indexed correctionId,
        bytes32 indexed originalGrantId,
        bytes32 previousCommitment,
        bytes32 correctedCommitment,
        bytes32 reasonHash
    );
    event ResultInvalidatedV5(bytes32 indexed sessionId, uint32 indexed revision, bytes32 reason, bytes32 correctionId);

    constructor(address selectedDirectory, bytes32 expectedRuntime, bytes32 community)
        PublicationConsentV1(selectedDirectory, expectedRuntime, community)
    {}

    function setGrader(address grader, uint8 activity, bool allowed, uint64 expectedConfigurationRevision) external {
        _controller(expectedConfigurationRevision);
        require(grader != address(0), "invalid_grader");
        _activity(activity);
        graders[grader][activity] = allowed;
        emit GraderSetV5(grader, activity, allowed, expectedConfigurationRevision);
    }

    function _activity(uint8 activity) private pure returns (bytes32) {
        if (activity == KARAOKE) return KARAOKE_PURPOSE;
        if (activity == STUDY) return STUDY_PURPOSE;
        revert("unsupported_activity");
    }

    function _publisher(uint8 activity, uint64 expectedConfigurationRevision) private view {
        _activity(activity);
        require(
            msg.sender == _community(expectedConfigurationRevision).configuration.publisher
                && graders[msg.sender][activity],
            "not_publisher_grader"
        );
    }

    function periodOf(uint64 timestamp) public pure returns (uint64) {
        require(timestamp >= EPOCH_START, "before_epoch");
        return uint64((timestamp - EPOCH_START) / PERIOD_SECONDS);
    }

    function activatePolicy(
        uint8 activity,
        bytes32 policy,
        string calldata uri,
        uint64 period,
        uint64 expectedConfigurationRevision
    ) external {
        _controller(expectedConfigurationRevision);
        _activity(activity);
        Activation[] storage history = activations[activity];
        require(
            policy != 0
                && period > (block.timestamp < EPOCH_START ? 0 : (block.timestamp - EPOCH_START) / PERIOD_SECONDS),
            "activation_not_prospective"
        );
        require(history.length == 0 || period > history[history.length - 1].period, "activation_not_increasing");
        history.push(Activation(policy, period));
        emit PolicyActivatedV5(activity, policy, uri, period, 1, expectedConfigurationRevision);
    }

    function policyFor(uint8 activity, uint64 period) public view returns (bytes32) {
        _activity(activity);
        Activation[] storage history = activations[activity];
        for (uint256 i = history.length; i > 0; --i) {
            if (history[i - 1].period <= period) return history[i - 1].policy;
        }
        return bytes32(0);
    }

    function setEligibility(
        address learner,
        bool eligible,
        uint64 effectiveAt,
        bytes32 reason,
        uint64 expectedConfigurationRevision
    ) external {
        _controller(expectedConfigurationRevision);
        emit EligibilityChangedV5(learner, eligible, effectiveAt, reason);
    }

    function publish(Result calldata r, bytes calldata outcomes, uint64 expectedConfigurationRevision) external {
        _publisher(r.activity, expectedConfigurationRevision);
        require(msg.sender == r.grader, "not_grader");
        require(r.revision == 1 && r.supersedes == 0 && commitments[r.sessionId] == 0, "duplicate_or_revision");
        (PublicationGrant memory g,) = this.grantOf(r.grantId);
        (bool allowed,) =
            checkGrant(r.grantId, r.learner, _activity(r.activity), address(this), g.policyHash, r.startedAt);
        require(allowed, "publication_consent_inactive");
        require(r.completedAt >= r.startedAt && r.completedAt <= block.timestamp, "invalid_time");
        require(
            r.sessionId != 0 && r.learner != address(0) && r.song.posts != address(0) && r.song.chainId != 0
                && r.song.communityId == communityId && r.song.postId != 0 && r.contentRevision != 0
                && r.scoringPolicy != 0,
            "invalid_context"
        );
        require(r.qualificationPolicy == policyFor(r.activity, periodOf(r.completedAt)), "wrong_policy");
        require(r.status >= 1 && r.status <= 4, "invalid_terminal_status");
        _coverage(r.activity, r.status, r.linesTotal, r.exercisesHash, outcomes);
        _record(r, outcomes, expectedConfigurationRevision);
    }

    function correct(
        Result calldata previous,
        bytes calldata oldOutcomes,
        bytes calldata outcomes,
        uint8 status,
        PublicationCorrection calldata permit,
        bytes calldata signature,
        uint64 expectedConfigurationRevision
    ) external {
        _publisher(previous.activity, expectedConfigurationRevision);
        _previous(previous, oldOutcomes);
        require(status >= 1 && status <= 4, "invalid_terminal_status");
        _coverage(previous.activity, status, previous.linesTotal, previous.exercisesHash, outcomes);
        require(keccak256(outcomes) != keccak256(oldOutcomes) || status != previous.status, "no_change");
        Result memory next = previous;
        next.revision++;
        next.supersedes = commitments[previous.sessionId];
        next.status = status;
        bytes32 digest = _correction(previous, next, outcomes, permit, signature, bytes32(0));
        _record(next, outcomes, expectedConfigurationRevision);
        emit ResultCorrectedV5(next.sessionId, digest, next.grantId, next.supersedes, commitments[next.sessionId], 0);
    }

    function invalidate(
        Result calldata previous,
        bytes calldata outcomes,
        bytes32 reason,
        PublicationCorrection calldata permit,
        bytes calldata signature,
        uint64 expectedConfigurationRevision
    ) external {
        _publisher(previous.activity, expectedConfigurationRevision);
        _previous(previous, outcomes);
        require(previous.status != 5 && reason != 0, "invalid_invalidation");
        Result memory next = previous;
        next.revision++;
        next.supersedes = commitments[previous.sessionId];
        next.status = 5;
        bytes32 digest = _correction(previous, next, outcomes, permit, signature, reason);
        _record(next, outcomes, expectedConfigurationRevision);
        emit ResultCorrectedV5(
            next.sessionId, digest, next.grantId, next.supersedes, commitments[next.sessionId], reason
        );
        emit ResultInvalidatedV5(next.sessionId, next.revision, reason, digest);
    }

    function _correction(
        Result calldata previous,
        Result memory next,
        bytes calldata outcomes,
        PublicationCorrection calldata permit,
        bytes calldata signature,
        bytes32 reason
    ) private returns (bytes32) {
        if (
            permit.learner != previous.learner || permit.resultId != previous.sessionId
                || permit.originalGrantId != previous.grantId
                || keccak256(bytes(permit.purpose)) != _activity(previous.activity)
                || permit.previousCommitment != next.supersedes
                || permit.correctedCommitment != commitmentOf(next, outcomes) || permit.reasonHash != reason
        ) revert InvalidCorrection();
        return _consumeCorrection(permit, signature);
    }

    function commitmentOf(Result memory r, bytes memory outcomes) public pure returns (bytes32) {
        return keccak256(abi.encode(RESULT_DOMAIN, r, outcomes));
    }

    function _previous(Result calldata r, bytes calldata outcomes) private view {
        require(commitments[r.sessionId] != 0 && commitments[r.sessionId] == commitmentOf(r, outcomes), "stale_result");
    }

    function _record(Result memory r, bytes memory outcomes, uint64 revision) private {
        bytes32 commitment = commitmentOf(r, outcomes);
        commitments[r.sessionId] = commitment;
        emit ResultPublishedV5(r.sessionId, r.learner, r.revision, r, outcomes, commitment, msg.sender, revision);
    }

    function _karaokeCoverage(uint16 count, bytes32 exerciseHash, bytes calldata outcomes) private pure {
        require(count > 0 && count <= MAX_LINES && outcomes.length == uint256(count) * 5, "invalid_coverage");
        bytes memory ordered = new bytes(uint256(count) * 2);
        for (uint256 i; i < count; ++i) {
            uint256 offset = i * 5;
            uint16 ordinal = uint16(bytes2(outcomes[offset:offset + 2]));
            require(ordinal == i + 1, "invalid_order");
            ordered[i * 2] = outcomes[offset];
            ordered[i * 2 + 1] = outcomes[offset + 1];
            uint8 status = uint8(outcomes[offset + 2]);
            uint16 score = uint16(bytes2(outcomes[offset + 3:offset + 5]));
            require(status >= 1 && status <= 5 && (status == 1 ? score <= 10000 : score == 0), "invalid_grade");
        }
        require(keccak256(ordered) == exerciseHash, "wrong_exercises");
    }

    function _coverage(
        uint8 activity,
        uint8 terminalStatus,
        uint16 count,
        bytes32 exerciseHash,
        bytes calldata outcomes
    ) private pure {
        if (activity == KARAOKE) {
            _karaokeCoverage(count, exerciseHash, outcomes);
        } else {
            require(activity == STUDY, "unsupported_activity");
            require(count >= 4 && count <= 10 && outcomes.length == uint256(count) * 3, "invalid_coverage");
            bytes memory ordered = new bytes(uint256(count) * 2);
            uint16[] memory ordinals = new uint16[](count);
            for (uint256 i; i < count; ++i) {
                uint256 offset = i * 3;
                uint16 ordinal = uint16(bytes2(outcomes[offset:offset + 2]));
                require(ordinal > 0 && ordinal <= MAX_SOURCE_LINES, "invalid_source_ordinal");
                for (uint256 j; j < i; ++j) {
                    require(ordinals[j] != ordinal, "duplicate_exercise");
                }
                ordinals[i] = ordinal;
                ordered[i * 2] = outcomes[offset];
                ordered[i * 2 + 1] = outcomes[offset + 1];
                uint8 status = uint8(outcomes[offset + 2]);
                require(status >= 1 && status <= 5, "invalid_study_outcome");
                require(terminalStatus != 1 || status <= 2, "incomplete_study");
            }
            require(keccak256(ordered) == exerciseHash, "wrong_exercises");
        }
    }
}
