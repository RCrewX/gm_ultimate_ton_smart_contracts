// SPDX-License-Identifier: UNLICENSED
import { toNano } from '@ton/core';
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { MoveMode, type HardTravelInfo } from '../../wrappers/ton_race_game/structs';
import { Opcodes, HARD_TRAVEL_MIN_VALUE } from '../../wrappers/ton_race_game/types';

describe('Hard Travel - Rejections', () => {
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

    it('reject EXIT mode: exitCode 937', async () => {
        const info = makeHardTravelInfo({ mode: MoveMode.EXIT });
        const value = HARD_TRAVEL_MIN_VALUE + toNano('1');

        SC_System.messageResult = await SC_System.ownerShip.sendHardTravel(
            SC_System.ownerAccount.getSender(),
            value,
            info
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: false,
            op: Opcodes.OP_REQUEST_TO_HARD_TRAVEL,
            exitCode: 937,
        });
    });

    it('reject maxTurns >= 100: exitCode 938', async () => {
        const info = makeHardTravelInfo({ maxTurns: 100 });
        const value = HARD_TRAVEL_MIN_VALUE + toNano('1');

        SC_System.messageResult = await SC_System.ownerShip.sendHardTravel(
            SC_System.ownerAccount.getSender(),
            value,
            info
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: false,
            op: Opcodes.OP_REQUEST_TO_HARD_TRAVEL,
            exitCode: 938,
        });
    });

    it('reject value below HARD_TRAVEL_MIN_VALUE: exitCode 939', async () => {
        const info = makeHardTravelInfo();
        // Just under the (right-sized) floor — track the const so this stays correct if the floor moves.
        const lowValue = HARD_TRAVEL_MIN_VALUE - toNano('0.01');

        SC_System.messageResult = await SC_System.ownerShip.sendHardTravel(
            SC_System.ownerAccount.getSender(),
            lowValue,
            info
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: false,
            op: Opcodes.OP_REQUEST_TO_HARD_TRAVEL,
            exitCode: 939,
        });
    });

    it('edge valid: maxTurns=99 with sufficient value succeeds', async () => {
        const info = makeHardTravelInfo({ maxTurns: 99 });
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

    it('edge valid: value exactly HARD_TRAVEL_MIN_VALUE succeeds (contract uses >=)', async () => {
        const info = makeHardTravelInfo({ maxTurns: 0 });
        const value = HARD_TRAVEL_MIN_VALUE;

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
});
