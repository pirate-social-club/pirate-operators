// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import {LearningResultsV5} from "../../contracts/LearningResultsV5.sol";
import {
    ICommunityPublicationConsentV1 as C
} from "../../contracts/interfaces/community/ICommunityPublicationConsentV1.sol";
import {CommunityDirectoryV3} from "../../contracts/community/CommunityDirectoryV3.sol";
import {ICommunityDirectoryV3 as D} from "../../contracts/interfaces/community/ICommunityDirectoryV3.sol";
import {ICommunityDirectoryV1 as V1} from "../../contracts/interfaces/community/ICommunityDirectoryV1.sol";
import {CommunityPostsV1} from "../../contracts/community/CommunityPostsV1.sol";

interface ConsentVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function warp(uint256) external;
    function chainId(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function etch(address, bytes calldata) external;
    function getCode(string calldata) external view returns (bytes memory);
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

abstract contract PublicationFixture {
    event RuntimeEvidence(string contractName, bytes runtime, bytes constructorArgs);
    ConsentVm constant vm = ConsentVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant OWNER = address(0x101);
    address constant PUBLISHER = address(0x102);
    address constant REGISTRAR = address(0x103);
    uint256 constant LEARNER_KEY = 0x123ab;
    uint256 constant REVIEWER_KEY = 0x456ab;
    bytes32 constant KEY = keccak256("consent-community");
    bytes32 constant POLICY = bytes32(0x1d2ea4ae13cce1616602f7b4613ad1d59d85231a1a43be2de0f93f28a062b2de);
    string constant URI = "ipfs://bafkreigh2akiscaildc6c3bwi6f6t3kp34lwd77d5ppf2v3atx7q7hkwgy";
    CommunityDirectoryV3 directory;
    LearningResultsV5 learning;
    CommunityPostsV1 posts;
    bytes32 communityId;
    address learner;

    function deployArtifact(string memory artifact, bytes memory args) internal returns (address result) {
        bytes memory code = bytes.concat(vm.getCode(artifact), args);
        assembly ("memory-safe") { result := create(0, add(code, 32), mload(code)) }
        require(result != address(0), "fixture_deploy");
    }

    function setUp() public virtual {
        vm.chainId(31337);
        vm.warp(1793552400 + 10 days);
        directory = CommunityDirectoryV3(
            deployArtifact("out/CommunityDirectoryV3.sol/CommunityDirectoryV3.json", abi.encode(address(this)))
        );
        communityId = directory.communityIdFor(KEY);
        learning = LearningResultsV5(
            deployArtifact(
                "out/LearningResultsV5.sol/LearningResultsV5.json",
                abi.encode(address(directory), address(directory).codehash, communityId)
            )
        );
        posts = CommunityPostsV1(
            deployArtifact("out/CommunityPostsV1.sol/CommunityPostsV1.json", abi.encode(address(directory)))
        );
        directory.configureRegistrar(REGISTRAR, uint64(block.timestamp + 1 days), 10, 0);
        vm.prank(REGISTRAR);
        require(
            directory.registerHostedCommunity(
                D.HostingBinding(KEY, keccak256("installation")),
                config(PUBLISHER, address(learning)),
                bytes32(0x5ea1c1496ae485da327664ced22f2dc35ee4cb01633fdd083e2153569fcb3a78),
                1
            ) == communityId
        );
        learner = vm.addr(LEARNER_KEY);
    }

    function config(address publisher, address records) internal pure returns (V1.Configuration memory) {
        return V1.Configuration(
            OWNER,
            publisher,
            address(0),
            records,
            bytes32(0xb0d4913f313bf0e18b6ec2d81d84ff748bdd415a26cb32243978b22b248567bc),
            URI
        );
    }

    function descriptor(string memory name, address target, bytes32 policy) internal {
        (uint64 prior,) = learning.purpose(keccak256(bytes(name)));
        uint64 revision = directory.getCommunity(communityId).configurationRevision;
        vm.prank(OWNER);
        learning.configurePurpose(
            name, prior, revision, C.PurposeDescriptor(target, target.codehash, policy, 30 days, 900, true)
        );
    }

    function grantValue(address wallet, string memory name, address target, bytes32 policy, bytes32 nonce)
        internal
        view
        returns (C.PublicationGrant memory g)
    {
        (uint64 revision,) = learning.purpose(keccak256(bytes(name)));
        g = C.PublicationGrant(
            wallet,
            communityId,
            name,
            target,
            target.codehash,
            revision,
            policy,
            learning.withdrawalEpoch(wallet, keccak256(bytes(name))),
            nonce,
            uint64(block.timestamp),
            uint64(block.timestamp),
            uint64(block.timestamp + 14 days),
            uint64(block.timestamp + 600)
        );
    }

    function signature(uint256 key, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function authorize(uint256 key, string memory name, address target, bytes32 policy, bytes32 nonce)
        internal
        returns (bytes32 id)
    {
        C.PublicationGrant memory g = grantValue(vm.addr(key), name, target, policy, nonce);
        id = learning.grantDigest(g);
        learning.grant(g, signature(key, id));
    }

    function withdraw(address wallet, string memory name) internal {
        C.PublicationWithdrawal memory w = C.PublicationWithdrawal(
            wallet,
            communityId,
            name,
            learning.withdrawalEpoch(wallet, keccak256(bytes(name))),
            keccak256("withdraw"),
            uint64(block.timestamp + 60)
        );
        vm.prank(wallet);
        learning.withdraw(w, "");
    }

    function allowed(bytes32 id, address wallet, string memory name, address target, bytes32 policy, uint64 at)
        internal
        view
        returns (bool)
    {
        (bool ok,) = learning.checkGrant(id, wallet, keccak256(bytes(name)), target, policy, at);
        return ok;
    }
}

contract Consent1271Fixture {
    bytes32 public expected;
    uint8 public mode;

    function configure(bytes32 digest, uint8 value) external {
        expected = digest;
        mode = value;
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        require(mode != 2, "account_refused");
        return mode == 0 && digest == expected ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract PublicationConsentV1Test is PublicationFixture {
    function testDeployedRuntimeEvidenceAndConstructorPins() public {
        require(learning.communityId() == communityId && address(learning.directory()) == address(directory));
        require(
            learning.directoryRuntimeHash() == address(directory).codehash && learning.VERSION() == 5
                && learning.consentVersion() == 1
        );
        emit RuntimeEvidence(
            "LearningResultsV5",
            address(learning).code,
            abi.encode(address(directory), address(directory).codehash, communityId)
        );
    }

    function testFixedTypedVectorsAgainstActualContractDigestFunctions() public {
        address fixedAddress = 0x2222222222222222222222222222222222222222;
        vm.etch(fixedAddress, address(learning).code);
        LearningResultsV5 fixedRegistry = LearningResultsV5(fixedAddress);
        C.PublicationGrant memory g = C.PublicationGrant(
            0x1111111111111111111111111111111111111111,
            0x3333333333333333333333333333333333333333333333333333333333333333,
            "karaoke-results",
            fixedAddress,
            0x4444444444444444444444444444444444444444444444444444444444444444,
            1,
            0x5555555555555555555555555555555555555555555555555555555555555555,
            0,
            0x6666666666666666666666666666666666666666666666666666666666666666,
            1800000000,
            1800000000,
            1800003600,
            1800000600
        );
        require(fixedRegistry.grantDigest(g) == 0x1ce5f32e2f8d407fb29a2bcfad26b7aacedacdbe9eabb15a6b2faddc3b46368d);
        C.PublicationWithdrawal memory w =
            C.PublicationWithdrawal(g.learner, g.communityId, g.purpose, 0, g.nonce, g.submitBefore);
        require(fixedRegistry.withdrawalDigest(w) == 0x5a960761f5bb48d04b38af3b3b74fb497c5e5d07360c434d027f04a95df68b6d);
        C.PublicationCorrection memory c = C.PublicationCorrection(
            g.learner,
            g.communityId,
            g.purpose,
            fixedAddress,
            g.publicationTargetRuntimeHash,
            1,
            g.policyHash,
            1,
            0x7777777777777777777777777777777777777777777777777777777777777777,
            0x8888888888888888888888888888888888888888888888888888888888888888,
            0x9999999999999999999999999999999999999999999999999999999999999999,
            0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,
            0,
            g.nonce,
            g.issuedAt,
            g.submitBefore
        );
        require(fixedRegistry.correctionDigest(c) == 0x0f7b6ce0a7e8bd00c2280dc34699c86e5951460aaf6c1fc4ac1d4590a4ef0ccf);
    }

    function testDisabledByDefaultAndCurrentControllerRevisionRequired() public {
        C.PublicationGrant memory g =
            grantValue(learner, "karaoke-results", address(learning), POLICY, bytes32(uint256(1)));
        vm.expectRevert(C.InvalidDescriptor.selector);
        learning.grant(g, "");
        C.PurposeDescriptor memory d =
            C.PurposeDescriptor(address(learning), address(learning).codehash, POLICY, 30 days, 900, true);
        vm.expectRevert(C.Unauthorized.selector);
        learning.configurePurpose("karaoke-results", 0, 1, d);
        vm.prank(OWNER);
        vm.expectRevert(C.StaleRevision.selector);
        learning.configurePurpose("karaoke-results", 0, 2, d);
        descriptor("karaoke-results", address(learning), POLICY);
    }

    function testRealEoaGrantReceiptAndIndependentTypedPreimage() public {
        descriptor("karaoke-results", address(learning), POLICY);
        C.PublicationGrant memory g =
            grantValue(learner, "karaoke-results", address(learning), POLICY, bytes32(uint256(1)));
        bytes32 inner = keccak256(
            bytes.concat(
                abi.encode(learning.GRANT_TYPEHASH(), g.learner, g.communityId, keccak256(bytes(g.purpose))),
                abi.encode(
                    g.publicationTarget,
                    g.publicationTargetRuntimeHash,
                    g.permissionRevision,
                    g.policyHash,
                    g.withdrawalEpoch,
                    g.nonce
                ),
                abi.encode(g.issuedAt, g.validAfter, g.expiresAt, g.submitBefore)
            )
        );
        bytes32 id = keccak256(abi.encodePacked("\x19\x01", learning.DOMAIN_SEPARATOR(), inner));
        require(id == learning.grantDigest(g));
        vm.recordLogs();
        learning.grant(g, signature(LEARNER_KEY, id));
        ConsentVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].topics[1] == id && logs[0].topics[2] == bytes32(uint256(uint160(learner))));
        (C.PublicationGrant memory saved, uint64 at) = learning.grantOf(id);
        require(keccak256(abi.encode(saved)) == keccak256(abi.encode(g)) && at == block.timestamp);
        require(allowed(id, learner, g.purpose, address(learning), POLICY, at));
        vm.expectRevert(C.NonceUsed.selector);
        learning.grant(g, signature(LEARNER_KEY, id));
    }

    function testAlteredSignedBindingsAndChainCannotConsumeNonce() public {
        descriptor("karaoke-results", address(learning), POLICY);
        C.PublicationGrant memory g =
            grantValue(learner, "karaoke-results", address(learning), POLICY, bytes32(uint256(1)));
        bytes memory sig = signature(LEARNER_KEY, learning.grantDigest(g));
        g.nonce = bytes32(uint256(2));
        vm.expectRevert(C.InvalidConsent.selector);
        learning.grant(g, sig);
        g.nonce = bytes32(uint256(1));
        vm.chainId(6343);
        vm.expectRevert(C.InvalidConsent.selector);
        learning.grant(g, sig);
        vm.chainId(31337);
        g.communityId = bytes32(uint256(9));
        vm.expectRevert(C.InvalidConsent.selector);
        learning.grant(g, sig);
        g.communityId = communityId;
        g.policyHash = bytes32(uint256(7));
        vm.expectRevert(C.InvalidDescriptor.selector);
        learning.grant(g, sig);
        g.policyHash = POLICY;
        learning.grant(g, sig);
    }

    function testWithdrawalFencesQueuedGrantAndRegrantDoesNotSubstituteOriginal() public {
        descriptor("karaoke-results", address(learning), POLICY);
        C.PublicationGrant memory queued =
            grantValue(learner, "karaoke-results", address(learning), POLICY, bytes32(uint256(1)));
        bytes memory sig = signature(LEARNER_KEY, learning.grantDigest(queued));
        bytes32 old = authorize(LEARNER_KEY, queued.purpose, address(learning), POLICY, bytes32(uint256(2)));
        withdraw(learner, queued.purpose);
        vm.expectRevert(C.InvalidConsent.selector);
        learning.grant(queued, sig);
        bytes32 fresh = authorize(LEARNER_KEY, queued.purpose, address(learning), POLICY, bytes32(uint256(1)));
        require(!allowed(old, learner, queued.purpose, address(learning), POLICY, uint64(block.timestamp)));
        require(allowed(fresh, learner, queued.purpose, address(learning), POLICY, uint64(block.timestamp)));
    }

    function testExclusiveSubmissionExpiryAndDelayedEffectiveStart() public {
        descriptor("karaoke-results", address(learning), POLICY);
        C.PublicationGrant memory g =
            grantValue(learner, "karaoke-results", address(learning), POLICY, bytes32(uint256(1)));
        uint64 start = g.issuedAt;
        bytes32 id = learning.grantDigest(g);
        bytes memory sig = signature(LEARNER_KEY, id);
        vm.warp(start + 10);
        learning.grant(g, sig);
        require(!allowed(id, learner, g.purpose, address(learning), POLICY, start));
        require(allowed(id, learner, g.purpose, address(learning), POLICY, start + 10));
        vm.warp(g.expiresAt);
        require(!allowed(id, learner, g.purpose, address(learning), POLICY, start + 10));
        g = grantValue(learner, g.purpose, address(learning), POLICY, bytes32(uint256(2)));
        sig = signature(LEARNER_KEY, learning.grantDigest(g));
        vm.warp(g.submitBefore);
        vm.expectRevert(C.InvalidWindow.selector);
        learning.grant(g, sig);
    }

    function testDescriptorAbaDoesNotReviveAndOriginRotationDoesNotRevoke() public {
        descriptor("karaoke-results", address(learning), POLICY);
        bytes32 id = authorize(LEARNER_KEY, "karaoke-results", address(learning), POLICY, bytes32(uint256(1)));
        vm.prank(OWNER);
        directory.configureHostedCommunity(
            communityId, 1, config(address(0x104), address(learning)), keccak256("https://new.example")
        );
        require(allowed(id, learner, "karaoke-results", address(learning), POLICY, uint64(block.timestamp)));
        descriptor(
            "karaoke-results",
            address(learning),
            bytes32(0xd9298a10d1b0735837dc4bd85dac641b0f3cef27a47e5d53a54f2f3f5b2fcffa)
        );
        descriptor("karaoke-results", address(learning), POLICY);
        require(!allowed(id, learner, "karaoke-results", address(learning), POLICY, uint64(block.timestamp)));
    }

    function testReplacementDisablesGrantButRetainsWithdrawalAndHistory() public {
        descriptor("karaoke-results", address(learning), POLICY);
        bytes32 id = authorize(LEARNER_KEY, "karaoke-results", address(learning), POLICY, bytes32(uint256(1)));
        vm.prank(OWNER);
        directory.configure(communityId, 1, config(PUBLISHER, address(0)));
        require(!allowed(id, learner, "karaoke-results", address(learning), POLICY, uint64(block.timestamp)));
        withdraw(learner, "karaoke-results");
        (C.PublicationGrant memory saved,) = learning.grantOf(id);
        require(saved.learner == learner);
    }

    function testCodeAccountUses1271AndRefusalRevertCannotConsumeNonce() public {
        descriptor("karaoke-results", address(learning), POLICY);
        Consent1271Fixture account = new Consent1271Fixture();
        C.PublicationGrant memory g =
            grantValue(address(account), "karaoke-results", address(learning), POLICY, bytes32(uint256(1)));
        bytes32 id = learning.grantDigest(g);
        account.configure(id, 1);
        vm.expectRevert(C.InvalidConsent.selector);
        learning.grant(g, hex"1234");
        account.configure(id, 2);
        vm.expectRevert(C.InvalidConsent.selector);
        learning.grant(g, hex"1234");
        account.configure(id, 0);
        learning.grant(g, hex"1234");
        require(allowed(id, address(account), g.purpose, address(learning), POLICY, uint64(block.timestamp)));
    }

    function testChangedDirectoryCodeAndWrongPurposeAreDenied() public {
        descriptor("karaoke-results", address(learning), POLICY);
        bytes32 id = authorize(LEARNER_KEY, "karaoke-results", address(learning), POLICY, bytes32(uint256(1)));
        require(!allowed(id, learner, "study-results", address(learning), POLICY, uint64(block.timestamp)));
        vm.etch(address(directory), hex"00");
        require(!allowed(id, learner, "karaoke-results", address(learning), POLICY, uint64(block.timestamp)));
    }
}
