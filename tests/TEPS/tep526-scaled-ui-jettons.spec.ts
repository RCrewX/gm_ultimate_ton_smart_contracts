// SPDX-License-Identifier: UNLICENSED
import { toNano } from '@ton/core';
import '@ton/test-utils';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { JettonMinter } from '../../wrappers/tep/jetton/JettonMinter';
import { jettonContentToCell } from '../../wrappers/tep/jetton/JettonMinter';

describe('TEP-526 Scaled UI Jettons', () => {
    let SC_System: ContractSystem;
    let notOwnerAccount: SandboxContract<TreasuryContract>;
    beforeEach(async () => {
        SC_System = await initContractSystem();
        notOwnerAccount = await SC_System.blockchain.treasury('notOwner');
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
    });

    it('Test get_display_multiplier returns default 1:1 multiplier', async () => {
        const jettonContent = jettonContentToCell({ type: 1, uri: 'https://example.com/jetton.json' });
        const jettonMinter = SC_System.blockchain.openContract(JettonMinter.createFromConfig({
            admin: SC_System.ownerAccount.address,
            content: jettonContent,
            wallet_code: SC_System.jettonWalletCode,
            displayNumerator: 1n,
            displayDenominator: 1n,
        }, SC_System.jettonMinterCode));

        await jettonMinter.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        const multiplier = await jettonMinter.getDisplayMultiplier();
        expect(multiplier.numerator).toBe(1n);
        expect(multiplier.denominator).toBe(1n);
    });

    it('Test get_display_multiplier returns custom multiplier', async () => {
        const jettonContent = jettonContentToCell({ type: 1, uri: 'https://example.com/jetton.json' });
        const jettonMinter = SC_System.blockchain.openContract(JettonMinter.createFromConfig({
            admin: SC_System.ownerAccount.address,
            content: jettonContent,
            wallet_code: SC_System.jettonWalletCode,
            displayNumerator: 2n,
            displayDenominator: 3n,
        }, SC_System.jettonMinterCode));

        await jettonMinter.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        const multiplier = await jettonMinter.getDisplayMultiplier();
        expect(multiplier.numerator).toBe(2n);
        expect(multiplier.denominator).toBe(3n);
    });

    it('Test change_display_multiplier updates multiplier', async () => {
        const jettonContent = jettonContentToCell({ type: 1, uri: 'https://example.com/jetton.json' });
        const jettonMinter = SC_System.blockchain.openContract(JettonMinter.createFromConfig({
            admin: SC_System.ownerAccount.address,
            content: jettonContent,
            wallet_code: SC_System.jettonWalletCode,
            displayNumerator: 1n,
            displayDenominator: 1n,
        }, SC_System.jettonMinterCode));

        await jettonMinter.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Change multiplier to 5:2
        SC_System.messageResult = await jettonMinter.sendChangeDisplayMultiplier(
            SC_System.ownerAccount.getSender(),
            5n,
            2n,
            'Test comment'
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: jettonMinter.address,
            success: true,
        });

        const multiplier = await jettonMinter.getDisplayMultiplier();
        expect(multiplier.numerator).toBe(5n);
        expect(multiplier.denominator).toBe(2n);
    });

    it('Test change_display_multiplier rejects zero numerator', async () => {
        const jettonContent = jettonContentToCell({ type: 1, uri: 'https://example.com/jetton.json' });
        const jettonMinter = SC_System.blockchain.openContract(JettonMinter.createFromConfig({
            admin: SC_System.ownerAccount.address,
            content: jettonContent,
            wallet_code: SC_System.jettonWalletCode,
        }, SC_System.jettonMinterCode));

        await jettonMinter.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Try to change multiplier with zero numerator - should fail in wrapper
        await expect(
            jettonMinter.sendChangeDisplayMultiplier(
                SC_System.ownerAccount.getSender(),
                0n,
                1n
            )
        ).rejects.toThrow();
    });

    it('Test change_display_multiplier rejects zero denominator', async () => {
        const jettonContent = jettonContentToCell({ type: 1, uri: 'https://example.com/jetton.json' });
        const jettonMinter = SC_System.blockchain.openContract(JettonMinter.createFromConfig({
            admin: SC_System.ownerAccount.address,
            content: jettonContent,
            wallet_code: SC_System.jettonWalletCode,
        }, SC_System.jettonMinterCode));

        await jettonMinter.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Try to change multiplier with zero denominator - should fail in wrapper
        await expect(
            jettonMinter.sendChangeDisplayMultiplier(
                SC_System.ownerAccount.getSender(),
                1n,
                0n
            )
        ).rejects.toThrow();
    });

    it('Test change_display_multiplier only allowed by admin', async () => {
        const jettonContent = jettonContentToCell({ type: 1, uri: 'https://example.com/jetton.json' });
        const jettonMinter = SC_System.blockchain.openContract(JettonMinter.createFromConfig({
            admin: SC_System.ownerAccount.address,
            content: jettonContent,
            wallet_code: SC_System.jettonWalletCode,
        }, SC_System.jettonMinterCode));

        await jettonMinter.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Try to change multiplier from non-admin account - should fail
        SC_System.messageResult = await jettonMinter.sendChangeDisplayMultiplier(
            notOwnerAccount.getSender(),
            2n,
            3n
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: notOwnerAccount.address,
            to: jettonMinter.address,
            success: false,
        });
    });
});

