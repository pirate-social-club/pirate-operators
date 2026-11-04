// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

interface IPaymentToken {
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @notice Prepaid operator work for communities on MegaETH
/// (docs/operator-payments.md). A community deposits funds and signs one
/// Purchase per unit of work: a karaoke segment take or an admission job.
/// Anyone may redeem a purchase; the contract pays the signed recipient the
/// signed amount at most once per (community, unit) and records which
/// purchase it paid.
///
/// Purchases are revocable purchase orders, not guaranteed vouchers: a
/// community may withdraw its deposit or rotate its signer at any time, and
/// outstanding purchases may promise more than the deposit holds. An operator
/// relies on a confirmed redemption before incurring costs it needs covered.
contract OperatorPayments {
    struct Purchase {
        /// The community's admin address, which is its identity here.
        address community;
        /// keccak256 of the unit key, "segment:<ticket>:<segment>:<take>" or "admission:<job>".
        bytes32 unit;
        /// Zero for admission jobs.
        bytes32 ticketId;
        bytes32 quoteId;
        address operator;
        address recipient;
        address token;
        uint256 amount;
        /// The signed validity interval: redeemable from validAfter until before expiresAt.
        uint64 validAfter;
        uint64 expiresAt;
    }

    bytes32 public constant PURCHASE_TYPEHASH = keccak256(
        "Purchase(address community,bytes32 unit,bytes32 ticketId,bytes32 quoteId,address operator,address recipient,address token,uint256 amount,uint64 validAfter,uint64 expiresAt)"
    );
    /// The longest signed validity interval a purchase may carry.
    uint256 public constant MAX_AUTHORIZATION_LIFETIME = 1 hours;
    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(address community => address) public signer;
    mapping(address community => mapping(address token => uint256)) public balance;
    /// The digest of the purchase paid for each unit, or zero.
    mapping(address community => mapping(bytes32 unit => bytes32)) public redemption;
    /// An operator closes a ticket at finalization; no later purchase for it is paid.
    mapping(address community => mapping(bytes32 ticketId => mapping(address operator => bool))) public closed;
    uint256 private locked = 1;

    event SignerSet(address indexed community, address signer);
    event Deposited(address indexed community, address indexed token, address from, uint256 amount);
    event Withdrawn(address indexed community, address token, uint256 amount, address to);
    event TicketClosed(address indexed community, bytes32 indexed ticketId, address indexed operator);
    event Purchased(
        address indexed community,
        bytes32 indexed unit,
        address indexed operator,
        bytes32 digest,
        bytes32 ticketId,
        bytes32 quoteId,
        address recipient,
        address token,
        uint256 amount
    );

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Pirate Operator Payments"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    modifier nonReentrant() {
        require(locked == 1, "reentrant");
        locked = 2;
        _;
        locked = 1;
    }

    /// @notice The caller's address is the community; this names the key that signs its purchases.
    function setSigner(address purchaseSigner) external {
        signer[msg.sender] = purchaseSigner;
        emit SignerSet(msg.sender, purchaseSigner);
    }

    function deposit(address community, address token, uint256 amount) external nonReentrant {
        require(community != address(0) && token != address(0) && amount > 0, "invalid_deposit");
        require(IPaymentToken(token).transferFrom(msg.sender, address(this), amount), "transfer_failed");
        balance[community][token] += amount;
        emit Deposited(community, token, msg.sender, amount);
    }

    function withdraw(address token, uint256 amount, address to) external nonReentrant {
        require(to != address(0) && amount > 0, "invalid_withdrawal");
        require(balance[msg.sender][token] >= amount, "insufficient_balance");
        balance[msg.sender][token] -= amount;
        require(IPaymentToken(token).transfer(to, amount), "transfer_failed");
        emit Withdrawn(msg.sender, token, amount, to);
    }

    /// @notice The caller, as operator, closes a ticket; its later purchases naming this operator are refused.
    function closeTicket(address community, bytes32 ticketId) external {
        require(ticketId != bytes32(0), "invalid_ticket");
        closed[community][ticketId][msg.sender] = true;
        emit TicketClosed(community, ticketId, msg.sender);
    }

    function redeemed(address community, bytes32 unit) external view returns (bool) {
        return redemption[community][unit] != bytes32(0);
    }

    function purchaseDigest(Purchase calldata p) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(
                    abi.encode(
                        PURCHASE_TYPEHASH,
                        p.community,
                        p.unit,
                        p.ticketId,
                        p.quoteId,
                        p.operator,
                        p.recipient,
                        p.token,
                        p.amount,
                        p.validAfter,
                        p.expiresAt
                    )
                )
            )
        );
    }

    function redeem(Purchase calldata p, bytes calldata signature) external nonReentrant {
        _redeem(p, signature);
    }

    /// @notice Redeems each purchase independently; one failure never blocks the rest.
    function redeemBatch(Purchase[] calldata purchases, bytes[] calldata signatures)
        external
        nonReentrant
        returns (bool[] memory results)
    {
        require(purchases.length == signatures.length && purchases.length <= 50, "invalid_batch");
        results = new bool[](purchases.length);
        for (uint256 i = 0; i < purchases.length; i++) {
            try this.redeemOne(purchases[i], signatures[i]) {
                results[i] = true;
            } catch {
                results[i] = false;
            }
        }
    }

    /// @dev Only callable by this contract, for redeemBatch's per-item rollback.
    function redeemOne(Purchase calldata p, bytes calldata signature) external {
        require(msg.sender == address(this), "internal_only");
        _redeem(p, signature);
    }

    function _redeem(Purchase calldata p, bytes calldata signature) internal {
        require(
            p.validAfter <= block.timestamp && block.timestamp < p.expiresAt
                && p.expiresAt - p.validAfter <= MAX_AUTHORIZATION_LIFETIME,
            "authorization_not_valid"
        );
        require(p.amount > 0 && p.recipient != address(0) && p.token != address(0), "invalid_purchase");
        require(p.ticketId == bytes32(0) || !closed[p.community][p.ticketId][p.operator], "ticket_closed");
        require(redemption[p.community][p.unit] == bytes32(0), "already_redeemed");
        bytes32 digest = purchaseDigest(p);
        address expected = signer[p.community];
        require(expected != address(0) && _recover(digest, signature) == expected, "bad_authorization");
        require(balance[p.community][p.token] >= p.amount, "insufficient_balance");
        redemption[p.community][p.unit] = digest;
        balance[p.community][p.token] -= p.amount;
        require(IPaymentToken(p.token).transfer(p.recipient, p.amount), "transfer_failed");
        emit Purchased(p.community, p.unit, p.operator, digest, p.ticketId, p.quoteId, p.recipient, p.token, p.amount);
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
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
        return ecrecover(digest, v, r, s);
    }
}
