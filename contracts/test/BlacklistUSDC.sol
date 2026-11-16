// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Jeton de test qui imite la liste noire de l'USDC réel : les virements vers une
///         adresse bloquée échouent. Uniquement pour les tests.
contract BlacklistUSDC is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Blacklist USDC", "bUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool value) external {
        blocked[who] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "bloque");
        super._update(from, to, value);
    }
}
