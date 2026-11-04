// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import {PublicationReference} from "../../../contracts/community/PublicationReference.sol";
import {CommunityVm} from "./CommunityFixture.sol";

contract ReferenceHarness {
    function valid(string calldata uri) external pure returns (bool) {
        return PublicationReference.valid(uri);
    }
}

contract PublicationReferenceTest {
    CommunityVm constant vm = CommunityVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    ReferenceHarness harness = new ReferenceHarness();
    string constant URI = "ipfs://bafkreigh2akiscaildc6c3bwi6f6t3kp34lwd77d5ppf2v3atx7q7hkwgy";

    function testCIDShapesAndCanonicalPaths() public view {
        require(harness.valid(URI));
        require(harness.valid("ipfs://QmYwAPJzv5CZsnAzt8auVZRnGi2CkfHMj3iGdqAmvHtK7s"));
        require(harness.valid(string.concat(URI, "/folder/manifest-v1.json")));
        require(!harness.valid("https://example.invalid/file"));
        require(!harness.valid("ipns://mutable-name"));
        require(!harness.valid("ipfs://ipns/example"));
        require(!harness.valid("ipfs://"));
        require(!harness.valid(string.concat(URI, "?x=1")));
        require(!harness.valid(string.concat(URI, "#fragment")));
        require(!harness.valid(string.concat(URI, "/../file")));
        require(!harness.valid(string.concat(URI, "/./file")));
        require(!harness.valid(string.concat(URI, "/%2e%2e/file")));
        require(!harness.valid(string.concat(URI, "//file")));
        require(!harness.valid(string.concat(URI, "/")));
    }

    function testReferenceLengthBoundary() public view {
        bytes memory path = new bytes(512 - bytes(URI).length - 1);
        for (uint256 i; i < path.length; ++i) {
            path[i] = "a";
        }
        string memory maximum = string.concat(URI, "/", string(path));
        require(bytes(maximum).length == 512 && harness.valid(maximum));
        require(!harness.valid(string.concat(maximum, "a")));
    }

    function testFuzzControlBytesRejected(uint8 control) public view {
        control %= 33;
        require(!harness.valid(string(abi.encodePacked(URI, "/asset", bytes1(control)))));
    }
}
