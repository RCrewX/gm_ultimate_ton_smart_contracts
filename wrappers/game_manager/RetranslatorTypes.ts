// SPDX-License-Identifier: UNLICENSED
import { Address, beginCell, Cell, toNano } from '@ton/core';

// =============================================================================
// Retranslator (R*) PRIVATE types — registries, config messages and output
// bodies. Mirrors contracts/game_manager/retranslator.tolk. GM never imports
// these (decoupling invariant); they are reachable here only for tests/tooling.
// =============================================================================

// Gas costs (TON). Match contracts/game_manager/static.tolk.
export const GAS_COST_SET_JETTON_INFO = toNano('0.020');
export const GAS_COST_SET_GAMES_INFO = toNano('0.8'); // enough for several games + cashback
export const GAS_COST_SET_TOOLS_INFO = toNano('0.020');
export const GAS_COST_SET_ALLOW_BURN = toNano('0.015');
export const GAS_COST_REQUEST_BURN = toNano('0.015');

// Opcodes (must match retranslator.tolk / static.tolk).
export const ROpcodes = {
    OP_SET_JETTON_INFO: 0x53455401,
    OP_SET_GAMES_INFO: 0x7b2c3d4e,
    OP_SET_ALLOW_BURN: 0x7a8b9c0d,
    OP_SET_TOOLS_INFO: 0x53455403,
    OP_FORWARD_MINT_REQUEST: 0xf62ed009,
    OP_REQUEST_BURN: 0x8b9c0d1e,
    OP_JETTON_USED: 0xd7610922,
    OP_INTERNAL_TRANSFER_STEP: 0x178d4519,
    OP_MINT_NEW_JETTONS: 0x00000015,
    OP_ASK_TO_BURN: 0x595f07bc,
    // Printer recipe requests (wrapped in R1.data). Must match retranslator.tolk.
    OP_MINT_NFT: 0x4d6e6674,
    OP_MINT_SBT: 0x4d736274,
    OP_REVOKE_SBT: 0x52766b73,
    // ⚒ ANVIL edit recipes (wrapped in R1.data). Owner/GM-only on R*.
    OP_EDIT_NFT: 0x456e6674,
    OP_EDIT_SBT: 0x45736274,
    // Printer output bodies emitted by GM (R4). Must match the printer collections.
    OP_PRINTER_DEPLOY_NFT: 0x00000001,
    OP_PRINTER_DEPLOY_SBTN: 0x00000001,
    OP_PRINTER_REVOKE_SBTN_ITEM: 0x00000004,
    OP_PRINTER_EDIT_NFT_ITEM: 0x00000006,
    OP_PRINTER_EDIT_SBT_ITEM: 0x00000007,
} as const;

// ----- Registry shapes -----
export type JettonInfo = {
    jettonMinterAddress: Address;
    jettonWalletCode: Cell;
};

// Named-slot games registry (mirrors retranslator.tolk GamesInfo). active_game
// MUST equal the ssm or ton_race_game slot; ubps is registration-only. The three
// slots are nullable (addr_none) for forward-safety.
export type GamesInfo = {
    active_game: Address;
    ssm: Address | null;
    ton_race_game: Address | null;
    ubps: Address | null;
};

export type ToolsInfo = {
    feeNumerator: number;
    feeDenominator: number;
    feeCollector: Address | null;
    nftPrinterAddress: Address | null;
    sbtPrinterAddress: Address | null;
    extra: Cell | null;
};

// ----- Config message shapes -----
export type SetJettonInfo = { jettonInfo: Cell }; // Cell<JettonInfo>
export type SetGamesInfo = { gamesInfo: Cell }; // Cell<GamesInfo>
export type SetAllowBurn = { allow_burn: boolean };
export type SetToolsInfo = { toolsInfo: Cell }; // Cell<ToolsInfo>

// ----- Inbound request shapes (wrapped inside R1.data / R2.data) -----
export type ForwardMintRequest = { receiver: Address; amount: bigint };
export type RequestBurn = {
    queryId: bigint;
    jettonAmount: bigint;
    sendExcessesTo: Address | null;
    customPayload: Cell | null;
};

// ----- Output body shape (delivered by GM to a game) -----
export type JettonUsed = { jettonAmount: bigint; data: Cell };

// ----- Printer recipe request shapes (wrapped inside R1.data) -----
export type MintNft = { receiver: Address; content: Cell };
export type MintSbt = { receiver: Address; individualContent: Cell };
export type RevokeSbt = { queryId: bigint; itemAddress: Address };
// ⚒ ANVIL edit recipes: route an opaque content cell to an existing item.
export type EditNft = { itemAddress: Address; content: Cell };
export type EditSbt = { itemAddress: Address; content: Cell };

// ----- Structured item content schemas (built off-chain; opaque to GM/R*) -----
// NFTContent { origin: address, type: uint64, tier: uint64, seen: Maybe(^Cell) } —
// matches contracts/printers/nft_printer/storage.tolk (Tolk field `itemType` == `type`).
// `seen` is the multisplav (type-5) provenance Bloom filter; null/undefined for
// non-type-5 items (a single trailing '0' bit). CONSUMER: the published NFT decoder
// must read this trailing Maybe(^Cell).
export type NFTContent = {
    origin: Address;
    type: bigint | number;
    tier: bigint | number;
    seen?: Cell | null;
};
// SBTContent { tatoo: Cell<SnakeString> } — matches sbt_printer/storage.tolk.
export type SBTContent = { tatoo: Cell };

export function encodeNftContent(c: NFTContent): Cell {
    return beginCell()
        .storeAddress(c.origin)
        .storeUint(c.type, 64)
        .storeUint(c.tier, 64)
        .storeMaybeRef(c.seen ?? null)
        .endCell();
}

export function decodeNftContent(cell: Cell): NFTContent {
    const s = cell.beginParse();
    return {
        origin: s.loadAddress(),
        type: s.loadUintBig(64),
        tier: s.loadUintBig(64),
        seen: s.loadMaybeRef(),
    };
}

/** Build a SnakeString cell (short string stored as the cell's data tail). */
export function snakeString(s: string): Cell {
    return beginCell().storeStringTail(s).endCell();
}

export function encodeSbtContent(c: SBTContent): Cell {
    return beginCell().storeRef(c.tatoo).endCell();
}

export function decodeSbtContent(cell: Cell): SBTContent {
    return { tatoo: cell.beginParse().loadRef() };
}

// ----- Registry encoders -----
export function encodeJettonInfo(info: JettonInfo): Cell {
    return beginCell()
        .storeAddress(info.jettonMinterAddress)
        .storeRef(info.jettonWalletCode)
        .endCell();
}

export function encodeGamesInfo(info: GamesInfo): Cell {
    // storeAddress(null) writes the addr_none tag, matching Tolk `address?`.
    // ubps lives in a child cell (GamesInfoExtra) so the root stays < 1023 bits;
    // four full addresses inline would overflow.
    const extra = beginCell().storeAddress(info.ubps).endCell();
    return beginCell()
        .storeAddress(info.active_game)
        .storeAddress(info.ssm)
        .storeAddress(info.ton_race_game)
        .storeRef(extra)
        .endCell();
}

export function encodeToolsInfo(info: ToolsInfo): Cell {
    return beginCell()
        .storeUint(info.feeNumerator, 16)
        .storeUint(info.feeDenominator, 16)
        .storeAddress(info.feeCollector)
        .storeAddress(info.nftPrinterAddress)
        .storeAddress(info.sbtPrinterAddress)
        .storeMaybeRef(info.extra)
        .endCell();
}

// ----- Config encoders -----
export function encodeSetJettonInfo(msg: SetJettonInfo): Cell {
    return beginCell().storeUint(ROpcodes.OP_SET_JETTON_INFO, 32).storeRef(msg.jettonInfo).endCell();
}

export function encodeSetGamesInfo(msg: SetGamesInfo): Cell {
    return beginCell().storeUint(ROpcodes.OP_SET_GAMES_INFO, 32).storeRef(msg.gamesInfo).endCell();
}

export function encodeSetAllowBurn(msg: SetAllowBurn): Cell {
    return beginCell().storeUint(ROpcodes.OP_SET_ALLOW_BURN, 32).storeBit(msg.allow_burn).endCell();
}

export function encodeSetToolsInfo(msg: SetToolsInfo): Cell {
    return beginCell().storeUint(ROpcodes.OP_SET_TOOLS_INFO, 32).storeRef(msg.toolsInfo).endCell();
}

// ----- Inbound request encoders (to be wrapped in R1 before sending to GM) -----
export function encodeForwardMintRequest(msg: ForwardMintRequest): Cell {
    return beginCell()
        .storeUint(ROpcodes.OP_FORWARD_MINT_REQUEST, 32)
        .storeAddress(msg.receiver)
        .storeCoins(msg.amount)
        .endCell();
}

export function encodeRequestBurn(msg: RequestBurn): Cell {
    return beginCell()
        .storeUint(ROpcodes.OP_REQUEST_BURN, 32)
        .storeUint(msg.queryId, 64)
        .storeCoins(msg.jettonAmount)
        .storeAddress(msg.sendExcessesTo)
        .storeMaybeRef(msg.customPayload)
        .endCell();
}

export function encodeJettonUsed(msg: JettonUsed): Cell {
    return beginCell()
        .storeUint(ROpcodes.OP_JETTON_USED, 32)
        .storeCoins(msg.jettonAmount)
        .storeRef(msg.data)
        .endCell();
}

// ----- Printer recipe request encoders (wrapped in R1 before sending to GM) -----
export function encodeMintNft(msg: MintNft): Cell {
    return beginCell()
        .storeUint(ROpcodes.OP_MINT_NFT, 32)
        .storeAddress(msg.receiver)
        .storeRef(msg.content)
        .endCell();
}

export function encodeMintSbt(msg: MintSbt): Cell {
    return beginCell()
        .storeUint(ROpcodes.OP_MINT_SBT, 32)
        .storeAddress(msg.receiver)
        .storeRef(msg.individualContent)
        .endCell();
}

export function encodeRevokeSbt(msg: RevokeSbt): Cell {
    return beginCell()
        .storeUint(ROpcodes.OP_REVOKE_SBT, 32)
        .storeUint(msg.queryId, 64)
        .storeAddress(msg.itemAddress)
        .endCell();
}

// ⚒ ANVIL edit recipes (wrapped in R1 before sending to GM; owner/GM-only on R*).
export function encodeEditNft(msg: EditNft): Cell {
    return beginCell()
        .storeUint(ROpcodes.OP_EDIT_NFT, 32)
        .storeAddress(msg.itemAddress)
        .storeRef(msg.content)
        .endCell();
}

export function encodeEditSbt(msg: EditSbt): Cell {
    return beginCell()
        .storeUint(ROpcodes.OP_EDIT_SBT, 32)
        .storeAddress(msg.itemAddress)
        .storeRef(msg.content)
        .endCell();
}

// =============================================================================
// ⚒ ANVIL recipe engine — constants + helpers. Mirror retranslator.tolk.
// =============================================================================
export const AnvilRecipe = {
    COMBINE: 1,     // I(X|K|R)+I(X|K|R) -> I(X|K+1|R)
    MULTISPLAV: 2,  // I(5|K|N)+I(5|0|R) -> I(5|K+1|N)
    ZERO_TYPE: 3,   // I(X|K|R) -> I(0|K|R)
    ZERO_TIER: 4,   // I(X|K|R) -> I(X|0|R)
    MELT: 5,        // burn item -> mint RUDA
} as const;

export const AnvilOutcomeKind = {
    UPDATE: 1,         // overwrite item1 content
    UPDATE_DESTROY: 2, // overwrite item1 + destroy item2
    MELT: 3,           // destroy item1 + mint RUDA
} as const;

// Distinct ANVIL exit codes (retranslator.tolk).
export const AnvilErrors = {
    UNKNOWN_RECIPE: 970,
    TYPE_MISMATCH: 971,
    TIER_MISMATCH: 972,
    ORIGIN_MISMATCH: 973,
    TIER_CAP: 974,
    NOT_TYPE5: 975,
    MULTISPLAV_PRIMARY_NOT_NATIVE: 976,
    MULTISPLAV_SACRIFICE_NOT_TIER0: 977,
    SAME_ORIGIN_MULTISPLAV: 978,
    MELT_NON_NATIVE: 979,
    TIER_TOO_HIGH: 980,
    NOT_PRINTER: 981,
    BAD_MULTISPLAV_MINT_AMOUNT: 982,
    MULTISPLAV_TIER_CAP: 983,
    MULTISPLAV_ORIGIN_ALREADY_SEEN: 984,
    SAFETY_TIER_CAP: 985,
    RECIPE_ARITY: 986,
} as const;

// ⚒ Multisplav provenance Bloom filter params (mirror retranslator.tolk).
export const MULTISPLAV_FILTER_BITS = 512;
export const MULTISPLAV_FILTER_K = 3;
export const MULTISPLAV_TIER_CAP = 64;

// ⚒ ANVIL tier caps + type space (mirror retranslator.tolk; verified on-chain via
// get_anvil_caps in the ABI guard spec).
export const TIER_CAP_TYPE0 = 10;      // generic (type 0) combine cap
export const SAFETY_TIER_CAP = 1000;   // high ceiling for all non-generic types
export const MELT_MAX_TIER = 30;       // native melt 10^K guard (10^30 < coins max)
export const TYPE_GENERIC = 0;
export const TYPE_MULTISPLAV = 5;

export const ANVIL_OPCODES = {
    OP_ANVIL_COMBINE: 0x416e7643,
    OP_ANVIL_TRANSFORM: 0x416e7654,
    OP_ANVIL_MELT: 0x416e764d,
    OP_PRINTER_ANVIL_APPLY: 0x416e7641,
    // item-flow ops (printer item/collection); match nft_printer/messages.tolk
    OP_ANVIL_INIT: 0x416e7601,
    OP_ANVIL_HOP: 0x416e7602,
    OP_ANVIL_REPORT_TO_COLLECTION: 0x416e7603,
    OP_SET_NFT_CONTENT_AND_DESTROY: 0x416e7604,
    OP_ANVIL_DESTROY_FROM_SIBLING: 0x416e7605,
    OP_ANVIL_DESTROY: 0x416e7606,
} as const;

// ANVIL gas budgets + amounts (mirror retranslator.tolk). nano strings published.
export const ANVIL_ITEM_OP_TON = toNano('0.05');     // collection -> item op hop
export const ANVIL_DESTROY_TON = toNano('0.05');     // item1 -> item2 destroy hop
export const MELT_HUNDRED_RUDA = 100n;               // non-native I(0|10|R) -> 100 RUDA (raw; 0-decimal)
export const MULTISPLAV_MINT_STAKE = 1000n;          // 1000 RUDA -> I(5|0|N) (raw; 0-decimal)
export const ANVIL_MULTISPLAV_MINT_TAG = 0x4d756c74; // "Mult" forwardPayload tag

export type AnvilGetInput = {
    recipe: number;
    i1Origin: Address;
    i1Type: number | bigint;
    i1Tier: number | bigint;
    i2Origin: Address;
    i2Type: number | bigint;
    i2Tier: number | bigint;
    nativeOrigin: Address;
};

// TupleItem[] for the get_anvil_outcome get-method.
export function anvilGetArgs(a: AnvilGetInput) {
    const addr = (x: Address) => ({ type: 'slice' as const, cell: beginCell().storeAddress(x).endCell() });
    const int = (x: number | bigint) => ({ type: 'int' as const, value: BigInt(x) });
    return [
        int(a.recipe),
        addr(a.i1Origin),
        int(a.i1Type),
        int(a.i1Tier),
        addr(a.i2Origin),
        int(a.i2Type),
        int(a.i2Tier),
        addr(a.nativeOrigin),
    ];
}
