// SPDX-License-Identifier: UNLICENSED
/**
 * Game Constants Aggregator
 *
 * Single source of truth for the *non-secret* constants other projects
 * (ton_site, new_tg_bot, ton_provider_system, …) need to stay in sync with
 * the GM Ultimate (`gm_ultimate_ton_smart_contracts`) contracts: opcodes,
 * error codes, gas costs, TON amounts, enums and the on-chain storage layout.
 *
 * Provenance:
 *  - Opcodes / gas costs / TON amounts / enums / storage layout are imported
 *    from the TypeScript wrappers (`wrappers/**`), which are the canonical
 *    TS values used to build/parse messages.
 *  - Error codes are parsed *live* from the Tolk sources (`contracts/**`), so
 *    they can never drift from the deployed contracts.
 *
 * Everything here is JSON-serialisable:
 *  - opcodes are emitted as zero-padded 8-hex strings (e.g. "0x5a1b2c3d").
 *    `Number("0x5a1b2c3d")` recovers the numeric value in JS/TS.
 *  - TON / jetton amounts are emitted as decimal nanoTON / nano-unit *strings*
 *    (bigint can't be represented in JSON).
 *  - plain counts (HP, percentages, bit widths) are emitted as numbers.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import {
    Opcodes as GameManagerOpcodes,
    GAS_COST_REDIRECT_MESSAGE,
    GAS_COST_SET_RETRANSLATOR,
} from '../wrappers/game_manager/types';

import {
    ROpcodes as RetranslatorOpcodes,
    GAS_COST_SET_GAMES_INFO,
    GAS_COST_SET_JETTON_INFO,
    GAS_COST_SET_TOOLS_INFO,
    GAS_COST_SET_ALLOW_BURN,
    GAS_COST_REQUEST_BURN,
    ANVIL_OPCODES,
    AnvilRecipe,
    AnvilOutcomeKind,
    ANVIL_ITEM_OP_TON,
    ANVIL_DESTROY_TON,
    MELT_HUNDRED_RUDA,
    MULTISPLAV_MINT_STAKE,
    ANVIL_MULTISPLAV_MINT_TAG,
    TIER_CAP_TYPE0,
    SAFETY_TIER_CAP,
    MELT_MAX_TIER,
    TYPE_GENERIC,
    TYPE_MULTISPLAV,
    MULTISPLAV_FILTER_BITS,
    MULTISPLAV_FILTER_K,
    MULTISPLAV_TIER_CAP,
} from '../wrappers/game_manager/RetranslatorTypes';

import {
    Opcodes as SsmOpcodes,
    MIN_ROLL_VALUE,
    NFT_REWARD_BUDGET,
    RUDA_MINT_BUDGET,
    ESCROW_RETURN_BUDGET,
    NATIVE_BURN_BUDGET,
    RUDA_AMOUNT_10,
    RUDA_AMOUNT_100,
    RUDA_AMOUNT_1000,
    CUSTOM_ALLOWED_AMOUNT,
    ONE_RUDA,
    SSM_REELS,
    SYM_ZERO,
    SYM_SEVEN,
    SYM_X,
    OUT_NOTHING,
    OUT_NFT,
    OUT_MINT_RUDA,
    OUT_RETURN_ESCROW,
} from '../wrappers/soulless_slot_machine/types';

import {
    Opcodes as SubcontractOpcodes,
    GAS_COST_FORWARD,
    GAS_COST_FORWARD_WITH_INIT,
    GAS_COST_MANUAL_DEPLOY,
} from '../wrappers/subcontract/types';

import {
    Opcodes as TrgOpcodes,
    JettonUsageMode,
    BASIC_STORAGE_TAX,
    BASIC_SHIP_HP,
    MINT_TON_AMOUNT,
    GAS_COST_REQUEST_SHIP_ADDRESS,
    GAS_COST_REQUEST_COORDINATE_CELL_ADDRESS,
    GAS_COST_REQUEST_TO_MOVE,
    GAS_COST_MOVE_SHIP_TO_CC,
    GAS_COST_MOVE,
    GAS_COST_MOVE_END,
    GAS_COST_REQUEST_MINT as TRG_GAS_COST_REQUEST_MINT,
    GAS_COST_REQUEST_SHIP_TO_MINT,
    GAS_COST_FORWARD_MINT_REQUEST,
    GAS_COST_JETTON_USED,
    GAS_COST_SHIP_UPGRADE,
    GAS_COST_RESET_SHIP,
    GAS_COST_TRANSFER_NOTIFICATION,
    HARD_TRAVEL_MIN_VALUE,
} from '../wrappers/ton_race_game/types';

import {
    X_TYPE_BITS,
    Y_TYPE_BITS,
    HP_TYPE_BITS,
    UniqueResult,
    MoveMode,
    SHIP_SESSION_PUBKEY_BITS,
    SHIP_SESSION_SEQNO_BITS,
    SHIP_SESSION_VALID_UNTIL_BITS,
    SHIP_SESSION_MOVES_LEFT_BITS,
    SHIP_SESSION_MOVE_MODE_BITS,
    SHIP_SESSION_SIGNATURE_BITS,
} from '../wrappers/ton_race_game/structs';

import { Op as NftOp } from '../wrappers/tep/nft/types';
import { Op as SbtOp } from '../wrappers/tep/sbt/types';
import { Op as JettonOp, Errors as JettonErrors } from '../wrappers/tep/jetton/JettonConstants';
import { NFTPrinterOp } from '../wrappers/printers/nft_printer/NFTPrinter';
import { SBTPrinterOp } from '../wrappers/printers/sbt_printer/SBTPrinter';

/**
 * Bump when the *shape* of the `constants` section changes (not when a value
 * changes) so consumers can guard against incompatible layouts.
 */
// v2: SSM rebuilt as a slot machine (new opcodes/amounts/enums) + the ANVIL
// recipe engine (new `anvil` opcode namespace, `retranslator` errors, ANVIL gas/
// amounts, SSM symbol/reward + ANVIL recipe enums, `ssmSlot` contract code).
// v3: gap-closing plans — multisplav provenance (`NFTContent` now ends with a
// Maybe(^Cell) `seen` Bloom filter; new errors 983/984; filter params), SSM native
// stake BURN (new `SsmBurnStake` opcode, NATIVE_BURN_BUDGET, MIN_ROLL_VALUE 0.7->1.0),
// and ANVIL tier caps + type space (SAFETY_TIER_CAP/err 985, TYPE_GENERIC/MULTISPLAV,
// new `anvilTypeSpace`/`anvilTierCaps` + `nftContentSeen` storage-layout keys).
// v4: ShipSession W5 wallet-extension published — new `opcodes.shipSession`
// (extn/send-msg/RequestToMove/revoke), `errors.shipSession` (950..959),
// `gasCosts.shipSession`, and `shipSession*` storageLayout wire-format keys, plus a
// `shipSession` code-hash in contractCodes. Code-only (per-user contract, no address).
// v5: W5 ShipSession RETIRED — the session is now NATIVE to the Ship contract.
// REMOVED: `opcodes.shipSession`, `errors.shipSession`, `gasCosts.shipSession`, and the
// `shipSession` code-hash in contractCodes. ADDED: the ship-native session — the
// `OP_SET_SESSION_KEY` opcode under `opcodes.tonRaceGame`, session errors 950..960 under
// `errors.tonRaceGame`/`errors.common` (live-parsed), and the new `SHIP_SESSION_*` wire
// widths (pubkey/seqno/validUntil/movesLeft/moveMode/signature) under storageLayout. The
// signed external is `ShipExternalEnvelope{ signature:bits512, ^SessionMoveInner }` where
// SessionMoveInner = seqno:u32 validUntil:u32 moveMode:u8, sent directly to the SHIP.
export const CONSTANTS_SCHEMA_VERSION = 5;

// ============================================================================
// Serialisation helpers
// ============================================================================

/** 32-bit opcode -> "0xXXXXXXXX" (8 hex digits, unsigned). */
function hex(op: number): string {
    return '0x' + (op >>> 0).toString(16).padStart(8, '0');
}

/** bigint -> decimal string (nanoTON / nano-units). */
function nano(v: bigint): string {
    return v.toString();
}

/** Map a record of opcode numbers to hex strings. */
function hexMap(src: Record<string, number>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(src)) {
        out[k] = hex(v);
    }
    return out;
}

/** Read every numeric static member of a class-with-static-numbers (jetton Op/Errors). */
function staticNumberMap(cls: Record<string, unknown>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(cls)) {
        if (typeof v === 'number') out[k] = v;
    }
    return out;
}

// ============================================================================
// Error codes — parsed live from Tolk sources
// ============================================================================

/** Repo root (this file lives in `lib/`). */
const REPO_ROOT = join(__dirname, '..');

/** Match `const ERR_FOO = 123` / `const ERROR_BAR = 0xFFFF` (ignores `ton(...)` consts). */
const ERROR_CONST_RE = /^\s*const\s+(ERR(?:OR)?_[A-Z0-9_]+)\s*=\s*(0x[0-9a-fA-F]+|\d+)/gm;

function parseErrorCodes(relPath: string): Record<string, number> {
    const out: Record<string, number> = {};
    let raw: string;
    try {
        raw = readFileSync(join(REPO_ROOT, relPath), 'utf-8');
    } catch (e) {
        throw new Error(`Cannot read Tolk error source ${relPath}: ${(e as Error).message}`);
    }
    let m: RegExpExecArray | null;
    ERROR_CONST_RE.lastIndex = 0;
    while ((m = ERROR_CONST_RE.exec(raw)) !== null) {
        out[m[1]] = m[2].startsWith('0x') ? parseInt(m[2], 16) : parseInt(m[2], 10);
    }
    return out;
}

// ============================================================================
// Constants assembly
// ============================================================================

export interface GameConstants {
    schemaVersion: number;
    _note: string;
    token: unknown;
    opcodes: Record<string, Record<string, string>>;
    errors: Record<string, Record<string, number>>;
    gasCosts: Record<string, Record<string, string>>;
    amounts: Record<string, string>;
    gameConstants: Record<string, number | string>;
    enums: Record<string, Record<string, number>>;
    storageLayout: Record<string, number>;
    sendModes: Record<string, number>;
}

function readTokenMetadata(): unknown {
    try {
        return JSON.parse(readFileSync(join(REPO_ROOT, 'metadata.json'), 'utf-8'));
    } catch {
        return null;
    }
}

/**
 * Build the full, JSON-serialisable constants object.
 */
export function buildGameConstants(): GameConstants {
    return {
        schemaVersion: CONSTANTS_SCHEMA_VERSION,
        _note:
            'Single source of truth for the GM Ultimate (gm_ultimate_ton_smart_contracts) ' +
            'contract opcodes/errors/constants. ' +
            'opcodes are "0x"-hex strings (use Number(v) for the integer); ' +
            'gasCosts and amounts are decimal nanoTON/nano-unit strings; ' +
            'errors are parsed live from contracts/**/*.tolk.',

        token: readTokenMetadata(),

        opcodes: {
            gameManager: hexMap(GameManagerOpcodes),
            retranslator: hexMap(RetranslatorOpcodes),
            soullessSlotMachine: hexMap(SsmOpcodes),
            // ⚒ ANVIL recipe engine — R*-private request/result + printer item-flow
            // ops. The recipe-request opcodes (Combine/Transform/Melt) + the apply
            // body live on R*; the item-flow ops live on the NFT printer item/coll.
            anvil: hexMap(ANVIL_OPCODES),
            subcontract: hexMap(SubcontractOpcodes),
            tonRaceGame: hexMap(TrgOpcodes),
            jetton: hexMap(staticNumberMap(JettonOp as unknown as Record<string, unknown>)),
            nft: hexMap(NftOp),
            sbt: hexMap(SbtOp),
            // GM-owned printer collections (DeployNft/DeploySbtn/RevokeSbtnItem/admin).
            // The R1 recipe opcodes (MintNft/MintSbt/RevokeSbt) live under `retranslator`.
            nftPrinter: hexMap(NFTPrinterOp),
            sbtPrinter: hexMap(SBTPrinterOp),
            // NOTE: the native ship session opcode `OP_SET_SESSION_KEY` is published under
            // `tonRaceGame` above (it is a ship message). The signed external move carries
            // no opcode (raw signature ++ ^SessionMoveInner) — see storageLayout for its wire.
        },

        errors: {
            common: parseErrorCodes('contracts/ton_race_game/static/errors.tolk'),
            gameManager: parseErrorCodes('contracts/game_manager/static.tolk'),
            // R* recipe-engine + dispatch errors (incl. ANVIL 970..982) live here.
            retranslator: parseErrorCodes('contracts/game_manager/retranslator.tolk'),
            soullessSlotMachine: parseErrorCodes('contracts/soulless_slot_machine/static.tolk'),
            subcontract: parseErrorCodes('contracts/subcontract/static.tolk'),
            tonRaceGame: parseErrorCodes('contracts/ton_race_game/static/errors.tolk'),
            jetton: { ...staticNumberMap(JettonErrors as unknown as Record<string, unknown>), ...parseErrorCodes('contracts/tep/jetton/errors.tolk') },
            nft: parseErrorCodes('contracts/tep/nft/errors.tolk'),
            sbt: parseErrorCodes('contracts/tep/sbt/errors.tolk'),
            nftPrinter: parseErrorCodes('contracts/printers/nft_printer/errors.tolk'),
            sbtPrinter: parseErrorCodes('contracts/printers/sbt_printer/errors.tolk'),
            // Native ship session errors (950..960) are live-parsed from the ship's own
            // errors.tolk — they land in `common`/`tonRaceGame` above, no separate group.
        },

        gasCosts: {
            gameManager: {
                GAS_COST_REDIRECT_MESSAGE: nano(GAS_COST_REDIRECT_MESSAGE),
                GAS_COST_SET_RETRANSLATOR: nano(GAS_COST_SET_RETRANSLATOR),
            },
            retranslator: {
                GAS_COST_SET_JETTON_INFO: nano(GAS_COST_SET_JETTON_INFO),
                GAS_COST_SET_GAMES_INFO: nano(GAS_COST_SET_GAMES_INFO),
                GAS_COST_SET_TOOLS_INFO: nano(GAS_COST_SET_TOOLS_INFO),
                GAS_COST_SET_ALLOW_BURN: nano(GAS_COST_SET_ALLOW_BURN),
                GAS_COST_REQUEST_BURN: nano(GAS_COST_REQUEST_BURN),
            },
            anvil: {
                // per-hop budgets inside the ANVIL return chain
                ANVIL_ITEM_OP_TON: nano(ANVIL_ITEM_OP_TON),
                ANVIL_DESTROY_TON: nano(ANVIL_DESTROY_TON),
            },
            soullessSlotMachine: {
                MIN_ROLL_VALUE: nano(MIN_ROLL_VALUE),
                NFT_REWARD_BUDGET: nano(NFT_REWARD_BUDGET),
                RUDA_MINT_BUDGET: nano(RUDA_MINT_BUDGET),
                ESCROW_RETURN_BUDGET: nano(ESCROW_RETURN_BUDGET),
                NATIVE_BURN_BUDGET: nano(NATIVE_BURN_BUDGET), // native-stake burn R1 chain
            },
            subcontract: {
                GAS_COST_FORWARD: nano(GAS_COST_FORWARD),
                GAS_COST_FORWARD_WITH_INIT: nano(GAS_COST_FORWARD_WITH_INIT),
                GAS_COST_MANUAL_DEPLOY: nano(GAS_COST_MANUAL_DEPLOY),
            },
            tonRaceGame: {
                GAS_COST_REQUEST_SHIP_ADDRESS: nano(GAS_COST_REQUEST_SHIP_ADDRESS),
                GAS_COST_REQUEST_COORDINATE_CELL_ADDRESS: nano(GAS_COST_REQUEST_COORDINATE_CELL_ADDRESS),
                GAS_COST_REQUEST_TO_MOVE: nano(GAS_COST_REQUEST_TO_MOVE),
                GAS_COST_MOVE_SHIP_TO_CC: nano(GAS_COST_MOVE_SHIP_TO_CC),
                GAS_COST_MOVE: nano(GAS_COST_MOVE),
                GAS_COST_MOVE_END: nano(GAS_COST_MOVE_END),
                GAS_COST_REQUEST_MINT: nano(TRG_GAS_COST_REQUEST_MINT),
                GAS_COST_REQUEST_SHIP_TO_MINT: nano(GAS_COST_REQUEST_SHIP_TO_MINT),
                GAS_COST_FORWARD_MINT_REQUEST: nano(GAS_COST_FORWARD_MINT_REQUEST),
                GAS_COST_JETTON_USED: nano(GAS_COST_JETTON_USED),
                GAS_COST_SHIP_UPGRADE: nano(GAS_COST_SHIP_UPGRADE),
                GAS_COST_RESET_SHIP: nano(GAS_COST_RESET_SHIP),
                GAS_COST_TRANSFER_NOTIFICATION: nano(GAS_COST_TRANSFER_NOTIFICATION),
            },
        },

        // TON-denominated amounts (nanoTON strings).
        amounts: {
            BASIC_STORAGE_TAX: nano(BASIC_STORAGE_TAX),
            MINT_TON_AMOUNT: nano(MINT_TON_AMOUNT),
            SSM_MIN_ROLL_VALUE: nano(MIN_ROLL_VALUE),
            HARD_TRAVEL_MIN_VALUE: nano(HARD_TRAVEL_MIN_VALUE),
        },

        // Plain game-logic counts (not TON amounts).
        gameConstants: {
            BASIC_SHIP_HP: nano(BASIC_SHIP_HP),
            // SSM allowed stakes (raw jetton units): native RUDA + the custom amount.
            SSM_RUDA_AMOUNT_10: nano(RUDA_AMOUNT_10),
            SSM_RUDA_AMOUNT_100: nano(RUDA_AMOUNT_100),
            SSM_RUDA_AMOUNT_1000: nano(RUDA_AMOUNT_1000),
            SSM_NUM_REELS: SSM_REELS, // published key kept stable (value unchanged = 3)
            // ⚒ ANVIL 1000-RUDA mint: forwardPayload tag (uint32) the depositor sets.
            ANVIL_MULTISPLAV_MINT_TAG: ANVIL_MULTISPLAV_MINT_TAG,
            SSM_ONE_RUDA: nano(ONE_RUDA),
            SSM_CUSTOM_ALLOWED_AMOUNT: CUSTOM_ALLOWED_AMOUNT.toString(),
            // ⚒ ANVIL melt/mint amounts (raw jetton units).
            ANVIL_MELT_HUNDRED_RUDA: nano(MELT_HUNDRED_RUDA),
            ANVIL_MULTISPLAV_MINT_STAKE: nano(MULTISPLAV_MINT_STAKE),
            // ⚒ ANVIL tier caps (plain counts) — type 0 caps at 10; all other types at
            // SAFETY_TIER_CAP; type-5 has the tighter MULTISPLAV cap; native melt 10^K guard.
            ANVIL_TIER_CAP_TYPE0: TIER_CAP_TYPE0,
            ANVIL_SAFETY_TIER_CAP: SAFETY_TIER_CAP,
            ANVIL_MULTISPLAV_TIER_CAP: MULTISPLAV_TIER_CAP,
            ANVIL_MELT_MAX_TIER: MELT_MAX_TIER,
            // ⚒ ANVIL type space: only these two values carry special rules.
            ANVIL_TYPE_GENERIC: TYPE_GENERIC,
            ANVIL_TYPE_MULTISPLAV: TYPE_MULTISPLAV,
            // ⚒ multisplav provenance Bloom filter geometry (the `seen` field).
            ANVIL_MULTISPLAV_FILTER_BITS: MULTISPLAV_FILTER_BITS,
            ANVIL_MULTISPLAV_FILTER_K: MULTISPLAV_FILTER_K,
        },

        enums: {
            MoveMode: { LEFT: MoveMode.LEFT, UP: MoveMode.UP, RIGHT: MoveMode.RIGHT, EXIT: MoveMode.EXIT },
            UniqueResult: {
                SAFE_EXIT: UniqueResult.SAFE_EXIT,
                CRASH: UniqueResult.CRASH,
                CONTINUE: UniqueResult.CONTINUE,
            },
            JettonUsageMode: {
                SHIP_UPGRADE: JettonUsageMode.SHIP_UPGRADE,
                FAST_TRAVEL_UPGRADE: JettonUsageMode.FAST_TRAVEL_UPGRADE,
            },
            // ⚒ SSM slot machine: reel symbols + reward outcome kinds.
            SsmSymbol: { ZERO: SYM_ZERO, SEVEN: SYM_SEVEN, X: SYM_X },
            SsmRewardKind: {
                NOTHING: OUT_NOTHING, NFT: OUT_NFT, MINT_RUDA: OUT_MINT_RUDA, RETURN_ESCROW: OUT_RETURN_ESCROW,
            },
            // ⚒ ANVIL recipe codes + outcome kinds.
            AnvilRecipe: {
                COMBINE: AnvilRecipe.COMBINE, MULTISPLAV: AnvilRecipe.MULTISPLAV,
                ZERO_TYPE: AnvilRecipe.ZERO_TYPE, ZERO_TIER: AnvilRecipe.ZERO_TIER, MELT: AnvilRecipe.MELT,
            },
            AnvilOutcomeKind: {
                UPDATE: AnvilOutcomeKind.UPDATE, UPDATE_DESTROY: AnvilOutcomeKind.UPDATE_DESTROY, MELT: AnvilOutcomeKind.MELT,
            },
            // ⚒ ANVIL type space — only these two values carry special rules; every
            // other uint64 is generic (capped at SAFETY_TIER_CAP, no special semantics).
            AnvilTypeSpace: { GENERIC: TYPE_GENERIC, MULTISPLAV: TYPE_MULTISPLAV },
        },

        storageLayout: {
            X_TYPE_BITS,
            Y_TYPE_BITS,
            HP_TYPE_BITS,
            // ⚒ NFTContent now = {origin:address, itemType:uint64, tier:uint64, seen:Maybe(^Cell)}.
            // CONSUMER: the decoder must read the trailing Maybe(^Cell) `seen` (1 bit, +1 ref
            // when present). `seen` is the multisplav (type-5) provenance Bloom filter cell of
            // MULTISPLAV_FILTER_BITS bits (2x uint256); null for every non-type-5 item.
            NFT_CONTENT_SEEN_MAYBE_REF: 1,
            MULTISPLAV_FILTER_BITS,
            // Native ship session wire format (the consumer ports these serializers):
            //   SetSessionKey (internal, to the SHIP) body =
            //     op:uint32(OP_SET_SESSION_KEY) ++ sessionPublicKey:uint256
            //     ++ validUntil:uint32 ++ movesLeft:uint16
            //   SessionMoveInner (signed) = seqno:uint32 ++ validUntil:uint32 ++ moveMode:uint8
            //   ShipExternalEnvelope = signature:bits512 ++ ^SessionMoveInner
            //     (sign over inner.hash(); send the envelope as an EXTERNAL to the ship)
            //   validUntil in the signed inner MUST equal the ship's stored sessionValidUntil.
            SHIP_SESSION_PUBKEY_BITS,
            SHIP_SESSION_SEQNO_BITS,
            SHIP_SESSION_VALID_UNTIL_BITS,
            SHIP_SESSION_MOVES_LEFT_BITS,
            SHIP_SESSION_MOVE_MODE_BITS,
            SHIP_SESSION_SIGNATURE_BITS,
        },

        sendModes: {
            CARRY_ALL_REMAINING_BALANCE: 128,
        },
    };
}
