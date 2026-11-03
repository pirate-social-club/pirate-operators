// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import "./PoolHandler.sol";

interface SetupVm {
    function warp(uint256) external;
    function addr(uint256) external returns (address);
    function prank(address) external;
}

contract PoolInvariants {
    SetupVm constant vm = SetupVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    TestUSDC token;
    MockJackpot jackpot;
    RewardPool pool;
    PoolHandler handler;
    address participantA;
    address participantB;

    function setUp() public {
        vm.warp(1800000000);
        participantA = vm.addr(6);
        participantB = vm.addr(7);
        token = new TestUSDC();
        jackpot = new MockJackpot(address(token));
        bytes32 policy = keccak256("invariant-policy");
        pool = new RewardPool(
            address(token),
            address(jackpot),
            vm.addr(9),
            address(this),
            vm.addr(5),
            1,
            1800000100,
            60,
            1,
            1_000_000,
            policy
        );
        token.mint(address(pool), 1_000_000);
        handler = new PoolHandler(pool, jackpot, token, address(this), participantA, participantB);
        bytes32 a = handler.leaf(participantA);
        bytes32 b = handler.leaf(participantB);
        pool.commitEntries(a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a)), 2, policy);
        uint8[] memory numbers = new uint8[](5);
        for (uint8 i; i < 5; i++) {
            numbers[i] = i + 1;
        }
        IMegapot.Ticket[] memory picks = new IMegapot.Ticket[](1);
        picks[0] = IMegapot.Ticket(numbers, 1);
        vm.prank(vm.addr(9));
        pool.purchase(picks);
        jackpot.setClaimModes(true, false);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_conservationOfMintedTokens() public view {
        uint256 total = token.balanceOf(address(pool)) + token.balanceOf(address(jackpot))
            + token.balanceOf(participantA) + token.balanceOf(participantB) + token.balanceOf(address(this));
        require(total == 1_000_000 + handler.ghostWin(), "money_not_conserved");
    }

    function invariant_settlementRequiresKnownFinalResult() public view {
        if (pool.settled()) {
            require(jackpot.drawn(1), "settled_before_draw");
            require(pool.winnings() == handler.ghostWin(), "wrong_winnings");
        }
        require(!jackpot.finalizeSucceeded(), "reentrant_finalization");
    }

    function invariant_cancellationPreservesSponsorCapital() public view {
        if (!pool.cancelled()) return;
        require(!pool.settled() && !pool.finalized() && pool.registeredCount() == 0 && pool.share() == 0);
        require(pool.sponsorBalance() + handler.ghostSponsorPaid() == 1_000_000);
        require(token.balanceOf(address(pool)) == pool.sponsorBalance());
    }

    function invariant_registrationAndWithdrawalHappenOnce() public view {
        require(!handler.violation(), "eligibility_violation");
        require(
            handler.registrations(participantA) <= 1 && handler.registrations(participantB) <= 1,
            "duplicate_registration"
        );
        require(
            handler.withdrawals(participantA) <= 1 && handler.withdrawals(participantB) <= 1, "duplicate_withdrawal"
        );
        require(pool.registeredCount() == handler.ghostRegistrations(), "registration_count_mismatch");
    }

    function invariant_allocationsRemainFullyBacked() public view {
        if (!pool.finalized()) return;
        uint256 count = handler.ghostRegistrations();
        uint256 expectedShare = count == 0 ? 0 : handler.ghostWin() / count;
        require(pool.share() == expectedShare, "incorrect_split");
        uint256 remaining = count - handler.withdrawals(participantA) - handler.withdrawals(participantB);
        require(
            token.balanceOf(address(pool)) == remaining * expectedShare + pool.sponsorBalance(), "unbacked_allocation"
        );
        require(
            pool.sponsorBalance() + handler.ghostSponsorPaid() == handler.ghostWin() - count * expectedShare,
            "incorrect_sponsor_share"
        );
    }

    function testHandlerTraversesWinningLifecycle() public {
        handler.draw(11, true);
        handler.settle();
        handler.register(false, false);
        handler.register(true, false);
        handler.advance(61);
        handler.finalize();
        handler.withdraw(false, false);
        handler.withdraw(true, false);
        handler.withdrawSponsor();
        require(
            handler.ghostRegistrations() == 2 && token.balanceOf(participantA) == 5
                && token.balanceOf(participantB) == 5
        );
        invariant_conservationOfMintedTokens();
        invariant_allocationsRemainFullyBacked();
    }
}
