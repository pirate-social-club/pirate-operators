// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import "../../contracts/RewardPool.sol";
import {IMegapot} from "../../contracts/interfaces/IMegapot.sol";
import "../../contracts/test/Providers.sol";

interface Vm {
    function warp(uint256) external;
    function addr(uint256) external returns (address);
    function prank(address) external;
    function expectRevert() external;
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
}

contract RewardPoolTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    TestUSDC token;
    MockJackpot jackpot;
    RewardPool pool;
    bytes32 constant POLICY = keccak256("test-policy");
    bytes32 constant ATTEMPT = keccak256("attempt");
    address alice;
    address bob;

    function setUp() public {
        vm.warp(1800000000);
        alice = vm.addr(6);
        bob = vm.addr(7);
        token = new TestUSDC();
        jackpot = new MockJackpot(address(token));
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
            POLICY
        );
        token.mint(address(pool), 1_000_000);
    }

    function selections() internal pure returns (IMegapot.Ticket[] memory list) {
        list = new IMegapot.Ticket[](1);
        uint8[] memory normals = new uint8[](5);
        for (uint8 i; i < 5; i++) {
            normals[i] = i + 1;
        }
        list[0] = IMegapot.Ticket(normals, 1);
    }

    function purchase() internal {
        IMegapot.Ticket[] memory list = selections();
        address executor = vm.addr(9);
        vm.prank(executor);
        pool.purchase(list);
    }

    function leaf(address wallet) internal view returns (bytes32) {
        return keccak256(abi.encode(address(pool), uint256(1), wallet, ATTEMPT));
    }

    function sorted(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function win(uint256 amount) internal {
        pool.commitEntries(sorted(leaf(alice), leaf(bob)), 2, POLICY);
        purchase();
        vm.warp(1800000100);
        jackpot.draw(1, amount);
        pool.settle();
    }

    function register(address wallet, bytes32 sibling, bytes32 nullifier) internal {
        _register(wallet, sibling, nullifier, false);
    }

    function rejectRegistration(address wallet, bytes32 sibling, bytes32 nullifier) internal {
        _register(wallet, sibling, nullifier, true);
    }

    function _register(address wallet, bytes32 sibling, bytes32 nullifier, bool reject) internal {
        uint256 expiry = block.timestamp + 600;
        bytes32 body = keccak256(abi.encode(pool.ATTESTATION_TYPEHASH(), pool.scope(), nullifier, wallet, expiry));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(5, keccak256(abi.encodePacked("\x19\x01", pool.DOMAIN_SEPARATOR(), body)));
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = sibling;
        if (reject) vm.expectRevert();
        vm.prank(wallet);
        pool.register(ATTEMPT, proof, nullifier, expiry, abi.encodePacked(r, s, v));
    }

    function testPayoutRoundingAndDoubleWithdrawal() public {
        win(11);
        register(alice, leaf(bob), bytes32(uint256(1)));
        register(bob, leaf(alice), bytes32(uint256(2)));
        vm.warp(pool.deadline());
        pool.finalize();
        require(pool.share() == 5 && pool.sponsorBalance() == 1);
        vm.prank(alice);
        pool.withdraw(alice);
        require(token.balanceOf(alice) == 5);
        vm.expectRevert();
        vm.prank(alice);
        pool.withdraw(alice);
        vm.prank(bob);
        pool.withdraw(bob);
        pool.withdrawSponsor(address(this));
        require(token.balanceOf(address(pool)) == 0 && token.balanceOf(address(this)) == 1);
    }

    function testSameScopedNullifierCannotRegisterSecondWallet() public {
        win(10);
        register(alice, leaf(bob), bytes32(uint256(1)));
        rejectRegistration(bob, leaf(alice), bytes32(uint256(1)));
        require(pool.registeredCount() == 1);
    }

    function testTransferFailurePreservesAllocationForever() public {
        win(10);
        register(alice, leaf(bob), bytes32(uint256(1)));
        vm.warp(pool.deadline());
        pool.finalize();
        token.blockRecipient(alice, true);
        vm.expectRevert();
        vm.prank(alice);
        pool.withdraw(alice);
        require(!pool.withdrawn(alice));
        vm.warp(block.timestamp + 3650 days);
        vm.prank(alice);
        pool.withdraw(bob);
        require(token.balanceOf(bob) == 10);
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
        rejectRegistration(alice, leaf(bob), bytes32(uint256(1)));
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
        pool.commitEntries(sorted(leaf(alice), leaf(bob)), 2, POLICY);
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
        pool.commitEntries(sorted(leaf(alice), leaf(bob)), 2, POLICY);
        jackpot.setTicketPrice(1_000_001);
        IMegapot.Ticket[] memory list = selections();
        vm.expectRevert();
        vm.prank(vm.addr(9));
        pool.purchase(list);
        require(!pool.purchased() && token.balanceOf(address(pool)) == 1_000_000);
        require(token.allowance(address(pool), address(jackpot)) == 0 && jackpot.nextTicketId() == 1);
    }

    function testEarlyZeroClaimCannotFinalizePool() public {
        pool.commitEntries(sorted(leaf(alice), leaf(bob)), 2, POLICY);
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
        vm.prank(bob);
        pool.settle();
        require(pool.winnings() == 23 && pool.settled());
    }

    function testAdvancingDrawingIdWithoutResultIsNotFinality() public {
        pool.commitEntries(sorted(leaf(alice), leaf(bob)), 2, POLICY);
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
        pool.commitEntries(sorted(leaf(alice), leaf(bob)), 2, POLICY);
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
        pool.commitEntries(sorted(leaf(alice), leaf(bob)), 2, POLICY);
        jackpot.setTicketPrice(500_000);
        purchase();
        require(pool.sponsorBalance() == 500_000);
        vm.warp(1800000100);
        jackpot.draw(1, 11);
        pool.settle();
        register(alice, leaf(bob), bytes32(uint256(1)));
        vm.warp(pool.deadline());
        pool.finalize();
        vm.prank(alice);
        pool.withdraw(alice);
        pool.withdrawSponsor(address(this));
        require(token.balanceOf(alice) == 11 && token.balanceOf(address(this)) == 500_000);
        require(token.balanceOf(address(pool)) == 0);
    }

    function testProviderCallbackCannotFinalizeDuringSettlement() public {
        pool.commitEntries(sorted(leaf(alice), leaf(bob)), 2, POLICY);
        purchase();
        vm.warp(1800000100);
        jackpot.draw(1, 9);
        jackpot.setReenterFinalize(true);
        pool.settle();
        require(!jackpot.finalizeSucceeded() && !pool.finalized() && pool.winnings() == 9);
        register(alice, leaf(bob), bytes32(uint256(1)));
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
        register(alice, leaf(bob), bytes32(uint256(1)));
        vm.warp(end);
        rejectRegistration(bob, leaf(alice), bytes32(uint256(2)));
        vm.warp(end + 1);
        rejectRegistration(bob, leaf(alice), bytes32(uint256(2)));
        pool.finalize();
        vm.warp(end + 100 * 365 days);
        vm.prank(alice);
        pool.withdraw(alice);
        require(token.balanceOf(alice) == 12);
    }
}
