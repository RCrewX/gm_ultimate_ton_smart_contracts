// SPDX-License-Identifier: UNLICENSED
import { beginCell, toNano } from '@ton/core';
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { GAS_COST_REDIRECT_MESSAGE } from '../../wrappers/game_manager/types';

describe('GameManager', () => {
    let SC_System: ContractSystem;
    beforeEach(async () => {
        SC_System = await initContractSystem();
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
    });

    it('Test GameManager message redirection - owner can redirect messages to any address', async () => {
        const recipient = await SC_System.blockchain.treasury('redirectRecipient');
        const testMessage = beginCell()
            .storeUint(0x12345678, 32)
            .storeUint(42, 64)
            .endCell();

        const forwardAmount = toNano('0.05');
        // Need to send gas cost + forward amount for redirect message
        SC_System.messageResult = await SC_System.gameManager.sendRedirectMessage(
            SC_System.ownerAccount.getSender(),
            GAS_COST_REDIRECT_MESSAGE + forwardAmount,
            recipient.address,
            testMessage,
            forwardAmount
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.gameManager.address,
            success: true,
        });

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: recipient.address,
            success: true,
        });
    });
});

