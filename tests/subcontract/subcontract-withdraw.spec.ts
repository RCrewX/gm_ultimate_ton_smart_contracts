// SPDX-License-Identifier: UNLICENSED
import { toNano } from '@ton/core';
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { Subcontract } from '../../wrappers/subcontract/Subcontract';
import { BASIC_STORAGE_TAX } from '../../wrappers/ton_race_game/types';

describe('Subcontract - Withdraw Operations', () => {
    let SC_System: ContractSystem;
    beforeEach(async () => {
        SC_System = await initContractSystem();
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
    });

    it('Test Subcontract withdraw - owner can withdraw all funds leaving BASIC_STORAGE_TAX', async () => {
        const subcontractId = 7n;
        
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Fund the subcontract with some TON
        const fundAmount = toNano('2');
        await SC_System.ownerAccount.send({
            to: subcontract.address,
            value: fundAmount,
        });

        // Get initial owner balance
        const initialOwnerBalance = await SC_System.ownerAccount.getBalance();

        // Calculate withdrawable amount
        // The contract calculates: balanceBeforeMsg = getOriginalBalance() - in.valueCoins
        // maxWithdrawable = balanceBeforeMsg - BASIC_STORAGE_TAX
        // So we need to account for the incoming message value (0.01 TON) when calculating
        const contract = await SC_System.blockchain.getContract(subcontract.address);
        const balanceBefore = contract.balance;
        const messageValue = toNano('0.01'); // Value sent with withdraw message
        // Contract sees: balanceBeforeMsg = balanceBefore - messageValue
        // maxWithdrawable = (balanceBefore - messageValue) - BASIC_STORAGE_TAX
        const withdrawAmount = balanceBefore - messageValue - BASIC_STORAGE_TAX;
        
        // Withdraw funds
        SC_System.messageResult = await subcontract.sendWithdraw(
            SC_System.ownerAccount.getSender(),
            withdrawAmount,
            SC_System.ownerAccount.address,
            messageValue
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: true,
        });

        // Verify funds were sent to owner
        // The contract had initial deployment funds (0.5 TON) plus the fundAmount (2 TON)
        // But some was spent on gas fees, so actual withdrawable is less
        const withdrawTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.inMessage?.info.src?.equals(subcontract.address) === true &&
            tx.inMessage?.info.dest?.equals(SC_System.ownerAccount.address) === true
        );
        expect(withdrawTx).toBeDefined();
        if (withdrawTx?.inMessage?.info.value) {
            const withdrawnAmount = withdrawTx.inMessage.info.value.coins;
            // Should be approximately (deployment + fundAmount) - gas fees - BASIC_STORAGE_TAX
            // Deployment was 0.5 TON, fundAmount is 2 TON, but gas fees reduce available balance
            // After gas fees and BASIC_STORAGE_TAX, should be around 1.9-2.0 TON
            expect(withdrawnAmount).toBeGreaterThan(toNano('1.8'));
            expect(withdrawnAmount).toBeLessThan(toNano('2.5'));
        }

        // Verify owner balance increased
        const finalOwnerBalance = await SC_System.ownerAccount.getBalance();
        expect(finalOwnerBalance).toBeGreaterThan(initialOwnerBalance);
    });

    it('Test Subcontract withdraw - unauthorized user cannot withdraw', async () => {
        const subcontractId = 8n;
        
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Fund the subcontract
        await SC_System.ownerAccount.send({
            to: subcontract.address,
            value: toNano('1'),
        });

        // Create unauthorized sender
        const unauthorizedAccount = await SC_System.blockchain.treasury('unauthorized');
        
        // Try to withdraw as unauthorized user - should fail
        SC_System.messageResult = await subcontract.sendWithdraw(
            unauthorizedAccount.getSender(),
            toNano('0.5'),
            unauthorizedAccount.address,
            toNano('0.01')
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: unauthorizedAccount.address,
            to: subcontract.address,
            success: false,
            exitCode: 926, // ERR_INVALID_OWNER_SENDER
        });
    });

    it('Test Subcontract withdraw - amount validation', async () => {
        const subcontractId = 203n;
        
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Fund the subcontract
        await SC_System.ownerAccount.send({
            to: subcontract.address,
            value: toNano('1'),
        });

        // Try to withdraw amount less than BASIC_STORAGE_TAX - should fail
        SC_System.messageResult = await subcontract.sendWithdraw(
            SC_System.ownerAccount.getSender(),
            toNano('0.005'), // Less than BASIC_STORAGE_TAX
            SC_System.ownerAccount.address,
            toNano('0.01')
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: false,
            exitCode: 927, // ERR_WITHDRAW_AMOUNT_TOO_LOW
        });

        // Try to withdraw amount more than available - should fail
        const contract = await SC_System.blockchain.getContract(subcontract.address);
        const balance = contract.balance;
        const maxWithdrawable = balance - toNano('0.01'); // Leave BASIC_STORAGE_TAX
        
        SC_System.messageResult = await subcontract.sendWithdraw(
            SC_System.ownerAccount.getSender(),
            maxWithdrawable + toNano('0.1'), // More than available
            SC_System.ownerAccount.address,
            toNano('0.01')
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: false,
            exitCode: 928, // ERR_WITHDRAW_AMOUNT_TOO_HIGH
        });
    });

    it('Test Subcontract withdraw - successful withdrawal with specified amount', async () => {
        const subcontractId = 204n;
        
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Fund the subcontract
        await SC_System.ownerAccount.send({
            to: subcontract.address,
            value: toNano('2'),
        });

        const initialOwnerBalance = await SC_System.ownerAccount.getBalance();
        
        // Withdraw specific amount (0.5 TON)
        const withdrawAmount = toNano('0.5');
        SC_System.messageResult = await subcontract.sendWithdraw(
            SC_System.ownerAccount.getSender(),
            withdrawAmount,
            SC_System.ownerAccount.address,
            toNano('0.01')
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: true,
        });

        // Verify the amount was withdrawn
        const withdrawTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.inMessage?.info.src?.equals(subcontract.address) === true &&
            tx.inMessage?.info.dest?.equals(SC_System.ownerAccount.address) === true
        );
        expect(withdrawTx).toBeDefined();
        if (withdrawTx?.inMessage?.info.value) {
            const withdrawnAmount = withdrawTx.inMessage.info.value.coins;
            // Should be at least the requested amount (contract sends msg.amount exactly)
            // May be slightly more due to how balance is calculated, but should be close
            expect(withdrawnAmount).toBeGreaterThanOrEqual(withdrawAmount);
            expect(withdrawnAmount).toBeLessThanOrEqual(withdrawAmount + toNano('0.01')); // Allow small variance
        }
    });

    it('Test Subcontract withdraw - can withdraw to different receiver address', async () => {
        const subcontractId = 205n;
        
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Fund the subcontract
        await SC_System.ownerAccount.send({
            to: subcontract.address,
            value: toNano('2'),
        });

        // Create a different receiver
        const receiver = await SC_System.blockchain.treasury('receiver');
        const initialReceiverBalance = await receiver.getBalance();

        // Withdraw to receiver (not owner)
        const withdrawAmount = toNano('0.5');
        SC_System.messageResult = await subcontract.sendWithdraw(
            SC_System.ownerAccount.getSender(),
            withdrawAmount,
            receiver.address,
            toNano('0.01')
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: true,
        });

        // Verify funds were sent to receiver (not owner)
        const withdrawTx = SC_System.messageResult.transactions.find((tx: any) => 
            tx.inMessage?.info.src?.equals(subcontract.address) === true &&
            tx.inMessage?.info.dest?.equals(receiver.address) === true
        );
        expect(withdrawTx).toBeDefined();
        if (withdrawTx?.inMessage?.info.value) {
            const withdrawnAmount = withdrawTx.inMessage.info.value.coins;
            expect(withdrawnAmount).toBeGreaterThanOrEqual(withdrawAmount);
        }

        // Verify receiver balance increased
        const finalReceiverBalance = await receiver.getBalance();
        expect(finalReceiverBalance).toBeGreaterThan(initialReceiverBalance);
    });
});

