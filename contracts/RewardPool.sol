// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import {IMegapot, ITicketOwnership} from "./interfaces/IMegapot.sol";

interface Token {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

/// @notice Local experiment: one immutable pool and drawing, no upgradeability.
/// @dev V2 wire-shaped local provider; no deployed Megapot compatibility is asserted.
contract RewardPool {
    Token public immutable asset;
    IMegapot public immutable jackpot;
    address public immutable ticketNFT;
    address public immutable executor;
    uint256 public immutable maxTicketSpend;
    uint256 public ticketSpend;
    uint256[] public ticketIds;
    bool private entered;
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
        require(
            cutoff_ > block.timestamp && window_ > 0 && tickets_ > 0 && maxTicketSpend_ > 0, "invalid_configuration"
        );
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
        window = window_;
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
        require(purchased && !settled && block.timestamp >= cutoff, "settlement_refused");
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

    function register(
        bytes32 attemptId,
        bytes32[] calldata proof,
        bytes32 nullifier,
        uint256 expiresAt,
        bytes calldata signature
    ) external {
        require(settled && winnings > 0 && !finalized && block.timestamp < deadline, "registration_closed");
        require(
            !registered[msg.sender] && !usedNullifiers[nullifier] && registeredCount < entryCount,
            "duplicate_registration"
        );
        bytes32 leaf = keccak256(abi.encode(address(this), drawingId, msg.sender, attemptId));
        for (uint256 i; i < proof.length; i++) {
            leaf = leaf < proof[i]
                ? keccak256(abi.encodePacked(leaf, proof[i]))
                : keccak256(abi.encodePacked(proof[i], leaf));
        }
        require(leaf == root, "bad_merkle_proof");
        require(block.timestamp < expiresAt && signature.length == 65, "bad_attestation");
        bytes32 body = keccak256(abi.encode(ATTESTATION_TYPEHASH, scope(), nullifier, msg.sender, expiresAt));
        bytes32 message = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, body));
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
        require(ecrecover(message, v, r, s) == attester, "untrusted_attester");
        registered[msg.sender] = true;
        usedNullifiers[nullifier] = true;
        registeredCount++;
        emit Registered(msg.sender, nullifier);
    }

    function finalize() external nonReentrant {
        require(settled && !finalized && block.timestamp >= deadline, "finalization_refused");
        finalized = true;
        share = registeredCount == 0 ? 0 : winnings / registeredCount;
        sponsorBalance += winnings - share * registeredCount;
        emit Finalized(registeredCount, share, sponsorBalance);
    }

    function withdraw(address to) external nonReentrant {
        require(finalized && registered[msg.sender] && !withdrawn[msg.sender] && to != address(0), "withdrawal_refused");
        withdrawn[msg.sender] = true;
        require(asset.transfer(to, share), "transfer_failed");
        emit Withdrawn(msg.sender, to, share);
    }

    function withdrawSponsor(address to) external nonReentrant {
        require(finalized && msg.sender == sponsor && to != address(0), "sponsor_refused");
        uint256 amount = sponsorBalance;
        sponsorBalance = 0;
        require(asset.transfer(to, amount), "transfer_failed");
    }
}
