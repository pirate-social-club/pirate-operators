// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import "../../contracts/RewardPool.sol";
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
        pool = new RewardPool(address(token), address(jackpot), address(this), vm.addr(5), 1, 1800000100, 60, 1, POLICY);
        token.mint(address(pool), 1);
    }

    function leaf(address wallet) internal view returns (bytes32) {
        return keccak256(abi.encode(address(pool), uint256(1), wallet, ATTEMPT));
    }

    function sorted(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function win(uint256 amount) internal {
        pool.commitEntries(sorted(leaf(alice), leaf(bob)), 2, POLICY);
        pool.purchase();
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
        vm.expectRevert();
        pool.purchase();
    }
}
