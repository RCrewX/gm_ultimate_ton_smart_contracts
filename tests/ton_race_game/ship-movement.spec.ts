// SPDX-License-Identifier: UNLICENSED
import { Cell, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Game } from '../../wrappers/ton_race_game/Game';
import '@ton/test-utils';
import { Ship } from '../../wrappers/ton_race_game/Ship';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { MoveMode } from '../../wrappers/ton_race_game/structs';
import { Opcodes, GAS_COST_SEND_MOVE, GAS_COST_ANY_MESSAGE } from '../../wrappers/ton_race_game/types';
import { CoordinateCell } from '../../wrappers/ton_race_game/CoordinateCell';

describe('Ship Movement', () => {
    let SC_System: ContractSystem;
    beforeEach(async () => {
        SC_System = await initContractSystem();
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
    });

    it('Get Ship, pop-up ship, move UP', async () => {
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.UP);
        let cc_old = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: {x: 0n, y: 0n},
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));
        let cc_new = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: {x: 0n, y: 1n},
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));
        
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerShip.address,
            to: cc_old.address,
            success: true,
            op: Opcodes.OP_MOVE_SHIP_TO_CC,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: cc_old.address,
            to: cc_new.address,
            success: true,
            op: Opcodes.OP_MOVE,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: cc_new.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });
    });

    it('Get Ship, pop-up ship, move UP x5', async () => {
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.UP);

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });

        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.UP);
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });

        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.UP);
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });

        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.UP);
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });

        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.UP);
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });

        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_ANY_MESSAGE, MoveMode.EXIT);
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });
    });

    it('Test move LEFT - verify coordinates and message path', async () => {
        // First move UP to get to (0, 1)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.UP);
        
        // Now move LEFT from (0, 1) to (-1, 2)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.LEFT);
        
        const cc_old = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: {x: 0n, y: 1n},
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));
        const cc_new = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: {x: -1n, y: 2n},
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));
        
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerShip.address,
            to: cc_old.address,
            success: true,
            op: Opcodes.OP_MOVE_SHIP_TO_CC,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: cc_old.address,
            to: cc_new.address,
            success: true,
            op: Opcodes.OP_MOVE,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: cc_new.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });

        const gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            expect(gameData.xy.x).toBe(-1n);
            expect(gameData.xy.y).toBe(2n);
        }
    });

    it('Test move RIGHT - verify coordinates and message path', async () => {
        // First move UP to get to (0, 1)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.UP);
        
        // Now move RIGHT from (0, 1) to (1, 2)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.RIGHT);
        
        const cc_old = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: {x: 0n, y: 1n},
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));
        const cc_new = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: {x: 1n, y: 2n},
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));
        
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerShip.address,
            to: cc_old.address,
            success: true,
            op: Opcodes.OP_MOVE_SHIP_TO_CC,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: cc_old.address,
            to: cc_new.address,
            success: true,
            op: Opcodes.OP_MOVE,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: cc_new.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });

        const gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            expect(gameData.xy.x).toBe(1n);
            expect(gameData.xy.y).toBe(2n);
        }
    });

    it('Test move EXIT - verify complete message path', async () => {
        // First move UP to get to (0, 1)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.UP);
        
        // Now move EXIT from (0, 1)
        // EXIT mode: x stays same (0), y increases by 1 -> (0, 2)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.EXIT);
        
        const cc_old = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: {x: 0n, y: 1n},
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));
        const cc_new = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: {x: 0n, y: 2n},
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));
        
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerShip.address,
            to: cc_old.address,
            success: true,
            op: Opcodes.OP_MOVE_SHIP_TO_CC,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: cc_old.address,
            to: cc_new.address,
            success: true,
            op: Opcodes.OP_MOVE,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: cc_new.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });
    });

    it('Test complete message path with all opcodes - LEFT move', async () => {
        // Move UP first
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.UP);
        
        // Move LEFT
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.LEFT);
        
        const cc_old = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: {x: 0n, y: 1n},
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));
        const cc_new = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: {x: -1n, y: 2n},
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));
        
        // Verify complete message chain
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerShip.address,
            to: cc_old.address,
            success: true,
            op: Opcodes.OP_MOVE_SHIP_TO_CC,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: cc_old.address,
            to: cc_new.address,
            success: true,
            op: Opcodes.OP_MOVE,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: cc_new.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerShip.address,
            to: SC_System.ownerAccount.address,
            success: true,
            op: Opcodes.OP_RETURN_EXCESSES_BACK,
        });
    });

    it('Test complete message path with all opcodes - RIGHT move', async () => {
        // Move UP first
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.UP);
        
        // Move RIGHT
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.RIGHT);
        
        const cc_old = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: {x: 0n, y: 1n},
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));
        const cc_new = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: {x: 1n, y: 2n},
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));
        
        // Verify complete message chain
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerShip.address,
            to: cc_old.address,
            success: true,
            op: Opcodes.OP_MOVE_SHIP_TO_CC,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: cc_old.address,
            to: cc_new.address,
            success: true,
            op: Opcodes.OP_MOVE,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: cc_new.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerShip.address,
            to: SC_System.ownerAccount.address,
            success: true,
            op: Opcodes.OP_RETURN_EXCESSES_BACK,
        });
    });

    it('Test multiple moves and verify coordinate progression', async () => {
        // Initial move UP: (0,0) -> (0,1)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.UP);
        let gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            expect(gameData.xy.x).toBe(0n);
            expect(gameData.xy.y).toBe(1n);
        }
        
        // Move RIGHT: (0,1) -> (1,2)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.RIGHT);
        gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            expect(gameData.xy.x).toBe(1n);
            expect(gameData.xy.y).toBe(2n);
        }
        
        // Move LEFT: (1,2) -> (0,3)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.LEFT);
        gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            expect(gameData.xy.x).toBe(0n);
            expect(gameData.xy.y).toBe(3n);
        }
        
        // Move UP again: (0,3) -> (0,4)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.UP);
        gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            expect(gameData.xy.x).toBe(0n);
            expect(gameData.xy.y).toBe(4n);
        }
    });

    it('Test coordinate update after MoveEnd - verify coordinates always update on CONTINUE', async () => {
        // This test specifically checks that coordinates are updated after MoveEnd
        // Initial move UP: (0,0) -> (0,1)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.UP);
        let gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            const beforeX = gameData.xy.x;
            const beforeY = gameData.xy.y;
            expect(beforeX).toBe(0n);
            expect(beforeY).toBe(1n);
            
            // Move RIGHT: (0,1) -> (1,2) - coordinates MUST change
            SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.RIGHT);
            gameData = await SC_System.ownerShip.getCurrentGameData();
            expect(gameData).not.toBeNull();
            if (gameData) {
                // Verify coordinates changed
                expect(gameData.xy.x).not.toBe(beforeX);
                expect(gameData.xy.y).not.toBe(beforeY);
                expect(gameData.xy.x).toBe(1n);
                expect(gameData.xy.y).toBe(2n);
            }
        }
    });

    it('Test HP update after MoveEnd - verify HP is correctly updated on CONTINUE (may Fail)', async () => {
        // Initial move UP: (0,0) -> (0,1)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.UP);
        let gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            const initialHp = gameData.hp;
            expect(initialHp).toBeGreaterThan(0n);
            
            // Move again - HP should be updated based on cell HP
            SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_SEND_MOVE, MoveMode.UP);
            gameData = await SC_System.ownerShip.getCurrentGameData();
            expect(gameData).not.toBeNull();
            if (gameData) {
                // HP should be valid (>= 0) and should reflect the result of the move
                expect(gameData.hp).toBeGreaterThanOrEqual(0n);
                // HP should be <= initial HP (can only decrease or stay same on CONTINUE)
                expect(gameData.hp).toBeLessThanOrEqual(initialHp);
            }
        }
    });
});

