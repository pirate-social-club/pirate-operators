// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import {CommunityDirectoryV2} from "../../../contracts/community/CommunityDirectoryV2.sol";
import {ICommunityDirectoryV2 as D} from "../../../contracts/interfaces/community/ICommunityDirectoryV2.sol";
import {ICommunityDirectoryV1 as V1} from "../../../contracts/interfaces/community/ICommunityDirectoryV1.sol";
import {CommunityPostsV1} from "../../../contracts/community/CommunityPostsV1.sol";
import {ICommunityPostsV1 as Posts} from "../../../contracts/interfaces/community/ICommunityPostsV1.sol";

interface SharedDirectoryVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function chainId(uint256) external;
    function prank(address) external;
    function warp(uint256) external;
    function etch(address, bytes calldata) external;
    function expectRevert(bytes4) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

// Deliberately has no factory/admin/tld getters. Source pinning must suffice for
// directory enrollment, while issuance and HNS authority remain unproven.
contract SharedRegistryCodeFixture {
    function marker() external pure returns (uint256) {
        return 3;
    }
}

contract CommunityDirectoryV2Test {
    SharedDirectoryVm constant vm = SharedDirectoryVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    CommunityDirectoryV2 directory;
    address registry;
    address constant CONTROLLER = address(0x1111);
    address constant PUBLISHER = address(0x2222);
    address constant OTHER = address(0x3333);
    bytes32 constant KEY = keccak256("portable-community");
    string constant URI = "ipfs://bafkreigh2akiscaildc6c3bwi6f6t3kp34lwd77d5ppf2v3atx7q7hkwgy";

    function setUp() public {
        vm.chainId(31337);
        directory = new CommunityDirectoryV2(address(this), 86400);
        registry = address(new SharedRegistryCodeFixture());
        directory.admitRegistry(registry, source());
    }

    function source() internal view returns (D.RegistrySource memory) {
        return D.RegistrySource(registry.codehash, bytes20(uint160(123)), keccak256("fixture-abi"));
    }

    function binding(bytes32 key, string memory tld) internal view returns (D.Binding memory) {
        D.RegistrySource memory s = source();
        return D.Binding(
            key,
            keccak256("installation"),
            sha256(bytes("https://community.example")),
            keccak256(abi.encode(keccak256("pirate.namespace/1"), keccak256(bytes(tld)))),
            s.runtimeCodeHash,
            s.sourceCommit,
            s.abiSha256
        );
    }

    function config(address controller, address publisher) internal pure returns (V1.Configuration memory) {
        return V1.Configuration(controller, publisher, address(0), address(0), keccak256("config"), URI);
    }

    function register() internal returns (bytes32) {
        return
            directory.registerSharedCommunity(
                registry, "fixture", binding(KEY, "fixture"), config(CONTROLLER, PUBLISHER)
            );
    }

    function testPortableKeyIdentityAndNamespaceAreIndependentOfRegistry() public {
        bytes32 id = register();
        require(id == keccak256(abi.encode(keccak256("pirate.community/2"), uint256(31337), KEY)));
        require(id != keccak256(abi.encode(block.chainid, registry)));
        require(
            directory.namespaceIdFor("fixture")
                == keccak256(abi.encode(keccak256("pirate.namespace/1"), keccak256("fixture")))
        );
        bytes32 second = directory.registerSharedCommunity(
            registry, "fixture", binding(keccak256("second"), "fixture"), config(CONTROLLER, PUBLISHER)
        );
        require(second != id && directory.getCommunity(second).registry == directory.getCommunity(id).registry);
        D.Binding memory duplicate = binding(KEY, "other");
        vm.expectRevert(V1.AlreadyRegistered.selector);
        directory.registerSharedCommunity(registry, "other", duplicate, config(CONTROLLER, PUBLISHER));
    }

    function testRegistrationEventsBindExactIdentityAndConfiguration() public {
        vm.recordLogs();
        bytes32 id = register();
        SharedDirectoryVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 3 && logs[1].topics[1] == id && logs[2].topics[1] == id);
        require(
            logs[1].topics[0]
                == keccak256("CommunityBound(bytes32,(bytes32,bytes32,bytes32,bytes32,bytes32,bytes20,bytes32))")
        );
        D.Binding memory observed = abi.decode(logs[1].data, (D.Binding));
        require(keccak256(abi.encode(observed)) == keccak256(abi.encode(binding(KEY, "fixture"))));
        require(!directory.isDiscoverable(id));
    }

    function testPublicKeyKnowledgeCannotFrontRunEnrollment() public {
        D.Binding memory requested = binding(KEY, "fixture");
        vm.prank(OTHER);
        vm.expectRevert(V1.Unauthorized.selector);
        directory.registerSharedCommunity(registry, "fixture", requested, config(OTHER, OTHER));
        register();
    }

    function testSourcePinsAndCanonicalTldRefuse() public {
        D.Binding memory b = binding(KEY, "fixture");
        b.abiSha256 = bytes32(uint256(1));
        vm.expectRevert(V1.InvalidRegistry.selector);
        directory.registerSharedCommunity(registry, "fixture", b, config(CONTROLLER, PUBLISHER));
        b = binding(KEY, "fixture");
        b.installationId = bytes32(0);
        vm.expectRevert(D.InvalidBinding.selector);
        directory.registerSharedCommunity(registry, "fixture", b, config(CONTROLLER, PUBLISHER));
        vm.expectRevert(D.InvalidBinding.selector);
        directory.namespaceIdFor("fixture\n");
        vm.expectRevert(D.InvalidBinding.selector);
        directory.namespaceIdFor("xn--fixture");
        vm.expectRevert(D.InvalidBinding.selector);
        directory.namespaceIdFor("Fixture");
        vm.expectRevert(D.InvalidBinding.selector);
        directory.namespaceIdFor("fixture.");
        vm.etch(registry, hex"60006000fd");
        b = binding(KEY, "fixture");
        vm.expectRevert(V1.InvalidRegistry.selector);
        directory.registerSharedCommunity(registry, "fixture", b, config(CONTROLLER, PUBLISHER));
    }

    function testAdminHandoverIsTwoStepAndCannotSeizeCommunityConfiguration() public {
        bytes32 id = register();
        vm.prank(OTHER);
        vm.expectRevert(V1.Unauthorized.selector);
        directory.proposeAdmin(OTHER);
        directory.proposeAdmin(OTHER);
        require(directory.admin() == address(this));
        vm.expectRevert(V1.Unauthorized.selector);
        directory.acceptAdmin();
        vm.prank(OTHER);
        directory.acceptAdmin();
        require(directory.admin() == OTHER && directory.pendingAdmin() == address(0));
        vm.prank(OTHER);
        vm.expectRevert(V1.Unauthorized.selector);
        directory.configure(id, 1, config(OTHER, OTHER));
        vm.expectRevert(V1.Unauthorized.selector);
        directory.proposeAdmin(address(this));
        vm.prank(CONTROLLER);
        directory.configure(id, 1, config(CONTROLLER, OTHER));
    }

    function testNonAdminCannotAdmitAttestOrList() public {
        bytes32 id = register();
        vm.prank(OTHER);
        vm.expectRevert(V1.Unauthorized.selector);
        directory.admitRegistry(registry, source());
        V1.NamespaceVerification memory proof = V1.NamespaceVerification(
            1, 1, bytes32(uint256(1)), uint64(block.timestamp), uint64(block.timestamp + 60), bytes32(uint256(2))
        );
        vm.prank(OTHER);
        vm.expectRevert(V1.Unauthorized.selector);
        directory.verifyNamespace(id, 0, proof);
        vm.prank(OTHER);
        vm.expectRevert(V1.Unauthorized.selector);
        directory.setListed(id, 0, true, bytes32(0));
        directory.verifyNamespace(id, 0, proof);
        directory.setListed(id, 0, true, bytes32(0));
        require(directory.isDiscoverable(id));
        vm.warp(proof.validUntil);
        require(!directory.isDiscoverable(id));
    }

    function testV1SelectorsRefuseAndV1ReadTupleWorks() public {
        vm.expectRevert(D.LegacyEntryPoint.selector);
        directory.communityIdFor(registry);
        vm.expectRevert(D.LegacyEntryPoint.selector);
        directory.registerCommunity(registry, config(CONTROLLER, PUBLISHER));
        bytes32 id = register();
        V1.Community memory row = V1(address(directory)).getCommunity(id);
        require(row.configuration.publisher == PUBLISHER && row.configurationRevision == 1);
    }

    function testMoreThan256ConfigurationRevisionsPreserveBinding() public {
        bytes32 id = register();
        bytes32 beforeBinding = keccak256(abi.encode(directory.getBinding(id)));
        for (uint64 revision = 1; revision < 300; ++revision) {
            vm.prank(CONTROLLER);
            directory.configure(id, revision, config(CONTROLLER, PUBLISHER));
        }
        require(directory.getCommunity(id).configurationRevision == 300);
        require(beforeBinding == keccak256(abi.encode(directory.getBinding(id))));
        vm.prank(CONTROLLER);
        vm.expectRevert(V1.StaleRevision.selector);
        directory.configure(id, 256, config(CONTROLLER, PUBLISHER));
    }

    function testControllerTransferExactRevisionAndNewAdminDoesNotReplaceIt() public {
        bytes32 id = register();
        V1.Configuration memory next = config(OTHER, PUBLISHER);
        vm.prank(CONTROLLER);
        uint64 proposal = directory.proposeControllerTransfer(id, 1, next, uint64(block.timestamp + 60));
        vm.expectRevert(V1.InvalidControllerTransfer.selector);
        directory.acceptControllerTransfer(id, proposal, next);
        vm.prank(OTHER);
        directory.acceptControllerTransfer(id, proposal, next);
        require(directory.getCommunity(id).configuration.controller == OTHER);
        vm.prank(CONTROLLER);
        vm.expectRevert(V1.Unauthorized.selector);
        directory.configure(id, 2, config(CONTROLLER, PUBLISHER));
    }

    function testPostsV1ConsumesExactReadTupleWithoutRegistryAuthority() public {
        bytes32 id = register();
        CommunityPostsV1 posts = new CommunityPostsV1(address(directory));
        vm.prank(PUBLISHER);
        posts.publishRevision(
            id, bytes32(uint256(1)), 0, 1, bytes32(uint256(2)), Posts.Kind.Song, bytes32(uint256(3)), URI
        );
        require(posts.getPost(id, bytes32(uint256(1))).revision == 1);
        vm.expectRevert(Posts.UnauthorizedPublisher.selector);
        posts.publishRevision(
            id, bytes32(uint256(1)), 1, 1, bytes32(uint256(2)), Posts.Kind.Song, bytes32(uint256(4)), URI
        );
    }

    function testWrongChainRefusesDeployment() public {
        vm.chainId(1);
        vm.expectRevert(D.InvalidDeploymentProfile.selector);
        new CommunityDirectoryV2(address(this), 86400);
    }

    function testAttestationCannotRegressOrSurviveConfigurationChange() public {
        bytes32 id = register();
        vm.warp(1000);
        V1.NamespaceVerification memory proof =
            V1.NamespaceVerification(1, 10, bytes32(uint256(1)), 1000, 1060, bytes32(uint256(2)));
        directory.verifyNamespace(id, 0, proof);
        directory.setListed(id, 0, true, bytes32(0));
        proof.observedAt = 999;
        vm.expectRevert(V1.InvalidVerification.selector);
        directory.verifyNamespace(id, 1, proof);
        vm.prank(CONTROLLER);
        directory.configure(id, 1, config(CONTROLLER, PUBLISHER));
        require(!directory.isDiscoverable(id));
        proof.observedAt = 1000;
        vm.expectRevert(V1.InvalidVerification.selector);
        directory.verifyNamespace(id, 1, proof);
    }

    function testFuzzPortableIdUsesFullKey(bytes32 key) public view {
        if (key == bytes32(0)) return;
        require(
            directory.communityIdFor(key) == keccak256(abi.encode(keccak256("pirate.community/2"), block.chainid, key))
        );
    }
}
