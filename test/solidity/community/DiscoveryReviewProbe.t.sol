// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import "./DiscoveryAuthorityFixture.sol";

/// Reviewer probes: powers that exist at aefafa5 but are not exercised by the PR's tests.
contract DiscoveryReviewProbeTest is DiscoveryAuthorityFixture {
    // 1. A stolen verifier key can cut a listed community's verification to one second.
    function testProbeStolenVerifierKeyShortensListedCommunity() public {
        enable();
        verify();
        list(true, 0);
        require(directory.isDiscoverable(communityId), "precondition: discoverable");

        uint64 vrev = directory.getCommunity(communityId).verificationRevision;
        Directory.NamespaceVerification memory shortProof = proof(1);
        vm.prank(SERVICE); // attacker holding the current service key
        verifierAuthority.verifyNamespace(communityId, vrev, shortProof);
        vm.warp(block.timestamp + 2);
        require(!directory.isDiscoverable(communityId), "shortened verification removed discovery");
        require(directory.getCommunity(communityId).listed, "listing flag untouched");

        // Recovery: governance rotates the key; the new service submits fresh evidence.
        verifierAdmin(abi.encodeCall(VerifierAuthority.setOperator, (NEXT_SERVICE)));
        vrev = directory.getCommunity(communityId).verificationRevision;
        Directory.NamespaceVerification memory fresh = proof(1 hours);
        vm.prank(NEXT_SERVICE);
        verifierAuthority.verifyNamespace(communityId, vrev, fresh);
        require(directory.isDiscoverable(communityId), "fresh evidence restores discovery without governance relisting");
    }

    // 1b. Evidence observed before the attacker's attestation is no longer accepted.
    function testProbeOlderHonestEvidenceRejectedAfterAttack() public {
        enable();
        verify();
        Directory.NamespaceVerification memory older = proof(1 hours); // observed now
        vm.warp(block.timestamp + 60);
        uint64 vrev = directory.getCommunity(communityId).verificationRevision;
        Directory.NamespaceVerification memory attack = proof(1); // observed 60 s later
        vm.prank(SERVICE);
        verifierAuthority.verifyNamespace(communityId, vrev, attack);
        vrev = directory.getCommunity(communityId).verificationRevision;
        vm.prank(SERVICE);
        vm.expectRevert(Directory.InvalidVerification.selector);
        verifierAuthority.verifyNamespace(communityId, vrev, older);
    }

    // 2. A stolen emergency key keeps restoration stale until governance rotates it out.
    function testProbeStolenEmergencyKeyBlocksRestorationUntilRotated() public {
        enable();
        verify();
        list(true, 0);          // listingRevision -> 1
        delist();               // -> 2
        delist();               // attacker front-runs the queued restore -> 3
        vm.expectRevert();      // Safe tx prepared against revision 2 fails
        list(true, 2);
        listingAdmin(abi.encodeCall(ListingAuthority.setEmergencyKey, (address(0))));
        list(true, 3);
        require(directory.isDiscoverable(communityId), "restored after rotation");
    }

    // 3. One address may hold both the verifier service key and the emergency key.
    function testProbeSameAddressMayHoldBothOperationalKeys() public {
        bindBoth();
        verifierAdmin(abi.encodeCall(VerifierAuthority.setOperator, (SERVICE)));
        listingAdmin(abi.encodeCall(ListingAuthority.setEmergencyKey, (SERVICE)));
        require(listingAuthority.emergencyKey() == verifierAuthority.operator(), "both roles on one key");
    }

    // 3b. The only cross-role check rejects the verifier contract, which cannot call emergencyDelist anyway.
    function testProbeEmergencyAliasCheckTargetsContractNotOperator() public {
        bindBoth();
        vm.expectRevert(ListingAuthority.InvalidEmergencyKey.selector);
        listingAdmin(abi.encodeCall(ListingAuthority.setEmergencyKey, (address(verifierAuthority))));
    }
}
