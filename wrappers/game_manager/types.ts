// SPDX-License-Identifier: UNLICENSED
import { Address, beginCell, Cell, toNano } from '@ton/core';

// =============================================================================
// GameManager (GM) WIRE PROTOCOL types — the shared GM<->R* protocol + GM needs.
// R*-private message/registry types live in ./RetranslatorTypes.ts.
// These mirror contracts/game_manager/static.tolk.
// =============================================================================

// Gas costs (TON). Match the constants in contracts/game_manager/static.tolk.
export const GAS_COST_REDIRECT_MESSAGE = toNano('0.009'); // 0.0081816 + buffer
export const GAS_COST_SET_RETRANSLATOR = toNano('0.015');

// Opcodes (must match static.tolk).
export const Opcodes = {
    OP_R1: 0x52310001,
    OP_R2: 0x52320002,
    OP_R3: 0x52330003,
    OP_SET_RETRANSLATOR: 0x53455452,
    OP_REDIRECT_MESSAGE: 0x83449946,
    OP_RETURN_EXCESSES_BACK: 0xd53276db,
    OP_LITERALY_ANYTHING: 0x0a1b2c3d,
    OP_TRANSFER_NOTIFICATION_FOR_RECIPIENT: 0x7362d09c,
} as const;

// ----- Message shapes -----
export type R1 = {
    data: Cell;
};

export type R2 = {
    initiator: Address;
    data: Cell;
};

export type R3 = {
    recipient: Address;
    data: Cell;
};

export type SetRetranslator = {
    retranslatorAddress: Address;
};

export type RedirectMessage = {
    queryId: bigint;
    destination: Address;
    messageBody: Cell;
    forwardTonAmount: bigint;
};

// ----- Encoders -----
export function encodeR1(msg: R1): Cell {
    return beginCell().storeUint(Opcodes.OP_R1, 32).storeRef(msg.data).endCell();
}

export function encodeR2(msg: R2): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_R2, 32)
        .storeAddress(msg.initiator)
        .storeRef(msg.data)
        .endCell();
}

export function encodeR3(msg: R3): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_R3, 32)
        .storeAddress(msg.recipient)
        .storeRef(msg.data)
        .endCell();
}

export function encodeSetRetranslator(msg: SetRetranslator): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_SET_RETRANSLATOR, 32)
        .storeAddress(msg.retranslatorAddress)
        .endCell();
}

export function encodeRedirectMessage(msg: RedirectMessage): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_REDIRECT_MESSAGE, 32)
        .storeUint(msg.queryId, 64)
        .storeAddress(msg.destination)
        .storeRef(msg.messageBody)
        .storeCoins(msg.forwardTonAmount)
        .endCell();
}
