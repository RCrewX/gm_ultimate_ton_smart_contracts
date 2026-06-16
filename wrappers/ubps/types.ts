// SPDX-License-Identifier: UNLICENSED
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { createHash } from 'crypto';

// =============================================================================
// Constants, opcodes, errors and encoders for the UBPS module (master + Unit +
// Question + Answer + BeliefSet). Must stay in sync with contracts/ubps/static.tolk.
//
// UBPS is an INDEPENDENT module: no RUDA/jetton, no GM/R* pipe. Its R* registry
// slot is registration-only (the master address is stored for discovery and is
// NEVER reward-authorized).
// =============================================================================

export const BASIC_STORAGE_TAX = toNano('0.01');

// BeliefSet size caps (static.tolk). Tunable.
export const MAX_A = 100;
export const MAX_BS = 20;

export const UBPS_MIN_OP_VALUE = toNano('0.1');

// Question/Answer strings must be a single byte-aligned cell so the on-chain
// SHA256U (slice.bitsHash) matches the off-chain sha256 of the UTF-8 bytes.
export const UBPS_MAX_STRING_BYTES = 127;

export const Opcodes = {
    // to master
    OP_ACTIVATE_QUESTION: 0x55425001,
    OP_ACTIVATE_ANSWER: 0x55425002,
    OP_CREATE_BELIEF_SET: 0x55425003,
    // master -> child
    OP_ACTIVATE_QUESTION_MSG: 0x55425011,
    OP_ACTIVATE_ANSWER_MSG: 0x55425012,
    OP_POPULATE_BELIEF_SET: 0x55425013,
    // to a Unit
    OP_SET_POINTER: 0x55425021,
    // shared excess / catch-all
    OP_RETURN_EXCESSES_BACK: 0xd53276db,
    OP_LITERALY_ANYTHING: 0x0a1b2c3d,
} as const;

export const Errors = {
    ERR_UBPS_INVALID_SENDER: 600,
    ERR_UBPS_HASH_MISMATCH: 601,
    ERR_UBPS_ALREADY_ACTIVE: 602,
    ERR_UBPS_ALREADY_CREATED: 603,
    ERR_UBPS_TOO_MANY_A: 604,
    ERR_UBPS_TOO_MANY_BS: 605,
    ERR_UBPS_INVALID_OWNER_SENDER: 606,
    ERR_UBPS_VALUE_TOO_LOW: 607,
    ERR_UBPS_NOT_MASTER: 608,
} as const;

// -----------------------------------------------------------------------------
//  String encoding & id (string.hash). Mirrors the on-chain slice.bitsHash():
//  sha256 of the question/answer UTF-8 bytes (single byte-aligned cell).
// -----------------------------------------------------------------------------
export function buildStringCell(s: string): Cell {
    const bytes = Buffer.from(s, 'utf8');
    if (bytes.length > UBPS_MAX_STRING_BYTES) {
        throw new Error(
            `UBPS string too long: ${bytes.length} bytes > ${UBPS_MAX_STRING_BYTES} ` +
            `(must fit a single byte-aligned cell so SHA256U matches off-chain sha256)`,
        );
    }
    return beginCell().storeStringTail(s).endCell();
}

export function stringId(s: string): bigint {
    const bytes = Buffer.from(s, 'utf8');
    if (bytes.length > UBPS_MAX_STRING_BYTES) {
        throw new Error(`UBPS string too long: ${bytes.length} bytes > ${UBPS_MAX_STRING_BYTES}`);
    }
    return BigInt('0x' + createHash('sha256').update(bytes).digest('hex'));
}

export const emptyCell = (): Cell => beginCell().endCell();

// =============================================================================
//  Storage / config encoders (mirror the Tolk *Storage layouts; declaration order)
// =============================================================================

export type UBPSConfig = {
    ownerAddress: Address;
    unitCode: Cell;
    questionCode: Cell;
    answerCode: Cell;
    beliefSetCode: Cell;
    nextBsIndex?: bigint | number;
};

export function ubpsConfigToCell(c: UBPSConfig): Cell {
    return beginCell()
        .storeAddress(c.ownerAddress)
        .storeRef(c.unitCode)
        .storeRef(c.questionCode)
        .storeRef(c.answerCode)
        .storeRef(c.beliefSetCode)
        .storeUint(c.nextBsIndex ?? 0, 64)
        .endCell();
}

export type UnitConfig = {
    ubpsMaster: Address;
    userAddress: Address;
    up?: Address | null; // address calc fixes up = null
};

export function unitConfigToCell(c: UnitConfig): Cell {
    return beginCell()
        .storeAddress(c.ubpsMaster)
        .storeAddress(c.userAddress)
        .storeAddress(c.up ?? null)
        .endCell();
}

export type QuestionConfig = {
    ubpsMaster: Address;
    questionId: bigint;
    active?: boolean;        // address calc fixes active = false
    questionBytes?: Cell | null; // and questionBytes = null
};

export function questionConfigToCell(c: QuestionConfig): Cell {
    return beginCell()
        .storeAddress(c.ubpsMaster)
        .storeUint(c.questionId, 256)
        .storeBit(c.active ?? false)
        .storeMaybeRef(c.questionBytes ?? null)
        .endCell();
}

export type AnswerConfig = {
    ubpsMaster: Address;
    questionAddress: Address;
    answerId: bigint;
    active?: boolean;
    answerBytes?: Cell | null;
};

export function answerConfigToCell(c: AnswerConfig): Cell {
    return beginCell()
        .storeAddress(c.ubpsMaster)
        .storeAddress(c.questionAddress)
        .storeUint(c.answerId, 256)
        .storeBit(c.active ?? false)
        .storeMaybeRef(c.answerBytes ?? null)
        .endCell();
}

export type BeliefSetConfig = {
    ubpsMaster: Address;
    bsIndex: bigint | number;
    created?: boolean;       // address calc fixes created/root=false, counts=0, empty sets
    root?: boolean;
    aCount?: number;
    bsCount?: number;
    aSet?: Cell;
    bsSet?: Cell;
};

export function beliefSetConfigToCell(c: BeliefSetConfig): Cell {
    return beginCell()
        .storeAddress(c.ubpsMaster)
        .storeUint(c.bsIndex, 64)
        .storeBit(c.created ?? false)
        .storeBit(c.root ?? false)
        .storeUint(c.aCount ?? 0, 16)
        .storeUint(c.bsCount ?? 0, 16)
        .storeRef(c.aSet ?? emptyCell())
        .storeRef(c.bsSet ?? emptyCell())
        .endCell();
}

// =============================================================================
//  Message-body encoders
// =============================================================================
export function encodeActivateQuestion(questionId: bigint, questionBytes: Cell): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_ACTIVATE_QUESTION, 32)
        .storeUint(questionId, 256)
        .storeRef(questionBytes)
        .endCell();
}

export function encodeActivateAnswer(questionAddress: Address, answerId: bigint, answerBytes: Cell): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_ACTIVATE_ANSWER, 32)
        .storeAddress(questionAddress)
        .storeUint(answerId, 256)
        .storeRef(answerBytes)
        .endCell();
}

export function encodeCreateBeliefSet(
    root: boolean,
    aCount: number,
    bsCount: number,
    aSet: Cell,
    bsSet: Cell,
): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_CREATE_BELIEF_SET, 32)
        .storeBit(root)
        .storeUint(aCount, 16)
        .storeUint(bsCount, 16)
        .storeRef(aSet)
        .storeRef(bsSet)
        .endCell();
}

export function encodeSetPointer(up: Address | null): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_SET_POINTER, 32)
        .storeAddress(up)
        .endCell();
}

// Build an opaque set cell from a list of addresses (one storeAddress each,
// chained into refs past the per-cell address budget). Off-chain shape — the
// contract treats aSet/bsSet as opaque (no on-chain parse).
export function buildAddressSet(addrs: Address[]): Cell {
    if (addrs.length === 0) return emptyCell();
    // Up to 3 addresses (3*267=801 bits) per cell, remainder in a ref tail.
    const head = addrs.slice(0, 3);
    const tail = addrs.slice(3);
    let b = beginCell();
    for (const a of head) b = b.storeAddress(a);
    if (tail.length > 0) b = b.storeRef(buildAddressSet(tail));
    return b.endCell();
}
