// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import "../../contracts/OperatorPayments.sol";
import "../../contracts/test/PaymentToken.sol";

interface PaymentsVm {
    function warp(uint256) external;
    function addr(uint256) external returns (address);
    function prank(address) external;
    function expectRevert(bytes calldata) external;
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
}

contract OperatorPaymentsTest {
    PaymentsVm constant vm = PaymentsVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant SIGNER_KEY = 11;
    OperatorPayments payments;
    TestPaymentToken token;
    address community;
    address operator;
    bytes32 constant TICKET = keccak256("ticket");

    function setUp() public {
        vm.warp(1800000000);
        payments = new OperatorPayments();
        token = new TestPaymentToken();
        community = vm.addr(10);
        operator = vm.addr(12);
        vm.prank(community);
        payments.setSigner(vm.addr(SIGNER_KEY));
        token.mint(address(this), 10_000);
        token.approve(address(payments), 10_000);
        payments.deposit(community, address(token), 5_000);
    }

    function purchase(bytes32 unit, uint256 amount) internal view returns (OperatorPayments.Purchase memory) {
        return OperatorPayments.Purchase({
            community: community,
            unit: unit,
            ticketId: TICKET,
            quoteId: keccak256("quote"),
            operator: operator,
            recipient: operator,
            token: address(token),
            amount: amount,
            validAfter: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 120)
        });
    }

    function signed(OperatorPayments.Purchase memory p, uint256 key) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, payments.purchaseDigest(p));
        return abi.encodePacked(r, s, v);
    }

    function testRedeemPaysOnceAndRecordsTheDigest() public {
        OperatorPayments.Purchase memory p = purchase(keccak256("segment:t:seg-01:0"), 1_000);
        bytes memory sig = signed(p, SIGNER_KEY);
        payments.redeem(p, sig);
        require(token.balanceOf(operator) == 1_000, "paid");
        require(payments.balance(community, address(token)) == 4_000, "debited");
        require(payments.redemption(community, p.unit) == payments.purchaseDigest(p), "digest");
        vm.expectRevert(bytes("already_redeemed"));
        payments.redeem(p, sig);
    }

    /// Review finding 1: a shared redeemed flag cannot prove the expected purchase.
    function testDigestDistinguishesARivalPurchaseForTheSameUnit() public {
        bytes32 unit = keccak256("segment:t:seg-02:0");
        OperatorPayments.Purchase memory rival = purchase(unit, 1);
        rival.recipient = community;
        payments.redeem(rival, signed(rival, SIGNER_KEY));
        OperatorPayments.Purchase memory expected = purchase(unit, 1_000);
        require(payments.redeemed(community, unit), "unit redeemed");
        require(payments.redemption(community, unit) != payments.purchaseDigest(expected), "not the expected one");
        require(token.balanceOf(operator) == 0, "operator unpaid");
        bytes memory sig = signed(expected, SIGNER_KEY);
        vm.expectRevert(bytes("already_redeemed"));
        payments.redeem(expected, sig);
    }

    function testOtherSignerOrChangedTermsRefused() public {
        OperatorPayments.Purchase memory p = purchase(keccak256("u"), 1_000);
        bytes memory wrong = signed(p, 13);
        vm.expectRevert(bytes("bad_authorization"));
        payments.redeem(p, wrong);
        bytes memory sig = signed(p, SIGNER_KEY);
        p.amount = 2_000;
        vm.expectRevert(bytes("bad_authorization"));
        payments.redeem(p, sig);
        p.amount = 1_000;
        p.recipient = vm.addr(14);
        vm.expectRevert(bytes("bad_authorization"));
        payments.redeem(p, sig);
    }

    /// Review finding 3: the signed interval, not the remaining time, is bounded.
    function testValidityIntervalIsSignedAndBounded() public {
        OperatorPayments.Purchase memory early = purchase(keccak256("early"), 1_000);
        early.validAfter = uint64(block.timestamp + 10);
        early.expiresAt = uint64(block.timestamp + 70);
        bytes memory earlySig = signed(early, SIGNER_KEY);
        vm.expectRevert(bytes("authorization_not_valid"));
        payments.redeem(early, earlySig);
        OperatorPayments.Purchase memory long = purchase(keccak256("long"), 1_000);
        long.expiresAt = uint64(block.timestamp + 2 hours);
        bytes memory longSig = signed(long, SIGNER_KEY);
        vm.expectRevert(bytes("authorization_not_valid"));
        payments.redeem(long, longSig);
        // Waiting does not make an over-long interval redeemable.
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(bytes("authorization_not_valid"));
        payments.redeem(long, longSig);
        OperatorPayments.Purchase memory p = purchase(keccak256("u"), 1_000);
        bytes memory sig = signed(p, SIGNER_KEY);
        vm.warp(block.timestamp + 120);
        vm.expectRevert(bytes("authorization_not_valid"));
        payments.redeem(p, sig);
    }

    /// Review finding 4: a closed ticket refuses later redemptions by anyone.
    function testClosedTicketRefusesLaterRedemption() public {
        OperatorPayments.Purchase memory p = purchase(keccak256("segment:t:seg-03:0"), 1_000);
        bytes memory sig = signed(p, SIGNER_KEY);
        vm.prank(operator);
        payments.closeTicket(community, TICKET);
        vm.expectRevert(bytes("ticket_closed"));
        payments.redeem(p, sig);
        // Another operator's purchase for the same ticket is unaffected.
        OperatorPayments.Purchase memory other = purchase(keccak256("segment:t:seg-04:0"), 1_000);
        other.operator = vm.addr(15);
        other.recipient = vm.addr(15);
        payments.redeem(other, signed(other, SIGNER_KEY));
        // Admission purchases carry no ticket and are never closed.
        OperatorPayments.Purchase memory admission = purchase(keccak256("admission:job"), 1_000);
        admission.ticketId = bytes32(0);
        payments.redeem(admission, signed(admission, SIGNER_KEY));
        require(token.balanceOf(operator) == 1_000, "admission paid");
    }

    /// Review finding 2: purchases are revocable orders, not funded vouchers.
    function testWithdrawalAndRotationRevokeOutstandingPurchases() public {
        OperatorPayments.Purchase memory p = purchase(keccak256("u"), 1_000);
        bytes memory sig = signed(p, SIGNER_KEY);
        vm.prank(community);
        payments.withdraw(address(token), 5_000, community);
        require(token.balanceOf(community) == 5_000, "withdrawn");
        vm.expectRevert(bytes("insufficient_balance"));
        payments.redeem(p, sig);
        payments.deposit(community, address(token), 5_000);
        vm.prank(community);
        payments.setSigner(vm.addr(16));
        vm.expectRevert(bytes("bad_authorization"));
        payments.redeem(p, sig);
    }

    function testRevertedTransferLeavesUnitUnredeemed() public {
        token.blockRecipient(operator, true);
        OperatorPayments.Purchase memory p = purchase(keccak256("u"), 1_000);
        bytes memory sig = signed(p, SIGNER_KEY);
        vm.expectRevert(bytes("transfer_failed"));
        payments.redeem(p, sig);
        require(!payments.redeemed(community, p.unit), "not marked after revert");
        require(payments.balance(community, address(token)) == 5_000, "not debited after revert");
    }

    function testNoncanonicalSignatureRefused() public {
        OperatorPayments.Purchase memory p = purchase(keccak256("u"), 1_000);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, payments.purchaseDigest(p));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory flipped = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(bytes("noncanonical_signature"));
        payments.redeem(p, flipped);
    }

    function testBatchIsolatesFailures() public {
        OperatorPayments.Purchase[] memory ps = new OperatorPayments.Purchase[](3);
        bytes[] memory sigs = new bytes[](3);
        ps[0] = purchase(keccak256("a"), 1_000);
        ps[1] = purchase(keccak256("b"), 1_000);
        ps[2] = purchase(keccak256("c"), 1_000);
        sigs[0] = signed(ps[0], SIGNER_KEY);
        sigs[1] = signed(ps[1], 13);
        sigs[2] = signed(ps[2], SIGNER_KEY);
        bool[] memory results = payments.redeemBatch(ps, sigs);
        require(results[0] && !results[1] && results[2], "isolated");
        require(token.balanceOf(operator) == 2_000, "two paid");
        vm.expectRevert(bytes("internal_only"));
        payments.redeemOne(ps[1], sigs[1]);
    }
}
