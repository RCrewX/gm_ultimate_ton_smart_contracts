// SPDX-License-Identifier: UNLICENSED
import { beginCell, Cell, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem, buildJettonUsageForwardPayload } from '../test_utils';
import { Opcodes, GAS_COST_REQUEST_TO_MOVE, TODO_TOTAL_GAS_TO_MOVE, BASIC_SHIP_HP, GAS_COST_SEND_MOVE, JettonUsageMode } from '../../wrappers/ton_race_game/types';
import { Opcodes as GameManagerOpcodes, GAS_COST_REDIRECT_MESSAGE } from '../../wrappers/game_manager/types';
import { MoveMode } from '../../wrappers/ton_race_game/structs';
import { JettonMinter } from '../../wrappers/tep/jetton/JettonMinter';
import { JettonWallet } from '../../wrappers/tep/jetton/JettonWallet';
import { jettonContentToCell } from '../../wrappers/tep/jetton/JettonMinter';
import { Ship } from '../../wrappers/ton_race_game/Ship';
import { Op } from '../../wrappers/tep/jetton/JettonConstants';

describe('Ship Upgrade', () => {
    let SC_System: ContractSystem;
    let otherUser: SandboxContract<TreasuryContract>;
    let anotherUser: SandboxContract<TreasuryContract>;

    beforeEach(async () => {
        SC_System = await initContractSystem();
        otherUser = await SC_System.blockchain.treasury('otherUser');
        anotherUser = await SC_System.blockchain.treasury('anotherUser');

        // Deploy JettonWallets for otherUser and anotherUser
        const otherUserJettonWallet = SC_System.blockchain.openContract(JettonWallet.createFromConfig({
            ownerAddress: otherUser.address,
            minterAddress: SC_System.jettonMinter.address,
        }, SC_System.jettonWalletCode));
        const anotherUserJettonWallet = SC_System.blockchain.openContract(JettonWallet.createFromConfig({
            ownerAddress: anotherUser.address,
            minterAddress: SC_System.jettonMinter.address,
        }, SC_System.jettonWalletCode));
        SC_System.messageResult =await otherUserJettonWallet.sendDeploy(otherUser.getSender(), toNano('0.5'));
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: otherUser.address,
            to: otherUserJettonWallet.address,
            success: true,
            deploy: true,
        });
        SC_System.messageResult = await anotherUserJettonWallet.sendDeploy(anotherUser.getSender(), toNano('0.5'));
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: anotherUser.address,
            to: anotherUserJettonWallet.address,
            success: true,
            deploy: true,
        });
        expect(await SC_System.ownerShip.getMovementInProcess()).toBe(false);
        
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
        otherUser = null as any;
        anotherUser = null as any;
    });

    it('should upgrade ship HP when jettons are transferred to GameManager', async () => {
        // Jetton info is already set up by test_utils
        // Jetton info is already set up by test_utils, no need to check for set transaction

        // Get initial ship HP
        const initialGameData = await SC_System.ownerShip.getCurrentGameData();
        const initialHP = initialGameData ? initialGameData.hp : 100n; // BASIC_SHIP_HP
        expect(await SC_System.ownerShip.getMovementInProcess()).toBe(false);
        // Calculate GameManager's jetton wallet address
        const gameManagerJettonWalletAddress = await SC_System.jettonMinter.getWalletAddress(SC_System.gameManager.address);
        const gameManagerJettonWallet = SC_System.blockchain.openContract(
            JettonWallet.createFromAddress(gameManagerJettonWalletAddress)
        );      
        

        

        // Check user has jettons
        const userBalance = await SC_System.ownerJettonWallet.getJettonBalance();
        expect(userBalance).toBeGreaterThan(0n);

        // Transfer jettons to GameManager with game address and ship address in forwardPayload
        // forwardPayload structure: first ref = game address, second ref = data cell (ship address)
        const transferAmount = toNano('100');
        const forwardPayload = buildJettonUsageForwardPayload(
            SC_System.game.address,
            SC_System.ownerShip.address,
            JettonUsageMode.SHIP_UPGRADE,
        );

        SC_System.messageResult = await SC_System.ownerJettonWallet.sendTransfer(
            SC_System.ownerAccount.getSender(),
            toNano('0.2'),
            transferAmount,
            SC_System.gameManager.address,
            SC_System.ownerAccount.address,
            beginCell().endCell(), // customPayload
            toNano('0.1'), // forwardAmount
            forwardPayload
        );

        // Verify transfer notification was sent to GameManager
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: gameManagerJettonWallet.address,
            to: SC_System.gameManager.address,
            success: true,
            op: GameManagerOpcodes.OP_TRANSFER_NOTIFICATION_FOR_RECIPIENT,
        });

        // Verify JettonUsed was sent from GameManager to Game
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.game.address,
            success: true,
            op: Opcodes.OP_JETTON_USED,
        });

        // Verify ShipUpgrade was sent to Ship
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.game.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_SHIP_UPGRADE,
        });

        // Check ship HP increased (should be between 1 and transferAmount)
        const finalGameData = await SC_System.ownerShip.getCurrentGameData();
        expect(finalGameData).not.toBeNull();
        if (finalGameData) {
            const hpIncrease = finalGameData.hp - initialHP;
            expect(hpIncrease).toBeGreaterThanOrEqual(1n);
            expect(hpIncrease).toBeLessThanOrEqual(transferAmount*3n);
        }
    });

    it('should allow any user to upgrade any ship', async () => {
        // Jetton info is already set up by test_utils
        // Create a ship for another user
        const anotherUserShip = SC_System.blockchain.openContract(Ship.createFromConfig({
            userAddress: anotherUser.address,
            gameAddress: SC_System.game.address,
            coordinateCellCode: SC_System.coordinateCellCode,
        }, SC_System.shipCode));

        await anotherUserShip.sendDeploy(anotherUser.getSender(), toNano('2'));
        await anotherUserShip.sendMove(anotherUser.getSender(), toNano('1'), MoveMode.UP);
        SC_System.messageResult = await anotherUserShip.sendMove(anotherUser.getSender(), toNano('1'), MoveMode.EXIT);
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: anotherUserShip.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });
        // Get initial HP of another user's ship
        const initialGameData = await anotherUserShip.getCurrentGameData();
        const initialHP = initialGameData ? initialGameData.hp : 100n;

        // Get otherUser's jetton wallet
        const otherUserJettonWalletAddress = await SC_System.jettonMinter.getWalletAddress(otherUser.address);
        const otherUserJettonWallet = SC_System.blockchain.openContract(
            JettonWallet.createFromAddress(otherUserJettonWalletAddress)
        );

        //  Pop up jettons to otherUser from owner
        SC_System.messageResult = await SC_System.ownerJettonWallet.sendTransfer(
            SC_System.ownerAccount.getSender(),
            toNano('0.2'),
            toNano('100'),
            otherUser.address,
            SC_System.ownerAccount.address,
            beginCell().endCell(), // customPayload
            toNano('0.1'), // forwardAmount
            beginCell().endCell()
        );
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerJettonWallet.address,
            to: otherUserJettonWallet.address,
            success: true,
            // op: JettonWalletOpcodes.OP_TRANSFER,
        });

        // otherUser transfers jettons to GameManager to upgrade anotherUser's ship
        const transferAmount = toNano('50');
        const forwardPayload = buildJettonUsageForwardPayload(
            SC_System.game.address,
            anotherUserShip.address,
            JettonUsageMode.SHIP_UPGRADE,
        );

        SC_System.messageResult = await otherUserJettonWallet.sendTransfer(
            otherUser.getSender(),
            toNano('0.2'),
            transferAmount,
            SC_System.gameManager.address,
            otherUser.address,
            beginCell().endCell(), // customPayload
            toNano('0.1'), // forwardAmount
            forwardPayload
        );

        // Verify upgrade happened
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.game.address,
            to: anotherUserShip.address,
            success: true,
            op: Opcodes.OP_SHIP_UPGRADE,
        });

        // Check ship HP increased
        const finalGameData = await anotherUserShip.getCurrentGameData();
        expect(finalGameData).not.toBeNull();
        if (finalGameData) {
            const hpIncrease = finalGameData.hp - initialHP;
            expect(hpIncrease).toBeGreaterThanOrEqual(1n);
            expect(hpIncrease).toBeLessThanOrEqual(transferAmount*3n);
        }
    });

    it('should only accept transfers from native jetton wallet', async () => {
        // Jetton info is already set up by test_utils
        // Create a different jetton minter (not the native one)
        const foreignJettonContent = jettonContentToCell({ type: 1, uri: 'https://foreign.com/jetton.json' });
        const foreignJettonMinter = SC_System.blockchain.openContract(JettonMinter.createFromConfig({
            admin: otherUser.address,
            content: foreignJettonContent,
            wallet_code: SC_System.jettonWalletCode,
        }, SC_System.jettonMinterCode));

        await foreignJettonMinter.sendDeploy(otherUser.getSender(), toNano('0.5'));

        // Mint foreign jettons to otherUser
        await foreignJettonMinter.sendMint(
            otherUser.getSender(),
            otherUser.address,
            toNano('1000'),
            toNano('0.1'),
            toNano('0.2')
        );

        // Get foreign jetton wallet
        const foreignJettonWallet = SC_System.blockchain.openContract(
            JettonWallet.createFromConfig({
                ownerAddress: otherUser.address,
                minterAddress: foreignJettonMinter.address,
            }, SC_System.jettonWalletCode)
        );
        SC_System.messageResult = await foreignJettonWallet.sendDeploy(otherUser.getSender(), toNano('0.5'));
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: otherUser.address,
            to: foreignJettonWallet.address,
            success: true,
        });

        // Try to transfer foreign jettons to GameManager
        const forwardPayload = buildJettonUsageForwardPayload(
            SC_System.game.address,
            SC_System.ownerShip.address,
            JettonUsageMode.SHIP_UPGRADE,
        );

        SC_System.messageResult = await foreignJettonWallet.sendTransfer(
            otherUser.getSender(),
            toNano('0.2'),
            toNano('100'),
            SC_System.gameManager.address,
            otherUser.address,
            beginCell().endCell(), // customPayload
            toNano('0.1'), // forwardAmount
            forwardPayload
        );

        // New architecture: the dumb-pipe GM does NOT validate the wallet. It wraps
        // the foreign notification into R2 and forwards it to the Retranslator, which
        // rejects it because the initiator is not GM's NATIVE jetton wallet.
        const gameManagerForeignJettonWallet = SC_System.blockchain.openContract(
            JettonWallet.createFromConfig({
                ownerAddress: SC_System.gameManager.address,
                minterAddress: foreignJettonMinter.address,
            }, SC_System.jettonWalletCode)
        );
        // Foreign wallet -> GM succeeds (GM just forwards).
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: gameManagerForeignJettonWallet.address,
            to: SC_System.gameManager.address,
            success: true,
            op: GameManagerOpcodes.OP_TRANSFER_NOTIFICATION_FOR_RECIPIENT,
        });
        // GM -> R* (R2) is rejected: ERR_INVALID_JETTON_WALLET_SENDER (925).
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.retranslator.address,
            success: false,
            exitCode: 925,
            op: GameManagerOpcodes.OP_R2,
        });
    });

    it('should calculate HP increase randomly between 1 and N', async () => {
        // Jetton info is already set up by test_utils
        // Get user's jetton wallet
        const userJettonWalletAddress = await SC_System.jettonMinter.getWalletAddress(SC_System.ownerAccount.address);
        const userJettonWallet = SC_System.blockchain.openContract(
            JettonWallet.createFromAddress(userJettonWalletAddress)
        );

        // Mint jettons to user
        const redirectMessage = JettonMinter.mintMessage(SC_System.jettonMinter.address, SC_System.ownerAccount.address, toNano('10000'), toNano('0.1'), toNano('0.2'));
        SC_System.messageResult = await SC_System.gameManager.sendRedirectMessage(
            SC_System.ownerAccount.getSender(),
            GAS_COST_REDIRECT_MESSAGE,
            SC_System.ownerAccount.address,
            redirectMessage,
            toNano('0.1')
        );
        // Perform multiple upgrades to verify randomness
        const transferAmount = toNano('100');
        const forwardPayload = buildJettonUsageForwardPayload(
            SC_System.game.address,
            SC_System.ownerShip.address,
            JettonUsageMode.SHIP_UPGRADE,
        );

        const hpIncreases: bigint[] = [];

        for (let i = 0; i < 5; i++) {
            const gameDataBefore = await SC_System.ownerShip.getCurrentGameData();
            const hpBefore = gameDataBefore ? gameDataBefore.hp : 100n;

            SC_System.messageResult = await userJettonWallet.sendTransfer(
                SC_System.ownerAccount.getSender(),
                toNano('0.2'),
                transferAmount,
                SC_System.gameManager.address,
                SC_System.ownerAccount.address,
                beginCell().endCell(), // customPayload
                toNano('0.1'), // forwardAmount
                forwardPayload
            );

            const gameDataAfter = await SC_System.ownerShip.getCurrentGameData();
            const hpAfter = gameDataAfter ? gameDataAfter.hp : 100n;
            const hpIncrease = hpAfter - hpBefore;

            hpIncreases.push(hpIncrease);
            expect(hpIncrease).toBeGreaterThanOrEqual(1n);
            expect(hpIncrease).toBeLessThanOrEqual(transferAmount*3n);
        }

        // Verify we got different values (randomness)
        const uniqueIncreases = new Set(hpIncreases.map(h => h.toString()));
        // At least some variation (not all the same)
        expect(uniqueIncreases.size).toBeGreaterThan(1);
    });

    it('should update max_hp when ship is upgraded', async () => {
        // Jetton info is already set up by test_utils
        // Initialize ship by doing a first move (this sets max_hp to BASIC_SHIP_HP)
        // Use a higher value to ensure it covers TODO_TOTAL_GAS_TO_MOVE
        const moveValue = TODO_TOTAL_GAS_TO_MOVE;
        SC_System.messageResult = await SC_System.ownerShip.sendMove(
            SC_System.ownerAccount.getSender(),
            moveValue,
            MoveMode.UP
        );
        
        // Wait for move to complete
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });

        // Get initial max_hp (should be BASIC_SHIP_HP = 100 after first move)
        const initialMaxHp = await SC_System.ownerShip.getMaxHp();
        expect(initialMaxHp).toBe(BASIC_SHIP_HP); // BASIC_SHIP_HP

        // Get user's jetton wallet
        const userJettonWalletAddress = await SC_System.jettonMinter.getWalletAddress(SC_System.ownerAccount.address);
        const userJettonWallet = SC_System.blockchain.openContract(
            JettonWallet.createFromAddress(userJettonWalletAddress)
        );

        // Transfer jettons to upgrade ship
        const transferAmount = toNano('50');
        const forwardPayload = buildJettonUsageForwardPayload(
            SC_System.game.address,
            SC_System.ownerShip.address,
            JettonUsageMode.SHIP_UPGRADE,
        );

        SC_System.messageResult = await userJettonWallet.sendTransfer(
            SC_System.ownerAccount.getSender(),
            toNano('0.2'),
            transferAmount,
            SC_System.gameManager.address,
            SC_System.ownerAccount.address,
            beginCell().endCell(),
            toNano('0.1'),
            forwardPayload
        );

        // Verify upgrade happened
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.game.address,
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_SHIP_UPGRADE,
        });

        // Check max_hp increased
        const finalMaxHp = await SC_System.ownerShip.getMaxHp();
        const maxHpIncrease = finalMaxHp - initialMaxHp;
        expect(maxHpIncrease).toBeGreaterThanOrEqual(1n);
        expect(maxHpIncrease).toBeLessThanOrEqual(transferAmount*3n);

        // Verify max_hp matches current HP after upgrade
        const gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            // After upgrade, HP should be increased, and max_hp should match
            expect(gameData.hp).toBeGreaterThan(initialMaxHp);
            // max_hp should be at least as high as current HP
            expect(finalMaxHp).toBeGreaterThanOrEqual(gameData.hp);
        }
    });

    it('should restore HP to max_hp on safe exit', async () => {
        // Jetton info is already set up by test_utils
        // Upgrade ship first to increase max_hp
        const userJettonWalletAddress = await SC_System.jettonMinter.getWalletAddress(SC_System.ownerAccount.address);
        const userJettonWallet = SC_System.blockchain.openContract(
            JettonWallet.createFromAddress(userJettonWalletAddress)
        );

        const transferAmount = toNano('300');
        const forwardPayload = buildJettonUsageForwardPayload(
            SC_System.game.address,
            SC_System.ownerShip.address,
            JettonUsageMode.SHIP_UPGRADE,
        );

        SC_System.messageResult = await userJettonWallet.sendTransfer(
            SC_System.ownerAccount.getSender(),
            toNano('0.2'),
            transferAmount,
            SC_System.gameManager.address,
            SC_System.ownerAccount.address,
            beginCell().endCell(),
            toNano('0.1'),
            forwardPayload
        );

        // Get max_hp after upgrade
        const maxHpAfterUpgrade = await SC_System.ownerShip.getMaxHp();
        expect(maxHpAfterUpgrade).toBeGreaterThan(100n);

        // Move ship to trigger safe exit
        SC_System.messageResult = await SC_System.ownerShip.sendMove(
            SC_System.ownerAccount.getSender(),
            toNano('1'),
            3 // MoveMode.EXIT
        );

        // Wait for move to complete
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_MOVE_END,
        });

        // Check HP was restored to max_hp (not BASIC_SHIP_HP)
        const gameDataAfterExit = await SC_System.ownerShip.getCurrentGameData();
        expect(gameDataAfterExit).not.toBeNull();
        if (gameDataAfterExit) {
            expect(gameDataAfterExit.hp).toBe(maxHpAfterUpgrade);
            expect(gameDataAfterExit.hp).toBeGreaterThan(100n); // Should be upgraded max_hp, not BASIC_SHIP_HP
        }
    });
});

