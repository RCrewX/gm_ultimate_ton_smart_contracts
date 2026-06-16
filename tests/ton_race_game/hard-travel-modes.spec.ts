// SPDX-License-Identifier: UNLICENSED
import { toNano } from '@ton/core';
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { MoveMode, type HardTravelInfo } from '../../wrappers/ton_race_game/structs';
import { Opcodes, HARD_TRAVEL_MIN_VALUE } from '../../wrappers/ton_race_game/types';

describe('Hard Travel - Modes', () => {
    let SC_System: ContractSystem;

    beforeEach(async () => {
        SC_System = await initContractSystem();
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
    });

    function makeHardTravelInfo(overrides: Partial<HardTravelInfo> = {}): HardTravelInfo {
        return {
            mode: MoveMode.UP,
            gasLimit: toNano('2'),
            hpLimit: 1n,
            maxTurns: 3,
            ...overrides,
        };
    }

    it('mode UP from (0,0), maxTurns=0: 1 move, HardTravelMoveEnd, final xy = (0, 1)', async () => {
        const info = makeHardTravelInfo({ mode: MoveMode.UP, maxTurns: 0 });
        const value = HARD_TRAVEL_MIN_VALUE + toNano('1');

        SC_System.messageResult = await SC_System.ownerShip.sendHardTravel(
            SC_System.ownerAccount.getSender(),
            value,
            info
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_HARD_TRAVEL_MOVE_END,
        });
        expect(await SC_System.ownerShip.getMovementInProcess()).toBe(false);
        const gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        expect(gameData!.xy.x).toBe(0n);
        expect(gameData!.xy.y).toBe(1n);
    });

    it('mode LEFT from (0,0), maxTurns=0: 1 move, HardTravelMoveEnd, final xy.x = -1, y = 1', async () => {
        const info = makeHardTravelInfo({ mode: MoveMode.LEFT, maxTurns: 0 });
        const value = HARD_TRAVEL_MIN_VALUE + toNano('1');

        SC_System.messageResult = await SC_System.ownerShip.sendHardTravel(
            SC_System.ownerAccount.getSender(),
            value,
            info
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_HARD_TRAVEL_MOVE_END,
        });
        expect(await SC_System.ownerShip.getMovementInProcess()).toBe(false);
        const gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        expect(gameData!.xy.x).toBe(-1n);
        expect(gameData!.xy.y).toBe(1n);
    });

    it('mode RIGHT from (0,0), maxTurns=0: 1 move, HardTravelMoveEnd, final xy.x = 1, y = 1', async () => {
        const info = makeHardTravelInfo({ mode: MoveMode.RIGHT, maxTurns: 0 });
        const value = HARD_TRAVEL_MIN_VALUE + toNano('1');

        SC_System.messageResult = await SC_System.ownerShip.sendHardTravel(
            SC_System.ownerAccount.getSender(),
            value,
            info
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_HARD_TRAVEL_MOVE_END,
        });
        expect(await SC_System.ownerShip.getMovementInProcess()).toBe(false);
        const gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        expect(gameData!.xy.x).toBe(1n);
        expect(gameData!.xy.y).toBe(1n);
    });
});
