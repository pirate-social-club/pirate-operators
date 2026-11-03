// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import {IMegapot, ITicketOwnership} from "./interfaces/IMegapot.sol";

interface Token {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

/// @notice Local experiment: one immutable pool and drawing, no upgradeability.
/// @dev Pinned V2 fork conformance is tested; this is not a production-audited pool.
contract RewardPool {
    Token public immutable asset;
    IMegapot public immutable jackpot;
    address public immutable ticketNFT;
    address public immutable executor;
    uint256 public immutable maxTicketSpend;
    uint256 public ticketSpend;
    uint256[] public ticketIds;
    bool private entered;
    bool public cancelled;
    uint256 public constant DEFAULT_WINDOW = 7 days;
    uint256 public constant MAX_BATCH = 32;
    uint256 public constant ITEM_GAS = 300_000;
    mapping(address => address) public payoutRecipient;
    bytes32 public constant REGISTRATION_TYPEHASH = keccak256(
        "Registration(bytes32 scope,address claimant,address recipient,bytes32 attemptId,bytes32 nullifier,uint256 expiresAt)"
    );

    struct Registration {
        address claimant;
        address recipient;
        bytes32 attemptId;
        bytes32 nullifier;
        uint256 expiresAt;
        bytes32[] proof;
        bytes attestation;
        bytes authorization;
    }
    event BatchItem(uint256 indexed index, address indexed claimant, bool success);
    event Cancelled(uint256 recovered);

    address public immutable sponsor;
    address public immutable verifier;
    address public immutable attester;
    uint256 public immutable drawingId;
    uint256 public immutable cutoff;
    uint256 public immutable window;
    uint256 public immutable tickets;
    bytes32 public immutable policyHash;
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant ATTESTATION_TYPEHASH =
        keccak256("RewardAttestation(bytes32 scope,bytes32 nullifier,address claimant,uint256 expiresAt)");
    bytes32 public root;
    uint256 public entryCount;
    uint256 public winnings;
    uint256 public deadline;
    uint256 public registeredCount;
    uint256 public share;
    uint256 public sponsorBalance;
    bool public committed;
    bool public purchased;
    bool public settled;
    bool public finalized;
    mapping(address => bool) public registered;
    mapping(bytes32 => bool) public usedNullifiers;
    mapping(address => bool) public withdrawn;
    event EntriesCommitted(bytes32 root, uint256 count);
    event Settled(uint256 winnings, uint256 deadline);
    event Registered(address indexed claimant, bytes32 nullifier);
    event Finalized(uint256 count, uint256 share, uint256 sponsorBalance);
    event Withdrawn(address indexed claimant, address to, uint256 amount);

    constructor(
        address asset_,
        address jackpot_,
        address executor_,
        address verifier_,
        address attester_,
        uint256 drawing_,
        uint256 cutoff_,
        uint256 window_,
        uint256 tickets_,
        uint256 maxTicketSpend_,
        bytes32 policy_
    ) {
        require(
            asset_ != address(0) && jackpot_ != address(0) && executor_ != address(0) && verifier_ != address(0)
                && attester_ != address(0),
            "zero_address"
        );
        require(cutoff_ > block.timestamp && tickets_ > 0 && maxTicketSpend_ > 0, "invalid_configuration");
        asset = Token(asset_);
        jackpot = IMegapot(jackpot_);
        require(jackpot.usdc() == asset_, "wrong_asset");
        ticketNFT = jackpot.jackpotNFT();
        require(ticketNFT.code.length > 0, "invalid_ticket_nft");
        executor = executor_;
        maxTicketSpend = maxTicketSpend_;
        sponsor = msg.sender;
        verifier = verifier_;
        attester = attester_;
        drawingId = drawing_;
        cutoff = cutoff_;
        window = window_ == 0 ? DEFAULT_WINDOW : window_;
        tickets = tickets_;
        policyHash = policy_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Pirate Reward Pool"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function scope() public view returns (bytes32) {
        return keccak256(abi.encode("pirate-pool-registration/1", block.chainid, address(this), drawingId));
    }

    function commitEntries(bytes32 root_, uint256 count, bytes32 policy) external {
        require(msg.sender == verifier && !committed && block.timestamp < cutoff, "commit_refused");
        require(policy == policyHash && ((count == 0) == (root_ == bytes32(0))), "bad_commitment");
        committed = true;
        root = root_;
        entryCount = count;
        emit EntriesCommitted(root_, count);
    }

    modifier nonReentrant() {
        require(!entered, "reentrant_call");
        entered = true;
        _;
        entered = false;
    }

    function purchase(IMegapot.Ticket[] calldata selections) external nonReentrant {
        require(
            msg.sender == executor && committed && !purchased && entryCount > 0 && block.timestamp < cutoff,
            "purchase_refused"
        );
        require(
            selections.length == tickets && jackpot.currentDrawingId() == drawingId && jackpot.allowTicketPurchases(),
            "drawing_unavailable"
        );
        IMegapot.DrawingState memory state = jackpot.getDrawingState(drawingId);
        require(!state.jackpotLock && state.ticketPrice > 0, "invalid_ticket_quote");
        uint256 cost = state.ticketPrice * tickets;
        require(cost <= maxTicketSpend, "ticket_budget_exceeded");
        uint256 beforeBalance = asset.balanceOf(address(this));
        require(beforeBalance >= cost, "insufficient_ticket_funding");
        purchased = true;
        require(asset.approve(address(jackpot), cost), "approve_failed");
        uint256[] memory ids = jackpot.buyTickets(
            selections, address(this), new address[](0), new uint256[](0), bytes32("pirate-operators")
        );
        require(ids.length == tickets, "invalid_ticket_receipt");
        for (uint256 i; i < ids.length; i++) {
            require(ITicketOwnership(ticketNFT).ownerOf(ids[i]) == address(this), "ticket_not_owned");
            for (uint256 j; j < i; j++) {
                require(ids[j] != ids[i], "duplicate_ticket_id");
            }
        }
        require(jackpot.currentDrawingId() == drawingId, "drawing_changed");
        require(beforeBalance - asset.balanceOf(address(this)) == cost, "ticket_spend_mismatch");
        require(asset.approve(address(jackpot), 0), "approval_reset_failed");
        ticketIds = ids;
        ticketSpend = cost;
        sponsorBalance = beforeBalance - cost;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        require(msg.sender == ticketNFT && purchased && !settled, "unexpected_nft");
        return this.onERC721Received.selector;
    }

    function settle() external nonReentrant {
        require(purchased && !settled && !cancelled && block.timestamp >= cutoff, "settlement_refused");
        require(
            jackpot.currentDrawingId() > drawingId && jackpot.getDrawingState(drawingId).winningTicket != 0,
            "drawing_not_final"
        );
        settled = true;
        uint256 beforeBalance = asset.balanceOf(address(this));
        jackpot.claimWinnings(ticketIds);
        winnings = asset.balanceOf(address(this)) - beforeBalance;
        deadline = block.timestamp + window;
        emit Settled(winnings, deadline);
    }

    // Direct registration authenticates the claimant through their transaction.
    function register(
        bytes32 attemptId,
        bytes32[] calldata proof,
        bytes32 nullifier,
        uint256 expiresAt,
        bytes calldata signature
    ) external nonReentrant {
        _register(msg.sender, msg.sender, attemptId, proof, nullifier, expiresAt, signature);
    }

    // A relayer is never trusted to choose the claimant or payout recipient.
    function registerFor(Registration calldata r) external nonReentrant {
        bytes32 body = keccak256(
            abi.encode(REGISTRATION_TYPEHASH, scope(), r.claimant, r.recipient, r.attemptId, r.nullifier, r.expiresAt)
        );
        require(_recover(body, r.authorization) == r.claimant && r.claimant != address(0), "bad_authorization");
        _register(r.claimant, r.recipient, r.attemptId, r.proof, r.nullifier, r.expiresAt, r.attestation);
    }

    function _register(
        address claimant,
        address recipient,
        bytes32 attemptId,
        bytes32[] calldata proof,
        bytes32 nullifier,
        uint256 expiresAt,
        bytes calldata signature
    ) internal {
        require(
            settled && !cancelled && winnings > 0 && !finalized && block.timestamp < deadline, "registration_closed"
        );
        require(_supportedClaimant(claimant) && recipient != address(0), "unsupported_wallet_or_recipient");
        require(
            !registered[claimant] && !usedNullifiers[nullifier] && registeredCount < entryCount,
            "duplicate_registration"
        );
        require(proof.length <= 64, "proof_too_long");
        bytes32 leaf = keccak256(abi.encode(address(this), drawingId, claimant, attemptId));
        for (uint256 i; i < proof.length; i++) {
            leaf = leaf < proof[i]
                ? keccak256(abi.encodePacked(leaf, proof[i]))
                : keccak256(abi.encodePacked(proof[i], leaf));
        }
        require(leaf == root, "bad_merkle_proof");
        require(block.timestamp < expiresAt, "expired_attestation");
        require(
            _recover(keccak256(abi.encode(ATTESTATION_TYPEHASH, scope(), nullifier, claimant, expiresAt)), signature)
                == attester,
            "untrusted_attester"
        );
        registered[claimant] = true;
        payoutRecipient[claimant] = recipient;
        usedNullifiers[nullifier] = true;
        registeredCount++;
        emit Registered(claimant, nullifier);
    }

    function _supportedClaimant(address claimant) internal view returns (bool) {
        uint256 size = claimant.code.length;
        // EIP-7702 stores exactly 0xef0100 followed by a 20-byte delegate address.
        // Read the marker only; sponsored authorization still recovers the EOA key.
        return size == 0 || (size == 23 && bytes3(claimant.code) == hex"ef0100");
    }

    function _recover(bytes32 body, bytes calldata signature) internal view returns (address) {
        require(signature.length == 65, "bad_signature_length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        require(
            uint256(s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0 && (v == 27 || v == 28),
            "noncanonical_signature"
        );
        return ecrecover(keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, body)), v, r, s);
    }

    // Individual self-calls roll back independently, including out-of-gas items.
    // Callers still need enough gas for the bounded outer loop and calldata.
    function registerBatch(Registration[] calldata rows) external returns (bool[] memory results) {
        _batchSize(rows.length);
        results = new bool[](rows.length);
        for (uint256 i; i < rows.length; i++) {
            if (rows[i].proof.length > 64 || rows[i].attestation.length != 65 || rows[i].authorization.length != 65) {
                emit BatchItem(i, rows[i].claimant, false);
                continue;
            }
            (results[i],) = address(this).call{gas: ITEM_GAS}(abi.encodeCall(this.registerFor, (rows[i])));
            emit BatchItem(i, rows[i].claimant, results[i]);
        }
    }

    function withdrawBatch(address[] calldata claimants) external returns (bool[] memory results) {
        _batchSize(claimants.length);
        results = new bool[](claimants.length);
        for (uint256 i; i < claimants.length; i++) {
            (results[i],) = address(this).call{gas: ITEM_GAS}(abi.encodeCall(this.withdrawFor, (claimants[i])));
            emit BatchItem(i, claimants[i], results[i]);
        }
    }

    function _batchSize(uint256 count) internal view {
        require(count > 0 && count <= MAX_BATCH, "invalid_batch_size");
        require(gasleft() >= count * (ITEM_GAS + 70_000) + 50_000, "insufficient_batch_gas");
    }

    function finalize() external nonReentrant {
        require(settled && !cancelled && !finalized && block.timestamp >= deadline, "finalization_refused");
        finalized = true;
        share = registeredCount == 0 ? 0 : winnings / registeredCount;
        sponsorBalance += winnings - share * registeredCount;
        emit Finalized(registeredCount, share, sponsorBalance);
    }

    function withdraw(address to) external nonReentrant {
        // The claimant retains their existing direct, authenticated recovery path.
        _withdraw(msg.sender, to);
    }

    function withdrawFor(address claimant) external nonReentrant {
        _withdraw(claimant, payoutRecipient[claimant]);
    }

    function _withdraw(address claimant, address to) internal {
        require(
            finalized && !cancelled && registered[claimant] && !withdrawn[claimant] && to != address(0),
            "withdrawal_refused"
        );
        withdrawn[claimant] = true;
        require(asset.transfer(to, share), "transfer_failed");
        emit Withdrawn(claimant, to, share);
    }

    function recoverEmergency() external nonReentrant {
        require(purchased && !settled && !cancelled && jackpot.emergencyMode(), "emergency_refused");
        require(
            jackpot.currentDrawingId() == drawingId && jackpot.getDrawingState(drawingId).winningTicket == 0,
            "drawing_not_refundable"
        );
        uint256 beforeBalance = asset.balanceOf(address(this));
        jackpot.emergencyRefundTickets(ticketIds);
        uint256 recovered = asset.balanceOf(address(this)) - beforeBalance;
        // Pull-based sponsor credit makes a failed sponsor transfer retryable.
        sponsorBalance += recovered;
        cancelled = true;
        emit Cancelled(recovered);
    }

    function refundUnpurchased(address to) external nonReentrant {
        require(msg.sender == sponsor && !purchased && block.timestamp >= cutoff && to != address(0), "refund_refused");
        require(asset.transfer(to, asset.balanceOf(address(this))), "transfer_failed");
    }

    function withdrawSponsor(address to) external nonReentrant {
        require((finalized || cancelled) && msg.sender == sponsor && to != address(0), "sponsor_refused");
        uint256 amount = sponsorBalance;
        sponsorBalance = 0;
        require(asset.transfer(to, amount), "transfer_failed");
    }
}
