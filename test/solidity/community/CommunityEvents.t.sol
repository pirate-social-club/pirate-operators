// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import "./CommunityFixture.sol";

contract CommunityEventsTest is CommunityFixture {
    function testDirectoryCanBeReconstructedFromPublicEvents() public {
        vm.recordLogs();
        register();
        verify(1, 0);
        list(true, 0);
        Directory.Configuration memory next = config(NEXT, OTHER_PUBLISHER);
        vm.prank(OWNER);
        uint64 proposal = directory.proposeControllerTransfer(communityId, 1, next, uint64(block.timestamp + 30));
        vm.prank(NEXT);
        directory.acceptControllerTransfer(communityId, proposal, next);
        verify(2, 1);
        list(false, 1);
        CommunityVm.Log[] memory logs = vm.getRecordedLogs();
        Directory.Community memory reduced;
        uint256 configs;
        for (uint256 i; i < logs.length; ++i) {
            CommunityVm.Log memory entry = logs[i];
            if (entry.emitter != address(directory) || entry.topics[1] != communityId) continue;
            if (entry.topics[0] == keccak256("CommunityRegistered(bytes32,address,bytes32)")) {
                reduced.registry = address(uint160(uint256(entry.topics[2])));
                reduced.tldHash = abi.decode(entry.data, (bytes32));
            } else if (
                entry.topics[0]
                    == keccak256(
                        "ConfigurationPublished(bytes32,uint64,address,address,address,address,bytes32,string)"
                    )
            ) {
                (reduced.configurationRevision, reduced.configuration) = decodeConfiguration(entry.data);
                require(reduced.configurationRevision == ++configs);
            } else if (
                entry.topics[0]
                    == keccak256("NamespaceVerified(bytes32,uint64,(uint64,uint64,bytes32,uint64,uint64,bytes32))")
            ) {
                (reduced.verificationRevision, reduced.verification) =
                    abi.decode(entry.data, (uint64, Directory.NamespaceVerification));
            } else if (entry.topics[0] == keccak256("ListingChanged(bytes32,uint64,bool,bytes32)")) {
                (reduced.listingRevision, reduced.listed,) = abi.decode(entry.data, (uint64, bool, bytes32));
            }
        }
        require(configs == 2 && reduced.verificationRevision == 2 && reduced.listingRevision == 2);
        require(keccak256(abi.encode(reduced)) == keccak256(abi.encode(directory.getCommunity(communityId))));
    }

    function decodeConfiguration(bytes memory data)
        private
        pure
        returns (uint64 revision, Directory.Configuration memory c)
    {
        address controller;
        address publisher;
        address payments;
        address records;
        bytes32 digest;
        string memory uri;
        (revision, controller, publisher, payments, records, digest, uri) =
            abi.decode(data, (uint64, address, address, address, address, bytes32, string));
        c = Directory.Configuration(controller, publisher, payments, records, digest, uri);
    }
}
