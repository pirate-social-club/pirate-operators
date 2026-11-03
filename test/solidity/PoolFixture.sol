// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import "../../contracts/RewardPool.sol";
import {IMegapot} from "../../contracts/interfaces/IMegapot.sol";
import "../../contracts/test/Providers.sol";

interface Vm {
    function warp(uint256) external;
    function etch(address, bytes calldata) external;
    function addr(uint256) external returns (address);
    function prank(address) external;
    function expectRevert() external;
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
}

abstract contract PoolFixture {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    TestUSDC token;
    MockJackpot jackpot;
    RewardPool pool;
    bytes32 constant POLICY = keccak256("test-policy");
    bytes32 constant ATTEMPT = keccak256("attempt");
    address participantA;
    address participantB;

    function setUp() public {
        vm.warp(1800000000);
        participantA = vm.addr(6);
        participantB = vm.addr(7);
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
        pool.commitEntries(sorted(leaf(participantA), leaf(participantB)), 2, POLICY);
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
}
