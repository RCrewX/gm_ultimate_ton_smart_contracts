// SPDX-License-Identifier: UNLICENSED
import { toNano, TupleReader } from "@ton/core";

export const BASIC_STORAGE_TAX = toNano("0.01");

export const BASIC_SHIP_HP: bigint = 100n;
export const MINT_TON_AMOUNT: bigint = toNano("0.2");

// Gas costs from gas consumption tests (in TON)
// These match the constants in contracts/ton_race_game/static/constants.tolk
export const GAS_COST_REQUEST_SHIP_ADDRESS = toNano("0.015"); // From gas consumption test
export const GAS_COST_REQUEST_COORDINATE_CELL_ADDRESS = toNano("0.015"); // From gas consumption test
export const GAS_COST_REQUEST_TO_MOVE = toNano("0.06"); // 0.0589864 + buffer
export const GAS_COST_ANY_MESSAGE = toNano("1");
const var_mutableVar: bigint = 10n;
const val_immutableVal: bigint = 20n;

export const GAS_COST_SEND_MOVE = toNano("1");

// Internal message gas costs (from test results, with buffer)
export const GAS_COST_MOVE_SHIP_TO_CC = toNano("0.12"); // Ship -> CoordinateCell (MoveShipToCC) - estimated from move flow
/** Minimum value for RequestToMove (move execution; mint via RequestShipToMint). */
export const TOTAL_GAS_TO_MOVE = GAS_COST_REQUEST_TO_MOVE + GAS_COST_MOVE_SHIP_TO_CC + BASIC_STORAGE_TAX;
export const GAS_COST_MOVE = toNano("0.12"); // CoordinateCell -> CoordinateCell (Move) - estimated from move flow
export const GAS_COST_MOVE_END = toNano("0.06"); // CoordinateCell -> Ship (MoveEnd) - estimated
export const GAS_COST_REQUEST_MINT = toNano("0.22"); // Ship -> Game (RequestMint) - includes MINT_TON_AMOUNT (0.2) + gas
export const GAS_COST_REQUEST_SHIP_TO_MINT = toNano("0.22"); // Owner -> Ship (RequestShipToMint) - same as GAS_COST_REQUEST_MINT
export const GAS_COST_FORWARD_MINT_REQUEST = toNano("0.06"); // Game -> GameManager (ForwardMintRequest) - estimated
export const GAS_COST_JETTON_USED = toNano("0.06"); // GameManager -> Game (JettonUsed) - estimated
export const GAS_COST_SHIP_UPGRADE = toNano("0.06"); // Game -> Ship (ShipUpgrade) - estimated
export const GAS_COST_RESET_SHIP = toNano("0.05"); // Ship reset
export const GAS_COST_TRANSFER_NOTIFICATION = toNano("0.06"); // JettonWallet -> GameManager (TransferNotificationForRecipient) - estimated
/** WithdrawExcessTON handler gas (owner reclaim of ship surplus). Matches constants.tolk. */
export const GAS_COST_WITHDRAW = toNano("0.02");
/** Floor the ship keeps on a WithdrawExcessTON reclaim (== SESSION_MOVE_FLOAT). Matches constants.tolk. */
export const WITHDRAW_KEEP_AMOUNT = toNano("1");
/** Minimum value for RequestToHardTravel. Right-sized (ship-ton-economics-fix) to the real
 *  single-hop walk gas; the client funds the actual walk above this floor. Matches constants.tolk:
 *  GAS_COST_MOVE_SHIP_TO_CC + GAS_COST_MOVE + GAS_COST_MOVE_END + BASIC_STORAGE_TAX. */
export const HARD_TRAVEL_MIN_VALUE = GAS_COST_MOVE_SHIP_TO_CC + GAS_COST_MOVE + GAS_COST_MOVE_END + BASIC_STORAGE_TAX;

// messages.ts
import { Address, Cell, beginCell } from '@ton/core';
import {
    MoveMode,
    storeMoveMode,
    MoveData,
    storeMoveData,
    UniqueResult,
    storeUniqueResult,
    GameFields,
    storeGameFields,
    XY,
    storeXY,
    HardTravelInfo,
    storeHardTravelInfo,
    HP_TYPE_BITS,
    SHIP_SESSION_PUBKEY_BITS,
    SHIP_SESSION_SEQNO_BITS,
    SHIP_SESSION_VALID_UNTIL_BITS,
    SHIP_SESSION_MOVES_LEFT_BITS,
    SHIP_SESSION_MOVE_MODE_BITS,
} from './structs';

export enum JettonUsageMode {
    SHIP_UPGRADE = 0,
    FAST_TRAVEL_UPGRADE = 1,
}

// -------------------------
// Opcodes (из Tolk-struct’ов)
// -------------------------

export const Opcodes = {
    OP_RETURN_EXCESSES_BACK: 0xd53276db,
    OP_LITERALY_ANYTHING: 0x0a1b2c3d,

    OP_MOVE_SHIP_TO_CC: 0xeafb35a2,
    OP_MOVE: 0x6ecc3df6,
    OP_WITHDRAW_TON: 0xe06f1de3,
    OP_WITHDRAW_JETTON: 0xb3cff37d,
    OP_WITHDRAW_NFT: 0x09e971a8,
    OP_WITHDRAW_EXCESS_TON: 0x57644578, // "WdEx" — owner reclaim of ship surplus TON



    OP_MOVE_END: 0xb2a06139,
    OP_REQUEST_TO_MOVE: 0xf2a70b07,

    OP_REQUEST_MINT: 0xf5cc90ff,
    OP_REQUEST_SHIP_TO_MINT: 0x53035644,
    OP_REQUEST_SHIP_ADDRESS: 0xf0469aee,
    OP_REQUEST_COORDINATE_CELL_ADDRESS: 0x213f6f8a,
    OP_RESPONSE_ADDRESS: 0x33226fce,
    OP_FORWARD_MINT_REQUEST: 0xf62ed009,
    OP_JETTON_USED: 0xd7610922,
    OP_SHIP_UPGRADE: 0x7d37523d,
    OP_TRAVEL_TO_CC: 0x4b13d2f0,
    OP_REQUEST_TO_FAST_TRAVEL: 0x8d2f1ca4,
    OP_FAST_TRAVEL_UPGRADE: 0x5a1f0b21,
    OP_RESET_SHIP: 0x6a3b8fdd,
    OP_LAUNCH_HARD_TRAVEL: 0x7dbcd1dc,
    OP_HARD_TRAVEL: 0x2f168b85,
    OP_REQUEST_TO_HARD_TRAVEL: 0x18dd41ae,
    OP_HARD_TRAVEL_MOVE_END: 0x8e7f9a0b,
    // Native session-key authorisation (one-time internal authorise/rotate/revoke).
    OP_SET_SESSION_KEY: 0x5e55104b,
} as const;

export function loadGameFieldsOpt(stack: TupleReader): GameFields | null {
    // Для nullable многослотной структуры:
    // первые N слотов — поля (могут быть NULL, если всё значение = null),
    // последний слот — typeid (0 => null, иначе => not null)

    // Читаем поля как "optional" числа,
    // потому что в случае null там реально будут NULL.
    const x = stack.readBigNumberOpt();      // xy.x (X_TYPE)
    const y = stack.readBigNumberOpt();      // xy.y (Y_TYPE)
    const hp = stack.readBigNumberOpt();     // hp (HP_TYPE)
    const jettonAmount = stack.readBigNumberOpt(); // jettonAmount (coins/int)
    const typeId = stack.readBigNumber();    // последний слот — typeid

    // null-кейс: typeId == 0
    if (typeId === 0n) {
        return null;
    }

    // Если typeId != 0, все поля должны быть ненулевыми
    if (x === null || y === null || hp === null || jettonAmount === null) {
        throw new Error('Invalid GameFields? layout: typeId != 0, но какие-то поля NULL');
    }

    const xy: XY = { x, y };

    const gameFields: GameFields = {
        xy,
        hp,
        jettonAmount,
    };

    return gameFields;
}



// -------------------------
// Типы сообщений (TS-уровень)
// -------------------------

export type ReturnExcessesBack = {
    queryId: bigint; // uint64
};

export type LiteralyAnything = {
    queryId: bigint; // uint64
};

// To Coordinate Cell

export type MoveShipToCC = {
    user: Address;
    ship_hp: bigint; // uint64 (HP_TYPE)
    mode: MoveMode;
};

export type Move = {
    user: Address;
    mode: MoveMode;
    moveData: MoveData;
};

export type TravelToCC = {
    user: Address;
    ship_hp: bigint;
    xy: XY;
};

export type WithdrawTON = {
    queryId: bigint; // uint64
    recipient: Address;
    amount: bigint; // coins
};

export type WithdrawJetton = {
    queryId: bigint; // uint64
    jettonWalletAddress: Address;
    recipient: Address;
    amount: bigint; // coins
    forwardTonAmount: bigint; // coins
};

export type WithdrawNFT = {
    queryId: bigint; // uint64
    nftAddress: Address;
    recipient: Address;
    forwardTonAmount: bigint; // coins
    responseDestination: Address | null; // optional
    customPayload: Cell | null; // optional
};

// To Ship

export type MoveEnd = {
    result: UniqueResult;
    gameFields: GameFields;
};

/** From CoordinateCell to Ship when HardTravel ends (CRASH or CONTINUE). Carries accumulated jettons for correct 10% on CRASH. */
export type HardTravelMoveEnd = {
    result: UniqueResult;
    gameFields: GameFields;
};

export type RequestToMove = {
    mode: MoveMode;
};

export type RequestToFastTravel = {
    xy: XY;
};

export type LaunchHardTravel = {
    user: Address;
    ship_hp: bigint;
    info: HardTravelInfo;
};

export type HardTravel = {
    user: Address;
    ship_hp: bigint;
    info: HardTravelInfo;
    moveData: MoveData;
    turnIndex: number; // uint8
    accumulatedJettonAmount: bigint;
};

export type RequestToHardTravel = {
    info: HardTravelInfo;
};

// To Game

export type RequestMint = {
    receiver: Address;
    amount: bigint; // coins (нанотоны)
};

export type RequestShipAddress = {
    userAddress: Address;
};

export type RequestCoordinateCellAddress = {
    xy: XY;
};

export type ResponseAddress = {
    requestedAddress: Address;
};

export type JettonUsed = {
    jettonAmount: bigint; // coins
    data: Cell; // cell containing ship address
};

export type ShipUpgrade = {
    hpIncrease: bigint; // uint64 (HP_TYPE)
};

export type FastTravelUpgrade = {
    jettonAmount: bigint;
};

export type ResetShip = {};

export type RequestShipToMint = Record<string, never>; // empty body

export type WithdrawExcessTON = {
    queryId: bigint; // uint64
};

// Удобный union, если захочешь матчить по $$type
export type AnyMessage =
    | ({ $$type: 'ReturnExcessesBack' } & ReturnExcessesBack)
    | ({ $$type: 'LiteralyAnything' } & LiteralyAnything)
    | ({ $$type: 'MoveShipToCC' } & MoveShipToCC)
    | ({ $$type: 'Move' } & Move)
    | ({ $$type: 'TravelToCC' } & TravelToCC)
    | ({ $$type: 'WithdrawTON' } & WithdrawTON)
    | ({ $$type: 'WithdrawJetton' } & WithdrawJetton)
    | ({ $$type: 'WithdrawNFT' } & WithdrawNFT)
    | ({ $$type: 'MoveEnd' } & MoveEnd)
    | ({ $$type: 'HardTravelMoveEnd' } & HardTravelMoveEnd)
    | ({ $$type: 'RequestToMove' } & RequestToMove)
    | ({ $$type: 'RequestToFastTravel' } & RequestToFastTravel)
    | ({ $$type: 'LaunchHardTravel' } & LaunchHardTravel)
    | ({ $$type: 'HardTravel' } & HardTravel)
    | ({ $$type: 'RequestToHardTravel' } & RequestToHardTravel)
    | ({ $$type: 'RequestMint' } & RequestMint)
    | ({ $$type: 'RequestShipToMint' } & RequestShipToMint)
    | ({ $$type: 'RequestShipAddress' } & RequestShipAddress)
    | ({ $$type: 'RequestCoordinateCellAddress' } & RequestCoordinateCellAddress)
    | ({ $$type: 'ResponseAddress' } & ResponseAddress)
    | ({ $$type: 'JettonUsed' } & JettonUsed)
    | ({ $$type: 'ShipUpgrade' } & ShipUpgrade)
    | ({ $$type: 'FastTravelUpgrade' } & FastTravelUpgrade)
    | ({ $$type: 'ResetShip' } & ResetShip);

// -------------------------
// encode-функции для body сообщений
// -------------------------
//
// Каждая функция возвращает Cell, который можно передавать
// в provider.internal(via, { body: encodeX(...) })
// -------------------------

export function encodeReturnExcessesBack(msg: ReturnExcessesBack): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_RETURN_EXCESSES_BACK, 32)
        .storeUint(msg.queryId, 64)
        .endCell();
}

export function encodeLiteralyAnything(msg: LiteralyAnything): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_LITERALY_ANYTHING, 32)
        .storeUint(msg.queryId, 64)
        .endCell();
}

// To Coordinate Cell

export function encodeMoveShipToCC(msg: MoveShipToCC): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_MOVE_SHIP_TO_CC, 32);
    b.storeAddress(msg.user);
    b.storeUint(msg.ship_hp, HP_TYPE_BITS);
    storeMoveMode(b, msg.mode);
    return b.endCell();
}

export function encodeMove(msg: Move): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_MOVE, 32);
    b.storeAddress(msg.user);
    storeMoveMode(b, msg.mode);
    storeMoveData(b, msg.moveData);
    return b.endCell();
}

export function encodeTravelToCC(msg: TravelToCC): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_TRAVEL_TO_CC, 32);
    b.storeAddress(msg.user);
    storeMoveData(b, { ship_hp: msg.ship_hp, xy: msg.xy });
    return b.endCell();
}

export function encodeWithdrawTON(msg: WithdrawTON): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_WITHDRAW_TON, 32);
    b.storeUint(msg.queryId, 64);
    b.storeAddress(msg.recipient);
    b.storeCoins(msg.amount);
    return b.endCell();
}

export function encodeWithdrawJetton(msg: WithdrawJetton): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_WITHDRAW_JETTON, 32);
    b.storeUint(msg.queryId, 64);
    b.storeAddress(msg.jettonWalletAddress);
    b.storeAddress(msg.recipient);
    b.storeCoins(msg.amount);
    b.storeCoins(msg.forwardTonAmount);
    return b.endCell();
}

export function encodeWithdrawNFT(msg: WithdrawNFT): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_WITHDRAW_NFT, 32);
    b.storeUint(msg.queryId, 64);
    b.storeAddress(msg.nftAddress);
    b.storeAddress(msg.recipient);
    b.storeCoins(msg.forwardTonAmount);
    b.storeAddress(msg.responseDestination);
    b.storeMaybeRef(msg.customPayload);
    return b.endCell();
}

// To Ship

export function encodeMoveEnd(msg: MoveEnd): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_MOVE_END, 32);
    storeUniqueResult(b, msg.result);
    storeGameFields(b, msg.gameFields);
    return b.endCell();
}

export function encodeHardTravelMoveEnd(msg: HardTravelMoveEnd): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_HARD_TRAVEL_MOVE_END, 32);
    storeUniqueResult(b, msg.result);
    storeGameFields(b, msg.gameFields);
    return b.endCell();
}

export function encodeRequestToMove(msg: RequestToMove): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_REQUEST_TO_MOVE, 32);
    storeMoveMode(b, msg.mode);
    return b.endCell();
}

export function encodeRequestToFastTravel(msg: RequestToFastTravel): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_REQUEST_TO_FAST_TRAVEL, 32);
    storeXY(b, msg.xy);
    return b.endCell();
}

export function encodeLaunchHardTravel(msg: LaunchHardTravel): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_LAUNCH_HARD_TRAVEL, 32);
    b.storeAddress(msg.user);
    b.storeUint(msg.ship_hp, HP_TYPE_BITS);
    storeHardTravelInfo(b, msg.info);
    return b.endCell();
}

export function encodeHardTravel(msg: HardTravel): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_HARD_TRAVEL, 32);
    b.storeAddress(msg.user);
    b.storeUint(msg.ship_hp, HP_TYPE_BITS);
    storeHardTravelInfo(b, msg.info);
    storeMoveData(b, msg.moveData);
    b.storeUint(msg.turnIndex, 8);
    b.storeCoins(msg.accumulatedJettonAmount);
    return b.endCell();
}

export function encodeRequestToHardTravel(msg: RequestToHardTravel): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_REQUEST_TO_HARD_TRAVEL, 32);
    storeHardTravelInfo(b, msg.info);
    return b.endCell();
}

export function encodeRequestShipToMint(): Cell {
    return beginCell().storeUint(Opcodes.OP_REQUEST_SHIP_TO_MINT, 32).endCell();
}

// To Game

export function encodeRequestMint(msg: RequestMint): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_REQUEST_MINT, 32);
    b.storeAddress(msg.receiver);
    b.storeCoins(msg.amount);
    return b.endCell();
}

export function encodeRequestShipAddress(msg: RequestShipAddress): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_REQUEST_SHIP_ADDRESS, 32);
    b.storeAddress(msg.userAddress);
    return b.endCell();
}

export function encodeRequestCoordinateCellAddress(msg: RequestCoordinateCellAddress): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_REQUEST_COORDINATE_CELL_ADDRESS, 32);
    storeXY(b, msg.xy);
    return b.endCell();
}

export function encodeResponseAddress(msg: ResponseAddress): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_RESPONSE_ADDRESS, 32);
    b.storeAddress(msg.requestedAddress);
    return b.endCell();
}

export function encodeJettonUsed(msg: JettonUsed): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_JETTON_USED, 32);
    b.storeCoins(msg.jettonAmount);
    b.storeRef(msg.data);
    return b.endCell();
}

export function encodeShipUpgrade(msg: ShipUpgrade): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_SHIP_UPGRADE, 32);
    b.storeUint(msg.hpIncrease, HP_TYPE_BITS);
    return b.endCell();
}

export function encodeFastTravelUpgrade(msg: FastTravelUpgrade): Cell {
    const b = beginCell();
    b.storeUint(Opcodes.OP_FAST_TRAVEL_UPGRADE, 32);
    b.storeCoins(msg.jettonAmount);
    return b.endCell();
}

export function encodeResetShip(): Cell {
    return beginCell().storeUint(Opcodes.OP_RESET_SHIP, 32).endCell();
}

export function encodeWithdrawExcessTON(msg: WithdrawExcessTON): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_WITHDRAW_EXCESS_TON, 32)
        .storeUint(msg.queryId, 64)
        .endCell();
}

// -------------------------
// Native session-key authorisation (internal SetSessionKey + external move envelope)
// -------------------------

export type SetSessionKey = {
    sessionPublicKey: bigint; // Ed25519 (256 bits); 0 ⇒ revoke
    validUntil: number; // unix seconds — session time-box
    movesLeft: number; // move budget (uint16)
};

/** Encode the one-time internal SetSessionKey body (must be sent by the ship's userAddress). */
export function encodeSetSessionKey(msg: SetSessionKey): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_SET_SESSION_KEY, 32)
        .storeUint(msg.sessionPublicKey, SHIP_SESSION_PUBKEY_BITS)
        .storeUint(msg.validUntil, SHIP_SESSION_VALID_UNTIL_BITS)
        .storeUint(msg.movesLeft, SHIP_SESSION_MOVES_LEFT_BITS)
        .endCell();
}

/** The session-key-signed payload. Its cell hash is what the session key signs. Layout MUST
 *  match struct SessionMoveInner in static/messages.tolk: seqno:u32 validUntil:u32 moveMode:u8 */
export type SessionMoveInner = {
    seqno: number;
    validUntil: number;
    moveMode: number; // MoveMode uint8: LEFT=0 UP=1 RIGHT=2 EXIT=3
};

export function encodeSessionMoveInner(inner: SessionMoveInner): Cell {
    return beginCell()
        .storeUint(inner.seqno, SHIP_SESSION_SEQNO_BITS)
        .storeUint(inner.validUntil, SHIP_SESSION_VALID_UNTIL_BITS)
        .storeUint(inner.moveMode, SHIP_SESSION_MOVE_MODE_BITS)
        .endCell();
}

/** External envelope: signature(512) ++ ^inner. Matches struct ShipExternalEnvelope. */
export function encodeShipExternalEnvelope(signature: Buffer, inner: Cell): Cell {
    return beginCell()
        .storeBuffer(signature) // 512 bits
        .storeRef(inner)
        .endCell();
}

// -------------------------
// (опционально) универсальный encoder по $$type
// -------------------------

export function encodeAnyMessage(msg: AnyMessage): Cell {
    switch (msg.$$type) {
        case 'ReturnExcessesBack':
            return encodeReturnExcessesBack(msg);
        case 'LiteralyAnything':
            return encodeLiteralyAnything(msg);
        case 'MoveShipToCC':
            return encodeMoveShipToCC(msg);
        case 'Move':
            return encodeMove(msg);
        case 'TravelToCC':
            return encodeTravelToCC(msg);
        case 'WithdrawTON':
            return encodeWithdrawTON(msg);
        case 'WithdrawJetton':
            return encodeWithdrawJetton(msg);
        case 'WithdrawNFT':
            return encodeWithdrawNFT(msg);
        case 'MoveEnd':
            return encodeMoveEnd(msg);
        case 'HardTravelMoveEnd':
            return encodeHardTravelMoveEnd(msg);
        case 'RequestToMove':
            return encodeRequestToMove(msg);
        case 'RequestToFastTravel':
            return encodeRequestToFastTravel(msg);
        case 'LaunchHardTravel':
            return encodeLaunchHardTravel(msg);
        case 'HardTravel':
            return encodeHardTravel(msg);
        case 'RequestToHardTravel':
            return encodeRequestToHardTravel(msg);
        case 'RequestShipToMint':
            return encodeRequestShipToMint();
        case 'RequestMint':
            return encodeRequestMint(msg);
        case 'RequestShipAddress':
            return encodeRequestShipAddress(msg);
        case 'RequestCoordinateCellAddress':
            return encodeRequestCoordinateCellAddress(msg);
        case 'ResponseAddress':
            return encodeResponseAddress(msg);
        case 'JettonUsed':
            return encodeJettonUsed(msg);
        case 'ShipUpgrade':
            return encodeShipUpgrade(msg);
        case 'FastTravelUpgrade':
            return encodeFastTravelUpgrade(msg);
        case 'ResetShip':
            return encodeResetShip();
        default:
            // TS должен не дать сюда добраться, но на всякий случай:
            throw new Error('Unknown message type');
    }
}
