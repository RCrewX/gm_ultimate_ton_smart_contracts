// SPDX-License-Identifier: UNLICENSED
// =============================================================================
// static.tolk — SoullessSlotMachine (SSM) storage, constants, errors, the pure
// reward-mapping function, and SSM's message surface.
//
// SSM is a registered GAME from R*'s point of view: its native rewards go out as
// R1{ForwardMintRequest|MintNft} -> GM -> R2 -> R* -> R3 -> GM -> R4 -> minter/printer.
// SSM never parses R*-private payloads; it only emits the R1 envelope.
// =============================================================================

import "ssm_common"

// -----------------------------------------------------------------------------
// Allowed stake amounts.
//
// RUDA is 0-decimal / 1:1: one whole RUDA == one raw jetton unit (a balance of
// "10 RUDA" is the integer 10). This matches native melt (retranslator.tolk:
// pow10(K)-1 raw) and Upgrade Hull, which already operate on raw volumes. So the
// stakes are the raw integers 10 / 100 / 1000. The custom amount is an EXACT raw
// value (1_000_000) per the brief.
// -----------------------------------------------------------------------------
const ONE_RUDA: coins = 1 as coins;                 // 1 whole RUDA == 1 raw unit (RUDA is 0-decimal)
const RUDA_AMOUNT_10: coins = 10 as coins;
const RUDA_AMOUNT_100: coins = 100 as coins;
const RUDA_AMOUNT_1000: coins = 1000 as coins;
const CUSTOM_ALLOWED_AMOUNT: coins = 1000000 as coins; // exact raw, per brief

// Minimum TON that must arrive WITH a roll intake (covers 3 ephemeral
// deploys/hops + the native-stake burn R1 + the reward send + cashback). The
// depositor attaches this as the jetton-transfer forward TON; it survives the
// GM/R*/slot hops via carry-all. FLAGGED (uap consumer): raised from 0.7 -> 1.0
// to fund the extra burn-and-mint hop on the native path.
const MIN_ROLL_VALUE: coins = ton("1.0");

// Reward-send budgets (exact value attached; cashback gets the carry-all rest).
const NFT_REWARD_BUDGET: coins = ton("0.3");   // R1{MintNft} -> printer item deploy chain
const RUDA_MINT_BUDGET: coins = ton("0.25");   // R1{ForwardMintRequest} -> mint chain
const ESCROW_RETURN_BUDGET: coins = ton("0.06"); // AskToTransfer to SSM's custom wallet
// Native-stake burn budget: R1{SsmBurnStake} -> GM -> R* -> GM -> GM's RUDA wallet
// -> minter. Sized to fund that full hop chain even when SSM is not R*'s active-game
// fast-path (R* authorizes registered games via an O(1) named-slot check, no gas precondition).
const NATIVE_BURN_BUDGET: coins = ton("0.25");

// Outcome kinds returned by computeOutcome / the reward getter.
const OUT_NOTHING: int = 0;
const OUT_NFT: int = 1;          // mint an NFT (nftType, nftTier)
const OUT_MINT_RUDA: int = 2;    // native token win: mint mintRudaAmount RUDA
const OUT_RETURN_ESCROW: int = 3; // custom token win: return escrow (+ maybe 1 RUDA)

// Errors — SSM's own range (940..959; continues the legacy 940/942).
const ERR_INVALID_OWNER_SENDER = 940;     // JettonUsed not from GM / config not from owner
const ERR_MESSAGE_VALUE_TOO_LOW = 942;    // config message underfunded
const ERR_INVALID_RUDA_AMOUNT = 943;      // native stake not in {10,100,1000}
const ERR_INVALID_CUSTOM_AMOUNT = 944;    // custom stake != CUSTOM_ALLOWED_AMOUNT
const ERR_INSUFFICIENT_ROLL_VALUE = 945;  // not enough TON attached to roll
const ERR_INVALID_SLOT_RESULT_SENDER = 946; // RollResult not from the last slot
const ERR_BAD_FORWARD_PAYLOAD = 947;      // custom forwardPayload malformed

const GAS_COST_SET_CONFIG: coins = ton("0.01");

// =============================================================================
//  Storage
// =============================================================================
struct SSMStorage {
    ownerAddress: address       // GameManager (sole on-chain authority / native reward pipe)
    ssmSlotCode: cell           // SSMSlot code — to deploy slot0 and to verify the last slot
    rudaMasterAddress: address  // RUDA jetton minter; the "native" NFT origin
}

fun SSMStorage.load() {
    return SSMStorage.fromCell(contract.getData())
}

fun SSMStorage.save(self) {
    contract.setData(self.toCell())
}

// =============================================================================
//  Reward mapping — PURE function of (symbols, isNative, stake).
//  Exposed verbatim via a get-method (see soulless_slot_machine.tolk) so every
//  table row is unit-testable without RNG.
// =============================================================================
struct RewardOutcome {
    kind: int
    nftType: uint64
    nftTier: uint64
    mintRudaAmount: coins   // > 0  -> emit ForwardMintRequest for this many RUDA
    returnEscrow: bool      // true -> AskToTransfer the custom escrow back to player
}

fun computeOutcome(symbols: int, isNative: bool, stake: coins): RewardOutcome {
    var nX: int = 0;
    var n7: int = 0;
    var i: int = 0;
    while (i < SSM_REELS) {
        val s = symbolAt(symbols, i);
        if (s == SYM_X) {
            nX += 1;
        } else if (s == SYM_SEVEN) {
            n7 += 1;
        }
        i += 1;
    }

    // Any X -> an NFT; tier = number of X, type bumps to 1 if a 7 is present.
    // Identical for native and custom origins (only the origin address differs).
    if (nX >= 1) {
        var t: uint64 = 0;
        if (n7 >= 1) {
            t = 1;
        }
        return {
            kind: OUT_NFT,
            nftType: t,
            nftTier: nX as uint64,
            mintRudaAmount: 0,
            returnEscrow: false,
        };
    }

    // No X: outcome is driven purely by the count of 7s, and diverges by path.
    if (isNative) {
        if (n7 == 0) {
            return { kind: OUT_NOTHING, nftType: 0, nftTier: 0, mintRudaAmount: 0, returnEscrow: false };
        }
        if (n7 == 1) {
            // 070: tokens back (burn-and-mint -> mint the stake fresh)
            return { kind: OUT_MINT_RUDA, nftType: 0, nftTier: 0, mintRudaAmount: stake, returnEscrow: false };
        }
        if (n7 == 2) {
            // 077: tokens back + 1 RUDA
            return { kind: OUT_MINT_RUDA, nftType: 0, nftTier: 0, mintRudaAmount: stake + ONE_RUDA, returnEscrow: false };
        }
        // 777: 10x the win in tokens
        return { kind: OUT_MINT_RUDA, nftType: 0, nftTier: 0, mintRudaAmount: stake * 10, returnEscrow: false };
    } else {
        if (n7 == 0) {
            return { kind: OUT_NOTHING, nftType: 0, nftTier: 0, mintRudaAmount: 0, returnEscrow: false };
        }
        if (n7 == 1) {
            // 070: return the escrowed custom jetton (house can't mint it)
            return { kind: OUT_RETURN_ESCROW, nftType: 0, nftTier: 0, mintRudaAmount: 0, returnEscrow: true };
        }
        if (n7 == 2) {
            // 077: return escrow + 1 RUDA (the +1 is freshly minted RUDA)
            return { kind: OUT_RETURN_ESCROW, nftType: 0, nftTier: 0, mintRudaAmount: ONE_RUDA, returnEscrow: true };
        }
        // 777 (custom): the ONLY way to mint a non-native type-5 item
        return { kind: OUT_NFT, nftType: 5, nftTier: 0, mintRudaAmount: 0, returnEscrow: false };
    }
}

// Native stake must be exactly one of the allowed amounts.
fun isAllowedRudaAmount(amount: coins): bool {
    return amount == RUDA_AMOUNT_10 || amount == RUDA_AMOUNT_100 || amount == RUDA_AMOUNT_1000;
}

// =============================================================================
//  NFT content — MUST stay byte-identical to the NFTPrinter's NFTContent
//  (contracts/printers/nft_printer/storage.tolk): {origin, itemType, tier, seen}.
//  SSM builds it and ships it as the opaque `content` cell inside MintNft.
//  `seen` is the multisplav (type-5) provenance Bloom filter — ALWAYS null for an
//  SSM-minted item. It MUST be present (as a null Maybe-ref) so the layout matches
//  the printer item, which parses content as the 4-field NFTContent on every ANVIL
//  op / get_nft_content_fields; a 3-field cell would throw when the item loads it.
// =============================================================================
struct NFTContent {
    origin: address
    itemType: uint64
    tier: uint64
    seen: cell?
}

// =============================================================================
//  Inbound message bodies
// =============================================================================

// Native intake: GM delivers this (R* routed the RUDA transfer-notification to
// SSM as the game). `data` is the dataCell the depositor embedded in the
// forwardPayload — we parse it as RollIntakeData.
struct (0xd7610922) JettonUsed {
    jettonAmount: coins
    data: cell
}

// Embedded by the depositor inside the native forwardPayload's data ref.
struct RollIntakeData {
    player: address
    queryId: uint64
}

// Custom intake: a standard TEP-74 transfer-notification arrives DIRECTLY at SSM
// from SSM's own custom-jetton wallet (the escrow). forwardPayload carries the
// claimed master (trusted as origin per locked decision 4) + player + queryId.
type ForwardPayloadRemainder = RemainingBitsAndRefs

struct (0x7362d09c) TransferNotificationForRecipient {
    queryId: uint64
    jettonAmount: coins
    transferInitiator: address?
    forwardPayload: ForwardPayloadRemainder
}

// The single ref inside the custom forwardPayload.
struct CustomRollPayload {
    master: address          // claimed jetton master == NFT origin for this roll
    player: address
    queryId: uint64
}

// Owner (GM) may re-point the slot code / RUDA master (e.g. after a slot redeploy).
struct (0x5535e701) SetSsmConfig {
    ssmSlotCode: cell
    rudaMasterAddress: address
}

// =============================================================================
//  Outbound message bodies
// =============================================================================

// R1 envelope to the dumb-pipe GM (opcode must match game_manager/static.tolk).
struct (0x52310001) R1 {
    data: cell
}

// Wrapped inside R1.data — native reward MINT (SSM is a registered game).
struct (0xf62ed009) ForwardMintRequest {
    receiver: address
    amount: coins
}

// Wrapped inside R1.data — burn the native RUDA stake (burn-and-mint). R* gates
// this like a mint (registered game) and emits AskToBurn to GM's RUDA wallet.
// Opcode/layout MUST match retranslator.tolk SsmBurnStake.
struct (0x5362726e) SsmBurnStake {   // "Sbrn"
    queryId: uint64
    amount: coins
}

// Wrapped inside R1.data — NFT mint via the printer (R* routes to the NFTPrinter).
struct (0x4d6e6674) MintNft {
    receiver: address
    content: cell            // Cell<NFTContent>; opaque to GM/R*
}

// To SSM's own custom-jetton wallet: return the escrowed custom jetton to player.
struct (0x0f8a7ea5) AskToTransfer {
    queryId: uint64
    jettonAmount: coins
    transferRecipient: address
    sendExcessesTo: address?
    customPayload: cell?
    forwardTonAmount: coins
    forwardPayload: ForwardPayloadRemainder
}

// Cashback / generic excess return.
struct (0xd53276db) ReturnExcessesBack {
    queryId: uint64
}

struct (0x0a1b2c3d) LiteralyAnything {
    queryId: uint64
}

// =============================================================================
//  Deploy-address helper (for wrappers/tests/scripts via the get-method)
// =============================================================================
fun calcDeployedSSM(
    ownerAddress: address,
    ssmSlotCode: cell,
    rudaMasterAddress: address,
    ssmCode: cell,
): AutoDeployAddress {
    val initStorage: SSMStorage = {
        ownerAddress,
        ssmSlotCode,
        rudaMasterAddress,
    };
    return {
        stateInit: {
            code: ssmCode,
            data: initStorage.toCell()
        }
    };
}
