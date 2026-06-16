// SPDX-License-Identifier: UNLICENSED
// structs.ts
import { Address, Cell, Builder } from '@ton/core';
// Types 
export const Y_TYPE_BITS: number = 64
export const X_TYPE_BITS: number = 64
export const HP_TYPE_BITS: number = 64

// Native ship session-key wire widths — must match contracts/ton_race_game/static/structs.tolk.
export const SHIP_SESSION_PUBKEY_BITS: number = 256
export const SHIP_SESSION_SEQNO_BITS: number = 32
export const SHIP_SESSION_VALID_UNTIL_BITS: number = 32
export const SHIP_SESSION_MOVES_LEFT_BITS: number = 16
export const SHIP_SESSION_MOVE_MODE_BITS: number = 8
export const SHIP_SESSION_SIGNATURE_BITS: number = 512

// =======================
// Типы
// =======================

export enum UniqueResult {
    SAFE_EXIT = 0,
    CRASH = 1,
    CONTINUE = 2,
}

export enum MoveMode {
    LEFT = 0,
    UP = 1,
    RIGHT = 2,
    EXIT = 3,
}

// XY {
//   x: X_TYPE
//   y: Y_TYPE
// }
export type XY = {
    x: bigint;
    y: bigint;
};

// MoveData {
//   ship_hp: HP_TYPE
//   xy: XY
// }
export type MoveData = {
    ship_hp: bigint;
    xy: XY;
};

// HardTravelInfo: mode, gasLimit (> 1 TON), hpLimit (> 0), maxTurns (< 100)
export type HardTravelInfo = {
    mode: MoveMode;
    gasLimit: bigint;
    hpLimit: bigint;
    maxTurns: number; // 0..99
};

// GameFields {
//   xy: XY
//   hp: HP_TYPE
//   jettonAmount: coins
// }
export type GameFields = {
    xy: XY;
    hp: bigint;
    jettonAmount: bigint; // coins
};

// =======================
// store-функции
// =======================

// XY.toSlice:
// beginCell().storeInt(x, X_TYPE_BITS).storeUint(y, Y_TYPE_BITS)
export function storeXY(builder: Builder, src: XY) {
    builder.storeInt(src.x, X_TYPE_BITS);
    builder.storeUint(src.y, Y_TYPE_BITS);
}

// MoveData {
//   ship_hp: HP_TYPE
//   xy: XY
// }
export function storeMoveData(builder: Builder, src: MoveData) {
    builder.storeUint(src.ship_hp, HP_TYPE_BITS);
    storeXY(builder, src.xy);
}

// GameFields {
//   xy: XY
//   hp: HP_TYPE
//   jettonAmount: coins
// }
export function storeGameFields(builder: Builder, src: GameFields) {
    storeXY(builder, src.xy);
    builder.storeUint(src.hp, HP_TYPE_BITS);
    builder.storeCoins(src.jettonAmount);
}

// MoveMode — см. комментарий к типу.
// Если в Tolk, например, `uint8`, то так ок.
export function storeMoveMode(builder: Builder, src: MoveMode) {
    builder.storeUint(src, 8);
}

// UniqueResult — см. комментарий к типу.
// Сейчас считаем, что это просто Cell (отдельная ячейка).
export function storeUniqueResult(builder: Builder, src: UniqueResult) {
    builder.storeUint(src, 8);
}

// HardTravelInfo: mode (8), gasLimit (coins), hpLimit (64), maxTurns (64)
export function storeHardTravelInfo(builder: Builder, src: HardTravelInfo) {
    storeMoveMode(builder, src.mode);
    builder.storeCoins(src.gasLimit);
    builder.storeUint(src.hpLimit, HP_TYPE_BITS);
    builder.storeUint(src.maxTurns, 64);
}
