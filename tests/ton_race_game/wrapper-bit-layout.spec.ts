// SPDX-License-Identifier: UNLICENSED
import { Address } from '@ton/core';
import {
    encodeMoveShipToCC,
    encodeShipUpgrade,
    encodeLaunchHardTravel,
    encodeHardTravel,
    Opcodes,
} from '../../wrappers/ton_race_game/types';
import { MoveMode } from '../../wrappers/ton_race_game/structs';

// =============================================================================
// Wrapper bit-layout guard for the four HP-carrying encoders.
//
// ship_hp / hpIncrease are HP_TYPE == uint64 on-chain (structs.tolk: HP_TYPE_BITS=64).
// These four wrapper encoders historically wrote them as 256 bits, which mis-aligns
// every field that follows (mode / HardTravelInfo / MoveData) when the contract's
// 64-bit auto-parser reads the body. This test parses each encoded body with the
// CONTRACT's expected widths and asserts the cell is fully consumed — it fails
// hard if any field is written at the wrong width.
// =============================================================================

const SOME_ADDR = new Address(0, Buffer.alloc(32, 0x11));

describe('ton_race_game wrapper bit layout (HP fields are uint64, not uint256)', () => {
    it('encodeMoveShipToCC: opcode + addr + uint64 hp + uint8 mode, fully consumed', () => {
        const hp = 12345n;
        const s = encodeMoveShipToCC({ user: SOME_ADDR, ship_hp: hp, mode: MoveMode.UP }).beginParse();
        expect(s.loadUint(32)).toBe(Opcodes.OP_MOVE_SHIP_TO_CC);
        expect(s.loadAddress().equals(SOME_ADDR)).toBe(true);
        expect(s.loadUintBig(64)).toBe(hp);
        expect(s.loadUint(8)).toBe(MoveMode.UP);
        expect(s.remainingBits).toBe(0);
        expect(s.remainingRefs).toBe(0);
    });

    it('encodeShipUpgrade: opcode + uint64 hpIncrease, fully consumed', () => {
        const hp = 777n;
        const s = encodeShipUpgrade({ hpIncrease: hp }).beginParse();
        expect(s.loadUint(32)).toBe(Opcodes.OP_SHIP_UPGRADE);
        expect(s.loadUintBig(64)).toBe(hp);
        expect(s.remainingBits).toBe(0);
    });

    it('encodeLaunchHardTravel: opcode + addr + uint64 hp + HardTravelInfo, fully consumed', () => {
        const hp = 9000n;
        const info = { mode: MoveMode.LEFT, gasLimit: 2_000_000_000n, hpLimit: 50n, maxTurns: 7 };
        const s = encodeLaunchHardTravel({ user: SOME_ADDR, ship_hp: hp, info }).beginParse();
        expect(s.loadUint(32)).toBe(Opcodes.OP_LAUNCH_HARD_TRAVEL);
        expect(s.loadAddress().equals(SOME_ADDR)).toBe(true);
        expect(s.loadUintBig(64)).toBe(hp);
        // HardTravelInfo: mode(uint8), gasLimit(coins), hpLimit(uint64), maxTurns(uint64)
        expect(s.loadUint(8)).toBe(MoveMode.LEFT);
        expect(s.loadCoins()).toBe(info.gasLimit);
        expect(s.loadUintBig(64)).toBe(info.hpLimit);
        expect(s.loadUint(64)).toBe(info.maxTurns);
        expect(s.remainingBits).toBe(0);
    });

    it('encodeHardTravel: opcode + addr + uint64 hp + HardTravelInfo + MoveData + turnIndex + coins', () => {
        const hp = 9000n;
        const info = { mode: MoveMode.RIGHT, gasLimit: 1_500_000_000n, hpLimit: 50n, maxTurns: 3 };
        const moveData = { ship_hp: 4242n, xy: { x: -5n, y: 11n } };
        const s = encodeHardTravel({
            user: SOME_ADDR,
            ship_hp: hp,
            info,
            moveData,
            turnIndex: 2,
            accumulatedJettonAmount: 1234n,
        }).beginParse();
        expect(s.loadUint(32)).toBe(Opcodes.OP_HARD_TRAVEL);
        expect(s.loadAddress().equals(SOME_ADDR)).toBe(true);
        expect(s.loadUintBig(64)).toBe(hp);
        // HardTravelInfo
        expect(s.loadUint(8)).toBe(MoveMode.RIGHT);
        expect(s.loadCoins()).toBe(info.gasLimit);
        expect(s.loadUintBig(64)).toBe(info.hpLimit);
        expect(s.loadUint(64)).toBe(info.maxTurns);
        // MoveData: ship_hp(uint64), xy.x(int64), xy.y(uint64)
        expect(s.loadUintBig(64)).toBe(moveData.ship_hp);
        expect(s.loadIntBig(64)).toBe(moveData.xy.x);
        expect(s.loadUintBig(64)).toBe(moveData.xy.y);
        // tail
        expect(s.loadUint(8)).toBe(2);
        expect(s.loadCoins()).toBe(1234n);
        expect(s.remainingBits).toBe(0);
    });
});
