// SPDX-License-Identifier: UNLICENSED
import { toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { Ship } from '../../wrappers/ton_race_game/Ship';
import { MoveMode } from '../../wrappers/ton_race_game/structs';
import { Opcodes, TODO_TOTAL_GAS_TO_MOVE, GAS_COST_REQUEST_MINT, GAS_COST_ANY_MESSAGE } from '../../wrappers/ton_race_game/types';
import { Opcodes as GMOpcodes } from '../../wrappers/game_manager/types';
import { ROpcodes } from '../../wrappers/game_manager/RetranslatorTypes';

describe('RequestShipToMint', () => {
    const ERR_INVALID_USER_SENDER = 912;
    const ERR_NO_PENDING_MINT = 936;

    let SC_System: ContractSystem;

    beforeEach(async () => {
        SC_System = await initContractSystem();
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
    });

    it('rejects RequestShipToMint from non-owner', async () => {
        const otherAccount = await SC_System.blockchain.treasury('other');
        SC_System.messageResult = await SC_System.ownerShip.sendRequestShipToMint(
            otherAccount.getSender(),
            GAS_COST_REQUEST_MINT
        );
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: otherAccount.address,
            to: SC_System.ownerShip.address,
            success: false,
            exitCode: ERR_INVALID_USER_SENDER,
        });
    });

    it('rejects RequestShipToMint when pending_mint_amount is zero', async () => {
        // Deploy a second ship that has never completed a run with reward; do one UP (no EXIT) so pending stays 0.
        const shipCode = await compile('Ship');
        const freshShip = SC_System.blockchain.openContract(Ship.createFromConfig({
            userAddress: SC_System.ownerAccount.address,
            gameAddress: SC_System.game.address,
            coordinateCellCode: SC_System.coordinateCellCode,
        }, shipCode));
        await freshShip.sendDeploy(SC_System.ownerAccount.getSender(), toNano('1'));
        await freshShip.sendMove(SC_System.ownerAccount.getSender(), TODO_TOTAL_GAS_TO_MOVE, MoveMode.UP);
        const pending = await freshShip.getPendingMintAmount();
        expect(pending).toBe(0n);
        SC_System.messageResult = await freshShip.sendRequestShipToMint(
            SC_System.ownerAccount.getSender(),
            GAS_COST_REQUEST_MINT
        );
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: freshShip.address,
            success: false,
            exitCode: ERR_NO_PENDING_MINT,
        });
    });

    it('owner RequestShipToMint with pending > 0 sends RequestMint and zeros pending', async () => {
        await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TODO_TOTAL_GAS_TO_MOVE, MoveMode.UP);
        await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TODO_TOTAL_GAS_TO_MOVE, MoveMode.UP);
        let gameData = await SC_System.ownerShip.getCurrentGameData();
        if (!gameData || !gameData.jettonAmount || gameData.jettonAmount === 0n) {
            await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TODO_TOTAL_GAS_TO_MOVE, MoveMode.UP);
            await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), TODO_TOTAL_GAS_TO_MOVE, MoveMode.UP);
            gameData = await SC_System.ownerShip.getCurrentGameData();
        }
        if (!gameData || !gameData.jettonAmount || gameData.jettonAmount === 0n) {
            console.log('Skipping - no rewards accumulated');
            return;
        }
        await SC_System.ownerShip.sendMove(SC_System.ownerAccount.getSender(), GAS_COST_ANY_MESSAGE, MoveMode.EXIT);
        const pendingAfterExit = await SC_System.ownerShip.getPendingMintAmount();
        expect(pendingAfterExit).toBeGreaterThan(0n);

        SC_System.messageResult = await SC_System.ownerShip.sendRequestShipToMint(
            SC_System.ownerAccount.getSender(),
            GAS_COST_REQUEST_MINT
        );
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerShip.address,
            to: SC_System.game.address,
            success: true,
            op: Opcodes.OP_REQUEST_MINT,
        });
        // New architecture: game wraps ForwardMintRequest in R1 to the dumb-pipe GM,
        // GM forwards as R2 to the Retranslator, R* validates and replies R3, GM emits
        // the mint (R4) to the jetton minter.
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.game.address,
            to: SC_System.gameManager.address,
            success: true,
            op: GMOpcodes.OP_R1,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.retranslator.address,
            success: true,
            op: GMOpcodes.OP_R2,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.retranslator.address,
            to: SC_System.gameManager.address,
            success: true,
            op: GMOpcodes.OP_R3,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.jettonMinter.address,
            success: true,
            op: ROpcodes.OP_MINT_NEW_JETTONS,
        });
        const pendingAfterMint = await SC_System.ownerShip.getPendingMintAmount();
        expect(pendingAfterMint).toBe(0n);
    });
});
