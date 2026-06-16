// SPDX-License-Identifier: UNLICENSED
import { toNano } from '@ton/core';
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { MoveMode, type HardTravelInfo } from '../../wrappers/ton_race_game/structs';
import {
    Opcodes,
    GAS_COST_SEND_MOVE,
    HARD_TRAVEL_MIN_VALUE,
    TODO_TOTAL_GAS_TO_MOVE,
} from '../../wrappers/ton_race_game/types';

describe('Hard Travel', () => {
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

    it('happy path: RequestToHardTravel from (0,0), chain LaunchHardTravel -> HardTravel -> HardTravelMoveEnd', async () => {
        const info = makeHardTravelInfo({ maxTurns: 2 });
        const value = HARD_TRAVEL_MIN_VALUE + toNano('1');

        SC_System.messageResult = await SC_System.ownerShip.sendHardTravel(
            SC_System.ownerAccount.getSender(),
            value,
            info
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: true,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerShip.address,
            success: true,
        });
        // Ship receives HardTravelMoveEnd from the CC that was just visited
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_HARD_TRAVEL_MOVE_END,
        });
        expect(await SC_System.ownerShip.getMovementInProcess()).toBe(false);
    });

    it('end by maxTurns: maxTurns=0, exactly one move then HardTravelMoveEnd(CONTINUE)', async () => {
        const info = makeHardTravelInfo({ maxTurns: 0 });
        const value = HARD_TRAVEL_MIN_VALUE + toNano('1');

        SC_System.messageResult = await SC_System.ownerShip.sendHardTravel(
            SC_System.ownerAccount.getSender(),
            value,
            info
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: true,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_HARD_TRAVEL_MOVE_END,
        });
        expect(await SC_System.ownerShip.getMovementInProcess()).toBe(false);
        const gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        expect(gameData!.xy.y).toBe(1n);
    });

    it('HardTravel completion: Ship receives HardTravelMoveEnd and clears movement_in_process (CRASH 10% applied in contract when result is CRASH)', async () => {
        const info = makeHardTravelInfo({ maxTurns: 1 });
        const value = HARD_TRAVEL_MIN_VALUE + toNano('1');

        SC_System.messageResult = await SC_System.ownerShip.sendHardTravel(
            SC_System.ownerAccount.getSender(),
            value,
            info
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: true,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_HARD_TRAVEL_MOVE_END,
        });
        expect(await SC_System.ownerShip.getMovementInProcess()).toBe(false);
    });

    it('HardTravel from (0,1) after one move: LaunchHardTravel from current cell', async () => {
        await SC_System.ownerShip.sendMove(
            SC_System.ownerAccount.getSender(),
            TODO_TOTAL_GAS_TO_MOVE,
            MoveMode.UP
        );
        expect(await SC_System.ownerShip.getMovementInProcess()).toBe(false);
        const afterFirst = await SC_System.ownerShip.getCurrentGameData();
        expect(afterFirst!.xy.y).toBe(1n);

        const info = makeHardTravelInfo({ maxTurns: 2 });
        const value = HARD_TRAVEL_MIN_VALUE + toNano('1');

        SC_System.messageResult = await SC_System.ownerShip.sendHardTravel(
            SC_System.ownerAccount.getSender(),
            value,
            info
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerShip.address,
            success: true,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
        });
        expect(await SC_System.ownerShip.getMovementInProcess()).toBe(false);
    });
});
