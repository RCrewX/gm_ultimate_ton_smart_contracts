// SPDX-License-Identifier: UNLICENSED
// Constants
const BASIC_STORAGE_TAX = ton("0.01");
const DEFAULT_REDIRECT_EXCESS = false;
const DEFAULT_EXCESS_THRESHOLD = ton("0.5"); // Default excess threshold
const MIN_EXCESS_THRESHOLD = ton("0.01"); // Minimum allowed excess threshold

// Gas costs from gas consumption tests (in TON)
// These are maximum expected costs for each operation
const GAS_COST_FORWARD: coins = ton("0.005"); // 0.0031816 + buffer
const GAS_COST_FORWARD_WITH_INIT: coins = ton("0.01"); // Higher cost for deploy messages
const GAS_COST_WITHDRAW: coins = ton("0.005"); // Gas cost for withdraw operation
const GAS_MARGIN: coins = ton("0.01"); // Safety margin for external message execution
const GAS_COST_MANUAL_DEPLOY: int = ton("0.4");
// Errors
const ERR_UNAUTHORIZED = 901;  // Generic unauthorized (kept for backward compatibility)
const ERR_MESSAGE_VALUE_TOO_LOW = 904;  // Message value is too low (less than estimated gas cost)
const ERR_NOT_ENOUGH_BALANCE = 906;  // Not enough balance to perform the operation
// Subcontract-specific errors
const ERR_INVALID_OWNER_SENDER = 926;  // Sender is not the subcontract's owner address
const ERR_WITHDRAW_AMOUNT_TOO_LOW = 927;  // Withdraw amount is too low (must be > BASIC_STORAGE_TAX)
const ERR_WITHDRAW_AMOUNT_TOO_HIGH = 928;  // Withdraw amount exceeds available balance
const ERR_EXCESS_THRESHOLD_TOO_LOW = 929;  // Excess threshold is below minimum allowed value
// External message errors
const ERR_INVALID_SIGNATURE = 930;  // Invalid signature for external message
const ERR_BAD_SEQNO = 931;  // Sequence number mismatch for external message
const ERR_EXPIRED = 932;  // External message has expired (validUntil check failed)

const SEND_MODE_CARRY_ALL_REMAINING_BALANCE: uint8 = 128;
// Storage

struct SubcontractStorage {
    ownerAddress: address
    id: uint256
    redirectExcess: bool
    excessThreshold: coins
    ownerPublicKey: uint256  // Ed25519 public key (256 bits) for external message signature verification
    extSeqno: uint32  // External message sequence number for replay protection
}

fun SubcontractStorage.load() {
    return SubcontractStorage.fromCell(contract.getData())
}

fun SubcontractStorage.save(self) {
    contract.setData(self.toCell())
}

// Messages
struct (0xa2c65e14) ManualDeploy {
    queryId: uint64
}

// Forward message without stateInit (no deploy)
struct (0xf1c65e14) Forward {
    queryId: uint64
    destination: address
    forwardTonAmount: coins
    bounce: bool  // true = Bounce, false = NoBounce
    sendMode: uint8
    messageBody: cell
}

// Forward message with stateInit (for deploy)
struct (0x621c7833) ForwardWithInit {
    queryId: uint64
    destination: address
    forwardTonAmount: coins
    sendMode: uint8
    stateInit: cell  // StateInit cell for contract deployment
    messageBody: cell
}

// Withdraw message - owner can withdraw specified amount (leaving BASIC_STORAGE_TAX for gas safety)
struct (0x164546a9) Withdraw {
    queryId: uint64
    amount: coins
    receiver: address
}

// Set redirect excess flag message
struct (0x50245bad) SetRedirectExcess {
    queryId: uint64
    redirectExcess: bool
}

// Set excess threshold message
struct (0xc64d98a7) SetExcessThreshold {
    queryId: uint64
    excessThreshold: coins
}

// Excess message (from jetton transfers or other operations)
struct (0xd53276db) ReturnExcessesBack {
    queryId: uint64
}

// Jetton transfer notification (from jetton wallet)
// ForwardPayloadRemainder is RemainingBitsAndRefs
type ForwardPayloadRemainder = RemainingBitsAndRefs

struct (0x7362d09c) TransferNotificationForRecipient {
    queryId: uint64
    jettonAmount: coins
    transferInitiator: address?
    forwardPayload: ForwardPayloadRemainder
}

// External message types (for owner-signed external messages)
// Allowed external commands (only Forward and ForwardWithInit for now)
type AllowedExternalCommand = 
    | Forward
    | ForwardWithInit

// ExternalInner: signed data structure (what gets signed)
struct ExternalInner {
    seqno: uint32
    validUntil: uint32  // Unix timestamp (blockchain.now)
    command: AllowedExternalCommand
}

// ExternalEnvelope: external message body format (Approach 2: signed data as referenced cell)
struct ExternalEnvelope {
    signature: bits512  // Ed25519 signature (512 bits)
    inner: cell  // Referenced cell containing ExternalInner (signed data)
}

fun reserveValue(msgValue: coins, delta: coins = 0) {
    val base = (contract.getOriginalBalance() - msgValue) + BASIC_STORAGE_TAX;
    val reserveAmount = base + delta;
    // Ensure reserve is at least BASIC_STORAGE_TAX (can't reserve negative or too low)
    var finalReserve: coins;
    if (reserveAmount < BASIC_STORAGE_TAX) {
        finalReserve = BASIC_STORAGE_TAX;
    } else {
        finalReserve = reserveAmount;
    }
    reserveToncoinsOnBalance(finalReserve, RESERVE_MODE_EXACT_AMOUNT);
}

fun calcDeployedSubcontract(
    ownerAddress: address,
    id: uint256,
    ownerPublicKey: uint256,
    subcontractCode: cell,
): AutoDeployAddress {
    val initStorage: SubcontractStorage = {
        ownerAddress,
        id,
        redirectExcess: DEFAULT_REDIRECT_EXCESS,
        excessThreshold: DEFAULT_EXCESS_THRESHOLD,
        ownerPublicKey,
        extSeqno: 0,  // Start at 0 for external message sequence
    };
    return {
        stateInit: {
            code: subcontractCode,
            data: initStorage.toCell()
        }
    }
}

fun calcAddressOfSubcontract(
    ownerAddress: address,
    id: uint256,
    ownerPublicKey: uint256,
    subcontractCode: cell,
): address {
    val subcontractDeployed = calcDeployedSubcontract(ownerAddress, id, ownerPublicKey, subcontractCode);
    return subcontractDeployed.calculateAddress()
}

