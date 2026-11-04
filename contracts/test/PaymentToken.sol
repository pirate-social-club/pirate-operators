// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

/// @dev Local operator-payment token: plain ERC-20 transfers that emit the
/// standard Transfer event, six decimals and no value. TestUSDC emits no
/// events, so it cannot identify a payment by its log. `blockRecipient` forces
/// a reverted transfer for failure tests.
contract TestPaymentToken {
    string public constant name = "Pirate Local Test USD (no value)";
    string public constant symbol = "plUSD";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function blockRecipient(address to, bool value) external {
        blocked[to] = value;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
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
        require(!blocked[to] && balanceOf[from] >= amount, "transfer_failed");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
