// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice Jeton de test (6 décimales, comme l'USDC) pour les tests locaux et le réseau de test.
/// Tout le monde peut s'en distribuer avec faucet(). NE PAS déployer sur un réseau réel.
/// Son nom et son symbole ne doivent pas imiter un vrai jeton (USDC, USDT…) : les wallets
/// (MetaMask / Blockaid) signalent comme trompeuses les demandes liées à un jeton qui en imite un autre.
/// Comme le vrai USDC, il accepte les autorisations signées (permit, EIP-2612) : le joueur
/// autorise les mises par une simple signature, sans payer de frais.
contract MockUSDC is ERC20, ERC20Permit {
    constructor() ERC20("Jeton de test Arene", "ARENETEST") ERC20Permit("Jeton de test Arene") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet(uint256 amount) external {
        require(amount <= 10_000e6, "max 10 000 jetons par appel");
        _mint(msg.sender, amount);
    }

    /// @notice Pareil, mais vers une autre adresse : la clé de session du site peut ainsi
    ///         distribuer des jetons de test au joueur sans fenêtre de confirmation.
    function faucetTo(address to, uint256 amount) external {
        require(amount <= 10_000e6, "max 10 000 jetons par appel");
        _mint(to, amount);
    }
}
