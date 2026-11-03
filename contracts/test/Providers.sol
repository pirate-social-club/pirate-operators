// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

contract TestUSDC {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

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
        require(!blocked[to] && balanceOf[from] >= amount, "transfer_failed");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract MockJackpot {
    TestUSDC public immutable asset;
    mapping(uint256 => mapping(address => uint256)) public tickets;
    mapping(uint256 => bool) public drawn;
    mapping(uint256 => uint256) public outcome;
    mapping(uint256 => mapping(address => bool)) public claimed;

    constructor(address token) {
        asset = TestUSDC(token);
    }

    function buy(uint256 drawing, uint256 count) external {
        require(!drawn[drawing], "already_drawn");
        require(asset.transferFrom(msg.sender, address(this), count));
        tickets[drawing][msg.sender] += count;
    }

    function draw(uint256 drawing, uint256 win) external {
        require(!drawn[drawing], "already_drawn");
        drawn[drawing] = true;
        outcome[drawing] = win;
        asset.mint(address(this), win);
    }

    function claim(uint256 drawing) external {
        require(drawn[drawing] && tickets[drawing][msg.sender] > 0 && !claimed[drawing][msg.sender], "not_claimable");
        claimed[drawing][msg.sender] = true;
        require(asset.transfer(msg.sender, outcome[drawing]));
    }
}
