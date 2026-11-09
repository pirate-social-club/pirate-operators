// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

interface ResultConsent1271V4 {
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4);
}

/// @notice One community's terminal learning evidence. Grades live in events.
/// @dev Graders assert performance and timestamps. Indexers authenticate historical
/// source manifests; structural coverage checks do not prove an honest performance.
/// @notice Successor of LearningResultsV3. Publication permission is the
/// learner's sign-in signature (EIP-712 SignIn), recorded once and valid until
/// withdrawn. A later sign-in never moves the start of permission, so it cannot
/// strand lessons started earlier. Results, outcomes, grading roles, coverage
/// and correction rules are V3's.
contract LearningResultsV4 {
    uint256 public constant EPOCH_START = 1793552400;
    uint256 public constant PERIOD_SECONDS = 86400;
    uint16 public constant MAX_LINES = 500;
    uint8 public constant VERSION = 4;
    uint8 public constant KARAOKE = 1;
    uint8 public constant STUDY = 2;
    uint16 public constant MAX_SOURCE_LINES = 2000;
    /// A sign-in may be relayed for this long after it was signed.
    uint64 public constant RELAY_WINDOW = 7 days;
    bytes32 public constant SIGN_IN_TYPEHASH = keccak256(
        "SignIn(address learner,bytes32 communityId,string origin,bytes32 publicationPolicy,bytes32 nonce,uint64 issuedAt,uint64 expiresAt)"
    );
    bytes32 public constant REVOCATION_TYPEHASH = keccak256("Revocation(address learner,uint64 nonce)");
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public immutable communityId;
    bytes32 public immutable publicityPolicy;
    address public controller;

    /// @dev The same typed data is the community login. `expiresAt` is the
    /// login challenge's expiry; the application enforces it at sign-in.
    struct SignIn {
        address learner;
        bytes32 communityId;
        string origin;
        bytes32 publicationPolicy;
        bytes32 nonce;
        uint64 issuedAt;
        uint64 expiresAt;
    }

    struct Song {
        uint256 chainId;
        address posts;
        bytes32 communityId;
        bytes32 postId;
    }

    struct Result {
        bytes32 sessionId;
        address learner;
        bytes32 enrollmentId;
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
        uint8 status; // 1 completed, 2 abandoned, 3 expired, 4 payment missing, 5 invalidated
        uint32 revision;
        bytes32 supersedes;
    }

    struct Activation {
        bytes32 policy;
        uint64 period;
    }
    /// Revocation nonce, as in V3.
    mapping(address => uint64) public nextNonce;
    /// Earliest sign-in time of the permission in force; zero when none.
    mapping(address => uint64) public authorizedSince;
    /// Block time of the learner's last withdrawal.
    mapping(address => uint64) public revokedAt;
    mapping(bytes32 => address) public authorizationLearner;
    mapping(bytes32 => uint64) public authorizationIssuedAt;
    mapping(address => mapping(uint8 => bool)) public graders;
    mapping(bytes32 => bytes32) public commitments;
    mapping(uint8 => Activation[]) private activations;

    event ControllerChanged(address controller);
    event GraderSet(address indexed grader, uint8 indexed activity, bool allowed);
    event Authorized(
        address indexed learner, bytes32 indexed authorizationId, string origin, uint64 issuedAt, uint64 authorizedSince
    );
    event Revoked(address indexed learner, uint64 nonce, uint64 revokedAt);
    event PolicyActivated(
        uint8 indexed activity, bytes32 indexed policyHash, string policyURI, uint64 effectivePeriod, uint8 clockVersion
    );
    event EligibilityChanged(address indexed learner, bool eligible, uint64 effectiveAt, bytes32 reasonCode);
    event ResultPublished(
        bytes32 indexed sessionId,
        address indexed learner,
        uint32 indexed revision,
        Result result,
        bytes outcomes,
        bytes32 commitment,
        address publisher
    );
    event ResultInvalidated(bytes32 indexed sessionId, uint32 indexed revision, bytes32 reason);

    modifier onlyController() {
        require(msg.sender == controller, "not_controller");
        _;
    }

    constructor(address authority, bytes32 community, bytes32 publicity) {
        require(authority != address(0) && community != 0 && publicity != 0, "invalid_configuration");
        controller = authority;
        communityId = community;
        publicityPolicy = publicity;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Pirate Learning Results"),
                keccak256("4"),
                block.chainid,
                address(this)
            )
        );
        emit ControllerChanged(authority);
    }

    function setController(address authority) external onlyController {
        require(authority != address(0), "invalid_controller");
        controller = authority;
        emit ControllerChanged(authority);
    }

    function setGrader(address grader, uint8 activity, bool allowed) external onlyController {
        require(grader != address(0) && (activity == KARAOKE || activity == STUDY), "unsupported_activity");
        graders[grader][activity] = allowed;
        emit GraderSet(grader, activity, allowed);
    }

    function signInDigest(SignIn calldata a) public view returns (bytes32) {
        return _typed(
            keccak256(
                abi.encode(
                    SIGN_IN_TYPEHASH,
                    a.learner,
                    a.communityId,
                    keccak256(bytes(a.origin)),
                    a.publicationPolicy,
                    a.nonce,
                    a.issuedAt,
                    a.expiresAt
                )
            )
        );
    }

    /// @notice Records a learner's sign-in as publication permission. Anyone
    /// may relay it; only the learner's own signature authorizes.
    function authorize(SignIn calldata a, bytes calldata signature) external {
        require(
            a.learner != address(0) && a.communityId == communityId && a.publicationPolicy == publicityPolicy
                && bytes(a.origin).length > 0 && a.nonce != 0,
            "invalid_sign_in"
        );
        require(
            a.issuedAt <= block.timestamp && block.timestamp <= uint256(a.issuedAt) + RELAY_WINDOW
                && a.expiresAt > a.issuedAt,
            "stale_sign_in"
        );
        // A sign-in made before or at a withdrawal cannot restore permission.
        require(a.issuedAt > revokedAt[a.learner], "revoked_sign_in");
        bytes32 id = signInDigest(a);
        require(authorizationLearner[id] == address(0), "replayed_sign_in");
        require(_valid(a.learner, id, signature), "invalid_consent");
        authorizationLearner[id] = a.learner;
        authorizationIssuedAt[id] = a.issuedAt;
        uint64 since = authorizedSince[a.learner];
        // Relays can arrive out of order; permission starts at the earliest
        // sign-in after the last withdrawal.
        if (since == 0 || a.issuedAt < since) authorizedSince[a.learner] = a.issuedAt;
        emit Authorized(a.learner, id, a.origin, a.issuedAt, authorizedSince[a.learner]);
    }

    function revocationDigest(address learner, uint64 nonce) public view returns (bytes32) {
        return _typed(keccak256(abi.encode(REVOCATION_TYPEHASH, learner, nonce)));
    }

    /// @notice Direct account call or sponsored relay of an authenticated revocation.
    function revoke(address learner, uint64 nonce, bytes calldata signature) external {
        require(learner != address(0) && nonce == nextNonce[learner], "stale_nonce");
        require(
            msg.sender == learner || _valid(learner, revocationDigest(learner, nonce), signature), "invalid_consent"
        );
        nextNonce[learner] = nonce + 1;
        revokedAt[learner] = uint64(block.timestamp);
        delete authorizedSince[learner];
        emit Revoked(learner, nonce, uint64(block.timestamp));
    }

    function periodOf(uint64 timestamp) public pure returns (uint64) {
        require(timestamp >= EPOCH_START, "before_epoch");
        return uint64((timestamp - EPOCH_START) / PERIOD_SECONDS);
    }

    function activatePolicy(uint8 activity, bytes32 policy, string calldata uri, uint64 period)
        external
        onlyController
    {
        require(activity == KARAOKE || activity == STUDY, "unsupported_activity");
        Activation[] storage history = activations[activity];
        require(
            policy != 0
                && period > (block.timestamp < EPOCH_START ? 0 : (block.timestamp - EPOCH_START) / PERIOD_SECONDS),
            "activation_not_prospective"
        );
        require(history.length == 0 || period > history[history.length - 1].period, "activation_not_increasing");
        history.push(Activation(policy, period));
        emit PolicyActivated(activity, policy, uri, period, 1);
    }

    function policyFor(uint8 activity, uint64 period) public view returns (bytes32) {
        require(activity == KARAOKE || activity == STUDY, "unsupported_activity");
        Activation[] storage history = activations[activity];
        for (uint256 i = history.length; i > 0; --i) {
            if (history[i - 1].period <= period) return history[i - 1].policy;
        }
        return bytes32(0);
    }

    function setEligibility(address learner, bool eligible, uint64 effectiveAt, bytes32 reason)
        external
        onlyController
    {
        emit EligibilityChanged(learner, eligible, effectiveAt, reason);
    }

    /// @dev Karaoke retains its 5-byte ordinal/status/score encoding. Study uses
    /// 3-byte source-ordinal/first-pass-status entries; see learning-results-v3.md.
    function publish(Result calldata r, bytes calldata outcomes) external {
        require(r.revision == 1 && r.supersedes == 0 && commitments[r.sessionId] == 0, "duplicate_or_revision");
        require(msg.sender == r.grader && graders[r.grader][r.activity], "not_grader");
        // enrollmentId names the learner's sign-in authorization the run or
        // lesson started under; permission must be unbroken since then.
        uint64 since = authorizedSince[r.learner];
        uint64 issuedAt = authorizationIssuedAt[r.enrollmentId];
        require(
            authorizationLearner[r.enrollmentId] == r.learner && since != 0 && issuedAt >= since
                && issuedAt <= r.startedAt,
            "authorization_inactive"
        );
        require(r.activity == KARAOKE || r.activity == STUDY, "unsupported_activity");
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
        _record(r, outcomes);
    }

    /// @notice Previous data proves immutable context without storing every field.
    /// Corrections remain possible after publication permission is withdrawn.
    function correct(Result calldata previous, bytes calldata oldOutcomes, bytes calldata outcomes, uint8 status)
        external
    {
        _previous(previous, oldOutcomes);
        require(
            msg.sender == controller
                || (previous.status != 5 && msg.sender == previous.grader && graders[msg.sender][previous.activity]),
            "not_corrector"
        );
        require(status >= 1 && status <= 4, "invalid_terminal_status");
        _coverage(previous.activity, status, previous.linesTotal, previous.exercisesHash, outcomes);
        require(keccak256(outcomes) != keccak256(oldOutcomes) || status != previous.status, "no_change");
        Result memory next = previous;
        next.revision++;
        next.supersedes = commitments[previous.sessionId];
        next.status = status;
        _record(next, outcomes);
    }

    function invalidate(Result calldata previous, bytes calldata outcomes, bytes32 reason) external onlyController {
        _previous(previous, outcomes);
        require(previous.status != 5 && reason != 0, "invalid_invalidation");
        Result memory next = previous;
        next.revision++;
        next.supersedes = commitments[previous.sessionId];
        next.status = 5;
        _record(next, outcomes);
        emit ResultInvalidated(next.sessionId, next.revision, reason);
    }

    function commitmentOf(Result memory r, bytes memory outcomes) public pure returns (bytes32) {
        return keccak256(abi.encode(r, outcomes));
    }

    function _previous(Result calldata r, bytes calldata outcomes) private view {
        require(commitments[r.sessionId] != 0 && commitments[r.sessionId] == commitmentOf(r, outcomes), "stale_result");
    }

    function _record(Result memory r, bytes memory outcomes) private {
        bytes32 commitment = commitmentOf(r, outcomes);
        commitments[r.sessionId] = commitment;
        emit ResultPublished(r.sessionId, r.learner, r.revision, r, outcomes, commitment, msg.sender);
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

    function _typed(bytes32 inner) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, inner));
    }

    function _valid(address learner, bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (learner.code.length != 0) {
            try ResultConsent1271V4(learner).isValidSignature(digest, signature) returns (bytes4 magic) {
                return magic == 0x1626ba7e;
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
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0 || (v != 27 && v != 28)) {
            return false;
        }
        address signer = ecrecover(digest, v, r, s);
        return signer != address(0) && signer == learner;
    }
}
