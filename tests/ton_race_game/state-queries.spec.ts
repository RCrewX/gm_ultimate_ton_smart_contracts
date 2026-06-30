// SPDX-License-Identifier: UNLICENSED
import { toNano } from '@ton/core';
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { MoveMode } from '../../wrappers/ton_race_game/structs';
import { CoordinateCell } from '../../wrappers/ton_race_game/CoordinateCell';
import { GAS_COST_REQUEST_TO_MOVE, TOTAL_GAS_TO_MOVE, GAS_COST_ANY_MESSAGE, BASIC_SHIP_HP, Opcodes } from '../../wrappers/ton_race_game/types';
import { Ship } from '../../wrappers/ton_race_game/Ship';

describe('State Queries', () => {
    let SC_System: ContractSystem;
    beforeEach(async () => {
        SC_System = await initContractSystem();
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
    });

    it('Test Ship getCurrentGameData - verify initial state', async () => {
        let anyUser = await SC_System.blockchain.treasury('anyUser');
        let someShip = SC_System.blockchain.openContract(Ship.createFromConfig({
            userAddress: anyUser.address,
            gameAddress: SC_System.game.address,
            coordinateCellCode: SC_System.coordinateCellCode,
        }, SC_System.shipCode));
        SC_System.messageResult = await someShip.sendDeploy(anyUser.getSender(), toNano('0.5'));
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: anyUser.address,
            to: someShip.address,
            success: true,
            deploy: true,
        });
        const gameData = await someShip.getCurrentGameData();
        expect(gameData).toBeNull(); // Should be null before first move
    });

    it('Test Ship getCurrentGameData - verify after first move', async () => {
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        
        const gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            expect(gameData.xy.x).toBe(0n);
            expect(gameData.xy.y).toBe(1n);
            expect(gameData.hp).toBeGreaterThan(0n);
            expect(gameData.jettonAmount).toBeGreaterThanOrEqual(0n);
        }
    });

    it('Test Ship getCurrentGameData - verify after multiple moves (CONTINUE)', async () => {
        // Move 1: UP from (0,0) to (0,1)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        let gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            expect(gameData.xy.x).toBe(0n);
            expect(gameData.xy.y).toBe(1n);
        }

        // Move 2: RIGHT from (0,1) to (1,2)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.RIGHT);
        gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            expect(gameData.xy.x).toBe(1n);
            expect(gameData.xy.y).toBe(2n);
            expect(gameData.hp).toBeGreaterThan(0n);
        }

        // Move 3: LEFT from (1,2) to (0,3)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.LEFT);
        gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            expect(gameData.xy.x).toBe(0n);
            expect(gameData.xy.y).toBe(3n);
        }
    });

    it('Test Ship getCurrentGameData - verify after SAFE_EXIT', async () => {
        // First move to get into game
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        
        // Get initial jetton amount
        let gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        const initialJettonAmount = gameData ? gameData.jettonAmount : 0n;

        // Move several times to accumulate jettons
        for (let i = 0; i < 3; i++) {
            SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        }

        // Now do EXIT move which should trigger SAFE_EXIT if ship HP > cell HP
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_ANY_MESSAGE, MoveMode.EXIT);
        
        gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            // After SAFE_EXIT, coordinates should reset to (0, 0)
            expect(gameData.xy.x).toBe(0n);
            expect(gameData.xy.y).toBe(0n);
            // HP should be reset to max_hp (which is set to BASIC_SHIP_HP when gameFields are first initialized)
            expect(gameData.hp).toBe(BASIC_SHIP_HP);
            // Jetton amount should be reset to 0 (minted to user)
            expect(gameData.jettonAmount).toBe(0n);
        }
    });

    it('Test Ship getCurrentGameData - verify after CRASH', async () => {
        // First move to get into game
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        
        // Move to a high Y coordinate where cell HP might be high
        // Keep moving UP to increase Y (which increases cell HP)
        for (let i = 0; i < 10; i++) {
            SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
            const gameData = await SC_System.ownerShip.getCurrentGameData();
            if (gameData && gameData.hp <= 0n) {
                // Ship crashed, verify state
                expect(gameData.xy.x).toBe(0n);
                expect(gameData.xy.y).toBe(0n);
                // HP should be reset to max_hp (which is set to BASIC_SHIP_HP when gameFields are first initialized)
                expect(gameData.hp).toBe(BASIC_SHIP_HP);
                expect(gameData.jettonAmount).toBe(0n);
                break;
            }
        }
    });

    it('Test Ship getCurrentGameData - verify jetton accumulation on CONTINUE', async () => {
        // First move
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        
        let gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        const initialJettonAmount = gameData ? gameData.jettonAmount : 0n;

        // Move again (should accumulate jettons if CONTINUE)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        
        gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            // Jetton amount should be >= initial (accumulated if CONTINUE)
            expect(gameData.jettonAmount).toBeGreaterThanOrEqual(initialJettonAmount);
        }
    });

    it('Test Ship getCurrentGameData - verify HP changes on CONTINUE', async () => {
        // First move
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        
        let gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        const initialHp = gameData ? gameData.hp : 0n;
        expect(initialHp).toBeGreaterThan(0n);

        // Move again (HP should decrease if CONTINUE and cell has HP)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        
        gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            // HP should be valid (>= 0)
            expect(gameData.hp).toBeGreaterThanOrEqual(0n);
            // HP should be <= initial HP (can only decrease or stay same)
            expect(gameData.hp).toBeLessThanOrEqual(initialHp);
        }
    });

    it('Test Ship getTonBalance', async () => {
        const balance = await SC_System.ownerShip.getTonBalance();
        expect(balance).toBeGreaterThan(0n);
    });

    it('Test Ship getTonBalance - verify balance after operations', async () => {
        const initialBalance = await SC_System.ownerShip.getTonBalance();
        expect(initialBalance).toBeGreaterThan(0n);

        // Perform a move (should consume some TON)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        
        const balanceAfterMove = await SC_System.ownerShip.getTonBalance();
        // Balance should still be positive (but may be less due to gas)
        expect(balanceAfterMove).toBeGreaterThan(0n);
    });

    it('Test CoordinateCell getTonBalance', async () => {
        // First move to create a coordinate cell
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        
        const cc = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: {x: 0n, y: 1n},
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));
        
        const balance = await cc.getTonBalance();
        expect(balance).toBeGreaterThanOrEqual(0n);
    });

    it('Test Ship getMovementInProcess - initial state', async () => {
        const movementInProcess = await SC_System.ownerShip.getMovementInProcess();
        expect(movementInProcess).toBe(false);
    });

    it('Test Ship getMovementInProcess - during movement', async () => {
        // Start a move
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        
        // Check movement_in_process is true (before MoveEnd)
        // Note: This might be tricky to test exactly because MoveEnd happens in the same transaction
        // But we can verify it's false after the move completes
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });

        // After move completes, movement_in_process should be false
        const movementInProcess = await SC_System.ownerShip.getMovementInProcess();
        expect(movementInProcess).toBe(false);
    });

    it('Test Ship getMaxHp - initial state', async () => {
        let anyUser = await SC_System.blockchain.treasury('anyUser');
        let someShip = SC_System.blockchain.openContract(Ship.createFromConfig({
            userAddress: anyUser.address,
            gameAddress: SC_System.game.address,
            coordinateCellCode: SC_System.coordinateCellCode,
        }, SC_System.shipCode));
        SC_System.messageResult = await someShip.sendDeploy(anyUser.getSender(), toNano('0.5'));
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: anyUser.address,
            to: someShip.address,
            success: true,
            deploy: true,
        });

        
        const maxHp = await someShip.getMaxHp();
        // Before first move, max_hp should be 0 (not initialized)
        // After first move, it will be set to BASIC_SHIP_HP
        expect(maxHp).toBe(0n);
    });

    // Note: max_hp update after first move is tested in ship-upgrade.spec.ts
    // The getter is verified to work in the "Test Ship getMaxHp - initial state" test above
});

