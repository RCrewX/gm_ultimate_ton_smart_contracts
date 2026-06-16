// SPDX-License-Identifier: UNLICENSED
import { beginCell, Cell, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { Opcodes } from '../../wrappers/ton_race_game/types';
import { JettonMinter } from '../../wrappers/tep/jetton/JettonMinter';
import { JettonWallet } from '../../wrappers/tep/jetton/JettonWallet';
import { jettonContentToCell } from '../../wrappers/tep/jetton/JettonMinter';
import { ContractSystem, initContractSystem, setupCoordinateCellWithFirstExplorer, cleanupContractSystem } from '../test_utils';
import { BASIC_STORAGE_TAX } from '../../wrappers/ton_race_game/types';


describe('Withdrawals', () => {
    let SC_System: ContractSystem;
    let otherUser: SandboxContract<TreasuryContract>;
    let recipient: SandboxContract<TreasuryContract>;

    beforeEach(async () => {
        SC_System = await initContractSystem();
        otherUser = await SC_System.blockchain.treasury('otherUser');
        recipient = await SC_System.blockchain.treasury('recipient');
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
        otherUser = null as any;
        recipient = null as any;
    });

    describe('TON Withdrawal', () => {
        it('should allow firstExplorer to withdraw TON', async () => {
            const { coordinateCell } = await setupCoordinateCellWithFirstExplorer(SC_System, { x: 0n, y: 1n });

            // Send TON to CoordinateCell
            const sendAmount = toNano('1');
            await SC_System.ownerAccount.send({
                to: coordinateCell.address,
                value: sendAmount,
                body: Cell.EMPTY,
            });

            const balanceBefore = await coordinateCell.getTonBalance();
            expect(balanceBefore).toBeGreaterThanOrEqual(sendAmount - BASIC_STORAGE_TAX * 2n);

            // Withdraw TON
            const withdrawAmount = toNano('0.5');
            SC_System.messageResult = await coordinateCell.sendWithdrawTON(
                SC_System.ownerAccount.getSender(),
                toNano('0.1'),
                recipient.address,
                withdrawAmount
            );

            expect(SC_System.messageResult.transactions).toHaveTransaction({
                from: SC_System.ownerAccount.address,
                to: coordinateCell.address,
                success: true,
                op: Opcodes.OP_WITHDRAW_TON,
            });

            expect(SC_System.messageResult.transactions).toHaveTransaction({
                from: coordinateCell.address,
                to: recipient.address,
                success: true,
                op: Opcodes.OP_RETURN_EXCESSES_BACK,
            });

            const balanceAfter = await coordinateCell.getTonBalance();
            // Should have at least 0.1 TON remaining
            expect(balanceAfter).toBeGreaterThanOrEqual(toNano('0.1'));
        });

        it('should not allow withdrawal that would leave less than 0.1 TON', async () => {
            const { coordinateCell } = await setupCoordinateCellWithFirstExplorer(SC_System, { x: 0n, y: 1n });

            // Send TON to CoordinateCell
            const sendAmount = toNano('0.5');
            await SC_System.ownerAccount.send({
                to: coordinateCell.address,
                value: sendAmount,
                body: Cell.EMPTY,
            });

            const balanceBefore = await coordinateCell.getTonBalance();
            
            // Try to withdraw more than allowed (would leave less than 0.1 TON)
            const withdrawAmount = balanceBefore - toNano('0.05') + sendAmount; // Would leave only 0.05 TON
            SC_System.messageResult = await coordinateCell.sendWithdrawTON(
                SC_System.ownerAccount.getSender(),
                sendAmount,
                recipient.address,
                withdrawAmount
            );

            expect(SC_System.messageResult.transactions).toHaveTransaction({
                from: SC_System.ownerAccount.address,
                to: coordinateCell.address,
                success: false,
                op: Opcodes.OP_WITHDRAW_TON,
            });
        });

        it('should not allow non-firstExplorer to withdraw TON', async () => {
            const { coordinateCell } = await setupCoordinateCellWithFirstExplorer(SC_System, { x: 0n, y: 1n });

            // Send TON to CoordinateCell
            await SC_System.ownerAccount.send({
                to: coordinateCell.address,
                value: toNano('1'),
                body: Cell.EMPTY,
            });

            // Try to withdraw as other user
            SC_System.messageResult = await coordinateCell.sendWithdrawTON(
                otherUser.getSender(),
                toNano('0.1'),
                recipient.address,
                toNano('0.5')
            );

            expect(SC_System.messageResult.transactions).toHaveTransaction({
                from: otherUser.address,
                to: coordinateCell.address,
                success: false,
                op: Opcodes.OP_WITHDRAW_TON,
            });
        });
    });

    describe('Jetton Withdrawal', () => {
        it('should allow firstExplorer to withdraw jettons', async () => {
            const { coordinateCell } = await setupCoordinateCellWithFirstExplorer(SC_System, { x: 0n, y: 1n });

            // Deploy jetton minter
            const jettonContent = jettonContentToCell({ type: 1, uri: 'https://example.com/jetton.json' });
            const jettonMinter = SC_System.blockchain.openContract(JettonMinter.createFromConfig({
                admin: SC_System.ownerAccount.address,
                content: jettonContent,
                wallet_code: SC_System.jettonWalletCode,
            }, SC_System.jettonMinterCode));

            await jettonMinter.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

            // Calculate CoordinateCell's jetton wallet address
            const coordinateCellJettonWalletAddress = await jettonMinter.getWalletAddress(coordinateCell.address);
            const coordinateCellJettonWallet = SC_System.blockchain.openContract(
                JettonWallet.createFromAddress(coordinateCellJettonWalletAddress)
            );

            // Mint jettons to CoordinateCell
            await jettonMinter.sendMint(
                SC_System.ownerAccount.getSender(),
                coordinateCell.address,
                toNano('1000'), // jetton amount
                toNano('0.1'), // forward amount
                toNano('0.2') // total amount
            );

            // Check jetton balance
            const balanceBefore = await coordinateCellJettonWallet.getJettonBalance();
            expect(balanceBefore).toBeGreaterThan(0n);

            // Withdraw jettons
            const withdrawAmount = toNano('100');
            SC_System.messageResult = await coordinateCell.sendWithdrawJetton(
                SC_System.ownerAccount.getSender(),
                toNano('0.2'),
                coordinateCellJettonWallet.address,
                recipient.address,
                withdrawAmount,
                toNano('0.1')
            );

            expect(SC_System.messageResult.transactions).toHaveTransaction({
                from: SC_System.ownerAccount.address,
                to: coordinateCell.address,
                success: true,
                op: Opcodes.OP_WITHDRAW_JETTON,
            });

            // Should send AskToTransfer to jetton wallet
            expect(SC_System.messageResult.transactions).toHaveTransaction({
                from: coordinateCell.address,
                to: coordinateCellJettonWallet.address,
                success: true,
            });

            // Check recipient received jettons
            const recipientWalletAddress = await jettonMinter.getWalletAddress(recipient.address);
            const recipientWallet = SC_System.blockchain.openContract(
                JettonWallet.createFromAddress(recipientWalletAddress)
            );
            const recipientBalance = await recipientWallet.getJettonBalance();
            expect(recipientBalance).toBeGreaterThanOrEqual(withdrawAmount);
        });

        it('should not allow non-firstExplorer to withdraw jettons', async () => {
            const { coordinateCell } = await setupCoordinateCellWithFirstExplorer(SC_System, { x: 0n, y: 1n });

            // Deploy jetton minter
            const jettonContent = jettonContentToCell({ type: 1, uri: 'https://example.com/jetton.json' });
            const jettonMinter = SC_System.blockchain.openContract(JettonMinter.createFromConfig({
                admin: SC_System.ownerAccount.address,
                content: jettonContent,
                wallet_code: SC_System.jettonWalletCode,
            }, SC_System.jettonMinterCode));

            await jettonMinter.sendDeploy(SC_System.ownerAccount.getSender(), toNano('0.5'));

            // Mint jettons to CoordinateCell
            await jettonMinter.sendMint(
                SC_System.ownerAccount.getSender(),
                coordinateCell.address,
                toNano('1000'),
                toNano('0.1'),
                toNano('0.2')
            );

            // Calculate CoordinateCell's jetton wallet address
            const coordinateCellJettonWalletAddress = await jettonMinter.getWalletAddress(coordinateCell.address);

            // Try to withdraw as other user
            SC_System.messageResult = await coordinateCell.sendWithdrawJetton(
                otherUser.getSender(),
                toNano('0.2'),
                coordinateCellJettonWalletAddress,
                recipient.address,
                toNano('100'),
                toNano('0.1')
            );

            expect(SC_System.messageResult.transactions).toHaveTransaction({
                from: otherUser.address,
                to: coordinateCell.address,
                success: false,
                op: Opcodes.OP_WITHDRAW_JETTON,
            });
        });
    });

    describe('NFT Withdrawal', () => {
        it('should allow firstExplorer to withdraw NFT - correct message redirection', async () => {
            // Use y=1n because setupCoordinateCellWithFirstExplorer moves UP from (0,0) to (0,1)
            const { coordinateCell } = await setupCoordinateCellWithFirstExplorer(SC_System, { x: 0n, y: 1n });

            // Create a mock NFT address (we don't need actual NFT contract for this test)
            // We just verify that the message is correctly formatted and sent
            const mockNFTAddress = await SC_System.blockchain.treasury('mockNFT');
            
            // Fund coordinate cell for gas
            await SC_System.ownerAccount.send({
                to: coordinateCell.address,
                value: toNano('1'),
                body: Cell.EMPTY,
            });

            // Withdraw NFT
            SC_System.messageResult = await coordinateCell.sendWithdrawNFT(
                SC_System.ownerAccount.getSender(),
                toNano('0.2'),
                mockNFTAddress.address,
                recipient.address,
                toNano('0.1'),
                null, // responseDestination
                null  // customPayload
            );

            expect(SC_System.messageResult.transactions).toHaveTransaction({
                from: SC_System.ownerAccount.address,
                to: coordinateCell.address,
                success: true,
                op: Opcodes.OP_WITHDRAW_NFT,
            });

            // Verify message was sent to NFT address (may bounce since mockNFTAddress doesn't implement NFT standard)
            // Check that the message was sent with correct structure
            // Look for transaction from coordinateCell to mockNFTAddress (the NFT transfer message)
            const nftTransferTx = SC_System.messageResult.transactions.find((tx: any) => {
                const src = tx.inMessage?.info.src;
                const dest = tx.inMessage?.info.dest;
                return src && dest && 
                       src.equals(coordinateCell.address) && 
                       dest.equals(mockNFTAddress.address);
            });
            
            // If not found in inMessage, check outMessages (message sent by coordinateCell)
            let nftMessage = nftTransferTx?.inMessage;
            if (!nftMessage) {
                const ccTx = SC_System.messageResult.transactions.find((tx: any) => 
                    tx.inMessage?.info.dest?.equals(coordinateCell.address)
                );
                if (ccTx?.outMessages) {
                    for (const outMsg of ccTx.outMessages.values()) {
                        if (outMsg.info.dest?.equals(mockNFTAddress.address)) {
                            nftMessage = outMsg;
                            break;
                        }
                    }
                }
            }
            
            expect(nftMessage).toBeDefined();
            if (nftMessage?.body) {
                const bodySlice = nftMessage.body.beginParse();
                const opcode = bodySlice.loadUint(32);
                expect(opcode).toBe(0x5fcc3d14); // NFT Transfer opcode (TEP-62)
                
                // Verify structure: query_id, new_owner, response_destination, custom_payload, forward_amount
                const queryId = bodySlice.loadUint(64);
                const newOwner = bodySlice.loadAddress();
                expect(newOwner).toEqualAddress(recipient.address);
                
                // response_destination (optional address) - TEP-62 format: 2 bits (0b00=null, 0b10=address)
                const responseDestFlag = bodySlice.loadUint(2);
                expect(responseDestFlag).toBe(0); // Should be 0 (null) in our test
                
                // custom_payload (optional cell) - 1 bit (0=null, 1=cell)
                const hasCustomPayload = bodySlice.loadUint(1);
                expect(hasCustomPayload).toBe(0); // Should be 0 (null) in our test
                
                // forward_amount (VarUInteger 16)
                const forwardAmount = bodySlice.loadCoins();
                expect(forwardAmount).toBeGreaterThan(0n);
            }
        });

        it('should not allow non-firstExplorer to withdraw NFT', async () => {
            const { coordinateCell } = await setupCoordinateCellWithFirstExplorer(SC_System, { x: 0n, y: 1n });

            const mockNFTAddress = await SC_System.blockchain.treasury('mockNFT2');

            // Try to withdraw as other user
            SC_System.messageResult = await coordinateCell.sendWithdrawNFT(
                otherUser.getSender(),
                toNano('0.2'),
                mockNFTAddress.address,
                recipient.address,
                toNano('0.1'),
                null,
                null
            );

            expect(SC_System.messageResult.transactions).toHaveTransaction({
                from: otherUser.address,
                to: coordinateCell.address,
                success: false,
                op: Opcodes.OP_WITHDRAW_NFT,
            });
        });

        it('should correctly format NFT Transfer message with optional fields', async () => {
            const { coordinateCell } = await setupCoordinateCellWithFirstExplorer(SC_System, { x: 0n, y: 1n });

            const mockNFTAddress = await SC_System.blockchain.treasury('mockNFT3');
            const responseDest = await SC_System.blockchain.treasury('responseDest');
            const customPayload = beginCell().storeUint(12345, 32).endCell();

            // Fund coordinate cell
            await SC_System.ownerAccount.send({
                to: coordinateCell.address,
                value: toNano('1'),
                body: Cell.EMPTY,
            });

            // Withdraw NFT with optional fields
            SC_System.messageResult = await coordinateCell.sendWithdrawNFT(
                SC_System.ownerAccount.getSender(),
                toNano('0.2'),
                mockNFTAddress.address,
                recipient.address,
                toNano('0.1'),
                responseDest.address,
                customPayload
            );

            // Verify message was sent (may bounce since mockNFTAddress doesn't implement NFT standard)
            // Look for the NFT transfer message in transactions
            let nftMessage: any = null;
            for (const tx of SC_System.messageResult.transactions) {
                // Check inMessage
                if (tx.inMessage?.info.src?.equals(coordinateCell.address) && 
                    tx.inMessage?.info.dest?.equals(mockNFTAddress.address)) {
                    nftMessage = tx.inMessage;
                    break;
                }
                // Check outMessages
                if (tx.outMessages) {
                    for (const outMsg of tx.outMessages.values()) {
                        if (outMsg.info.src?.equals(coordinateCell.address) && 
                            outMsg.info.dest?.equals(mockNFTAddress.address)) {
                            nftMessage = outMsg;
                            break;
                        }
                    }
                }
                if (nftMessage) break;
            }
            
            expect(nftMessage).toBeDefined();
            if (nftMessage?.body) {
                const bodySlice = nftMessage.body.beginParse();
                const opcode = bodySlice.loadUint(32);
                expect(opcode).toBe(0x5fcc3d14);
                
                bodySlice.loadUint(64); // queryId
                bodySlice.loadAddress(); // newOwner
                
                // Check response_destination - TEP-62 format: 2 bits (0b00=null, 0b10=address)
                const responseDestFlag = bodySlice.loadUint(2);
                // TEP-62: 0b00 = null, 0b10 = address (any workchain) = 2 in decimal
                expect(responseDestFlag).toBe(2); // Should be 2 (0b10 = address present)
                if (responseDestFlag === 2) {
                    const responseDestAddr = bodySlice.loadAddress();
                    expect(responseDestAddr).toEqualAddress(responseDest.address);
                } else {
                    throw new Error(`Expected responseDestFlag to be 2 (0b10), got ${responseDestFlag}`);
                }
                
                // Check custom_payload - 1 bit (0=null, 1=cell)
                const hasCustomPayload = bodySlice.loadUint(1);
                expect(hasCustomPayload).toBe(1); // Should be 1 (cell present)
                if (hasCustomPayload === 1) {
                    const customPayloadRef = bodySlice.loadRef();
                    const customPayloadValue = customPayloadRef.beginParse().loadUint(32);
                    expect(customPayloadValue).toBe(12345);
                } else {
                    throw new Error(`Expected hasCustomPayload to be 1, got ${hasCustomPayload}`);
                }
            }
        });
    });
});

