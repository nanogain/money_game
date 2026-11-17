// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Comptes de jeu ERC-4337 : la clé de session du navigateur contrôle un SimpleAccount (modèle de
// référence d'eth-infinitism, EntryPoint v0.7). Ses transactions sont des « UserOperations » dont
// les frais sont payés par le paymaster de la plateforme (Coinbase CDP) : le joueur n'a pas besoin d'ETH.
import {SimpleAccountFactory} from "@account-abstraction/contracts/samples/SimpleAccountFactory.sol";
