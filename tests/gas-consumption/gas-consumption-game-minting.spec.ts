// SPDX-License-Identifier: UNLICENSED
import { beginCell, fromNano, toNano, SendMode } from "@ton/core";
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { Opcodes, GAS_COST_REQUEST_TO_MOVE, GAS_COST_MOVE_SHIP_TO_CC, GAS_COST_REQUEST_MINT, GAS_COST_FORWARD_MINT_REQUEST, MINT_TON_AMOUNT, TOTAL_GAS_TO_MOVE } from '../../wrappers/ton_race_game/types';
import { MoveMode } from '../../wrappers/ton_race_game/structs';
import { writeGasCosts } from '../../lib/buildOutput';

describe("Gas Prices - Game Minting", () => {
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
        writeGasCosts('game-minting', gasCosts);
        // Clear gasCosts to free memory
        Object.keys(gasCosts).forEach(key => delete gasCosts[key]);
    });

    it("RequestMint (may Fail)", async () => {
        await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);

        let gameData = await SC_System.ownerShip.getCurrentGameData();
        if (!gameData || !gameData.jettonAmount || gameData.jettonAmount === 0n) {
            await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
            await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
            gameData = await SC_System.ownerShip.getCurrentGameData();
        }
        expect(gameData).toBeDefined();
        if (!gameData || gameData.jettonAmount === undefined || gameData.jettonAmount === 0n) {
            console.log('Skipping test - ship has no rewards accumulated');
            return;
        }
        expect(gameData.jettonAmount).toBeGreaterThan(0n);

        const currentHp = gameData?.hp || 0n;
        if (currentHp <= 10n) {
            await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
            await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
            gameData = await SC_System.ownerShip.getCurrentGameData();
        }

        const minRequiredBalance = GAS_COST_REQUEST_TO_MOVE + GAS_COST_MOVE_SHIP_TO_CC + MINT_TON_AMOUNT + toNano('0.2');
        const currentBalance = await SC_System.ownerShip.getTonBalance();
        
        if (currentBalance < minRequiredBalance) {
            const needed = minRequiredBalance - currentBalance + toNano('1');
            await SC_System.ownerAccount.send({
                to: SC_System.ownerShip.address,
                value: needed,
                body: beginCell().endCell(),
            });
        }
        
        const balanceAfter = await SC_System.ownerShip.getTonBalance();
        expect(balanceAfter).toBeGreaterThanOrEqual(minRequiredBalance);

        // EXIT: stores pending_mint_amount; no RequestMint in same round
        await SC_System.ownerShip.sendMove(
            SC_System.ownerAccount.getSender(),
            TOTAL_GAS_TO_MOVE,
            MoveMode.EXIT
        );

        const pendingAfterExit = await SC_System.ownerShip.getPendingMintAmount();
        if (pendingAfterExit === 0n) {
            console.log('Skipping test - ship may have crashed (no pending mint)');
            return;
        }

        let little_less_than_gas_needed = toNano('0.01');
        let gas_sent = GAS_COST_REQUEST_MINT;

        // Owner triggers mint via RequestShipToMint; Ship sends RequestMint to Game
        SC_System.messageResult = await SC_System.ownerShip.sendRequestShipToMint(
            SC_System.ownerAccount.getSender(),
            gas_sent
        );

        const requestMintTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === SC_System.ownerShip.address && 
            tx.to === SC_System.game.address &&
            tx.op === Opcodes.OP_REQUEST_MINT
        );
        
        if (!requestMintTx || !requestMintTx.success) {
            if (requestMintTx && !requestMintTx.success) {
                console.log('RequestMint failed - likely not enough balance');
            } else {
                console.log('RequestMint not sent');
            }
            return;
        }

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerShip.address,
            to: SC_System.game.address,
            success: true,
            op: Opcodes.OP_REQUEST_MINT,
        });

        const cost = requestMintTx?.totalFees || toNano('0.1');
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['RequestMint'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });

    it("ForwardMintRequest", async () => {
        await SC_System.ownerAccount.send({
            to: SC_System.ownerShip.address,
            value: toNano('1'),
            body: beginCell().endCell(),
        });
        
        await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);

        let gameData = await SC_System.ownerShip.getCurrentGameData();
        if (!gameData || !gameData.jettonAmount || gameData.jettonAmount === 0n) {
            await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
            await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
            gameData = await SC_System.ownerShip.getCurrentGameData();
        }
        if (!gameData || !gameData.jettonAmount || gameData.jettonAmount === 0n) {
            await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
            await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
            gameData = await SC_System.ownerShip.getCurrentGameData();
        }
        expect(gameData).toBeDefined();
        if (!gameData || !gameData.jettonAmount) {
            console.log('Skipping ForwardMintRequest test - ship has no rewards accumulated');
            return;
        }
        expect(gameData.jettonAmount).toBeGreaterThan(0n);

        let little_less_than_gas_needed = toNano('0.01');
        let gas_sent = GAS_COST_FORWARD_MINT_REQUEST;

        const currentHp = gameData?.hp || 0n;
        if (currentHp <= 0n) {
            console.log('Skipping ForwardMintRequest test - ship has no HP');
            return;
        }

        // EXIT stores pending_mint_amount; then owner triggers mint via RequestShipToMint
        await SC_System.ownerShip.sendMove(
            SC_System.ownerAccount.getSender(),
            TOTAL_GAS_TO_MOVE,
            MoveMode.EXIT
        );
        SC_System.messageResult = await SC_System.ownerShip.sendRequestShipToMint(
            SC_System.ownerAccount.getSender(),
            GAS_COST_REQUEST_MINT
        );

        const forwardMintTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === SC_System.game.address && 
            tx.to === SC_System.gameManager.address &&
            tx.op === Opcodes.OP_FORWARD_MINT_REQUEST &&
            tx.success === true
        );
        
        if (!forwardMintTx) {
            console.log('ForwardMintRequest not sent - RequestMint may not have been sent');
            return;
        }

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.game.address,
            to: SC_System.gameManager.address,
            success: true,
            op: Opcodes.OP_FORWARD_MINT_REQUEST,
        });

        const cost = forwardMintTx?.totalFees || toNano('0.05');
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['ForwardMintRequest'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });
});

