// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import {IMegapot} from "../interfaces/IMegapot.sol";

contract TestUSDC {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;
    mapping(address => bool) public gasBurner;

    function setGasBurner(address to, bool value) external {
        gasBurner[to] = value;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function blockRecipient(address to, bool value) external {
        blocked[to] = value;
    }

    function approve(address to, uint256 amount) external returns (bool) {
        allowance[msg.sender][to] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (gasBurner[to]) {
            assembly { invalid() }
        }
        require(!blocked[to] && balanceOf[from] >= amount, "transfer_failed");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev Independent local V2 wire simulation, not the upstream implementation.
contract MockJackpot is IMegapot {
    TestUSDC public immutable asset;
    uint256 public currentDrawingId = 1;
    bool public allowTicketPurchases = true;
    bool public earlyClaimReturnsZero;
    bool public failClaim;
    bool public emergencyMode;
    bool public failRefund;

    function setEmergency(bool value, bool fail) external {
        emergencyMode = value;
        failRefund = fail;
    }
    bool public reenterFinalize;
    bool public finalizeSucceeded;
    uint256 public claimCalls;
    uint256 public nextTicketId = 1;
    mapping(uint256 => DrawingState) private states;
    mapping(uint256 => address) private owners;
    mapping(uint256 => uint256) public ticketDrawing;
    mapping(uint256 => bool) public drawn;
    mapping(uint256 => uint256) public outcome;
    mapping(uint256 => bool) private paid;

    constructor(address token) {
        asset = TestUSDC(token);
        states[1].ticketPrice = 1_000_000;
    }

    function usdc() external view returns (address) {
        return address(asset);
    }

    function jackpotNFT() external view returns (address) {
        return address(this);
    }

    function ownerOf(uint256 id) external view returns (address) {
        require(owners[id] != address(0), "missing_ticket");
        return owners[id];
    }

    function getDrawingState(uint256 id) external view returns (DrawingState memory) {
        return states[id];
    }

    function setTicketPrice(uint256 value) external {
        states[currentDrawingId].ticketPrice = value;
    }

    function setClaimModes(bool earlyZero, bool fail) external {
        earlyClaimReturnsZero = earlyZero;
        failClaim = fail;
    }

    function setReenterFinalize(bool value) external {
        reenterFinalize = value;
    }

    function lockDrawing() external {
        states[currentDrawingId].jackpotLock = true;
    }

    function advanceWithoutResult() external {
        currentDrawingId++;
    }

    function buyTickets(
        Ticket[] calldata selections,
        address recipient,
        address[] calldata,
        uint256[] calldata,
        bytes32
    ) external returns (uint256[] memory ids) {
        require(!emergencyMode && allowTicketPurchases && !states[currentDrawingId].jackpotLock, "purchases_closed");
        require(asset.transferFrom(msg.sender, address(this), selections.length * states[currentDrawingId].ticketPrice));
        ids = new uint256[](selections.length);
        for (uint256 i; i < selections.length; i++) {
            uint256 id = nextTicketId++;
            ids[i] = id;
            owners[id] = recipient;
            ticketDrawing[id] = currentDrawingId;
            if (recipient.code.length > 0) {
                (bool ok, bytes memory response) = recipient.call(
                    abi.encodeWithSignature(
                        "onERC721Received(address,address,uint256,bytes)", msg.sender, address(0), id, bytes("")
                    )
                );
                require(
                    ok
                        && abi.decode(response, (bytes4))
                            == bytes4(keccak256("onERC721Received(address,address,uint256,bytes)")),
                    "nft_rejected"
                );
            }
        }
    }

    function draw(uint256 id, uint256 win) external {
        require(!drawn[id], "already_drawn");
        drawn[id] = true;
        outcome[id] = win;
        states[id].winningTicket = 1;
        if (currentDrawingId <= id) currentDrawingId = id + 1;
        asset.mint(address(this), win);
    }

    function emergencyRefundTickets(uint256[] calldata ids) external {
        require(emergencyMode && !failRefund, "refund_unavailable");
        uint256 amount;
        for (uint256 i; i < ids.length; i++) {
            uint256 id = ids[i];
            require(ticketDrawing[id] == currentDrawingId && owners[id] == msg.sender, "not_refundable");
            delete owners[id];
            amount += states[currentDrawingId].ticketPrice;
        }
        require(asset.transfer(msg.sender, amount));
    }

    function claimWinnings(uint256[] calldata ids) external {
        claimCalls++;
        require(!failClaim, "provider_claim_failed");
        uint256 amount;
        for (uint256 i; i < ids.length; i++) {
            uint256 id = ids[i];
            uint256 drawing = ticketDrawing[id];
            if (!drawn[drawing] && earlyClaimReturnsZero) return;
            require(drawn[drawing] && drawing < currentDrawingId && owners[id] == msg.sender, "not_claimable");
            delete owners[id];
            if (!paid[drawing]) {
                amount += outcome[drawing];
                paid[drawing] = true;
            }
        }
        if (reenterFinalize) (finalizeSucceeded,) = msg.sender.call(abi.encodeWithSignature("finalize()"));
        require(asset.transfer(msg.sender, amount));
    }
}
