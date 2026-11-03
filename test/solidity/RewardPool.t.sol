// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import "./PoolFixture.sol";

contract RewardPoolTest is PoolFixture {
    function testPayoutRoundingAndDoubleWithdrawal() public {
        win(11);
        register(participantA, leaf(participantB), bytes32(uint256(1)));
        register(participantB, leaf(participantA), bytes32(uint256(2)));
        vm.warp(pool.deadline());
        pool.finalize();
        require(pool.share() == 5 && pool.sponsorBalance() == 1);
        vm.prank(participantA);
        pool.withdraw(participantA);
        require(token.balanceOf(participantA) == 5);
        vm.expectRevert();
        vm.prank(participantA);
        pool.withdraw(participantA);
        vm.prank(participantB);
        pool.withdraw(participantB);
        pool.withdrawSponsor(address(this));
        require(token.balanceOf(address(pool)) == 0 && token.balanceOf(address(this)) == 1);
    }

    function testSameScopedNullifierCannotRegisterSecondWallet() public {
        win(10);
        register(participantA, leaf(participantB), bytes32(uint256(1)));
        rejectRegistration(participantB, leaf(participantA), bytes32(uint256(1)));
        require(pool.registeredCount() == 1);
    }

    function testTransferFailurePreservesAllocationForever() public {
        win(10);
        register(participantA, leaf(participantB), bytes32(uint256(1)));
        vm.warp(pool.deadline());
        pool.finalize();
        token.blockRecipient(participantA, true);
        vm.expectRevert();
        vm.prank(participantA);
        pool.withdraw(participantA);
        require(!pool.withdrawn(participantA));
        vm.warp(block.timestamp + 3650 days);
        vm.prank(participantA);
        pool.withdraw(participantB);
        require(token.balanceOf(participantB) == 10);
    }

    function testZeroRegistrationsReturnWinningsToSponsor() public {
        win(17);
        vm.warp(pool.deadline());
        pool.finalize();
        pool.withdrawSponsor(address(this));
        require(token.balanceOf(address(this)) == 17);
    }

    function testLossCannotRegister() public {
        win(0);
        rejectRegistration(participantA, leaf(participantB), bytes32(uint256(1)));
    }

    function testCommitOnceAndEmptyEntryRefusal() public {
        pool.commitEntries(bytes32(0), 0, POLICY);
        vm.expectRevert();
        pool.commitEntries(bytes32(0), 0, POLICY);
        IMegapot.Ticket[] memory list = selections();
        vm.expectRevert();
        vm.prank(vm.addr(9));
        pool.purchase(list);
    }

    function testTicketPriceIsQuotedInTokenUnitsAndExecutorIsSeparate() public {
        pool.commitEntries(sorted(leaf(participantA), leaf(participantB)), 2, POLICY);
        IMegapot.Ticket[] memory list = selections();
        vm.expectRevert();
        pool.purchase(list);
        purchase();
        require(pool.executor() != pool.sponsor());
        require(pool.ticketSpend() == 1_000_000 && token.balanceOf(address(jackpot)) == 1_000_000);
        require(token.allowance(address(pool), address(jackpot)) == 0);
        require(jackpot.ownerOf(pool.ticketIds(0)) == address(pool));
    }

    function testPriceIncreaseCannotExceedSponsorCap() public {
        pool.commitEntries(sorted(leaf(participantA), leaf(participantB)), 2, POLICY);
        jackpot.setTicketPrice(1_000_001);
        IMegapot.Ticket[] memory list = selections();
        vm.expectRevert();
        vm.prank(vm.addr(9));
        pool.purchase(list);
        require(!pool.purchased() && token.balanceOf(address(pool)) == 1_000_000);
        require(token.allowance(address(pool), address(jackpot)) == 0 && jackpot.nextTicketId() == 1);
    }

    function testEarlyZeroClaimCannotFinalizePool() public {
        pool.commitEntries(sorted(leaf(participantA), leaf(participantB)), 2, POLICY);
        purchase();
        vm.warp(1800000100);
        jackpot.setClaimModes(true, false);
        uint256[] memory ids = new uint256[](1);
        ids[0] = pool.ticketIds(0);
        vm.prank(address(pool));
        jackpot.claimWinnings(ids);
        require(jackpot.claimCalls() == 1);
        vm.expectRevert();
        pool.settle();
        require(!pool.settled() && pool.winnings() == 0 && pool.deadline() == 0);
        require(jackpot.claimCalls() == 1);
        jackpot.draw(1, 23);
        vm.prank(participantB);
        pool.settle();
        require(pool.winnings() == 23 && pool.settled());
    }

    function testAdvancingDrawingIdWithoutResultIsNotFinality() public {
        pool.commitEntries(sorted(leaf(participantA), leaf(participantB)), 2, POLICY);
        purchase();
        vm.warp(1800000100);
        jackpot.advanceWithoutResult();
        vm.expectRevert();
        pool.settle();
        require(!pool.settled());
        jackpot.draw(1, 4);
        pool.settle();
        require(pool.winnings() == 4);
    }

    function testClaimFailureRollsBackAndCanRetry() public {
        pool.commitEntries(sorted(leaf(participantA), leaf(participantB)), 2, POLICY);
        purchase();
        vm.warp(1800000100);
        jackpot.draw(1, 9);
        jackpot.setClaimModes(false, true);
        vm.expectRevert();
        pool.settle();
        require(!pool.settled() && pool.deadline() == 0 && jackpot.ownerOf(pool.ticketIds(0)) == address(pool));
        jackpot.setClaimModes(false, false);
        pool.settle();
        require(pool.winnings() == 9);
    }

    function testDiscountedPurchaseReturnsUnusedSponsorCapitalWithoutDilution() public {
        pool.commitEntries(sorted(leaf(participantA), leaf(participantB)), 2, POLICY);
        jackpot.setTicketPrice(500_000);
        purchase();
        require(pool.sponsorBalance() == 500_000);
        vm.warp(1800000100);
        jackpot.draw(1, 11);
        pool.settle();
        register(participantA, leaf(participantB), bytes32(uint256(1)));
        vm.warp(pool.deadline());
        pool.finalize();
        vm.prank(participantA);
        pool.withdraw(participantA);
        pool.withdrawSponsor(address(this));
        require(token.balanceOf(participantA) == 11 && token.balanceOf(address(this)) == 500_000);
        require(token.balanceOf(address(pool)) == 0);
    }

    function testProviderCallbackCannotFinalizeDuringSettlement() public {
        pool.commitEntries(sorted(leaf(participantA), leaf(participantB)), 2, POLICY);
        purchase();
        vm.warp(1800000100);
        jackpot.draw(1, 9);
        jackpot.setReenterFinalize(true);
        pool.settle();
        require(!jackpot.finalizeSucceeded() && !pool.finalized() && pool.winnings() == 9);
        register(participantA, leaf(participantB), bytes32(uint256(1)));
    }

    function testDomainMatchesSpecifiedNameAndVersion() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Pirate Reward Pool"),
                keccak256("1"),
                block.chainid,
                address(pool)
            )
        );
        require(pool.DOMAIN_SEPARATOR() == expected);
    }

    function testRegistrationDeadlineIsStrictAndWithdrawalNeverExpires() public {
        win(12);
        uint256 end = pool.deadline();
        vm.warp(end - 1);
        register(participantA, leaf(participantB), bytes32(uint256(1)));
        vm.warp(end);
        rejectRegistration(participantB, leaf(participantA), bytes32(uint256(2)));
        vm.warp(end + 1);
        rejectRegistration(participantB, leaf(participantA), bytes32(uint256(2)));
        pool.finalize();
        vm.warp(end + 100 * 365 days);
        vm.prank(participantA);
        pool.withdraw(participantA);
        require(token.balanceOf(participantA) == 12);
    }

    function testUnpurchasedFundingReturnsOnlyAfterCutoffToSponsor() public {
        pool.commitEntries(bytes32(0), 0, POLICY);
        vm.expectRevert();
        pool.refundUnpurchased(address(this));
        vm.warp(1800000100);
        vm.expectRevert();
        vm.prank(participantA);
        pool.refundUnpurchased(participantA);
        pool.refundUnpurchased(address(this));
        require(token.balanceOf(address(this)) == 1_000_000 && token.balanceOf(address(pool)) == 0);
    }

    function testRefundCannotTakePurchasedOrAllocatedFunds() public {
        win(11);
        register(participantA, leaf(participantB), bytes32(uint256(1)));
        vm.expectRevert();
        pool.refundUnpurchased(address(this));
        vm.warp(pool.deadline());
        pool.finalize();
        vm.expectRevert();
        pool.refundUnpurchased(address(this));
        vm.prank(participantA);
        pool.withdraw(participantA);
        require(token.balanceOf(participantA) == 11);
    }
}
