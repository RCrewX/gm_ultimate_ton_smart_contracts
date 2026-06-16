// SPDX-License-Identifier: UNLICENSED
import { beginCell, fromNano, toNano } from "@ton/core";
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { Opcodes as GameManagerOpcodes, GAS_COST_REDIRECT_MESSAGE, GAS_COST_SET_RETRANSLATOR } from '../../wrappers/game_manager/types';
import { ROpcodes } from '../../wrappers/game_manager/RetranslatorTypes';
import { Retranslator } from '../../wrappers/game_manager/Retranslator';
import { JettonMinter } from '../../wrappers/tep/jetton/JettonMinter';
import { JettonWallet } from '../../wrappers/tep/jetton/JettonWallet';
import { writeGasCosts } from '../../lib/buildOutput';

describe("Gas Prices - GameManager", () => {
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
        writeGasCosts('game-manager', gasCosts);
        Object.keys(gasCosts).forEach(key => delete gasCosts[key]);
    });

    it("SetRetranslator", async () => {
        const newR = await SC_System.blockchain.treasury('newRetranslator');
        let initial_balance = await SC_System.ownerAccount.getBalance();
        let gas_sent = GAS_COST_SET_RETRANSLATOR + toNano('0.05');

        SC_System.messageResult = await SC_System.gameManager.sendSetRetranslator(
            SC_System.ownerAccount.getSender(),
            gas_sent,
            newR.address,
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.gameManager.address,
            success: true,
            op: GameManagerOpcodes.OP_SET_RETRANSLATOR,
        });

        let cost = initial_balance - (await SC_System.ownerAccount.getBalance());
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['SetRetranslator'] = costStr;
        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(toNano('0.001'));
    });

    it("SetGamesInfo (relayed to R*)", async () => {
        let initial_balance = await SC_System.ownerAccount.getBalance();
        let gas_sent = toNano('1');

        SC_System.messageResult = await SC_System.gameManager.sendRedirectMessage(
            SC_System.ownerAccount.getSender(),
            gas_sent,
            SC_System.retranslator.address,
            // Named slots: ton_race_game is the active reward game (ssm/ubps unset).
            Retranslator.setGamesInfoMessage({
                active_game: SC_System.game.address,
                ssm: null,
                ton_race_game: SC_System.game.address,
                ubps: null,
            }),
            toNano('0.9'),
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.retranslator.address,
            success: true,
            op: ROpcodes.OP_SET_GAMES_INFO,
        });

        let cost = initial_balance - (await SC_System.ownerAccount.getBalance());
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['SetGamesInfo'] = costStr;
        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(toNano('0.001'));
    });

    it("RedirectMessage", async () => {
        const mintAmount = toNano('1000');
        const redirectMessage = JettonMinter.mintMessage(
            SC_System.jettonMinter.address,
            SC_System.ownerAccount.address,
            mintAmount,
            toNano('0.1'),
            toNano('0.2'),
        );

        let initial_balance = await SC_System.ownerAccount.getBalance();
        const forwardAmount = toNano('0.1');
        let gas_sent = GAS_COST_REDIRECT_MESSAGE + forwardAmount;

        SC_System.messageResult = await SC_System.gameManager.sendRedirectMessage(
            SC_System.ownerAccount.getSender(),
            gas_sent,
            SC_System.jettonMinter.address,
            redirectMessage,
            forwardAmount,
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.gameManager.address,
            success: true,
            op: GameManagerOpcodes.OP_REDIRECT_MESSAGE,
        });

        let cost = initial_balance - (await SC_System.ownerAccount.getBalance());
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['RedirectMessage'] = costStr;
        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(toNano('0.001'));
    });

    it("Transfer (JettonWallet) into the pipe", async () => {
        const userBalance = await SC_System.ownerJettonWallet.getJettonBalance();
        expect(userBalance).toBeGreaterThan(0n);

        let initial_balance = await SC_System.ownerAccount.getBalance();
        let little_less_than_gas_needed = toNano('0.1');
        let gas_sent = toNano('0.2');

        const transferAmount = toNano('100');
        const forwardPayload = beginCell()
            .storeAddress(SC_System.ownerShip.address)
            .endCell();

        SC_System.messageResult = await SC_System.ownerJettonWallet.sendTransfer(
            SC_System.ownerAccount.getSender(),
            gas_sent,
            transferAmount,
            SC_System.gameManager.address,
            SC_System.ownerAccount.address,
            beginCell().endCell(),
            toNano('0.1'),
            forwardPayload,
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.ownerJettonWallet.address,
            success: true,
        });

        let cost = initial_balance - (await SC_System.ownerAccount.getBalance());
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['Transfer'] = costStr;
        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(little_less_than_gas_needed);
    });

    it("SetAllowBurn (relayed to R*)", async () => {
        let initial_balance = await SC_System.ownerAccount.getBalance();
        let gas_sent = toNano('0.2');

        SC_System.messageResult = await SC_System.gameManager.sendRedirectMessage(
            SC_System.ownerAccount.getSender(),
            gas_sent,
            SC_System.retranslator.address,
            Retranslator.setAllowBurnMessage(true),
            toNano('0.1'),
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.retranslator.address,
            success: true,
            op: ROpcodes.OP_SET_ALLOW_BURN,
        });

        let cost = initial_balance - (await SC_System.ownerAccount.getBalance());
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['SetAllowBurn'] = costStr;
        expect(cost).toBeLessThanOrEqual(gas_sent);
        expect(cost).toBeGreaterThanOrEqual(toNano('0.001'));
    });

    it("RequestBurn (owner-initiated via R1)", async () => {
        // Enable burn on R* (via redirect).
        await SC_System.gameManager.sendRedirectMessage(
            SC_System.ownerAccount.getSender(),
            toNano('0.2'),
            SC_System.retranslator.address,
            Retranslator.setAllowBurnMessage(true),
            toNano('0.1'),
        );

        // Initialize GM's own jetton wallet by minting to it.
        const mintAmount = toNano('1000');
        const forwardAmount = toNano('0.1');
        const redirectMessage = JettonMinter.mintMessage(
            SC_System.jettonMinter.address,
            SC_System.gameManager.address,
            mintAmount,
            toNano('0.1'),
            toNano('0.2'),
        );
        await SC_System.gameManager.sendRedirectMessage(
            SC_System.ownerAccount.getSender(),
            GAS_COST_REDIRECT_MESSAGE + forwardAmount,
            SC_System.jettonMinter.address,
            redirectMessage,
            forwardAmount,
        );

        const gameManagerWalletAddress = await SC_System.jettonMinter.getWalletAddress(SC_System.gameManager.address);
        const gameManagerWallet = SC_System.blockchain.openContract(
            JettonWallet.createFromAddress(gameManagerWalletAddress),
        );
        expect(await gameManagerWallet.getJettonBalance()).toBeGreaterThanOrEqual(mintAmount);

        await SC_System.ownerAccount.send({
            to: gameManagerWalletAddress,
            value: toNano('0.3'),
            body: beginCell().endCell(),
        });

        const burnAmount = toNano('100');
        let initial_balance = await SC_System.ownerAccount.getBalance();
        let gas_sent = toNano('0.6');

        SC_System.messageResult = await SC_System.gameManager.sendRequestBurn(
            SC_System.ownerAccount.getSender(),
            gas_sent,
            burnAmount,
        );

        // GM accepts the R1 envelope.
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.gameManager.address,
            success: true,
            op: GameManagerOpcodes.OP_R1,
        });
        // AskToBurn (R4) reaches GM's jetton wallet.
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: gameManagerWalletAddress,
            success: true,
            op: ROpcodes.OP_ASK_TO_BURN,
        });

        let cost = initial_balance - (await SC_System.ownerAccount.getBalance());
        const costStr = fromNano(cost);
        console.log(`Cost: ${costStr}`);
        gasCosts['RequestBurn'] = costStr;
        expect(cost).toBeLessThanOrEqual(gas_sent + toNano('0.01'));
        expect(cost).toBeGreaterThanOrEqual(toNano('0.001'));
    });
});
