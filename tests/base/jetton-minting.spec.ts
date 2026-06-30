// SPDX-License-Identifier: UNLICENSED
import { toNano } from '@ton/core';
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { MoveMode } from '../../wrappers/ton_race_game/structs';
import { Opcodes, TOTAL_GAS_TO_MOVE, GAS_COST_REQUEST_MINT, GAS_COST_ANY_MESSAGE } from '../../wrappers/ton_race_game/types';
import { Opcodes as GameManagerOpcodes } from '../../wrappers/game_manager/types';
import { JettonMinter } from '../../wrappers/tep/jetton/JettonMinter';
import { JettonWallet } from '../../wrappers/tep/jetton/JettonWallet';
import { jettonContentToCell } from '../../wrappers/tep/jetton/JettonMinter';

describe('Jetton Minting', () => {
    let SC_System: ContractSystem;
    beforeEach(async () => {
        SC_System = await initContractSystem();
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
    });

    it('Test complete minting flow - moves, safe exit, and jetton minting', async () => {


        // Do several moves to accumulate rewards
        // Move 1: UP from (0,0) to (0,1)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        let gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            expect(gameData.xy.y).toBe(1n);
            expect(gameData.jettonAmount).toBeGreaterThanOrEqual(0n);
        }

        // Move 2: UP from (0,1) to (0,2)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            expect(gameData.xy.y).toBe(2n);
        }

        // Move 3: RIGHT from (0,2) to (1,3)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.RIGHT);
        gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            expect(gameData.xy.x).toBe(1n);
            expect(gameData.xy.y).toBe(3n);
        }

        // Move 4: RIGHT from (1,3) to (2,4)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.RIGHT);
        gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            expect(gameData.xy.x).toBe(2n);
            expect(gameData.xy.y).toBe(4n);
        }

        // Move 5: RIGHT from (2,4) to (3,5)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.RIGHT);
        gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            expect(gameData.xy.x).toBe(3n);
            expect(gameData.xy.y).toBe(5n);
        }

        // Move 6: RIGHT from (3,5) to (4,6)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.RIGHT);
        gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        if (gameData) {
            expect(gameData.xy.x).toBe(4n);
            expect(gameData.xy.y).toBe(6n);
        }
        // Get the accumulated jetton amount before safe exit
        gameData = await SC_System.ownerShip.getCurrentGameData();
        let accumulatedAmount = gameData ? gameData.jettonAmount : 0n;
        expect(accumulatedAmount).toBeGreaterThan(0n);

        // Calculate user's jetton wallet address
        const userJettonWalletAddress = await SC_System.jettonMinter.getWalletAddress(SC_System.ownerAccount.address);
        const userJettonWallet = SC_System.blockchain.openContract(
            JettonWallet.createFromAddress(userJettonWalletAddress)
        );

        // Get initial jetton balance (should be 0)
        const initialJettonBalance = await userJettonWallet.getJettonBalance();
        // expect(initialJettonBalance).toBe(0n);

        // Do safe exit (stores reward in ship's pending_mint_amount; no RequestMint yet)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_ANY_MESSAGE, MoveMode.EXIT);
        // After EXIT, RequestMint is NOT sent in same round; owner must trigger mint via RequestShipToMint


        const pendingAfterExit = await SC_System.ownerShip.getPendingMintAmount();
        expect(pendingAfterExit).toBeGreaterThanOrEqual(accumulatedAmount);

        // Owner triggers mint via RequestShipToMint
        SC_System.messageResult = await SC_System.ownerShip.sendRequestShipToMint(
            SC_System.ownerAccount.getSender(),
            GAS_COST_REQUEST_MINT
        );

        // Verify the complete message flow (from RequestShipToMint)
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerShip.address,
            to: SC_System.game.address,
            success: true,
            op: Opcodes.OP_REQUEST_MINT,
        });

        // New architecture: the game wraps ForwardMintRequest in an R1 to the
        // dumb-pipe GM (which forwards R2 -> R* -> R3). The game->GM hop therefore
        // carries op R1, not the inner FORWARD_MINT_REQUEST. (See request-ship-to-mint.)
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.game.address,
            to: SC_System.gameManager.address,
            success: true,
            op: GameManagerOpcodes.OP_R1,
        });

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.jettonMinter.address,
            success: true,
        });

        // Verify jettons were minted to user's jetton wallet (not ship's wallet)
        const finalJettonBalance = await userJettonWallet.getJettonBalance();
        expect(finalJettonBalance).toBeGreaterThan(initialJettonBalance);
        expect(finalJettonBalance).toBeGreaterThanOrEqual(initialJettonBalance+accumulatedAmount);

        // Verify jettons did NOT go to ship's jetton wallet
        const shipJettonWalletAddress = await SC_System.jettonMinter.getWalletAddress(SC_System.ownerShip.address);
        const shipJettonWallet = SC_System.blockchain.openContract(
            JettonWallet.createFromAddress(shipJettonWalletAddress)
        );
        const shipJettonBalance = await shipJettonWallet.getJettonBalance();
        expect(shipJettonBalance).toBe(0n); // Ship should have 0 jettons

        // Pending mint should be zero after RequestShipToMint
        const pendingAfterMint = await SC_System.ownerShip.getPendingMintAmount();
        expect(pendingAfterMint).toBe(0n);

        // Verify TransferNotification was sent to user (receiver)
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: userJettonWalletAddress,
            to: SC_System.ownerAccount.address, // user address
            success: true,
            op: GameManagerOpcodes.OP_TRANSFER_NOTIFICATION_FOR_RECIPIENT,
        });

        // Verify excesses were sent to receiver (user who gets jettons)
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: userJettonWalletAddress,
            to: SC_System.ownerAccount.address, // receiver (user) receives excesses
            success: true,
            op: Opcodes.OP_RETURN_EXCESSES_BACK,
        });
    });

    it('Test mint flow - verify jettons go to user wallet and excesses to receiver (may Fail)', async () => {
        // Do a few moves to accumulate some rewards
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TOTAL_GAS_TO_MOVE, MoveMode.UP);
        
        // Get accumulated amount
        let gameData = await SC_System.ownerShip.getCurrentGameData();
        const accumulatedAmount = gameData ? gameData.jettonAmount : 0n;
        expect(accumulatedAmount).toBeGreaterThan(0n);

        // Get wallet addresses
        const userJettonWalletAddress = await SC_System.jettonMinter.getWalletAddress(SC_System.ownerAccount.address);
        const shipJettonWalletAddress = await SC_System.jettonMinter.getWalletAddress(SC_System.ownerShip.address);
        
        const userJettonWallet = SC_System.blockchain.openContract(
            JettonWallet.createFromAddress(userJettonWalletAddress)
        );
        const shipJettonWallet = SC_System.blockchain.openContract(
            JettonWallet.createFromAddress(shipJettonWalletAddress)
        );

        // Get initial balances
        const initialUserBalance = await userJettonWallet.getJettonBalance();
        const initialShipBalance = await shipJettonWallet.getJettonBalance();

        // Get initial user TON balance to verify excesses
        const initialUserTonBalance = await SC_System.ownerAccount.getBalance();

        // Safe exit (stores pending_mint_amount; no RequestMint in same round)
        SC_System.messageResult = await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_ANY_MESSAGE, MoveMode.EXIT);
        // Owner triggers mint via RequestShipToMint
        SC_System.messageResult = await SC_System.ownerShip.sendRequestShipToMint(
            SC_System.ownerAccount.getSender(),
            GAS_COST_REQUEST_MINT
        );

        // Verify complete message chain (from RequestShipToMint)
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerShip.address,
            to: SC_System.game.address,
            success: true,
            op: Opcodes.OP_REQUEST_MINT,
        });

        // New architecture: the game wraps ForwardMintRequest in an R1 to the
        // dumb-pipe GM (which forwards R2 -> R* -> R3). The game->GM hop therefore
        // carries op R1, not the inner FORWARD_MINT_REQUEST. (See request-ship-to-mint.)
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.game.address,
            to: SC_System.gameManager.address,
            success: true,
            op: GameManagerOpcodes.OP_R1,
        });

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.jettonMinter.address,
            success: true,
        });

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.jettonMinter.address,
            to: userJettonWalletAddress,
            success: true,
        });

        // Verify jettons went to USER's wallet (not ship's wallet)
        const finalUserBalance = await userJettonWallet.getJettonBalance();
        expect(finalUserBalance).toBeGreaterThan(initialUserBalance);
        expect(finalUserBalance).toBeGreaterThanOrEqual(initialUserBalance + accumulatedAmount);

        // Verify jettons did NOT go to ship's wallet
        const finalShipBalance = await shipJettonWallet.getJettonBalance();
        expect(finalShipBalance).toBe(initialShipBalance); // Ship wallet should still have 0

        // Verify TransferNotification was sent to user
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: userJettonWalletAddress,
            to: SC_System.ownerAccount.address, // user (receiver)
            success: true,
            op: GameManagerOpcodes.OP_TRANSFER_NOTIFICATION_FOR_RECIPIENT,
        });

        // Verify excesses were sent to receiver (user who gets jettons)
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: userJettonWalletAddress,
            to: SC_System.ownerAccount.address, // receiver (user) receives excesses
            success: true,
            op: Opcodes.OP_RETURN_EXCESSES_BACK,
        });

        // Note: We don't check balance increase because user also spent TON on moves
        // The excesses transaction confirms that excesses were sent to the receiver
    });
});

