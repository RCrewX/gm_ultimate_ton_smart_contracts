// SPDX-License-Identifier: UNLICENSED
import { fromNano, toNano } from '@ton/core';
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { MoveMode, type HardTravelInfo } from '../../wrappers/ton_race_game/structs';
import { HARD_TRAVEL_MIN_VALUE } from '../../wrappers/ton_race_game/types';
import { writeGasCosts } from '../../lib/buildOutput';

// HardTravel: each CC does the basic move first, then checks limits; Ship receives HardTravelMoveEnd from the CC that was just visited.
describe('Gas Prices - Hard Travel', () => {
    let SC_System: ContractSystem;
    const gasCosts: Record<string, string> = {};

    beforeEach(async () => {
        SC_System = await initContractSystem();
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
    });

    afterAll(() => {
        writeGasCosts('hard-travel', gasCosts);
        Object.keys(gasCosts).forEach(key => delete gasCosts[key]);
    });

    function makeHardTravelInfo(overrides: Partial<HardTravelInfo> = {}): HardTravelInfo {
        return {
            mode: MoveMode.UP,
            gasLimit: toNano('3'),
            hpLimit: 1n,
            maxTurns: 4,
            ...overrides,
        };
    }

    describe('by move count (mode UP)', () => {
        it('RequestToHardTravel 1 move (maxTurns=0)', async () => {
            const info = makeHardTravelInfo({ maxTurns: 0 });
            const value = HARD_TRAVEL_MIN_VALUE + toNano('1');

            const initialBalance = await SC_System.ownerAccount.getBalance();
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
            });

            const finalBalance = await SC_System.ownerAccount.getBalance();
            const cost = initialBalance - finalBalance;
            const costStr = fromNano(cost);
            gasCosts['RequestToHardTravel_1move'] = costStr;
            expect(cost).toBeLessThanOrEqual(value);
        });

        it('RequestToHardTravel 2 moves (maxTurns=1)', async () => {
            const info = makeHardTravelInfo({ maxTurns: 1 });
            const value = HARD_TRAVEL_MIN_VALUE + toNano('1.5');

            const initialBalance = await SC_System.ownerAccount.getBalance();
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
            });

            const finalBalance = await SC_System.ownerAccount.getBalance();
            const cost = initialBalance - finalBalance;
            const costStr = fromNano(cost);
            gasCosts['RequestToHardTravel_2moves'] = costStr;
            expect(cost).toBeLessThanOrEqual(value);
        });

        it('RequestToHardTravel 3 moves (maxTurns=2)', async () => {
            const info = makeHardTravelInfo({ maxTurns: 2 });
            const value = HARD_TRAVEL_MIN_VALUE + toNano('1.2');

            const initialBalance = await SC_System.ownerAccount.getBalance();
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
            });

            const finalBalance = await SC_System.ownerAccount.getBalance();
            const cost = initialBalance - finalBalance;
            const costStr = fromNano(cost);
            gasCosts['RequestToHardTravel_3moves'] = costStr;
            expect(cost).toBeLessThanOrEqual(value);
        });

        it('RequestToHardTravel 4 moves (maxTurns=3)', async () => {
            const info = makeHardTravelInfo({ maxTurns: 3 });
            const value = HARD_TRAVEL_MIN_VALUE + toNano('2');

            const initialBalance = await SC_System.ownerAccount.getBalance();
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
            });

            const finalBalance = await SC_System.ownerAccount.getBalance();
            const cost = initialBalance - finalBalance;
            const costStr = fromNano(cost);
            gasCosts['RequestToHardTravel_4moves'] = costStr;
            expect(cost).toBeLessThanOrEqual(value);
        });

        it('RequestToHardTravel 6 moves (maxTurns=5)', async () => {
            const info = makeHardTravelInfo({ maxTurns: 5 });
            const value = HARD_TRAVEL_MIN_VALUE + toNano('2');

            const initialBalance = await SC_System.ownerAccount.getBalance();
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
            });

            const finalBalance = await SC_System.ownerAccount.getBalance();
            const cost = initialBalance - finalBalance;
            const costStr = fromNano(cost);
            gasCosts['RequestToHardTravel_6moves'] = costStr;
            expect(cost).toBeLessThanOrEqual(value);
        });

        it('RequestToHardTravel 8 moves (maxTurns=7)', async () => {
            const info = makeHardTravelInfo({ maxTurns: 7 });
            const value = HARD_TRAVEL_MIN_VALUE + toNano('2.5');

            const initialBalance = await SC_System.ownerAccount.getBalance();
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
            });

            const finalBalance = await SC_System.ownerAccount.getBalance();
            const cost = initialBalance - finalBalance;
            const costStr = fromNano(cost);
            gasCosts['RequestToHardTravel_8moves'] = costStr;
            expect(cost).toBeLessThanOrEqual(value);
        });
    });

    describe('by mode (2 moves)', () => {
        it('RequestToHardTravel mode LEFT (2 moves)', async () => {
            const info = makeHardTravelInfo({ mode: MoveMode.LEFT, maxTurns: 1 });
            const value = HARD_TRAVEL_MIN_VALUE + toNano('1.5');

            const initialBalance = await SC_System.ownerAccount.getBalance();
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
            });

            const finalBalance = await SC_System.ownerAccount.getBalance();
            const cost = initialBalance - finalBalance;
            const costStr = fromNano(cost);
            gasCosts['RequestToHardTravel_mode_LEFT'] = costStr;
            expect(cost).toBeLessThanOrEqual(value);
        });

        it('RequestToHardTravel mode RIGHT (2 moves)', async () => {
            const info = makeHardTravelInfo({ mode: MoveMode.RIGHT, maxTurns: 1 });
            const value = HARD_TRAVEL_MIN_VALUE + toNano('1.5');

            const initialBalance = await SC_System.ownerAccount.getBalance();
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
            });

            const finalBalance = await SC_System.ownerAccount.getBalance();
            const cost = initialBalance - finalBalance;
            const costStr = fromNano(cost);
            gasCosts['RequestToHardTravel_mode_RIGHT'] = costStr;
            expect(cost).toBeLessThanOrEqual(value);
        });
    });

    describe('by limit reason', () => {
        it('RequestToHardTravel end by maxTurns (maxTurns=0)', async () => {
            const info = makeHardTravelInfo({ maxTurns: 0 });
            const value = HARD_TRAVEL_MIN_VALUE + toNano('1');

            const initialBalance = await SC_System.ownerAccount.getBalance();
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
            });

            const finalBalance = await SC_System.ownerAccount.getBalance();
            const cost = initialBalance - finalBalance;
            const costStr = fromNano(cost);
            gasCosts['RequestToHardTravel_endByMaxTurns'] = costStr;
            expect(cost).toBeLessThanOrEqual(value);
        });

        it('RequestToHardTravel end by gasLimit (low gas)', async () => {
            const info = makeHardTravelInfo({ gasLimit: toNano('1.05') });
            const value = HARD_TRAVEL_MIN_VALUE + toNano('0.1');

            const initialBalance = await SC_System.ownerAccount.getBalance();
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
            });

            const finalBalance = await SC_System.ownerAccount.getBalance();
            const cost = initialBalance - finalBalance;
            const costStr = fromNano(cost);
            gasCosts['RequestToHardTravel_endByGasLimit'] = costStr;
            expect(cost).toBeLessThanOrEqual(value);
        });

        it('RequestToHardTravel end by hpLimit', async () => {
            const info = makeHardTravelInfo({ hpLimit: 50n, maxTurns: 10, gasLimit: toNano('3') });
            const value = HARD_TRAVEL_MIN_VALUE + toNano('2');

            const initialBalance = await SC_System.ownerAccount.getBalance();
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
            });

            const finalBalance = await SC_System.ownerAccount.getBalance();
            const cost = initialBalance - finalBalance;
            const costStr = fromNano(cost);
            gasCosts['RequestToHardTravel_endByHpLimit'] = costStr;
            expect(cost).toBeLessThanOrEqual(value);
        });
    });

    describe('rejection', () => {
        it('RequestToHardTravel reject value too low (cost of failed tx)', async () => {
            const info = makeHardTravelInfo();
            const value = toNano('0.5');

            const initialBalance = await SC_System.ownerAccount.getBalance();
            SC_System.messageResult = await SC_System.ownerShip.sendHardTravel(
                SC_System.ownerAccount.getSender(),
                value,
                info
            );

            expect(SC_System.messageResult.transactions).toHaveTransaction({
                from: SC_System.ownerAccount.address,
                to: SC_System.ownerShip.address,
                success: false,
                exitCode: 939,
            });

            const finalBalance = await SC_System.ownerAccount.getBalance();
            const cost = initialBalance - finalBalance;
            const costStr = fromNano(cost);
            gasCosts['RequestToHardTravel_reject_valueTooLow'] = costStr;
        });
    });
});
