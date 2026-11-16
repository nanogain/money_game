// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Faux USDC (6 décimales) pour les tests locaux et le réseau de test.
/// Tout le monde peut s'en distribuer avec faucet(). NE PAS déployer sur un réseau réel.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet(uint256 amount) external {
        require(amount <= 10_000e6, "max 10 000 USDC par appel");
        _mint(msg.sender, amount);
    }
}
