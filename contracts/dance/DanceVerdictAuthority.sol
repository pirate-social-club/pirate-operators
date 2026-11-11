// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {ICommunityDirectoryV1 as Directory} from "../interfaces/community/ICommunityDirectoryV1.sol";
import {ICommunityPostsV1 as Posts} from "../interfaces/community/ICommunityPostsV1.sol";
import {DanceVerdictWire as Wire} from "./DanceVerdictWire.sol";

interface DanceLearningV4 {
    function VERSION() external view returns (uint8);
    function communityId() external view returns (bytes32);
    function authorizedSince(address learner) external view returns (uint64);
    function authorizationLearner(bytes32 id) external view returns (address);
    function authorizationIssuedAt(bytes32 id) external view returns (uint64);
}

/// @dev Resource epochs fence commands at their execution position. Only an
/// exact caller-scoped replay bypasses current guards and returns its first receipt.
abstract contract DanceVerdictAuthority {
    uint64 internal constant MAX_SAFE_MS = 9_007_199_254_740_991;
    uint8 public constant VERSION = 1;

    struct Deployment {
        bytes32 communityId;
        address directory;
        bytes32 directoryRuntimeHash;
        address v4;
        bytes32 v4RuntimeHash;
        address posts;
        bytes32 postsRuntimeHash;
        address publisher;
    }

    struct OwnerContext {
        uint64 epoch;
        uint64 configurationRevision;
        address controller;
        address wallet;
        uint64 validFromSeconds;
        uint64 expiresAtSeconds;
    }

    struct ReviewerRole {
        uint64 epoch;
        uint64 ownerEpoch;
        uint64 expiresAtSeconds;
        bool active;
    }

    struct Identity {
        address wallet;
        uint64 epoch;
        bytes32 groupId;
        uint64 groupEpoch;
        bool active;
    }

    struct KnownGroup {
        uint64 epoch;
        uint64 memberCount;
        uint64 pendingRebinds;
        bytes32 successor;
        bool active;
    }

    struct ReferenceState {
        uint64 epoch;
        uint64 revision;
        bytes32 segmentLayoutSha256;
        bool active;
    }

    struct Receipt {
        bytes32 commandHash;
        Wire.Operation operation;
        bytes32 resourceId;
        uint64 resourceEpoch;
        uint64 committedAtSeconds;
    }

    error InvalidSource();
    error Unauthorized();
    error StaleContext();
    error InvalidWindow();
    error InvalidCommand();
    error CommandConflict();
    error InvalidIdentity();
    error InvalidGroup();
    error InvalidReference();
    error InvalidRules();

    bytes32 public immutable communityId;
    Directory public immutable directory;
    bytes32 public immutable directoryRuntimeHash;
    DanceLearningV4 public immutable v4;
    bytes32 public immutable v4RuntimeHash;
    Posts public immutable posts;
    bytes32 public immutable postsRuntimeHash;
    address public immutable fixedPublisher;
    uint64 public immutable deploymentBlock;
    bytes32 public immutable publicityPolicyHash;
    bytes32 public immutable rulesSha256;
    bytes32 public immutable termsSha256;
    bytes32 public immutable rubricSha256;
    bytes32 public immutable mediaPolicySha256;
    bytes32 public immutable consentDisclosureSha256;
    bytes32 public immutable privacySha256;

    OwnerContext public ownerContext;
    uint64 public rulesEpoch;
    mapping(address => ReviewerRole) public reviewerRoles;
    mapping(bytes32 => Identity) public identities;
    mapping(bytes32 => KnownGroup) public groups;
    mapping(bytes32 => ReferenceState) public references;
    mapping(address => mapping(bytes32 => Receipt)) public commandReceipts;

    event CommandApplied(
        address indexed caller,
        bytes32 indexed commandId,
        Wire.Operation indexed operation,
        bytes32 commandHash,
        bytes32 resourceId,
        uint64 resourceEpoch,
        uint64 committedAtSeconds
    );

    constructor(Deployment memory p, Wire.Policy memory docs) {
        if (
            (block.chainid != 6343 && block.chainid != 31337) || p.communityId == 0 || p.publisher == address(0)
                || block.number > type(uint64).max || !_hasCode(p.directory, p.directoryRuntimeHash)
                || !_hasCode(p.v4, p.v4RuntimeHash) || !_hasCode(p.posts, p.postsRuntimeHash)
        ) revert InvalidSource();
        if (
            docs.rulesSha256 == 0 || docs.termsSha256 == 0 || docs.rubricSha256 == 0 || docs.mediaPolicySha256 == 0
                || docs.consentDisclosureSha256 == 0 || docs.privacySha256 == 0
        ) revert InvalidRules();
        communityId = p.communityId;
        directory = Directory(p.directory);
        directoryRuntimeHash = p.directoryRuntimeHash;
        v4 = DanceLearningV4(p.v4);
        v4RuntimeHash = p.v4RuntimeHash;
        posts = Posts(p.posts);
        postsRuntimeHash = p.postsRuntimeHash;
        fixedPublisher = p.publisher;
        deploymentBlock = uint64(block.number);
        publicityPolicyHash = Wire.policyHash(docs);
        rulesSha256 = docs.rulesSha256;
        termsSha256 = docs.termsSha256;
        rubricSha256 = docs.rubricSha256;
        mediaPolicySha256 = docs.mediaPolicySha256;
        consentDisclosureSha256 = docs.consentDisclosureSha256;
        privacySha256 = docs.privacySha256;
        _admittedCommunity();
    }

    function _hasCode(address target, bytes32 expected) private view returns (bool) {
        return target.code.length > 0 && target.codehash == expected;
    }

    function _domain() internal view returns (Wire.Domain memory) {
        return Wire.Domain(block.chainid, address(this), communityId);
    }

    function sourceHash() public view returns (bytes32) {
        Wire.SourcePin memory p;
        p.directory = address(directory);
        p.directoryRuntimeHash = directoryRuntimeHash;
        p.v4 = address(v4);
        p.v4RuntimeHash = v4RuntimeHash;
        p.posts = address(posts);
        p.postsRuntimeHash = postsRuntimeHash;
        p.fixedPublisher = fixedPublisher;
        p.publicityPolicyHash = publicityPolicyHash;
        p.rulesSha256 = rulesSha256;
        p.termsSha256 = termsSha256;
        p.rubricSha256 = rubricSha256;
        p.mediaPolicySha256 = mediaPolicySha256;
        p.deploymentBlock = deploymentBlock;
        p.runtimeCodeHash = address(this).codehash;
        return Wire.sourceHash(_domain(), p);
    }

    function _seconds() internal view returns (uint64) {
        if (block.timestamp == 0 || block.timestamp > MAX_SAFE_MS / 1000) revert InvalidWindow();
        return uint64(block.timestamp);
    }

    function _directoryCommunity() internal view returns (Directory.Community memory c) {
        if (!_hasCode(address(directory), directoryRuntimeHash)) revert InvalidSource();
        c = directory.getCommunity(communityId);
        if (c.configurationRevision == 0 || c.configuration.controller == address(0)) revert InvalidSource();
    }

    function _admittedCommunity() private view returns (Directory.Community memory c) {
        c = _directoryCommunity();
        if (
            c.configuration.publisher != fixedPublisher || c.configuration.learningRecords != address(v4)
                || !_hasCode(address(v4), v4RuntimeHash) || !_hasCode(address(posts), postsRuntimeHash)
                || v4.VERSION() != 4 || v4.communityId() != communityId || posts.directory() != address(directory)
        ) revert InvalidSource();
    }

    function _context(uint64 epoch, uint64 revision) internal view returns (OwnerContext memory owner) {
        Directory.Community memory c = _admittedCommunity();
        owner = ownerContext;
        uint64 nowSeconds = _seconds();
        if (
            epoch == 0 || owner.epoch != epoch || owner.configurationRevision != revision
                || c.configurationRevision != revision || c.configuration.controller != owner.controller
                || nowSeconds < owner.validFromSeconds || nowSeconds >= owner.expiresAtSeconds
        ) revert StaleContext();
    }

    function _publisher(uint64 epoch, uint64 revision) internal view returns (OwnerContext memory owner) {
        if (msg.sender != fixedPublisher) revert Unauthorized();
        return _context(epoch, revision);
    }

    function _existing(bytes32 id, bytes32 supplied, Wire.Operation op, bytes memory encodedPayload)
        internal
        view
        returns (Receipt memory prior)
    {
        bytes32 computed = Wire.commandHash(_domain(), op, msg.sender, id, encodedPayload);
        if (id == 0 || supplied != computed) revert InvalidCommand();
        prior = commandReceipts[msg.sender][id];
        if (prior.operation != Wire.Operation.Unknown && prior.commandHash != computed) revert CommandConflict();
    }

    function _remember(bytes32 id, bytes32 hash, Wire.Operation op, bytes32 resource, uint64 epoch)
        internal
        returns (Receipt memory saved)
    {
        saved = Receipt(hash, op, resource, epoch, _seconds());
        commandReceipts[msg.sender][id] = saved;
        emit CommandApplied(msg.sender, id, op, hash, resource, epoch, saved.committedAtSeconds);
    }

    function _walletResource(address wallet) private pure returns (bytes32) {
        return bytes32(uint256(uint160(wallet)));
    }

    function configureOwner(bytes32 id, bytes32 hash, Wire.ConfigureOwner calldata p)
        external
        returns (Receipt memory)
    {
        Receipt memory prior = _existing(id, hash, Wire.Operation.ConfigureOwner, abi.encode(p));
        if (prior.operation != Wire.Operation.Unknown) return prior;
        Directory.Community memory c = _admittedCommunity();
        if (msg.sender != c.configuration.controller) revert Unauthorized();
        if (
            p.expectedOwnerEpoch != ownerContext.epoch || p.expectedConfigurationRevision != c.configurationRevision
                || p.expectedController != c.configuration.controller || p.expectedPublisher != fixedPublisher
                || p.expectedV4 != address(v4) || p.policyHash != publicityPolicyHash || p.ownerWallet == address(0)
        ) revert StaleContext();
        if (
            p.validFromSeconds == 0 || p.validFromSeconds >= p.expiresAtSeconds || p.expiresAtSeconds <= _seconds()
                || p.expiresAtSeconds > MAX_SAFE_MS / 1000
        ) revert InvalidWindow();
        uint64 epoch = p.expectedOwnerEpoch + 1;
        ownerContext = OwnerContext(
            epoch,
            c.configurationRevision,
            c.configuration.controller,
            p.ownerWallet,
            p.validFromSeconds,
            p.expiresAtSeconds
        );
        return _remember(id, hash, Wire.Operation.ConfigureOwner, _walletResource(p.ownerWallet), epoch);
    }

    function grantReviewer(bytes32 id, bytes32 hash, Wire.GrantReviewer calldata p) external returns (Receipt memory) {
        Receipt memory prior = _existing(id, hash, Wire.Operation.GrantReviewer, abi.encode(p));
        if (prior.operation != Wire.Operation.Unknown) return prior;
        OwnerContext memory owner = _context(p.expectedOwnerEpoch, p.expectedConfigurationRevision);
        if (msg.sender != owner.wallet || p.reviewerWallet == address(0)) revert Unauthorized();
        if (reviewerRoles[p.reviewerWallet].epoch != p.expectedReviewerEpoch) revert StaleContext();
        if (p.expiresAtSeconds <= _seconds() || p.expiresAtSeconds > owner.expiresAtSeconds) revert InvalidWindow();
        uint64 epoch = p.expectedReviewerEpoch + 1;
        reviewerRoles[p.reviewerWallet] = ReviewerRole(epoch, owner.epoch, p.expiresAtSeconds, true);
        return _remember(id, hash, Wire.Operation.GrantReviewer, _walletResource(p.reviewerWallet), epoch);
    }

    function revokeReviewer(bytes32 id, bytes32 hash, Wire.RevokeReviewer calldata p)
        external
        returns (Receipt memory)
    {
        Receipt memory prior = _existing(id, hash, Wire.Operation.RevokeReviewer, abi.encode(p));
        if (prior.operation != Wire.Operation.Unknown) return prior;
        OwnerContext memory owner = _context(p.expectedOwnerEpoch, p.expectedConfigurationRevision);
        if (msg.sender != owner.wallet || p.reviewerWallet == address(0)) revert Unauthorized();
        if (reviewerRoles[p.reviewerWallet].epoch != p.expectedReviewerEpoch) revert StaleContext();
        uint64 epoch = p.expectedReviewerEpoch + 1;
        reviewerRoles[p.reviewerWallet] = ReviewerRole(epoch, owner.epoch, 0, false);
        return _remember(id, hash, Wire.Operation.RevokeReviewer, _walletResource(p.reviewerWallet), epoch);
    }

    function bindIdentity(bytes32 id, bytes32 hash, Wire.BindIdentity calldata p) external returns (Receipt memory) {
        Receipt memory prior = _existing(id, hash, Wire.Operation.BindIdentity, abi.encode(p));
        if (prior.operation != Wire.Operation.Unknown) return prior;
        _publisher(p.expectedOwnerEpoch, p.expectedConfigurationRevision);
        Identity storage identity = identities[p.accountCommitment];
        if (p.accountCommitment == 0 || p.wallet == address(0) || identity.epoch != p.expectedIdentityEpoch) {
            revert InvalidIdentity();
        }
        uint64 destinationEpoch = p.destinationGroupEpoch;
        if (identity.epoch == 0) {
            if (
                !p.createSingleton || p.sourceGroupId != 0 || p.sourceBindingGroupEpoch != 0
                    || p.sourceCurrentGroupEpoch != 0 || destinationEpoch != 0
                    || p.destinationGroupId != Wire.singletonId(_domain(), p.accountCommitment)
                    || groups[p.destinationGroupId].epoch != 0
            ) revert InvalidIdentity();
            destinationEpoch = 1;
            groups[p.destinationGroupId] = KnownGroup(1, 1, 0, 0, true);
        } else {
            _updateGroupBinding(identity, p);
        }
        uint64 epoch = identity.epoch + 1;
        identities[p.accountCommitment] = Identity(p.wallet, epoch, p.destinationGroupId, destinationEpoch, p.active);
        return _remember(id, hash, Wire.Operation.BindIdentity, p.accountCommitment, epoch);
    }

    function _updateGroupBinding(Identity storage identity, Wire.BindIdentity calldata p) private {
        KnownGroup storage source = groups[identity.groupId];
        if (
            p.createSingleton || identity.wallet != p.wallet || identity.groupId != p.sourceGroupId
                || identity.groupEpoch != p.sourceBindingGroupEpoch || source.epoch != p.sourceCurrentGroupEpoch
        ) revert InvalidIdentity();
        if (source.active) {
            if (
                p.destinationGroupId != identity.groupId || p.destinationGroupEpoch != source.epoch
                    || identity.groupEpoch != source.epoch
            ) revert InvalidIdentity();
            return;
        }
        KnownGroup storage destination = groups[p.destinationGroupId];
        if (
            source.successor != p.destinationGroupId || !destination.active
                || destination.epoch != p.destinationGroupEpoch || p.active != identity.active
                || source.memberCount == 0 || destination.pendingRebinds == 0
        ) revert InvalidIdentity();
        source.memberCount--;
        destination.pendingRebinds--;
        destination.memberCount++;
    }

    function mergeGroups(bytes32 id, bytes32 hash, Wire.MergeGroups calldata p) external returns (Receipt memory) {
        Receipt memory prior = _existing(id, hash, Wire.Operation.MergeGroups, abi.encode(p));
        if (prior.operation != Wire.Operation.Unknown) return prior;
        _publisher(p.expectedOwnerEpoch, p.expectedConfigurationRevision);
        KnownGroup storage left = groups[p.leftGroupId];
        KnownGroup storage right = groups[p.rightGroupId];
        if (
            p.leftGroupId == p.rightGroupId || !left.active || !right.active || left.epoch != p.expectedLeftEpoch
                || right.epoch != p.expectedRightEpoch || left.pendingRebinds != 0 || right.pendingRebinds != 0
                || p.newGroupId == 0 || groups[p.newGroupId].epoch != 0
        ) revert InvalidGroup();
        uint64 rebinds = left.memberCount + right.memberCount;
        left.active = false;
        left.epoch++;
        left.successor = p.newGroupId;
        right.active = false;
        right.epoch++;
        right.successor = p.newGroupId;
        groups[p.newGroupId] = KnownGroup(1, 0, rebinds, 0, true);
        return _remember(id, hash, Wire.Operation.MergeGroups, p.newGroupId, 1);
    }

    function setReference(bytes32 id, bytes32 hash, Wire.SetReference calldata p) external returns (Receipt memory) {
        Receipt memory prior = _existing(id, hash, Wire.Operation.SetReference, abi.encode(p));
        if (prior.operation != Wire.Operation.Unknown) return prior;
        _publisher(p.expectedOwnerEpoch, p.expectedConfigurationRevision);
        ReferenceState memory current = references[p.referenceId];
        if (
            p.referenceId == 0 || p.segmentLayoutSha256 == 0 || p.revision == 0
                || current.epoch != p.expectedReferenceEpoch
        ) {
            revert InvalidReference();
        }
        if (p.active ? p.revision <= current.revision : !current.active || p.revision < current.revision) {
            revert InvalidReference();
        }
        if (p.revision == current.revision && p.segmentLayoutSha256 != current.segmentLayoutSha256) {
            revert InvalidReference();
        }
        uint64 epoch = current.epoch + 1;
        references[p.referenceId] = ReferenceState(epoch, p.revision, p.segmentLayoutSha256, p.active);
        return _remember(id, hash, Wire.Operation.SetReference, p.referenceId, epoch);
    }

    function invalidateRules(bytes32 id, bytes32 hash, Wire.InvalidateRules calldata p)
        external
        returns (Receipt memory)
    {
        Receipt memory prior = _existing(id, hash, Wire.Operation.InvalidateRules, abi.encode(p));
        if (prior.operation != Wire.Operation.Unknown) return prior;
        Directory.Community memory c = _directoryCommunity();
        if (p.expectedConfigurationRevision != c.configurationRevision) revert StaleContext();
        if (msg.sender == c.configuration.controller) {
            if (p.expectedOwnerEpoch != 0 && p.expectedOwnerEpoch != ownerContext.epoch) revert StaleContext();
        } else {
            OwnerContext memory owner = _context(p.expectedOwnerEpoch, p.expectedConfigurationRevision);
            if (msg.sender != owner.wallet) revert Unauthorized();
        }
        if (p.expectedRulesEpoch != 0 || rulesEpoch != 0) revert InvalidRules();
        rulesEpoch = 1;
        return _remember(id, hash, Wire.Operation.InvalidateRules, publicityPolicyHash, 1);
    }
}
