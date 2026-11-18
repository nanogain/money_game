// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// POUR LES TESTS LOCAUX UNIQUEMENT : paymaster qui paie tout, et l'EntryPoint officiel v0.7.
import {BasePaymaster} from "@account-abstraction/contracts/core/BasePaymaster.sol";
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";

contract OpenPaymaster is BasePaymaster {
    constructor(IEntryPoint ep) BasePaymaster(ep) {}

    function _validatePaymasterUserOp(PackedUserOperation calldata, bytes32, uint256)
        internal
        pure
        override
        returns (bytes memory context, uint256 validationData)
    {
        return ("", 0);
    }
}
