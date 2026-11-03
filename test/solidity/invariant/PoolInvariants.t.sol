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
    address alice;
    address bob;

    function setUp() public {
        vm.warp(1800000000);
        alice = vm.addr(6);
        bob = vm.addr(7);
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
        handler = new PoolHandler(pool, jackpot, token, address(this), alice, bob);
        bytes32 a = handler.leaf(alice);
        bytes32 b = handler.leaf(bob);
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
        uint256 total = token.balanceOf(address(pool)) + token.balanceOf(address(jackpot)) + token.balanceOf(alice)
            + token.balanceOf(bob) + token.balanceOf(address(this));
        require(total == 1_000_000 + handler.ghostWin(), "money_not_conserved");
    }

    function invariant_settlementRequiresKnownFinalResult() public view {
        if (pool.settled()) {
            require(jackpot.drawn(1), "settled_before_draw");
            require(pool.winnings() == handler.ghostWin(), "wrong_winnings");
        }
        require(!jackpot.finalizeSucceeded(), "reentrant_finalization");
    }

    function invariant_registrationAndWithdrawalHappenOnce() public view {
        require(!handler.violation(), "eligibility_violation");
        require(handler.registrations(alice) <= 1 && handler.registrations(bob) <= 1, "duplicate_registration");
        require(handler.withdrawals(alice) <= 1 && handler.withdrawals(bob) <= 1, "duplicate_withdrawal");
        require(pool.registeredCount() == handler.ghostRegistrations(), "registration_count_mismatch");
    }

    function invariant_allocationsRemainFullyBacked() public view {
        if (!pool.finalized()) return;
        uint256 count = handler.ghostRegistrations();
        uint256 expectedShare = count == 0 ? 0 : handler.ghostWin() / count;
        require(pool.share() == expectedShare, "incorrect_split");
        uint256 remaining = count - handler.withdrawals(alice) - handler.withdrawals(bob);
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
        require(handler.ghostRegistrations() == 2 && token.balanceOf(alice) == 5 && token.balanceOf(bob) == 5);
        invariant_conservationOfMintedTokens();
        invariant_allocationsRemainFullyBacked();
    }
}
