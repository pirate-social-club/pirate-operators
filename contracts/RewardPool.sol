// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

interface Token {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface Jackpot {
    function buy(uint256 drawing, uint256 count) external;
    function claim(uint256 drawing) external;
}

/// @notice Local experiment: one immutable pool and drawing, no upgradeability.
/// @dev Jackpot is a simulated interface, not a claim of Megapot compatibility.
contract RewardPool {
    Token public immutable asset;
    Jackpot public immutable jackpot;
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
        address verifier_,
        address attester_,
        uint256 drawing_,
        uint256 cutoff_,
        uint256 window_,
        uint256 tickets_,
        bytes32 policy_
    ) {
        require(
            asset_ != address(0) && jackpot_ != address(0) && verifier_ != address(0) && attester_ != address(0),
            "zero_address"
        );
        require(cutoff_ > block.timestamp && window_ > 0 && tickets_ > 0, "invalid_configuration");
        asset = Token(asset_);
        jackpot = Jackpot(jackpot_);
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
                keccak256("PirateRewardPool"),
                keccak256("0"),
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

    function purchase() external {
        require(
            msg.sender == sponsor && committed && !purchased && entryCount > 0 && block.timestamp < cutoff,
            "purchase_refused"
        );
        purchased = true;
        require(asset.approve(address(jackpot), tickets), "approve_failed");
        jackpot.buy(drawingId, tickets);
    }

    function settle() external {
        require(purchased && !settled && block.timestamp >= cutoff, "settlement_refused");
        settled = true;
        uint256 beforeBalance = asset.balanceOf(address(this));
        jackpot.claim(drawingId);
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

    function finalize() external {
        require(settled && !finalized && block.timestamp >= deadline, "finalization_refused");
        finalized = true;
        share = registeredCount == 0 ? 0 : winnings / registeredCount;
        sponsorBalance = winnings - share * registeredCount;
        emit Finalized(registeredCount, share, sponsorBalance);
    }

    function withdraw(address to) external {
        require(finalized && registered[msg.sender] && !withdrawn[msg.sender] && to != address(0), "withdrawal_refused");
        withdrawn[msg.sender] = true;
        require(asset.transfer(to, share), "transfer_failed");
        emit Withdrawn(msg.sender, to, share);
    }

    function withdrawSponsor(address to) external {
        require(finalized && msg.sender == sponsor && to != address(0), "sponsor_refused");
        uint256 amount = sponsorBalance;
        sponsorBalance = 0;
        require(asset.transfer(to, amount), "transfer_failed");
    }
}
