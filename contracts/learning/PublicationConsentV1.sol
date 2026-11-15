// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {ICommunityPublicationConsentV1 as Consent} from "../interfaces/community/ICommunityPublicationConsentV1.sol";
import {ICommunityDirectoryV1 as Directory} from "../interfaces/community/ICommunityDirectoryV1.sol";

interface PublicationAccount1271 {
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4);
}

/// @dev Shared implementation only; LearningResultsV5 is the deployed consent registry.
abstract contract PublicationConsentV1 is Consent {
    bytes32 public constant KARAOKE_PURPOSE = keccak256("karaoke-results");
    bytes32 public constant STUDY_PURPOSE = keccak256("study-results");
    bytes32 public constant DANCE_PURPOSE = keccak256("dance-verdict");
    bytes32 public constant REVIEW_PURPOSE = keccak256("dance-review-attribution");
    bytes32 public constant GRANT_TYPEHASH = keccak256(
        "PublicationGrant(address learner,bytes32 communityId,string purpose,address publicationTarget,bytes32 publicationTargetRuntimeHash,uint64 permissionRevision,bytes32 policyHash,uint64 withdrawalEpoch,bytes32 nonce,uint64 issuedAt,uint64 validAfter,uint64 expiresAt,uint64 submitBefore)"
    );
    bytes32 public constant WITHDRAWAL_TYPEHASH = keccak256(
        "PublicationWithdrawal(address learner,bytes32 communityId,string purpose,uint64 expectedEpoch,bytes32 nonce,uint64 submitBefore)"
    );
    bytes32 public constant CORRECTION_TYPEHASH = keccak256(
        "PublicationCorrection(address learner,bytes32 communityId,string purpose,address publicationTarget,bytes32 publicationTargetRuntimeHash,uint64 permissionRevision,bytes32 policyHash,uint64 withdrawalEpoch,bytes32 resultId,bytes32 originalGrantId,bytes32 previousCommitment,bytes32 correctedCommitment,bytes32 reasonHash,bytes32 nonce,uint64 issuedAt,uint64 submitBefore)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public immutable override communityId;
    Directory public immutable directory;
    bytes32 public immutable directoryRuntimeHash;

    struct PurposeState {
        uint64 revision;
        PurposeDescriptor descriptor;
    }

    struct SavedGrant {
        PublicationGrant value;
        uint64 recordedAt;
    }
    mapping(bytes32 => PurposeState) private purposes;
    mapping(bytes32 => SavedGrant) private grants;
    mapping(address => mapping(bytes32 => uint64)) public override withdrawalEpoch;
    mapping(bytes32 => bool) public usedNonces;

    constructor(address selectedDirectory, bytes32 expectedRuntime, bytes32 community) {
        if (
            (block.chainid != 6343 && block.chainid != 31337) || community == 0
                || !_code(selectedDirectory, expectedRuntime)
        ) revert InvalidSource();
        communityId = community;
        directory = Directory(selectedDirectory);
        directoryRuntimeHash = expectedRuntime;
    }

    function consentVersion() external pure override returns (uint8) {
        return 1;
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("Pirate Publication Consent"), keccak256("1"), block.chainid, address(this)
            )
        );
    }

    function _typed(bytes32 inner) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), inner));
    }

    function _purpose(string memory value) internal pure returns (bytes32 p) {
        p = keccak256(bytes(value));
        if (p != KARAOKE_PURPOSE && p != STUDY_PURPOSE && p != DANCE_PURPOSE && p != REVIEW_PURPOSE) {
            revert InvalidPurpose();
        }
    }

    function _code(address target, bytes32 runtimeHash) internal view returns (bool) {
        return target.code.length != 0 && runtimeHash != 0 && target.codehash == runtimeHash;
    }

    function _activeRegistry() private view returns (bool) {
        if (!_code(address(directory), directoryRuntimeHash)) return false;
        try directory.getCommunity(communityId) returns (Directory.Community memory c) {
            return c.configurationRevision != 0 && c.configuration.learningRecords == address(this);
        } catch {
            return false;
        }
    }

    function _community(uint64 expectedRevision) internal view returns (Directory.Community memory c) {
        if (!_code(address(directory), directoryRuntimeHash)) revert InvalidSource();
        c = directory.getCommunity(communityId);
        if (c.configurationRevision == 0 || c.configuration.learningRecords != address(this)) revert InvalidSource();
        if (c.configurationRevision != expectedRevision) revert StaleRevision();
    }

    function _controller(uint64 expectedRevision) internal view {
        if (_community(expectedRevision).configuration.controller != msg.sender) revert Unauthorized();
    }

    function configurePurpose(
        string calldata name,
        uint64 expectedPermissionRevision,
        uint64 expectedConfigurationRevision,
        PurposeDescriptor calldata d
    ) external override {
        _controller(expectedConfigurationRevision);
        bytes32 p = _purpose(name);
        PurposeState storage state = purposes[p];
        if (state.revision != expectedPermissionRevision) revert StaleRevision();
        if (d.enabled) {
            if (
                !_code(d.target, d.runtimeHash) || d.policyHash == 0 || d.maxGrantDurationSeconds == 0
                    || d.maxSubmissionDelaySeconds == 0
                    || ((p == KARAOKE_PURPOSE || p == STUDY_PURPOSE) && d.target != address(this))
            ) revert InvalidDescriptor();
        } else if (
            d.target != address(0) || d.runtimeHash != 0 || d.policyHash != 0 || d.maxGrantDurationSeconds != 0
                || d.maxSubmissionDelaySeconds != 0
        ) {
            revert InvalidDescriptor();
        }
        state.revision++;
        state.descriptor = d;
        emit PurposeConfigured(
            p,
            state.revision,
            d.target,
            d.runtimeHash,
            d.policyHash,
            d.maxGrantDurationSeconds,
            d.maxSubmissionDelaySeconds,
            d.enabled
        );
    }

    function purpose(bytes32 p) external view override returns (uint64 revision, PurposeDescriptor memory descriptor) {
        PurposeState storage state = purposes[p];
        return (state.revision, state.descriptor);
    }

    function _nonceKey(bytes32 primary, address learner, bytes32 p, uint64 epoch, bytes32 nonce)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(primary, learner, p, epoch, nonce));
    }

    function _consumeNonce(bytes32 primary, address learner, bytes32 p, uint64 epoch, bytes32 nonce) private {
        if (learner == address(0) || nonce == 0) revert InvalidConsent();
        bytes32 key = _nonceKey(primary, learner, p, epoch, nonce);
        if (usedNonces[key]) revert NonceUsed();
        usedNonces[key] = true;
    }

    // Fixed 32-byte words encode the exact ordered EIP-712 primary types without
    // a dynamic tuple offset or stack-depth-sensitive wide abi.encode call.
    function grantDigest(PublicationGrant calldata g) public view override returns (bytes32) {
        bytes32[14] memory w;
        w[0] = GRANT_TYPEHASH;
        w[1] = bytes32(uint256(uint160(g.learner)));
        w[2] = g.communityId;
        w[3] = keccak256(bytes(g.purpose));
        w[4] = bytes32(uint256(uint160(g.publicationTarget)));
        w[5] = g.publicationTargetRuntimeHash;
        w[6] = bytes32(uint256(g.permissionRevision));
        w[7] = g.policyHash;
        w[8] = bytes32(uint256(g.withdrawalEpoch));
        w[9] = g.nonce;
        w[10] = bytes32(uint256(g.issuedAt));
        w[11] = bytes32(uint256(g.validAfter));
        w[12] = bytes32(uint256(g.expiresAt));
        w[13] = bytes32(uint256(g.submitBefore));
        return _typed(keccak256(abi.encode(w)));
    }

    function withdrawalDigest(PublicationWithdrawal calldata w) public view override returns (bytes32) {
        return _typed(
            keccak256(
                abi.encode(
                    WITHDRAWAL_TYPEHASH,
                    w.learner,
                    w.communityId,
                    keccak256(bytes(w.purpose)),
                    w.expectedEpoch,
                    w.nonce,
                    w.submitBefore
                )
            )
        );
    }

    function correctionDigest(PublicationCorrection calldata c) public view override returns (bytes32) {
        bytes32[17] memory w;
        w[0] = CORRECTION_TYPEHASH;
        w[1] = bytes32(uint256(uint160(c.learner)));
        w[2] = c.communityId;
        w[3] = keccak256(bytes(c.purpose));
        w[4] = bytes32(uint256(uint160(c.publicationTarget)));
        w[5] = c.publicationTargetRuntimeHash;
        w[6] = bytes32(uint256(c.permissionRevision));
        w[7] = c.policyHash;
        w[8] = bytes32(uint256(c.withdrawalEpoch));
        w[9] = c.resultId;
        w[10] = c.originalGrantId;
        w[11] = c.previousCommitment;
        w[12] = c.correctedCommitment;
        w[13] = c.reasonHash;
        w[14] = c.nonce;
        w[15] = bytes32(uint256(c.issuedAt));
        w[16] = bytes32(uint256(c.submitBefore));
        return _typed(keccak256(abi.encode(w)));
    }

    function _current(bytes32 p, uint64 revision, address target, bytes32 runtime, bytes32 policy)
        internal
        view
        returns (PurposeDescriptor memory d)
    {
        if (!_activeRegistry()) revert InvalidSource();
        PurposeState storage state = purposes[p];
        d = state.descriptor;
        if (
            !d.enabled || revision != state.revision || d.target != target || d.runtimeHash != runtime
                || d.policyHash != policy || !_code(target, runtime)
        ) revert InvalidDescriptor();
    }

    function grant(PublicationGrant calldata g, bytes calldata signature) external override {
        bytes32 p = _purpose(g.purpose);
        PurposeDescriptor memory d =
            _current(p, g.permissionRevision, g.publicationTarget, g.publicationTargetRuntimeHash, g.policyHash);
        if (g.communityId != communityId || g.withdrawalEpoch != withdrawalEpoch[g.learner][p]) {
            revert InvalidConsent();
        }
        if (
            g.issuedAt > g.validAfter || g.validAfter >= g.expiresAt || g.issuedAt > block.timestamp
                || block.timestamp >= g.submitBefore
                || g.submitBefore > uint256(g.issuedAt) + d.maxSubmissionDelaySeconds || g.submitBefore > g.expiresAt
                || g.expiresAt > uint256(g.issuedAt) + d.maxGrantDurationSeconds || block.timestamp > type(uint64).max
        ) revert InvalidWindow();
        bytes32 id = grantDigest(g);
        if (!_valid(g.learner, id, signature)) revert InvalidConsent();
        _consumeNonce(GRANT_TYPEHASH, g.learner, p, g.withdrawalEpoch, g.nonce);
        grants[id] = SavedGrant(g, uint64(block.timestamp));
        emit PublicationGranted(id, g.learner, p, g, uint64(block.timestamp));
    }

    function withdraw(PublicationWithdrawal calldata w, bytes calldata signature) external override {
        bytes32 p = _purpose(w.purpose);
        if (w.communityId != communityId || w.expectedEpoch != withdrawalEpoch[w.learner][p]) revert InvalidConsent();
        if (block.timestamp >= w.submitBefore) revert InvalidWindow();
        bytes32 id = withdrawalDigest(w);
        if (msg.sender != w.learner && !_valid(w.learner, id, signature)) revert InvalidConsent();
        _consumeNonce(WITHDRAWAL_TYPEHASH, w.learner, p, w.expectedEpoch, w.nonce);
        withdrawalEpoch[w.learner][p] = w.expectedEpoch + 1;
        emit PublicationWithdrawn(w.learner, p, w.expectedEpoch, w.expectedEpoch + 1, id);
    }

    function grantOf(bytes32 id) external view override returns (PublicationGrant memory, uint64 recordedAt) {
        SavedGrant storage saved = grants[id];
        return (saved.value, saved.recordedAt);
    }

    function checkGrant(bytes32 id, address learner, bytes32 p, address target, bytes32 policy, uint64 boundAt)
        public
        view
        override
        returns (bool allowed, uint8 reason)
    {
        SavedGrant storage saved = grants[id];
        PublicationGrant storage g = saved.value;
        Denial denial;
        if (g.learner == address(0)) {
            denial = Denial.UnknownGrant;
        } else if (
            g.learner != learner || keccak256(bytes(g.purpose)) != p || g.publicationTarget != target
                || g.policyHash != policy
        ) {
            denial = Denial.WrongScope;
        } else if (!_activeRegistry()) {
            denial = Denial.InactiveRegistry;
        } else {
            PurposeState storage state = purposes[p];
            PurposeDescriptor storage d = state.descriptor;
            if (
                !d.enabled || g.permissionRevision != state.revision || d.target != target
                    || d.runtimeHash != g.publicationTargetRuntimeHash || d.policyHash != policy
            ) {
                denial = Denial.SupersededDescriptor;
            } else if (!_code(target, d.runtimeHash)) {
                denial = Denial.ChangedTargetCode;
            } else if (g.withdrawalEpoch != withdrawalEpoch[learner][p]) {
                denial = Denial.Withdrawn;
            } else if (boundAt < saved.recordedAt || boundAt < g.validAfter || boundAt > block.timestamp) {
                denial = Denial.NotEffective;
            } else if (block.timestamp >= g.expiresAt) {
                denial = Denial.Expired;
            }
        }
        return (denial == Denial.None, uint8(denial));
    }

    function _consumeCorrection(PublicationCorrection calldata c, bytes calldata signature)
        internal
        returns (bytes32 id)
    {
        bytes32 p = _purpose(c.purpose);
        PurposeDescriptor memory d =
            _current(p, c.permissionRevision, c.publicationTarget, c.publicationTargetRuntimeHash, c.policyHash);
        if (
            c.communityId != communityId || c.publicationTarget != address(this)
                || c.withdrawalEpoch != withdrawalEpoch[c.learner][p] || c.resultId == 0 || c.originalGrantId == 0
                || c.previousCommitment == 0 || c.correctedCommitment == 0
        ) revert InvalidCorrection();
        if (
            c.issuedAt > block.timestamp || block.timestamp >= c.submitBefore
                || c.submitBefore > uint256(c.issuedAt) + d.maxSubmissionDelaySeconds
        ) revert InvalidWindow();
        id = correctionDigest(c);
        if (!_valid(c.learner, id, signature)) revert InvalidConsent();
        _consumeNonce(CORRECTION_TYPEHASH, c.learner, p, c.withdrawalEpoch, c.nonce);
    }

    function _valid(address learner, bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (learner == address(0)) return false;
        if (learner.code.length != 0) {
            try PublicationAccount1271(learner).isValidSignature(digest, signature) returns (bytes4 magic) {
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
        return ecrecover(digest, v, r, s) == learner;
    }
}
