// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import "./PoolFixture.sol";

contract SponsoredPoolTest is PoolFixture {
    function sig(uint256 key, bytes32 body) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", pool.DOMAIN_SEPARATOR(), body)));
        return abi.encodePacked(r, s, v);
    }

    function request(bool second, address recipient) internal returns (RewardPool.Registration memory r) {
        r.claimant = second ? participantB : participantA;
        r.recipient = recipient;
        r.attemptId = ATTEMPT;
        r.nullifier = bytes32(uint256(second ? 2 : 1));
        r.expiresAt = block.timestamp + 600;
        r.proof = new bytes32[](1);
        r.proof[0] = leaf(second ? participantA : participantB);
        signRequest(r, second ? 7 : 6);
    }

    function signRequest(RewardPool.Registration memory r, uint256 key) internal {
        r.attestation = sig(
            5, keccak256(abi.encode(pool.ATTESTATION_TYPEHASH(), pool.scope(), r.nullifier, r.claimant, r.expiresAt))
        );
        r.authorization = sig(
            key,
            keccak256(
                abi.encode(
                    pool.REGISTRATION_TYPEHASH(),
                    pool.scope(),
                    r.claimant,
                    r.recipient,
                    r.attemptId,
                    r.nullifier,
                    r.expiresAt
                )
            )
        );
    }

    function testAnyRelayerRegistersAndPaysOnlySignedRecipient() public {
        win(11);
        RewardPool.Registration memory r = request(false, participantB);
        vm.prank(address(0x999));
        pool.registerFor(r);
        require(pool.payoutRecipient(participantA) == participantB && !pool.registered(address(0x999)));
        vm.warp(pool.deadline());
        pool.finalize();
        vm.prank(address(0x888));
        pool.withdrawFor(participantA);
        require(token.balanceOf(participantB) == 11 && token.balanceOf(participantA) == 0);
        vm.expectRevert();
        pool.withdrawFor(participantA);
    }

    function testRecipientTamperingIsRejected() public {
        win(10);
        RewardPool.Registration memory r = request(false, participantA);
        r.recipient = participantB;
        vm.expectRevert();
        pool.registerFor(r);
        require(!pool.usedNullifiers(r.nullifier));
    }

    function testAllSignedFieldsBoundAndCannotReplay() public {
        win(10);
        RewardPool.Registration memory r = request(false, participantA);
        r.expiresAt++;
        vm.expectRevert();
        pool.registerFor(r);
        r.expiresAt--;
        r.attemptId = bytes32(uint256(99));
        vm.expectRevert();
        pool.registerFor(r);
        r.attemptId = ATTEMPT;
        r.nullifier = bytes32(uint256(99));
        vm.expectRevert();
        pool.registerFor(r);
        r.nullifier = bytes32(uint256(1));
        r.claimant = participantB;
        vm.expectRevert();
        pool.registerFor(r);
        r.claimant = participantA;
        pool.registerFor(r);
        vm.expectRevert();
        pool.registerFor(r);
    }

    function testWrongScopeAndExpiredAuthorization() public {
        win(10);
        RewardPool.Registration memory r = request(false, participantA);
        r.authorization = sig(
            6,
            keccak256(
                abi.encode(
                    pool.REGISTRATION_TYPEHASH(),
                    bytes32(uint256(12)),
                    r.claimant,
                    r.recipient,
                    r.attemptId,
                    r.nullifier,
                    r.expiresAt
                )
            )
        );
        vm.expectRevert();
        pool.registerFor(r);
        r.expiresAt = block.timestamp;
        signRequest(r, 6);
        vm.expectRevert();
        pool.registerFor(r);
    }

    function testAuthorizationCannotCrossChainOrPoolDomain() public {
        win(10);
        RewardPool.Registration memory r = request(false, participantA);
        bytes32 body = keccak256(
            abi.encode(
                pool.REGISTRATION_TYPEHASH(),
                pool.scope(),
                r.claimant,
                r.recipient,
                r.attemptId,
                r.nullifier,
                r.expiresAt
            )
        );
        for (uint256 i; i < 2; i++) {
            bytes32 wrongDomain = keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                    keccak256("Pirate Reward Pool"),
                    keccak256("1"),
                    i == 0 ? block.chainid + 1 : block.chainid,
                    i == 0 ? address(pool) : address(0x1234)
                )
            );
            (uint8 v, bytes32 rr, bytes32 s) = vm.sign(6, keccak256(abi.encodePacked("\x19\x01", wrongDomain, body)));
            r.authorization = abi.encodePacked(rr, s, v);
            vm.expectRevert();
            pool.registerFor(r);
        }
        require(!pool.registered(participantA));
    }

    function testBadAttesterAndZeroRecipientCannotRegister() public {
        win(10);
        RewardPool.Registration memory r = request(false, participantA);
        r.attestation = r.authorization;
        vm.expectRevert();
        pool.registerFor(r);
        r = request(false, address(0));
        vm.expectRevert();
        pool.registerFor(r);
    }

    function testContractClaimantsAreRefused() public {
        win(10);
        RewardPool.Registration memory r = request(false, participantB);
        vm.etch(participantA, hex"00");
        vm.expectRevert();
        pool.registerFor(r);
        vm.expectRevert();
        vm.prank(participantA);
        pool.register(ATTEMPT, r.proof, r.nullifier, r.expiresAt, r.attestation);
    }

    function testDelegatedWalletCanRegisterDirectly() public {
        win(10);
        RewardPool.Registration memory r = request(false, participantA);
        vm.etch(participantA, abi.encodePacked(hex"ef0100", address(0x1234)));
        vm.prank(participantA);
        pool.register(ATTEMPT, r.proof, r.nullifier, r.expiresAt, r.attestation);
        require(pool.registered(participantA) && pool.payoutRecipient(participantA) == participantA);
    }

    function testDelegatedWalletCanRegisterInSponsoredBatch() public {
        win(11);
        RewardPool.Registration[] memory rows = new RewardPool.Registration[](2);
        rows[0] = request(false, participantB);
        rows[1] = request(true, participantB);
        vm.etch(participantA, abi.encodePacked(hex"ef0100", address(0x1234)));
        vm.etch(participantB, abi.encodePacked(hex"ef0100", address(0x5678)));
        vm.prank(address(0x999));
        bool[] memory result = pool.registerBatch(rows);
        require(result[0] && result[1] && pool.registeredCount() == 2);
        require(pool.payoutRecipient(participantA) == participantB);
    }

    function testDelegationMarkerDoesNotReplaceOriginalSigner() public {
        win(10);
        vm.etch(participantA, abi.encodePacked(hex"ef0100", address(0x1234)));
        RewardPool.Registration memory r = request(false, participantB);
        signRequest(r, 7);
        vm.expectRevert();
        pool.registerFor(r);
        require(!pool.registered(participantA) && !pool.usedNullifiers(r.nullifier));
        signRequest(r, 6);
        pool.registerFor(r);
        require(pool.registered(participantA));
    }

    function testOtherCodeLengthsAndPrefixesAreRefused() public {
        win(10);
        RewardPool.Registration memory r = request(false, participantB);
        // The VM itself refuses ef01-prefixed code with the wrong size or version.
        // Exercise other bytecode sizes and a near-miss marker prefix.
        bytes[] memory unsupported = new bytes[](5);
        unsupported[0] = hex"000000";
        unsupported[1] = abi.encodePacked(hex"000000", bytes19(0));
        unsupported[2] = abi.encodePacked(hex"000000", bytes21(0));
        unsupported[3] = abi.encodePacked(hex"ee0100", address(0x1234));
        unsupported[4] = abi.encodePacked(hex"000000", address(0x1234));
        for (uint256 i; i < unsupported.length; i++) {
            vm.etch(participantA, unsupported[i]);
            vm.expectRevert();
            pool.registerFor(r);
            vm.expectRevert();
            vm.prank(participantA);
            pool.register(ATTEMPT, r.proof, r.nullifier, r.expiresAt, r.attestation);
        }
        require(pool.registeredCount() == 0 && !pool.usedNullifiers(r.nullifier));
    }

    function testSameVerySubjectCannotEnterThroughOtherWallet() public {
        win(10);
        pool.registerFor(request(false, participantA));
        RewardPool.Registration memory r = request(true, participantB);
        r.nullifier = bytes32(uint256(1));
        signRequest(r, 7);
        vm.expectRevert();
        pool.registerFor(r);
    }

    function testBatchSkipsBadRegistrationAndDuplicate() public {
        win(11);
        RewardPool.Registration[] memory rows = new RewardPool.Registration[](4);
        rows[0] = request(false, participantB);
        rows[0].authorization = hex"00";
        rows[1] = request(false, participantA);
        rows[2] = request(false, participantA);
        rows[3] = request(true, participantB);
        bool[] memory result = pool.registerBatch(rows);
        require(!result[0] && result[1] && !result[2] && result[3] && pool.registeredCount() == 2);
    }

    function testBatchSkipsBlockedPayoutThenRetriesForever() public {
        win(11);
        pool.registerFor(request(false, participantA));
        pool.registerFor(request(true, participantB));
        vm.warp(pool.deadline());
        pool.finalize();
        token.blockRecipient(participantA, true);
        address[] memory rows = new address[](3);
        rows[0] = participantA;
        rows[1] = address(0x999);
        rows[2] = participantB;
        bool[] memory result = pool.withdrawBatch(rows);
        require(!result[0] && !result[1] && result[2] && !pool.withdrawn(participantA) && pool.withdrawn(participantB));
        vm.warp(block.timestamp + 100 * 365 days);
        token.blockRecipient(participantA, false);
        pool.withdrawFor(participantA);
        require(token.balanceOf(participantA) == 5);
    }

    function testBatchIsolatesExhaustedItemAndOversizedProof() public {
        win(10);
        RewardPool.Registration[] memory requests = new RewardPool.Registration[](3);
        requests[0] = request(false, participantA);
        requests[0].proof = new bytes32[](1000);
        requests[1] = request(false, participantA);
        requests[2] = request(true, participantB);
        bool[] memory registeredRows = pool.registerBatch(requests);
        require(!registeredRows[0] && registeredRows[1] && registeredRows[2]);
        vm.warp(pool.deadline());
        pool.finalize();
        token.setGasBurner(participantA, true);
        address[] memory wallets = new address[](2);
        wallets[0] = participantA;
        wallets[1] = participantB;
        bool[] memory result = pool.withdrawBatch(wallets);
        require(!result[0] && result[1] && !pool.withdrawn(participantA));
        token.setGasBurner(participantA, false);
        pool.withdrawFor(participantA);
        require(token.balanceOf(participantA) == 5);
    }

    function testBatchBoundsAndGasReserve() public {
        RewardPool.Registration[] memory rows = new RewardPool.Registration[](33);
        vm.expectRevert();
        pool.registerBatch(rows);
        address[] memory wallets = new address[](0);
        vm.expectRevert();
        pool.withdrawBatch(wallets);
        wallets = new address[](2);
        (bool ok,) = address(pool).call{gas: 500_000}(abi.encodeCall(pool.withdrawBatch, (wallets)));
        require(!ok);
    }

    function testEmergencyRecoveryClosesPoolAndRefundsOnlySponsor() public {
        pool.commitEntries(sorted(leaf(participantA), leaf(participantB)), 2, POLICY);
        token.mint(address(pool), 17);
        purchase();
        vm.expectRevert();
        pool.recoverEmergency();
        jackpot.setEmergency(true, false);
        vm.prank(participantB);
        pool.recoverEmergency();
        require(pool.cancelled() && pool.sponsorBalance() == 1_000_017 && !pool.settled());
        vm.expectRevert();
        vm.prank(participantA);
        pool.withdrawSponsor(participantA);
        token.blockRecipient(address(this), true);
        vm.expectRevert();
        pool.withdrawSponsor(address(this));
        require(pool.sponsorBalance() == 1_000_017);
        token.blockRecipient(address(this), false);
        pool.withdrawSponsor(address(this));
        require(token.balanceOf(address(this)) == 1_000_017 && token.balanceOf(address(pool)) == 0);
        vm.expectRevert();
        pool.recoverEmergency();
        vm.warp(pool.cutoff());
        vm.expectRevert();
        pool.settle();
        vm.expectRevert();
        pool.finalize();
    }

    function testEmergencyRefundFailureCanRetry() public {
        pool.commitEntries(sorted(leaf(participantA), leaf(participantB)), 2, POLICY);
        purchase();
        jackpot.setEmergency(true, true);
        vm.expectRevert();
        pool.recoverEmergency();
        require(!pool.cancelled() && jackpot.ownerOf(pool.ticketIds(0)) == address(pool));
        jackpot.setEmergency(true, false);
        pool.recoverEmergency();
        require(pool.cancelled());
    }

    function testEmergencyCannotTakeSettledOrCompletedDrawingMoney() public {
        win(10);
        pool.registerFor(request(false, participantA));
        jackpot.setEmergency(true, false);
        vm.expectRevert();
        pool.recoverEmergency();
        vm.warp(pool.deadline());
        pool.finalize();
        pool.withdrawFor(participantA);
        require(token.balanceOf(participantA) == 10);
    }

    function testEmergencyCannotRefundPastDrawingEvenBeforePoolSettles() public {
        pool.commitEntries(sorted(leaf(participantA), leaf(participantB)), 2, POLICY);
        purchase();
        jackpot.draw(1, 10);
        jackpot.setEmergency(true, false);
        vm.expectRevert();
        pool.recoverEmergency();
        vm.warp(pool.cutoff());
        pool.settle();
        require(pool.winnings() == 10);
    }
}
