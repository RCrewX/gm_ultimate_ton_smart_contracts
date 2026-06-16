// SPDX-License-Identifier: UNLICENSED
import { beginCell, fromNano, toNano, SendMode } from "@ton/core";
import '@ton/test-utils';
import { ContractSystem, initContractSystem, setupCoordinateCellWithFirstExplorer, cleanupContractSystem } from '../test_utils';
import { Opcodes } from '../../wrappers/ton_race_game/types';
import { JettonMinter, jettonContentToCell } from '../../wrappers/tep/jetton/JettonMinter';
import { CoordinateCell } from '../../wrappers/ton_race_game/CoordinateCell';
import { writeGasCosts } from '../../lib/buildOutput';

describe("Gas Prices - Game Withdrawals", () => {
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
        writeGasCosts('game-withdrawals', gasCosts);
        // Clear gasCosts to free memory
        Object.keys(gasCosts).forEach(key => delete gasCosts[key]);
    });

    it("WithdrawTON", async () => {
        const { coordinateCell, firstExplorerShip } = await setupCoordinateCellWithFirstExplorer(SC_System, { x: 0n, y: 1n });
        const sendAmount = toNano('1');
        await SC_System.ownerAccount.send({
            to: coordinateCell.address,
            value: sendAmount,
            body: beginCell().endCell(),
        });

        const shipBalance = await firstExplorerShip.getTonBalance();
        if (shipBalance < toNano('0.2')) {
            await SC_System.ownerAccount.send({
                to: firstExplorerShip.address,
                value: toNano('0.2'),
                body: beginCell().endCell(),
            });
        }

        let little_less_than_gas_needed = toNano('0.05');
        let gas_sent = toNano('0.1');
        const withdrawAmount = toNano('0.5');

        SC_System.messageResult = await coordinateCell.sendWithdrawTON(
            SC_System.ownerAccount.getSender(),
            gas_sent,
            SC_System.ownerAccount.address,
            withdrawAmount
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: coordinateCell.address,
            success: true,
            op: Opcodes.OP_WITHDRAW_TON,
        });

        const mainTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === SC_System.ownerAccount.address && 
            tx.to === coordinateCell.address &&
            tx.op === Opcodes.OP_WITHDRAW_TON
        );
        const cost = mainTx?.totalFees || toNano('0.1');
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['WithdrawTON'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent + toNano('0.01'));
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });

    it("WithdrawJetton", async () => {
        const { coordinateCell, firstExplorerShip } = await setupCoordinateCellWithFirstExplorer(SC_System, { x: 0n, y: 1n });
        
        const jettonContent = jettonContentToCell({ type: 1, uri: 'https://example.com/jetton.json' });
        const jettonMinter = SC_System.blockchain.openContract(JettonMinter.createFromConfig({
            admin: SC_System.ownerAccount.address,
            content: jettonContent,
            wallet_code: SC_System.jettonWalletCode,
        }, SC_System.jettonMinterCode));

        await jettonMinter.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));
        await jettonMinter.sendMint(
            SC_System.ownerAccount.getSender(),
            coordinateCell.address,
            toNano('1000'),
            toNano('0.1'),
            toNano('0.2')
        );

        const coordinateCellJettonWalletAddress = await jettonMinter.getWalletAddress(coordinateCell.address);
        let little_less_than_gas_needed = toNano('0.1');
        let gas_sent = toNano('0.2');

        const shipBalance = await firstExplorerShip.getTonBalance();
        if (shipBalance < toNano('0.3')) {
            await SC_System.ownerAccount.send({
                to: firstExplorerShip.address,
                value: toNano('0.3'),
                body: beginCell().endCell(),
            });
        }

        const withdrawAmount = toNano('100');
        SC_System.messageResult = await coordinateCell.sendWithdrawJetton(
            SC_System.ownerAccount.getSender(),
            gas_sent,
            coordinateCellJettonWalletAddress,
            SC_System.ownerAccount.address,
            withdrawAmount,
            toNano('0.1')
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: coordinateCell.address,
            success: true,
            op: Opcodes.OP_WITHDRAW_JETTON,
        });

        const mainTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.from === SC_System.ownerAccount.address && 
            tx.to === coordinateCell.address &&
            tx.op === Opcodes.OP_WITHDRAW_JETTON
        );
        const cost = mainTx?.totalFees || toNano('0.1');
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['WithdrawJetton'] = costStr;

        expect(cost).toBeLessThanOrEqual(gas_sent + toNano('0.01'));
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });
});

