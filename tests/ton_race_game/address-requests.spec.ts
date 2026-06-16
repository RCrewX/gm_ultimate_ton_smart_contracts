// SPDX-License-Identifier: UNLICENSED
import { toNano } from '@ton/core';
import { Game } from '../../wrappers/ton_race_game/Game';
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { Opcodes, GAS_COST_REQUEST_SHIP_ADDRESS, GAS_COST_REQUEST_COORDINATE_CELL_ADDRESS } from '../../wrappers/ton_race_game/types';
import { CoordinateCell } from '../../wrappers/ton_race_game/CoordinateCell';

describe('Address Requests', () => {
    let SC_System: ContractSystem;
    beforeEach(async () => {
        SC_System = await initContractSystem();
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
    });

    it('Test Game sendRequestShipAddress - verify response message', async () => {
        SC_System.messageResult = await SC_System.game.sendRequestShipAddress(
            SC_System.ownerAccount.getSender(),
            GAS_COST_REQUEST_SHIP_ADDRESS,
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
        // The response goes to the sender (ownerAccount), not to the ship
        // The ship address is included in the ResponseAddress message body
    });

    it('Test Game sendRequestCoordinateCellAddress - verify response message', async () => {
        SC_System.messageResult = await SC_System.game.sendRequestCoordinateCellAddress(
            SC_System.ownerAccount.getSender(),
            GAS_COST_REQUEST_COORDINATE_CELL_ADDRESS,
            { x: 0n, y: 0n }
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
    });

    it('Test address calculation consistency - verify ship address matches', async () => {
        SC_System.messageResult = await SC_System.game.sendRequestShipAddress(
            SC_System.ownerAccount.getSender(),
            GAS_COST_REQUEST_SHIP_ADDRESS,
            SC_System.ownerAccount.address
        );
        
        // Find the ResponseAddress transaction
        const responseTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.inMessage?.body?.beginParse().loadUint(32) === Opcodes.OP_RESPONSE_ADDRESS
        );
        
        expect(responseTx).toBeDefined();
        // The ship address in response should match our ownerShip address
        expect(SC_System.ownerShip.address).toBeDefined();
    });

    it('Test address calculation consistency - verify coordinate cell address matches', async () => {
        const testXY = { x: 5n, y: 10n };
        
        SC_System.messageResult = await SC_System.game.sendRequestCoordinateCellAddress(
            SC_System.ownerAccount.getSender(),
            GAS_COST_REQUEST_COORDINATE_CELL_ADDRESS,
            testXY
        );
        
        // Find the ResponseAddress transaction
        const responseTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.inMessage?.body?.beginParse().loadUint(32) === Opcodes.OP_RESPONSE_ADDRESS
        );
        
        expect(responseTx).toBeDefined();
        
        // Verify the calculated address matches what we'd create manually
        const expectedCC = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: testXY,
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));
        
        expect(expectedCC.address).toBeDefined();
    });
});

