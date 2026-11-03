// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

/// @notice Minimal V2 wire surface, independently declared from published ABI facts.
/// @dev Source pins and unverified deployment assumptions are in docs/megapot-boundary.md.
interface IMegapot {
    struct Ticket {
        uint8[] normals;
        uint8 bonusball;
    }

    struct DrawingState {
        uint256 prizePool;
        uint256 ticketPrice;
        uint256 edgePerTicket;
        uint256 referralWinShare;
        uint256 referralFee;
        uint256 globalTicketsBought;
        uint256 lpEarnings;
        uint256 drawingTime;
        uint256 winningTicket;
        uint8 ballMax;
        uint8 bonusballMax;
        address payoutCalculator;
        bool jackpotLock;
    }
    function usdc() external view returns (address);
    function jackpotNFT() external view returns (address);
    function allowTicketPurchases() external view returns (bool);
    function currentDrawingId() external view returns (uint256);
    function getDrawingState(uint256 drawing) external view returns (DrawingState memory);
    function buyTickets(
        Ticket[] calldata selections,
        address recipient,
        address[] calldata referrers,
        uint256[] calldata referralSplit,
        bytes32 source
    ) external returns (uint256[] memory ids);
    function claimWinnings(uint256[] calldata ids) external;
}

interface ITicketOwnership {
    function ownerOf(uint256 ticketId) external view returns (address);
}
