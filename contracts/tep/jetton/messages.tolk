// SPDX-License-Identifier: UNLICENSED

type ForwardPayloadRemainder = RemainingBitsAndRefs

struct (0x0f8a7ea5) AskToTransfer {
    queryId: uint64
    jettonAmount: coins
    transferRecipient: address
    sendExcessesTo: address?
    customPayload: cell?
    forwardTonAmount: coins
    forwardPayload: ForwardPayloadRemainder
}

struct (0x7362d09c) TransferNotificationForRecipient {
    queryId: uint64
    jettonAmount: coins
    transferInitiator: address?
    forwardPayload: ForwardPayloadRemainder
}

struct (0x178d4519) InternalTransferStep {
    queryId: uint64
    jettonAmount: coins
    transferInitiator: address? // is null when minting (not initiated by another wallet)
    sendExcessesTo: address?
    forwardTonAmount: coins
    forwardPayload: ForwardPayloadRemainder
}

struct (0xd53276db) ReturnExcessesBack {
    queryId: uint64
}

struct (0x595f07bc) AskToBurn {
    queryId: uint64
    jettonAmount: coins
    sendExcessesTo: address?
    customPayload: cell?
}

struct (0x7bdd97de) BurnNotificationForMinter {
    queryId: uint64
    jettonAmount: coins
    burnInitiator: address
    sendExcessesTo: address?
}

struct (0x2c76b973) RequestWalletAddress {
    queryId: uint64
    ownerAddress: address
    includeOwnerAddress: bool
}

struct (0xd1735400) ResponseWalletAddress {
    queryId: uint64
    jettonWalletAddress: address?
    ownerAddress: Cell<address>?
}

struct (0x00000015) MintNewJettons {
    queryId: uint64
    mintRecipient: address
    tonAmount: coins
    internalTransferMsg: Cell<InternalTransferStep>
}

struct (0x00000003) ChangeMinterAdmin {
    queryId: uint64
    newAdminAddress: address
}

struct (0x00000004) ChangeMinterContent {
    queryId: uint64
    newContent: cell
}

struct (0x00000005) ChangeDisplayMultiplier {
    queryId: uint64
    numerator: uint256  // TEP-526: numerator for display multiplier (VarUInteger 32 in external message)
    denominator: uint256  // TEP-526: denominator for display multiplier (VarUInteger 32 in external message)
    comment: cell?  // Optional comment (SnakeString format - stored as cell with string data)
}


struct (0xac392598) DisplayMultiplierChanged {
    numerator: varuint32    // TL-B VarUInteger 32 (len + bytes) via STVARUINT32
    denominator: varuint32
    comment: cell?            // Maybe ^Cell (SnakeString root cell is OK)
}