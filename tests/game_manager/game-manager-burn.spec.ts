// SPDX-License-Identifier: UNLICENSED
import { beginCell, toNano } from '@ton/core';
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { GAS_COST_REDIRECT_MESSAGE } from '../../wrappers/game_manager/types';
import { ROpcodes } from '../../wrappers/game_manager/RetranslatorTypes';
import { Retranslator } from '../../wrappers/game_manager/Retranslator';
import { JettonWallet } from '../../wrappers/tep/jetton/JettonWallet';
import { JettonMinter } from '../../wrappers/tep/jetton/JettonMinter';

// New architecture notes:
//  - allow_burn lives on the Retranslator (R*), not GM. It is configured through
//    GM.RedirectMessage (owner -> GM -> R*).
//  - A burn is requested as R1{RequestBurn} to GM. GM forwards as R2 to R*, which
//    requires the ORIGINAL initiator to be the owner AND allow_burn == true, then
//    replies R3 so GM emits AskToBurn (R4) to GM's own jetton wallet.
describe('GameManager Burn Functionality (via Retranslator)', () => {
    let SC_System: ContractSystem;
    beforeEach(async () => {
        SC_System = await initContractSystem();
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
    });

    // Relay a SetAllowBurn to R* through GM (owner-gated redirect).
    async function setAllowBurn(allow_burn: boolean, sender = SC_System.ownerAccount) {
        return SC_System.gameManager.sendRedirectMessage(
            sender.getSender(),
            toNano('0.2'),
            SC_System.retranslator.address,
            Retranslator.setAllowBurnMessage(allow_burn),
            toNano('0.1'),
        );
    }

    // Mint jettons to GM's own wallet and fund it for the burn.
    async function mintToGameManagerWallet() {
        const mintAmount = toNano('1000');
        const forwardAmount = toNano('0.1');
        const redirectMessage = JettonMinter.mintMessage(
            SC_System.jettonMinter.address,
            SC_System.gameManager.address,
            mintAmount,
            toNano('0.1'),
            toNano('0.2'),
        );
        const mintResult = await SC_System.gameManager.sendRedirectMessage(
            SC_System.ownerAccount.getSender(),
            GAS_COST_REDIRECT_MESSAGE + forwardAmount,
            SC_System.jettonMinter.address,
            redirectMessage,
            forwardAmount,
        );
        expect(mintResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.jettonMinter.address,
            success: true,
        });
        const gmWalletAddress = await SC_System.jettonMinter.getWalletAddress(SC_System.gameManager.address);
        await SC_System.ownerAccount.send({
            to: gmWalletAddress,
            value: toNano('0.3'),
            body: beginCell().endCell(),
        });
        return gmWalletAddress;
    }

    it('allow_burn defaults to false on the Retranslator', async () => {
        expect(await SC_System.retranslator.getAllowBurn()).toBe(false);
    });

    it('only owner can configure allow_burn (redirect is owner-gated)', async () => {
        const nonOwner = await SC_System.blockchain.treasury('nonOwner');
        SC_System.messageResult = await setAllowBurn(true, nonOwner);
        // GM rejects the redirect from a non-owner.
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: nonOwner.address,
            to: SC_System.gameManager.address,
            success: false,
            exitCode: 920, // ERR_INVALID_OWNER_SENDER
        });
        expect(await SC_System.retranslator.getAllowBurn()).toBe(false);
    });

    it('owner can enable and disable allow_burn', async () => {
        await setAllowBurn(true);
        expect(await SC_System.retranslator.getAllowBurn()).toBe(true);
        await setAllowBurn(false);
        expect(await SC_System.retranslator.getAllowBurn()).toBe(false);
    });

    it('RequestBurn by owner fails when allow_burn is false (R* rejects)', async () => {
        const burnAmount = toNano('100');
        SC_System.messageResult = await SC_System.gameManager.sendRequestBurn(
            SC_System.ownerAccount.getSender(),
            toNano('0.3'),
            burnAmount,
        );
        // GM forwards (R1 -> R2); R* rejects because burn is disabled.
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.retranslator.address,
            success: false,
            exitCode: 927, // ERR_BURN_NOT_ALLOWED
        });
    });

    it('RequestBurn by non-owner is rejected by R* even when burn is enabled', async () => {
        await setAllowBurn(true);
        const anyUser = await SC_System.blockchain.treasury('anyUser');
        const burnAmount = toNano('100');
        SC_System.messageResult = await SC_System.gameManager.sendRequestBurn(
            anyUser.getSender(),
            toNano('0.3'),
            burnAmount,
        );
        // R* gates on the attested initiator: only the owner may burn.
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.retranslator.address,
            success: false,
            exitCode: 920, // ERR_INVALID_OWNER_SENDER
        });
    });

    it('RequestBurn by owner succeeds and emits AskToBurn to GM jetton wallet', async () => {
        await setAllowBurn(true);
        const gmWalletAddress = await mintToGameManagerWallet();

        const burnAmount = toNano('100');
        SC_System.messageResult = await SC_System.gameManager.sendRequestBurn(
            SC_System.ownerAccount.getSender(),
            toNano('0.6'),
            burnAmount,
        );

        // R1 -> R2 -> (logic) -> R3 -> R4(AskToBurn) -> GM jetton wallet.
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.retranslator.address,
            to: SC_System.gameManager.address,
            success: true,
            op: 0x52330003, // R3
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: gmWalletAddress,
            success: true,
            body: (body) => {
                if (!body) return false;
                const slice = body.beginParse();
                return slice.loadUint(32) === ROpcodes.OP_ASK_TO_BURN;
            },
        });
    });

    it('RequestBurn carries customPayload and sendExcessesTo into AskToBurn', async () => {
        await setAllowBurn(true);
        const gmWalletAddress = await mintToGameManagerWallet();

        const excessesRecipient = await SC_System.blockchain.treasury('excessesRecipient');
        const burnAmount = toNano('100');
        const customPayload = beginCell().storeUint(0x12345678, 32).endCell();

        SC_System.messageResult = await SC_System.gameManager.sendRequestBurn(
            SC_System.ownerAccount.getSender(),
            toNano('0.6'),
            burnAmount,
            excessesRecipient.address,
            customPayload,
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: gmWalletAddress,
            success: true,
            body: (body) => {
                if (!body) return false;
                const slice = body.beginParse();
                if (slice.loadUint(32) !== ROpcodes.OP_ASK_TO_BURN) return false;
                slice.loadUint(64); // queryId
                const jettonAmount = slice.loadCoins();
                const sendExcessesTo = slice.loadAddress();
                const hasCustomPayload = slice.loadBit();
                if (!hasCustomPayload) return false;
                slice.loadRef();
                return jettonAmount === burnAmount && sendExcessesTo.equals(excessesRecipient.address);
            },
        });
    });
});
