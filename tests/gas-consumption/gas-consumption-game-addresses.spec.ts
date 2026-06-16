// SPDX-License-Identifier: UNLICENSED
import { fromNano, toNano } from "@ton/core";
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { Opcodes, GAS_COST_REQUEST_SHIP_ADDRESS, GAS_COST_REQUEST_COORDINATE_CELL_ADDRESS } from '../../wrappers/ton_race_game/types';
import { writeGasCosts } from '../../lib/buildOutput';

describe("Gas Prices - Game Address Requests", () => {
    let SC_System: ContractSystem;
    let gasCosts: Record<string, string> = {};

    beforeEach(async () => {
        SC_System = await initContractSystem();
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
    });

    afterAll(() => {
        writeGasCosts('game-addresses', gasCosts);
        // Clear gasCosts to free memory
        Object.keys(gasCosts).forEach(key => delete gasCosts[key]);
    });

    it("RequestShipAddress", async () => {
        let initial_balance = await SC_System.ownerAccount.getBalance();
        let little_less_than_gas_needed = toNano('0.01');
        let gas_sent = GAS_COST_REQUEST_SHIP_ADDRESS;

        SC_System.messageResult = await SC_System.game.sendRequestShipAddress(
            SC_System.ownerAccount.getSender(),
            gas_sent,
            SC_System.ownerAccount.address
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.game.address,
            success: true,
            op: Opcodes.OP_REQUEST_SHIP_ADDRESS,
        });

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.game.address,
            to: SC_System.ownerAccount.address,
            success: true,
            op: Opcodes.OP_RESPONSE_ADDRESS,
        });

        let final_balance = await SC_System.ownerAccount.getBalance();
        let cost = initial_balance - final_balance;
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['RequestShipAddress'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });

    it("RequestCoordinateCellAddress", async () => {
        let initial_balance = await SC_System.ownerAccount.getBalance();
        let little_less_than_gas_needed = toNano('0.01');
        let gas_sent = GAS_COST_REQUEST_COORDINATE_CELL_ADDRESS;

        SC_System.messageResult = await SC_System.game.sendRequestCoordinateCellAddress(
            SC_System.ownerAccount.getSender(),
            gas_sent,
            { x: 5n, y: 10n }
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.game.address,
            success: true,
            op: Opcodes.OP_REQUEST_COORDINATE_CELL_ADDRESS,
        });

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.game.address,
            to: SC_System.ownerAccount.address,
            success: true,
            op: Opcodes.OP_RESPONSE_ADDRESS,
        });

        let final_balance = await SC_System.ownerAccount.getBalance();
        let cost = initial_balance - final_balance;
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['RequestCoordinateCellAddress'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });
});

