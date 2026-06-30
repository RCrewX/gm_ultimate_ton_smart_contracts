// SPDX-License-Identifier: UNLICENSED
// =============================================================================
// static.tolk — SHARED WIRE PROTOCOL between GameManager (GM) and Retranslator (R*)
// plus GM's own needs ONLY.
//
// Decoupling invariant (see CLAUDE.md): anything R*-private (registries, output
// bodies, jetton-wallet calc, config msgs that change with R* logic) lives in
// retranslator.tolk, NOT here. GM must never reference those types.
// =============================================================================

// Constants
const BASIC_STORAGE_TAX = ton("0.01");
const MY_LITTLE_TAX = ton("0.011");
const MINT_TON_AMOUNT: coins = ton("0.1");

// Gas costs from gas consumption tests (in TON)
// These are maximum expected costs for each operation (updated from test results)
const GAS_COST_SET_JETTON_MINTER_ADDRESS: coins = ton("0.019"); // 0.0184204 + buffer (deprecated, kept for compatibility)
const GAS_COST_DEPLOY_JETTON: coins = ton("0.025"); // Estimated gas cost (deprecated, minter deployed off-chain now)
const GAS_COST_SET_GAMES: coins = ton("0.015"); // 0.0141556 + buffer (deprecated, kept for compatibility)
const GAS_COST_SET_GAMES_INFO: coins = ton("0.020"); // Estimated gas cost for SetGamesInfo
const GAS_COST_SET_JETTON_INFO: coins = ton("0.020"); // Estimated gas cost for SetJettonInfo
const GAS_COST_SET_TOOLS_INFO: coins = ton("0.020"); // Estimated gas cost for SetToolsInfo
const GAS_COST_REDIRECT_MESSAGE: coins = ton("0.009"); // 0.0081816 + buffer
const GAS_COST_SET_ALLOW_BURN: coins = ton("0.015"); // Estimated gas cost for SetAllowBurn
const GAS_COST_SET_RETRANSLATOR: coins = ton("0.015"); // Estimated gas cost for SetRetranslator
const GAS_COST_REQUEST_BURN: coins = ton("0.015"); // Estimated gas cost for RequestBurn

// Errors
const ERR_UNAUTHORIZED = 901;  // Generic unauthorized (kept for backward compatibility)
const ERR_MESSAGE_VALUE_TOO_LOW = 904;  // Message value is too low (less than estimated gas cost)
const ERR_MISSING_REQUIRED_DATA = 906;  // Required data (like jettonMinterAddress) is null

// GameManager-specific errors
const ERR_INVALID_OWNER_SENDER = 920;  // Sender is not the game manager's owner address
const ERR_INVALID_GAME_SENDER = 921;  // Sender is not a valid game address from games list
const ERR_JETTON_MINTER_NOT_SET = 922;  // Jetton minter address is not set (null)
const ERR_JETTON_WALLET_CODE_NOT_SET = 923;  // Jetton wallet code is not set (null)
const ERR_GAMES_NOT_SET = 924;  // Games list is not set (null)
const ERR_INVALID_JETTON_WALLET_SENDER = 925;  // Sender is not the expected jetton wallet address
const ERR_INVALID_GAME_ADDRESS = 926;  // Game address is null or invalid
const ERR_BURN_NOT_ALLOWED = 927;  // Burn is not allowed (allow_burn is false)
const ERR_JETTON_INFO_ALREADY_SET = 928;  // Jetton info is already set and cannot be changed
const ERR_INVALID_GAMES_INFO = 929;  // Games info validation failed (first game must be active_game)
const ERR_GAME_NOT_FOUND = 930;  // Game not found in all_games list
const ERR_RETRANSLATOR_INACTIVE = 931;  // Retranslator kill-switch is engaged (active == false)
const ERR_INVALID_RETRANSLATOR_SENDER = 932;  // Sender is not the configured retranslator address
const ERR_TOOLS_INFO_NOT_SET = 933;  // ToolsInfo registry is not set (null) on R*
const ERR_NFT_PRINTER_NOT_SET = 934;  // ToolsInfo.nftPrinterAddress is null
const ERR_PASSPORT_PRINTER_NOT_SET = 935;  // ToolsInfo.passportPrinterAddress is null

const SEND_MODE_CARRY_ALL_REMAINING_BALANCE: uint8 = 128;

const MIN_JETTON_USAGE_AMOUNT: coins = 5 as coins;

// =============================================================================
//  GameManager storage
// =============================================================================

struct GameManagerStorage {
    ownerAddress: address // multisig will be perfect

    // The swappable brain. GM forwards inbound requests here and only sends what
    // R* tells it to. GM stores NO minter/games/printer addresses anymore.
    retranslatorAddress: address

    my_little_tax: coins // 0.01 by default

    config: cell?
    // reserved, currently unused — deployed as null (see calcDeployedGameManager)
}

fun GameManagerStorage.load() {
    return GameManagerStorage.fromCell(contract.getData())
}

fun GameManagerStorage.save(self) {
    contract.setData(self.toCell())
}

// =============================================================================
//  Shared wire protocol structs
//  R1: anyone -> GM    R2: GM -> R*    R3: R* -> GM    R4: GM -> recipient (a send)
// =============================================================================

struct (0x52310001) R1 {
    data: cell   // opaque to GM; GM does NOT inspect it
}

struct (0x52320002) R2 {
    initiator: address  // GM attests who sent the R1 (or the jetton wallet that notified)
    data: cell          // opaque to GM
}

struct (0x52330003) R3 {
    recipient: address  // GM forwards data here
    data: cell          // opaque to GM
}

struct (0x53455452) SetRetranslator {
    retranslatorAddress: address
}

// =============================================================================
//  Structs GM still matches directly
// =============================================================================

struct (0x83449946) RedirectMessage {
    queryId: uint64
    destination: address
    messageBody: cell
    forwardTonAmount: coins
}

// Jetton transfer notification (from a jetton wallet to GM). GM only matches its
// opcode to wrap the raw body into an R2; GM NEVER reads its fields.
struct (0x7362d09c) TransferNotificationForRecipient {
    queryId: uint64
    jettonAmount: coins
    transferInitiator: address?
    forwardPayload: ForwardPayloadRemainder
}

// Forward-payload remainder used by TransferNotificationForRecipient (here) and
// by InternalTransferStep (in retranslator.tolk, which imports this).
type ForwardPayloadRemainder = RemainingBitsAndRefs

type AnyMessage = ReturnExcessesBack | LiteralyAnything

struct (0xd53276db) ReturnExcessesBack {
    queryId: uint64
}

struct (0x0a1b2c3d) LiteralyAnything {
    queryId: uint64
}

// =============================================================================
//  Helpers
// =============================================================================

fun empty_cell() : cell {
    return beginCell().endCell();
}

fun reserveValue(msgValue: coins, delta: coins = 0) {
    val base = (contract.getOriginalBalance() - msgValue) + BASIC_STORAGE_TAX;
    reserveToncoinsOnBalance(base + delta, RESERVE_MODE_EXACT_AMOUNT);
}

fun calcDeployedGameManager(
    ownerAddress: address,
    gameManagerCode: cell,
): AutoDeployAddress {
    val initStorage: GameManagerStorage = {
        ownerAddress,
        // Deploy-time placeholder; overwritten by SetRetranslator before use.
        retranslatorAddress: ownerAddress,
        my_little_tax: MY_LITTLE_TAX,
        config: null,
    };
    return {
        stateInit: {
            code: gameManagerCode,
            data: initStorage.toCell()
        }
    }
}

fun calcAddressOfGameManager(
    ownerAddress: address,
    gameManagerCode: cell,
): address {
    val gameManagerDeployed = calcDeployedGameManager(ownerAddress, gameManagerCode);
    return gameManagerDeployed.calculateAddress();
}

// -----------------------------------------------------------------------------
// NOTE: MinterStorage/createMinterStorage and the jetton-minter address calc
// helpers below are currently UNUSED on-chain (the jetton minter is deployed
// off-chain with adminAddress = GM). They are kept here as shared utilities and
// are dead-code-eliminated by the compiler. They are NOT R*-private types.
// -----------------------------------------------------------------------------

// Jetton MinterStorage struct (copied from jetton project)
struct MinterStorage {
    totalSupply: coins
    adminAddress: address
    content: cell
    jettonWalletCode: cell
    displayNumerator: uint256  // TEP-526: numerator for display multiplier (VarUInteger 32 in messages)
    displayDenominator: uint256  // TEP-526: denominator for display multiplier (VarUInteger 32 in messages)
}

// Function to create MinterStorage cell for jetton minter initialization
fun createMinterStorage(adminAddress: address, content: cell, jettonWalletCode: cell): cell {
    val minterStorage: MinterStorage = {
        totalSupply: 0,
        adminAddress: adminAddress,
        content: content,
        jettonWalletCode: jettonWalletCode,
        displayNumerator: 1,  // Default 1:1 multiplier (TEP-526)
        displayDenominator: 1,
    };
    return minterStorage.toCell();
}

// Calculate jetton minter address from code and initData
fun calcDeployedJettonMinter(jettonMinterCode: cell, jettonMinterData: cell): AutoDeployAddress {
    return {
        stateInit: {
            code: jettonMinterCode,
            data: jettonMinterData
        }
    }
}

fun calcAddressOfJettonMinter(jettonMinterCode: cell, jettonMinterData: cell): address {
    val minterDeployed = calcDeployedJettonMinter(jettonMinterCode, jettonMinterData);
    return minterDeployed.calculateAddress()
}
