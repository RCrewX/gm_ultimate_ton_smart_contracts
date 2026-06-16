// SPDX-License-Identifier: UNLICENSED
import { beginCell, toNano, SendMode } from '@ton/core';
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { Subcontract } from '../../wrappers/subcontract/Subcontract';
import { GAS_COST_FORWARD, GAS_COST_MANUAL_DEPLOY } from '../../wrappers/subcontract/types';
import { Ship } from '../../wrappers/ton_race_game/Ship';
import { MoveMode } from '../../wrappers/ton_race_game/structs';
import { encodeRequestToMove } from '../../wrappers/ton_race_game/types';
import { Opcodes } from '../../wrappers/ton_race_game/types';
import { JettonWallet } from '../../wrappers/tep/jetton/JettonWallet';

describe('Subcontract - Basic Operations', () => {
    let SC_System: ContractSystem;
    beforeEach(async () => {
        SC_System = await initContractSystem();
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
    });

    it('Test Subcontract basic redirection - owner can redirect messages to any address', async () => {
        const subcontractId = 1n;
        
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Fund the subcontract so it has enough balance for forwarding
        await SC_System.ownerAccount.send({
            to: subcontract.address,
            value: toNano('0.5'),
        });

        const recipient = await SC_System.blockchain.treasury('redirectRecipient');
        const testMessage = beginCell()
            .storeUint(0x12345678, 32)
            .storeUint(42, 64)
            .endCell();

        const forwardAmount = toNano('0.05');
        // Need to send gas cost + forward amount for forward message
        SC_System.messageResult = await subcontract.sendForward(
            SC_System.ownerAccount.getSender(),
            GAS_COST_FORWARD + forwardAmount,
            recipient.address,
            testMessage,
            forwardAmount,
            false, // NoBounce
            SendMode.PAY_GAS_SEPARATELY
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: true,
        });

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: subcontract.address,
            to: recipient.address,
            success: true,
        });
    });

    it('Test Subcontract jetton transfer redirection', async () => {
        const subcontractId = 2n;
        
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Fund the subcontract so it has enough balance for forwarding
        await SC_System.ownerAccount.send({
            to: subcontract.address,
            value: toNano('0.5'),
        });

        // Create a recipient for jetton transfer
        const recipient = await SC_System.blockchain.treasury('jettonRecipient');
        const recipientJettonWalletAddress = await SC_System.jettonMinter.getWalletAddress(recipient.address);
        const recipientJettonWallet = SC_System.blockchain.openContract(
            JettonWallet.createFromConfig({
                ownerAddress: recipient.address,
                minterAddress: SC_System.jettonMinter.address,
            }, SC_System.jettonWalletCode)
        );

        // Create transfer message (AskToTransfer)
        const transferAmount = toNano('100');
        const forwardAmount = toNano('0.1');
        const transferMessage = beginCell()
            .storeUint(0x0f8a7ea5, 32) // AskToTransfer opcode
            .storeUint(0, 64) // queryId
            .storeCoins(transferAmount) // jettonAmount
            .storeAddress(recipient.address) // transferRecipient
            .storeAddress(null) // sendExcessesTo
            .storeMaybeRef(null) // customPayload
            .storeCoins(forwardAmount) // forwardTonAmount
            .storeRef(beginCell().endCell()) // forwardPayload
            .endCell();

        // Forward through subcontract to owner's jetton wallet
        SC_System.messageResult = await subcontract.sendForward(
            SC_System.ownerAccount.getSender(),
            GAS_COST_FORWARD + forwardAmount,
            SC_System.ownerJettonWallet.address,
            transferMessage,
            forwardAmount,
            false, // NoBounce
            SendMode.PAY_GAS_SEPARATELY
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: true,
        });

        // Verify message was redirected (even if wallet rejects it, the redirection happened)
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: subcontract.address,
            to: SC_System.ownerJettonWallet.address,
        });
    });

    it('Test Subcontract move redirection to ship', async () => {
        const subcontractId = 3n;
        
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Fund the subcontract so it has enough balance for forwarding
        await SC_System.ownerAccount.send({
            to: subcontract.address,
            value: toNano('1'),
        });

        // Create a ship with subcontract address as userAddress
        const shipForSubcontract = SC_System.blockchain.openContract(Ship.createFromConfig({
            userAddress: subcontract.address,
            gameAddress: SC_System.game.address,
            coordinateCellCode: SC_System.coordinateCellCode,
        }, SC_System.shipCode));

        await shipForSubcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('5'));

        // Create RequestToMove message
        const moveMessage = encodeRequestToMove({ mode: MoveMode.UP });
        const forwardAmount = toNano('1'); // Enough for ship move operation

        // Forward move request through subcontract to ship
        SC_System.messageResult = await subcontract.sendForward(
            SC_System.ownerAccount.getSender(),
            GAS_COST_FORWARD + forwardAmount,
            shipForSubcontract.address,
            moveMessage,
            forwardAmount,
            false, // NoBounce
            SendMode.PAY_GAS_SEPARATELY
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: true,
        });

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: subcontract.address,
            to: shipForSubcontract.address,
            success: true,
            op: Opcodes.OP_REQUEST_TO_MOVE,
        });

        // Verify ship processed the move
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: shipForSubcontract.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });
    });

    it('Test Subcontract unauthorized access - non-owner cannot redirect', async () => {
        const subcontractId = 4n;
        
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Create unauthorized sender
        const unauthorizedAccount = await SC_System.blockchain.treasury('unauthorized');
        const recipient = await SC_System.blockchain.treasury('recipient');
        const testMessage = beginCell()
            .storeUint(0x12345678, 32)
            .storeUint(42, 64)
            .endCell();

        const forwardAmount = toNano('0.05');
        
        // Try to forward as unauthorized user - should fail
        SC_System.messageResult = await subcontract.sendForward(
            unauthorizedAccount.getSender(),
            GAS_COST_FORWARD + forwardAmount,
            recipient.address,
            testMessage,
            forwardAmount,
            false, // NoBounce
            SendMode.PAY_GAS_SEPARATELY
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: unauthorizedAccount.address,
            to: subcontract.address,
            success: false,
            exitCode: 926, // ERR_INVALID_OWNER_SENDER
        });
    });

    it('Test Subcontract unauthorized access - non-owner cannot send ManualDeploy', async () => {
        const subcontractId = 401n;
        
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Fund the subcontract so it has enough balance for manual deploy
        await SC_System.ownerAccount.send({
            to: subcontract.address,
            value: toNano('1'),
        });

        // Create unauthorized sender
        const unauthorizedAccount = await SC_System.blockchain.treasury('unauthorized');
        
        // Try to send ManualDeploy as unauthorized user - should fail
        SC_System.messageResult = await subcontract.sendManualDeploy(
            unauthorizedAccount.getSender(),
            GAS_COST_MANUAL_DEPLOY,
            0n
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: unauthorizedAccount.address,
            to: subcontract.address,
            success: false,
            exitCode: 926, // ERR_INVALID_OWNER_SENDER
        });
    });

    it('Test Subcontract getters', async () => {
        const subcontractId = 5n;
        
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        const ownerAddress = await subcontract.getOwnerAddress();
        const id = await subcontract.getId();

        expect(ownerAddress).toEqualAddress(SC_System.ownerAccount.address);
        expect(id).toBe(subcontractId);

        // Test getting address of owned subcontract
        const ownedSubcontractId = 10n;
        const ownedSubcontractAddress = await subcontract.getSubcontractAddress(ownedSubcontractId);
        
        // Verify the address matches the calculated address
        const expectedSubcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: subcontract.address,
            id: ownedSubcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));
        
        expect(ownedSubcontractAddress).toEqualAddress(expectedSubcontract.address);
    });

    it('Test Subcontract can receive TransferNotificationForRecipient', async () => {
        const subcontractId = 200n;
        
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Manually send TransferNotificationForRecipient message to subcontract
        // This tests that subcontract can receive and process this message type
        const jettonAmount = toNano('100');
        
        // Create TransferNotificationForRecipient message body
        // struct (0x7362d09c) TransferNotificationForRecipient {
        //     queryId: uint64
        //     jettonAmount: coins (VarUInteger 16)
        //     transferInitiator: address? (Maybe address, 2 bits + 267 bits if present)
        //     forwardPayload: ForwardPayloadRemainder (RemainingBitsAndRefs - remaining bits/refs)
        // }
        // For empty forwardPayload, RemainingBitsAndRefs is just empty (0 bits, 0 refs)
        const notificationBody = beginCell()
            .storeUint(0x7362d09c, 32) // opcode
            .storeUint(0, 64) // queryId
            .storeCoins(jettonAmount) // jettonAmount (VarUInteger)
            .storeMaybeRef(null) // transferInitiator (null = 0 bit, then nothing)
            // forwardPayload: RemainingBitsAndRefs - empty (no additional bits/refs)
            .endCell();

        // Send the message directly to subcontract
        SC_System.messageResult = await SC_System.ownerAccount.send({
            to: subcontract.address,
            value: toNano('0.1'),
            body: notificationBody,
        });

        // Verify subcontract received and processed the message successfully
        // The subcontract contract now accepts TransferNotificationForRecipient messages
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: true,
        });
        
        // Verify subcontract is still active by checking owner address getter
        // If the message was rejected, the contract might have crashed
        const ownerAddress = await subcontract.getOwnerAddress();
        expect(ownerAddress).toEqualAddress(SC_System.ownerAccount.address);
    });

    it('Test Subcontract getters - redirect excess and threshold', async () => {
        const subcontractId = 201n;
        
        const subcontract = SC_System.blockchain.openContract(Subcontract.createFromConfig({
            ownerAddress: SC_System.ownerAccount.address,
            id: subcontractId,
            ownerPublicKey: 0n, // Dummy public key for basic tests
        }, SC_System.subcontractCode));

        await subcontract.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

        // Check default values
        const defaultRedirectExcess = await subcontract.getRedirectExcess();
        const defaultThreshold = await subcontract.getExcessThreshold();
        
        expect(defaultRedirectExcess).toBe(false);
        expect(defaultThreshold).toBe(toNano('0.5'));

        // Set redirect excess to true
        SC_System.messageResult = await subcontract.sendSetRedirectExcess(SC_System.ownerAccount.getSender(), true, toNano('0.1'));
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: subcontract.address,
            success: true,
        });
        const redirectExcessAfter = await subcontract.getRedirectExcess();
        expect(redirectExcessAfter).toBe(true);

        // Set excess threshold to 0.5 TON
        SC_System.messageResult = await subcontract.sendSetExcessThreshold(SC_System.ownerAccount.getSender(), toNano('0.5'), toNano('0.1'));
        const thresholdAfter = await subcontract.getExcessThreshold();
        expect(thresholdAfter).toBe(toNano('0.5'));
    });
});

