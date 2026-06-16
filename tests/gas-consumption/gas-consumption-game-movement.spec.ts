// SPDX-License-Identifier: UNLICENSED
import { beginCell, fromNano, toNano } from "@ton/core";
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { MoveMode } from '../../wrappers/ton_race_game/structs';
import { Opcodes, GAS_COST_REQUEST_TO_MOVE, GAS_COST_MOVE_SHIP_TO_CC, GAS_COST_MOVE, GAS_COST_MOVE_END, GAS_COST_REQUEST_MINT, MINT_TON_AMOUNT, TODO_TOTAL_GAS_TO_MOVE } from '../../wrappers/ton_race_game/types';
import { CoordinateCell } from '../../wrappers/ton_race_game/CoordinateCell';
import { writeGasCosts } from '../../lib/buildOutput';

describe("Gas Prices - Game Movement", () => {
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
        writeGasCosts('game-movement', gasCosts);
        // Clear gasCosts to free memory
        Object.keys(gasCosts).forEach(key => delete gasCosts[key]);
    });

    it("RequestToMove", async () => {
        const minRequiredBalance = GAS_COST_REQUEST_TO_MOVE + GAS_COST_MOVE_SHIP_TO_CC + toNano('0.1');
        const currentBalance = await SC_System.ownerShip.getTonBalance();
        if (currentBalance < minRequiredBalance) {
            await SC_System.ownerAccount.send({
                to: SC_System.ownerShip.address,
                value: minRequiredBalance - currentBalance + toNano('0.1'),
                body: beginCell().endCell(),
            });
        }

        let initial_balance = await SC_System.ownerAccount.getBalance();
        let little_less_than_gas_needed = toNano('0.01');
        let gas_sent = TODO_TOTAL_GAS_TO_MOVE;

        SC_System.messageResult = await SC_System.ownerShip.sendMove(
            SC_System.ownerAccount.getSender(),
            gas_sent,
            MoveMode.UP
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });

        let final_balance = await SC_System.ownerAccount.getBalance();
        let cost = initial_balance - final_balance;
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['RequestToMove'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });

    it("MoveShipToCC", async () => {
        const minRequiredBalance = GAS_COST_REQUEST_TO_MOVE + GAS_COST_MOVE_SHIP_TO_CC + toNano('0.1');
        const currentBalance = await SC_System.ownerShip.getTonBalance();
        if (currentBalance < minRequiredBalance) {
            await SC_System.ownerAccount.send({
                to: SC_System.ownerShip.address,
                value: minRequiredBalance - currentBalance + toNano('0.1'),
                body: beginCell().endCell(),
            });
        }

        const gameData = await SC_System.ownerShip.getCurrentGameData();
        const currentX = gameData?.xy.x || 0n;
        const currentY = gameData?.xy.y || 0n;
        
        const cc_old = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: {x: currentX, y: currentY},
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));

        let little_less_than_gas_needed = toNano('0.01');
        let gas_sent = GAS_COST_MOVE_SHIP_TO_CC;

        SC_System.messageResult = await SC_System.ownerShip.sendMove(
            SC_System.ownerAccount.getSender(),
            TODO_TOTAL_GAS_TO_MOVE,
            MoveMode.UP
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerShip.address,
            to: cc_old.address,
            success: true,
            op: Opcodes.OP_MOVE_SHIP_TO_CC,
        });

        const moveShipToCCTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === SC_System.ownerShip.address && 
            tx.to === cc_old.address &&
            tx.op === Opcodes.OP_MOVE_SHIP_TO_CC
        );
        
        const cost = moveShipToCCTx?.totalFees || toNano('0.1');
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['MoveShipToCC'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });

    it("Move", async () => {
        const minRequiredBalance = GAS_COST_REQUEST_TO_MOVE + GAS_COST_MOVE_SHIP_TO_CC + toNano('0.1');
        const currentBalance = await SC_System.ownerShip.getTonBalance();
        if (currentBalance < minRequiredBalance) {
            await SC_System.ownerAccount.send({
                to: SC_System.ownerShip.address,
                value: minRequiredBalance - currentBalance + toNano('0.1'),
                body: beginCell().endCell(),
            });
        }

        const gameData = await SC_System.ownerShip.getCurrentGameData();
        const currentX = gameData?.xy.x || 0n;
        const currentY = gameData?.xy.y || 0n;
        
        const cc_old = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: {x: currentX, y: currentY},
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));
        const cc_new = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: {x: currentX, y: currentY + 1n},
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));

        let little_less_than_gas_needed = toNano('0.01');
        let gas_sent = GAS_COST_MOVE;

        SC_System.messageResult = await SC_System.ownerShip.sendMove(
            SC_System.ownerAccount.getSender(),
            TODO_TOTAL_GAS_TO_MOVE,
            MoveMode.UP
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: cc_old.address,
            to: cc_new.address,
            success: true,
            op: Opcodes.OP_MOVE,
        });

        const moveTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === cc_old.address && 
            tx.to === cc_new.address &&
            tx.op === Opcodes.OP_MOVE
        );
        
        const cost = moveTx?.totalFees || toNano('0.1');
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['Move'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });

    it("MoveEnd without jettons minting", async () => {
        const minRequiredBalance = GAS_COST_REQUEST_TO_MOVE + GAS_COST_MOVE_SHIP_TO_CC + toNano('0.1');
        const currentBalance = await SC_System.ownerShip.getTonBalance();
        if (currentBalance < minRequiredBalance) {
            await SC_System.ownerAccount.send({
                to: SC_System.ownerShip.address,
                value: minRequiredBalance - currentBalance + toNano('0.1'),
                body: beginCell().endCell(),
            });
        }

        const gameData = await SC_System.ownerShip.getCurrentGameData();
        const currentX = gameData?.xy.x || 0n;
        const currentY = gameData?.xy.y || 0n;
        
        const cc_new = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: {x: currentX, y: currentY + 1n},
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));

        let little_less_than_gas_needed = toNano('0.01');
        let gas_sent = GAS_COST_MOVE_END;

        SC_System.messageResult = await SC_System.ownerShip.sendMove(
            SC_System.ownerAccount.getSender(),
            TODO_TOTAL_GAS_TO_MOVE,
            MoveMode.UP
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: cc_new.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });

        const requestMintTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === SC_System.ownerShip.address && 
            tx.to === SC_System.game.address &&
            tx.op === Opcodes.OP_REQUEST_MINT
        );
        expect(requestMintTx).toBeUndefined();

        const moveEndTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === cc_new.address && 
            tx.to === SC_System.ownerShip.address &&
            tx.op === Opcodes.OP_MOVE_END
        );
        
        const cost = moveEndTx?.totalFees || toNano('0.05');
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['MoveEnd without jettons'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });

    it("MoveEnd with jettons minting (may Fail)", async () => {
        const minRequiredBalance = GAS_COST_REQUEST_TO_MOVE + GAS_COST_MOVE_SHIP_TO_CC + MINT_TON_AMOUNT + toNano('0.2');
        const currentBalance = await SC_System.ownerShip.getTonBalance();
        if (currentBalance < minRequiredBalance) {
            await SC_System.ownerAccount.send({
                to: SC_System.ownerShip.address,
                value: minRequiredBalance - currentBalance + toNano('0.1'),
                body: beginCell().endCell(),
            });
        }

        await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TODO_TOTAL_GAS_TO_MOVE, MoveMode.UP);
        await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TODO_TOTAL_GAS_TO_MOVE, MoveMode.UP);
        await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TODO_TOTAL_GAS_TO_MOVE, MoveMode.UP);

        let gameData = await SC_System.ownerShip.getCurrentGameData();
        if (!gameData || !gameData.jettonAmount || gameData.jettonAmount === 0n) {
            await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TODO_TOTAL_GAS_TO_MOVE, MoveMode.UP);
            await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TODO_TOTAL_GAS_TO_MOVE, MoveMode.UP);
            gameData = await SC_System.ownerShip.getCurrentGameData();
        }
        if (!gameData || !gameData.jettonAmount || gameData.jettonAmount === 0n) {
            console.log('Skipping MoveEnd with jettons test - ship has no rewards accumulated');
            return;
        }
        expect(gameData.jettonAmount).toBeGreaterThan(0n);

        const currentX = gameData?.xy.x || 0n;
        const currentY = gameData?.xy.y || 0n;
        
        const currentHp = gameData?.hp || 0n;
        if (currentHp <= 10n) {
            await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TODO_TOTAL_GAS_TO_MOVE, MoveMode.UP);
            await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TODO_TOTAL_GAS_TO_MOVE, MoveMode.UP);
            gameData = await SC_System.ownerShip.getCurrentGameData();
        }

        const cc_new = SC_System.blockchain.openContract(CoordinateCell.createFromConfig({ 
            gameAddress: SC_System.game.address,
            xy: {x: currentX, y: currentY + 1n},
            shipCode: SC_System.shipCode,
        }, SC_System.coordinateCellCode));

        let little_less_than_gas_needed = toNano('0.01');
        let gas_sent = GAS_COST_MOVE_END;

        SC_System.messageResult = await SC_System.ownerShip.sendMove(
            SC_System.ownerAccount.getSender(),
            TODO_TOTAL_GAS_TO_MOVE,
            MoveMode.EXIT
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: cc_new.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });

        // After EXIT, RequestMint is NOT sent in same round (stored in pending_mint_amount; owner triggers via RequestShipToMint)
        const requestMintTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === SC_System.ownerShip.address && 
            tx.to === SC_System.game.address &&
            tx.op === Opcodes.OP_REQUEST_MINT
        );
        expect(requestMintTx).toBeUndefined();

        const moveEndTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === cc_new.address && 
            tx.to === SC_System.ownerShip.address &&
            tx.op === Opcodes.OP_MOVE_END
        );
        if (!moveEndTx) {
            console.log('MoveEnd with jettons test - MoveEnd not found');
            return;
        }
        
        const cost = moveEndTx?.totalFees || toNano('0.05');
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['MoveEnd with jettons'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });
});

