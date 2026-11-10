// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import "../../contracts/LearningResultsV4.sol";
import "./SignInVectorsV4.sol";

interface SignInVmV4 {
    function chainId(uint256) external;
    function expectRevert(bytes calldata) external;
}

/// The contract's own rendering of the EIP-4361 sign-in against texts the
/// shared builder (viem createSiweMessage) produced, and the constructor's
/// origin rule.
contract LearningResultsV4SignInTest {
    SignInVmV4 constant vm = SignInVmV4(address(uint160(uint256(keccak256("hevm cheat code")))));
    string constant STATEMENT =
        "Sign in to this community and let it publish your Karaoke and Study results under its terms, version 4, until you turn them off in settings. This does not join, create a creator wallet or authorize spending.";

    function _personal(bytes memory text) private pure returns (bytes32) {
        bytes memory length;
        for (uint256 n = text.length; n > 0; n /= 10) {
            length = abi.encodePacked(bytes1(uint8(48 + n % 10)), length);
        }
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n", length, text));
    }

    function _deploy(bytes32 community, bytes32 policy, string memory origin) private returns (LearningResultsV4) {
        return new LearningResultsV4(address(this), community, policy, origin);
    }

    /// Every vector's text and digest, with the contract deployed where the
    /// generator expected it (forge's test contract, CREATE nonce i + 1).
    function testRendersTheBuildersTextsAndDigests() public {
        require(address(this) == 0x7FA9385bE102ac3EAc297483Dd6233D62b3e1496, "test_contract_moved");
        SignInVectorsV4.Vector[] memory v = SignInVectorsV4.all();
        for (uint256 i; i < v.length; ++i) {
            vm.chainId(v[i].chainId);
            LearningResultsV4 records = _deploy(v[i].communityId, v[i].policy, v[i].origin);
            require(address(records) == v[i].deployed, "vector_address");
            LearningResultsV4.SignIn memory a = LearningResultsV4.SignIn(v[i].learner, v[i].nonce, v[i].issuedAt);
            string memory text = records.signInMessage(a);
            require(keccak256(bytes(text)) == keccak256(bytes(v[i].text)), string.concat("vector_text_", text));
            require(records.signInDigest(a) == v[i].digest, "vector_digest");
            require(_personal(bytes(v[i].text)) == v[i].digest, "vector_eip191");
        }
    }

    function testStatementIsTheProtocolConstant() public {
        LearningResultsV4 records = _deploy(keccak256("community"), keccak256("publicity"), "https://community.example");
        require(keccak256(bytes(records.SIGN_IN_STATEMENT())) == keccak256(bytes(STATEMENT)));
    }

    function testTimesFromYearTenThousandAreRefused() public {
        LearningResultsV4 records = _deploy(keccak256("community"), keccak256("publicity"), "https://community.example");
        LearningResultsV4.SignIn memory a = LearningResultsV4.SignIn(address(0xBEEF), bytes32(uint256(1)), 253402300799);
        records.signInMessage(a);
        a.issuedAt = 253402300800;
        vm.expectRevert(bytes("invalid_sign_in"));
        records.signInMessage(a);
        a.issuedAt = type(uint64).max;
        vm.expectRevert(bytes("invalid_sign_in"));
        records.signInDigest(a);
    }

    function _refused(string memory origin) private {
        vm.expectRevert(bytes("invalid_origin"));
        this.deployExternally(origin);
    }

    function deployExternally(string memory origin) external returns (address) {
        return address(_deploy(keccak256("community"), keccak256("publicity"), origin));
    }

    function testConstructorRefusesNonCanonicalOrigins() public {
        string[28] memory bad = [
            "",
            "https://",
            "https:/community.example",
            "http://community.example",
            "HTTPS://community.example",
            "https://Community.example",
            "https://community.example/",
            "https://community.example/path",
            "https://community.example?query",
            "https://community.example#fragment",
            "https://user@community.example",
            "https://community.example:",
            "https://community.example:443",
            "https://community.example:0",
            "https://community.example:0080",
            "https://community.example:65536",
            "https://community.example:123456",
            "https://community.example:8a",
            "https://community",
            "https://.community.example",
            "https://community..example",
            "https://community.example.",
            "https://-community.example",
            "https://community-.example",
            "https://community.-example",
            "https://community_x.example",
            " https://community.example",
            "https://community.example "
        ];
        for (uint256 i; i < bad.length; ++i) {
            _refused(bad[i]);
        }
        string[7] memory good = [
            "https://community.example",
            "https://localhost",
            "https://localhost:8787",
            "https://a-b.example:65535",
            "https://xn--bcher-kva.example",
            "https://127.0.0.1:8443",
            "https://pirate-first-song-20261105.piratesocialclub.workers.dev"
        ];
        for (uint256 i; i < good.length; ++i) {
            LearningResultsV4 records = LearningResultsV4(this.deployExternally(good[i]));
            require(keccak256(bytes(records.communityOrigin())) == keccak256(bytes(good[i])));
        }
    }
}
