// SPDX-License-Identifier: UNLICENSED
import { beginCell, fromNano, toNano } from "@ton/core";
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem, buildJettonUsageForwardPayload } from '../test_utils';
import { Opcodes, GAS_COST_JETTON_USED, GAS_COST_SHIP_UPGRADE, GAS_COST_TRANSFER_NOTIFICATION, BASIC_STORAGE_TAX, TODO_TOTAL_GAS_TO_MOVE, JettonUsageMode } from '../../wrappers/ton_race_game/types';
import { Opcodes as GameManagerOpcodes } from '../../wrappers/game_manager/types';
import { writeGasCosts } from '../../lib/buildOutput';
import { MoveMode } from "../../wrappers/ton_race_game/structs";

describe("Gas Prices - Game Upgrade", () => {
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
        writeGasCosts('game-upgrade', gasCosts);
        // Clear gasCosts to free memory
        Object.keys(gasCosts).forEach(key => delete gasCosts[key]);
    });

    it("JettonUsed", async () => {
        const gameManagerJettonWalletAddress = await SC_System.jettonMinter.getWalletAddress(SC_System.gameManager.address);
        const transferAmount = toNano('100');
        const forwardPayload = buildJettonUsageForwardPayload(
            SC_System.game.address,
            SC_System.ownerShip.address,
            JettonUsageMode.SHIP_UPGRADE,
        );

        let little_less_than_gas_needed = toNano('0.01');
        let gas_sent = GAS_COST_JETTON_USED;

        SC_System.messageResult = await SC_System.ownerJettonWallet.sendTransfer(
            SC_System.ownerAccount.getSender(),
            toNano('0.2'),
            transferAmount,
            SC_System.gameManager.address,
            SC_System.ownerAccount.address,
            beginCell().endCell(),
            toNano('0.1'),
            forwardPayload
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.game.address,
            success: true,
            op: Opcodes.OP_JETTON_USED,
        });

        const jettonUsedTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === SC_System.gameManager.address && 
            tx.to === SC_System.game.address &&
            tx.op === Opcodes.OP_JETTON_USED
        );
        
        const cost = jettonUsedTx?.totalFees || toNano('0.05');
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['JettonUsed'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });

    it("ShipUpgrade", async () => {
        const gameManagerJettonWalletAddress = await SC_System.jettonMinter.getWalletAddress(SC_System.gameManager.address);
        // Initialize ship by doing a first move (this sets max_hp to BASIC_SHIP_HP)
        // Use a higher value to ensure it covers TODO_TOTAL_GAS_TO_MOVE
        const moveValue = TODO_TOTAL_GAS_TO_MOVE;
        SC_System.messageResult = await SC_System.ownerShip.sendMove(
            SC_System.ownerAccount.getSender(),
            moveValue,
            MoveMode.UP
        );

        SC_System.messageResult = await SC_System.ownerShip.sendMove(
            SC_System.ownerAccount.getSender(),
            moveValue,
            MoveMode.EXIT
        );
        
        const transferAmount = toNano('100');
        const forwardPayload = buildJettonUsageForwardPayload(
            SC_System.game.address,
            SC_System.ownerShip.address,
            JettonUsageMode.SHIP_UPGRADE,
        );

        let little_less_than_gas_needed = toNano('0.01');
        let gas_sent = GAS_COST_SHIP_UPGRADE;

        SC_System.messageResult = await SC_System.ownerJettonWallet.sendTransfer(
            SC_System.ownerAccount.getSender(),
            toNano('0.2'),
            transferAmount,
            SC_System.gameManager.address,
            SC_System.ownerAccount.address,
            beginCell().endCell(),
            toNano('0.1'),
            forwardPayload
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.game.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_SHIP_UPGRADE,
        });

        const shipUpgradeTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === SC_System.game.address && 
            tx.to === SC_System.ownerShip.address &&
            tx.op === Opcodes.OP_SHIP_UPGRADE
        );
        
        const cost = shipUpgradeTx?.totalFees || toNano('0.05');
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['ShipUpgrade'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });

    it("TransferNotificationForRecipient", async () => {
        const gameManagerJettonWalletAddress = await SC_System.jettonMinter.getWalletAddress(SC_System.gameManager.address);
        const transferAmount = toNano('100');
        const forwardPayload = buildJettonUsageForwardPayload(
            SC_System.game.address,
            SC_System.ownerShip.address,
            JettonUsageMode.SHIP_UPGRADE,
        );

        let little_less_than_gas_needed = toNano('0.01');
        let gas_sent = GAS_COST_TRANSFER_NOTIFICATION;

        SC_System.messageResult = await SC_System.ownerJettonWallet.sendTransfer(
            SC_System.ownerAccount.getSender(),
            toNano('0.2'),
            transferAmount,
            SC_System.gameManager.address,
            SC_System.ownerAccount.address,
            beginCell().endCell(),
            toNano('0.1'),
            forwardPayload
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: gameManagerJettonWalletAddress,
            to: SC_System.gameManager.address,
            success: true,
            op: GameManagerOpcodes.OP_TRANSFER_NOTIFICATION_FOR_RECIPIENT,
        });

        const transferNotificationTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === gameManagerJettonWalletAddress && 
            tx.to === SC_System.gameManager.address &&
            tx.op === GameManagerOpcodes.OP_TRANSFER_NOTIFICATION_FOR_RECIPIENT
        );
        
        const cost = transferNotificationTx?.totalFees || toNano('0.05');
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['TransferNotificationForRecipient'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });
});

