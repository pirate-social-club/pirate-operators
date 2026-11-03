// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import "../../contracts/RewardPool.sol";

interface ForkVm {
    function createSelectFork(string calldata, uint256) external returns (uint256);
    function warp(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function expectRevert() external;
}

interface LiveJackpot is IMegapot {
    function owner() external view returns (address);
    function entropy() external view returns (address);
    function enableEmergencyMode() external;
    function runJackpot() external payable;
    function getEntropyCallbackFee() external view returns (uint256);
    function scaledEntropyCallback(bytes32, uint256[][] calldata, bytes calldata) external;
}

interface Payout {
    function getTierPayout(uint256, uint256) external view returns (uint256);
}

// Read-only RPC bootstrap; every purchase, impersonation and callback is local.
contract MegapotForkTest {
    ForkVm constant vm = ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    LiveJackpot constant live = LiveJackpot(0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2);
    bytes32 constant POLICY = keccak256("fork-policy");
    bytes32 constant ATTEMPT = keccak256("fork-attempt");
    RewardPool pool;
    Token asset;
    uint256 constant CLAIMANT_KEY = uint256(keccak256("pirate-fork-claimant-v1"));
    address claimant;
    uint256 drawing;
    uint256 price;

    function setUp() public {
        vm.createSelectFork("https://mainnet.base.org", 53468101);
        require(block.chainid == 8453 && block.number == 53468101, "wrong_fork");
        require(
            address(live).codehash == 0x597f3a8e9360fbfc2e623243507ee9e8a66609003078ffc33d9013cb0607002d,
            "wrong_provider_code"
        );
        require(!live.emergencyMode() && live.allowTicketPurchases(), "fork_not_open");
        claimant = vm.addr(CLAIMANT_KEY);
        vm.deal(claimant, 0);
        drawing = live.currentDrawingId();
        price = live.getDrawingState(drawing).ticketPrice;
        asset = Token(live.usdc());
        pool = new RewardPool(
            address(asset),
            address(live),
            address(this),
            address(this),
            vm.addr(5),
            drawing,
            block.timestamp + 100,
            0,
            1,
            price,
            POLICY
        );
        require(pool.window() == 7 days, "wrong_default_window");
        // Seed only the local fork from the provider's balance. No real tokens move.
        vm.prank(address(live));
        require(asset.transfer(address(pool), price + 17));
        pool.commitEntries(keccak256(abi.encode(address(pool), drawing, claimant, ATTEMPT)), 1, POLICY);
        uint8[] memory numbers = new uint8[](5);
        for (uint8 i; i < 5; i++) {
            numbers[i] = i + 1;
        }
        IMegapot.Ticket[] memory picks = new IMegapot.Ticket[](1);
        picks[0] = IMegapot.Ticket(numbers, 1);
        pool.purchase(picks);
        require(ITicketOwnership(pool.ticketNFT()).ownerOf(pool.ticketIds(0)) == address(pool));
    }

    function finish(bool winning) internal {
        draw(winning);
        pool.settle();
    }

    function draw(bool winning) internal {
        IMegapot.DrawingState memory state = live.getDrawingState(drawing);
        vm.warp(state.drawingTime + 1 > pool.cutoff() ? state.drawingTime + 1 : pool.cutoff());
        vm.deal(address(this), 1 ether);
        live.runJackpot{value: live.getEntropyCallbackFee()}();
        uint256[][] memory numbers = new uint256[][](2);
        numbers[0] = new uint256[](5);
        for (uint256 i; i < 5; i++) {
            numbers[0][i] = winning && i < 3 ? i + 1 : i + 6;
        }
        numbers[1] = new uint256[](1);
        numbers[1][0] = winning ? 1 : 2;
        // Deterministic local oracle delivery; this does not test Pyth liveness.
        address oracle = live.entropy();
        vm.prank(oracle);
        live.scaledEntropyCallback(bytes32(0), numbers, "");
        require(live.currentDrawingId() == drawing + 1 && live.getDrawingState(drawing).winningTicket != 0);
    }

    function signature(uint256 key, bytes32 body) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", pool.DOMAIN_SEPARATOR(), body)));
        return abi.encodePacked(r, s, v);
    }

    function testRealWinningClaimAndSponsoredPayout() public {
        finish(true);
        IMegapot.DrawingState memory state = live.getDrawingState(drawing);
        uint256 gross = Payout(state.payoutCalculator).getTierPayout(drawing, 7); // three normals + bonus
        uint256 expected = gross - gross * state.referralWinShare / 1e18;
        require(expected > 0 && pool.winnings() == expected, "net_win_mismatch");
        RewardPool.Registration memory r;
        r.claimant = claimant;
        r.recipient = vm.addr(7);
        r.attemptId = ATTEMPT;
        r.nullifier = bytes32(uint256(1));
        r.expiresAt = block.timestamp + 1 days;
        r.proof = new bytes32[](0);
        r.attestation = signature(
            5, keccak256(abi.encode(pool.ATTESTATION_TYPEHASH(), pool.scope(), r.nullifier, r.claimant, r.expiresAt))
        );
        r.authorization = signature(
            CLAIMANT_KEY,
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
        pool.registerFor(r);
        vm.warp(pool.deadline());
        pool.finalize();
        uint256 beforeBalance = asset.balanceOf(r.recipient);
        pool.withdrawFor(claimant);
        require(asset.balanceOf(r.recipient) - beforeBalance == expected && claimant.balance == 0);
        pool.withdrawSponsor(address(this));
        require(asset.balanceOf(address(pool)) == 0);
    }

    function testRealLosingClaimPaysZero() public {
        finish(false);
        require(pool.winnings() == 0 && pool.settled());
        vm.warp(pool.deadline());
        pool.finalize();
        pool.withdrawSponsor(address(this));
        require(asset.balanceOf(address(pool)) == 0);
    }

    function testRealEmergencyRecoversTicketsAndLeftover() public {
        address owner = live.owner();
        vm.prank(owner);
        live.enableEmergencyMode();
        vm.prank(vm.addr(8));
        pool.recoverEmergency();
        require(pool.cancelled() && !pool.settled() && pool.sponsorBalance() == price + 17);
        pool.withdrawSponsor(address(this));
        require(asset.balanceOf(address(pool)) == 0);
        vm.expectRevert();
        pool.recoverEmergency();
    }

    function testEmergencyAfterCompletedDrawingStillSettlesOldTickets() public {
        draw(true);
        address owner = live.owner();
        vm.prank(owner);
        live.enableEmergencyMode();
        vm.expectRevert();
        pool.recoverEmergency();
        pool.settle();
        require(pool.winnings() > 0 && !pool.cancelled());
    }
}
