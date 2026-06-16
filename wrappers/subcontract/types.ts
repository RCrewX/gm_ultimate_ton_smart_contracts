// SPDX-License-Identifier: UNLICENSED
import { Address, beginCell, Cell, toNano } from '@ton/core';

// Gas costs from gas consumption tests (in TON)
// These match the constants in contracts/subcontract/static.tolk
export const GAS_COST_FORWARD = toNano("0.005"); // 0.0031816 + buffer
export const GAS_COST_FORWARD_WITH_INIT = toNano("0.01"); // Higher cost for deploy messages
export const GAS_COST_MANUAL_DEPLOY = toNano("0.4"); // Manual deployment gas cost (from ton_game/contracts/subcontract/static.tolk)
// Opcodes
export const Opcodes = {
    OP_FORWARD: 0xf1c65e14,
    OP_FORWARD_WITH_INIT: 0x621c7833,
    OP_WITHDRAW: 0x164546a9,
    OP_RETURN_EXCESSES_BACK: 0xd53276db,
    OP_SET_REDIRECT_EXCESS: 0x50245bad,
    OP_SET_EXCESS_THRESHOLD: 0xc64d98a7,
    OP_MANUAL_DEPLOY: 0xa2c65e14,
} as const;

// Message types

export type ManualDeploy = {
    queryId: bigint;
};

export type Forward = {
    queryId: bigint;
    destination: Address;
    forwardTonAmount: bigint;
    bounce: boolean; // true = Bounce, false = NoBounce
    sendMode: number;
    messageBody: Cell;
};

export type ForwardWithInit = {
    queryId: bigint;
    destination: Address;
    forwardTonAmount: bigint;
    sendMode: number;
    stateInit: Cell; // StateInit cell for contract deployment
    messageBody: Cell;
};

export type Withdraw = {
    queryId: bigint;
    amount: bigint;
    receiver: Address;
};

export type SetRedirectExcess = {
    queryId: bigint;
    redirectExcess: boolean;
};

export type SetExcessThreshold = {
    queryId: bigint;
    excessThreshold: bigint;
};

export type ReturnExcessesBack = {
    queryId: bigint;
};

// Encode functions

export function encodeManualDeploy(msg: ManualDeploy): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_MANUAL_DEPLOY, 32)
        .storeUint(msg.queryId, 64)
        .endCell();
}

export function encodeForward(msg: Forward): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_FORWARD, 32)
        .storeUint(msg.queryId, 64)
        .storeAddress(msg.destination)
        .storeCoins(msg.forwardTonAmount)
        .storeBit(msg.bounce)
        .storeUint(msg.sendMode, 8)
        .storeRef(msg.messageBody)
        .endCell();
}

export function encodeForwardWithInit(msg: ForwardWithInit): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_FORWARD_WITH_INIT, 32)
        .storeUint(msg.queryId, 64)
        .storeAddress(msg.destination)
        .storeCoins(msg.forwardTonAmount)
        .storeUint(msg.sendMode, 8)
        .storeRef(msg.stateInit)
        .storeRef(msg.messageBody)
        .endCell();
}

export function encodeWithdraw(msg: Withdraw): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_WITHDRAW, 32)
        .storeUint(msg.queryId, 64)
        .storeCoins(msg.amount)
        .storeAddress(msg.receiver)
        .endCell();
}

export function encodeSetRedirectExcess(msg: SetRedirectExcess): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_SET_REDIRECT_EXCESS, 32)
        .storeUint(msg.queryId, 64)
        .storeBit(msg.redirectExcess)
        .endCell();
}

export function encodeSetExcessThreshold(msg: SetExcessThreshold): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_SET_EXCESS_THRESHOLD, 32)
        .storeUint(msg.queryId, 64)
        .storeCoins(msg.excessThreshold)
        .endCell();
}

export function encodeReturnExcessesBack(msg: ReturnExcessesBack): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_RETURN_EXCESSES_BACK, 32)
        .storeUint(msg.queryId, 64)
        .endCell();
}

// External message types
export type ExternalInner = {
    seqno: number; // uint32
    validUntil: number; // uint32 (Unix timestamp)
    command: Forward | ForwardWithInit;
};

export type ExternalEnvelope = {
    signature: Buffer; // bits512 (Ed25519 signature, 64 bytes)
    inner: Cell; // Referenced cell containing ExternalInner
};

/**
 * Encode ExternalInner (signed data structure)
 * This is what gets signed - the cell hash is used as the message to sign
 * 
 * Layout:
 * - seqno: uint32 (32 bits)
 * - validUntil: uint32 (32 bits)
 * - command: AllowedExternalCommand (union type, stored with opcode)
 *   - If Forward: opcode (32 bits) + Forward fields
 *   - If ForwardWithInit: opcode (32 bits) + ForwardWithInit fields
 */
export function encodeExternalInner(inner: ExternalInner): Cell {
    const cell = beginCell()
        .storeUint(inner.seqno, 32)
        .storeUint(inner.validUntil, 32);
    
    // Store command inline (union type with opcode)
    if ('stateInit' in inner.command) {
        // ForwardWithInit
        const cmd = inner.command as ForwardWithInit;
        cell.storeUint(Opcodes.OP_FORWARD_WITH_INIT, 32)
            .storeUint(cmd.queryId, 64)
            .storeAddress(cmd.destination)
            .storeCoins(cmd.forwardTonAmount)
            .storeUint(cmd.sendMode, 8)
            .storeRef(cmd.stateInit)
            .storeRef(cmd.messageBody);
    } else {
        // Forward
        const cmd = inner.command as Forward;
        cell.storeUint(Opcodes.OP_FORWARD, 32)
            .storeUint(cmd.queryId, 64)
            .storeAddress(cmd.destination)
            .storeCoins(cmd.forwardTonAmount)
            .storeBit(cmd.bounce)
            .storeUint(cmd.sendMode, 8)
            .storeRef(cmd.messageBody);
    }
    
    return cell.endCell();
}

/**
 * Encode ExternalEnvelope (external message body)
 * Approach 2: signed data as referenced cell
 */
export function encodeExternalEnvelope(envelope: ExternalEnvelope): Cell {
    return beginCell()
        .storeBuffer(envelope.signature) // 512 bits (64 bytes)
        .storeRef(envelope.inner)
        .endCell();
}

