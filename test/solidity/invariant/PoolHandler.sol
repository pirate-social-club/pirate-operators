// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import "../../../contracts/RewardPool.sol";
import "../../../contracts/test/Providers.sol";

interface InvariantVm {
    function warp(uint256) external;
    function prank(address) external;
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
}

/// @dev Expected money and accepted actions are tracked from observable outcomes.
contract PoolHandler {
    InvariantVm constant vm = InvariantVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    RewardPool public immutable pool;
    MockJackpot public immutable jackpot;
    TestUSDC public immutable token;
    address public immutable sponsor;
    address public immutable participantA;
    address public immutable participantB;
    bytes32 constant ATTEMPT = keccak256("attempt");
    uint256 public ghostWin;
    uint256 public ghostRegistrations;
    uint256 public ghostSponsorPaid;
    bool public violation;
    mapping(address => uint256) public registrations;
    mapping(address => uint256) public withdrawals;
    mapping(bytes32 => bool) public acceptedNullifiers;

    constructor(
        RewardPool pool_,
        MockJackpot jackpot_,
        TestUSDC token_,
        address sponsor_,
        address participantA_,
        address participantB_
    ) {
        pool = pool_;
        jackpot = jackpot_;
        token = token_;
        sponsor = sponsor_;
        participantA = participantA_;
        participantB = participantB_;
    }

    function advance(uint32 seconds_) external {
        vm.warp(block.timestamp + uint256(seconds_) % 30 days);
    }

    function draw(uint96 amount, bool callback) external {
        if (jackpot.drawn(1) || pool.cancelled()) return;
        vm.warp(block.timestamp < pool.cutoff() ? pool.cutoff() : block.timestamp);
        ghostWin = uint256(amount) % 100_000_001;
        jackpot.setReenterFinalize(callback);
        jackpot.draw(1, ghostWin);
    }

    function emergency() external {
        jackpot.setEmergency(true, false);
        (bool ok,) = address(pool).call(abi.encodeCall(pool.recoverEmergency, ()));
        ok;
    }

    function settle() external {
        (bool ok,) = address(pool).call(abi.encodeCall(pool.settle, ()));
        ok;
    }

    function leaf(address user) public view returns (bytes32) {
        return keccak256(abi.encode(address(pool), uint256(1), user, ATTEMPT));
    }

    function register(bool second, bool sameSubject) external {
        address user = second ? participantB : participantA;
        bytes32 nullifier = keccak256(abi.encode(second && !sameSubject ? uint256(2) : uint256(1), pool.scope()));
        bool open = pool.settled() && !pool.finalized() && ghostWin > 0 && block.timestamp < pool.deadline();
        bytes32 body =
            keccak256(abi.encode(pool.ATTESTATION_TYPEHASH(), pool.scope(), nullifier, user, type(uint256).max));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(5, keccak256(abi.encodePacked("\x19\x01", pool.DOMAIN_SEPARATOR(), body)));
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leaf(second ? participantA : participantB);
        bytes memory data =
            abi.encodeCall(pool.register, (ATTEMPT, proof, nullifier, type(uint256).max, abi.encodePacked(r, s, v)));
        vm.prank(user);
        (bool ok,) = address(pool).call(data);
        if (ok) {
            if (!open || acceptedNullifiers[nullifier]) violation = true;
            acceptedNullifiers[nullifier] = true;
            registrations[user]++;
            ghostRegistrations++;
        }
    }

    function finalize() external {
        (bool ok,) = address(pool).call(abi.encodeCall(pool.finalize, ()));
        ok;
    }

    function withdraw(bool second, bool blockTransfer) external {
        address user = second ? participantB : participantA;
        token.blockRecipient(user, blockTransfer);
        vm.prank(user);
        (bool ok,) = address(pool).call(abi.encodeCall(pool.withdraw, (user)));
        if (ok) withdrawals[user]++;
    }

    function withdrawSponsor() external {
        uint256 beforeBalance = token.balanceOf(sponsor);
        vm.prank(sponsor);
        (bool ok,) = address(pool).call(abi.encodeCall(pool.withdrawSponsor, (sponsor)));
        if (ok) ghostSponsorPaid += token.balanceOf(sponsor) - beforeBalance;
    }
}
