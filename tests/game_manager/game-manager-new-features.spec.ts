// SPDX-License-Identifier: UNLICENSED
import { beginCell, toNano, Address } from '@ton/core';
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { GAS_COST_SET_RETRANSLATOR } from '../../wrappers/game_manager/types';
import { Retranslator } from '../../wrappers/game_manager/Retranslator';

// New-architecture GM/R* features:
//  - SetRetranslator points the dumb-pipe GM at the swappable brain (owner-only).
//  - Games/jetton registries live on R*, configured via GM.RedirectMessage relay.
describe('GameManager New Features (Retranslator wiring)', () => {
    let SC_System: ContractSystem;
    beforeEach(async () => {
        SC_System = await initContractSystem();
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
    });

    // Relay a SetGamesInfo to R* through GM.
    async function setGamesInfo(active_game: Address, all_games: any) {
        return SC_System.gameManager.sendRedirectMessage(
            SC_System.ownerAccount.getSender(),
            toNano('1'),
            SC_System.retranslator.address,
            Retranslator.setGamesInfoMessage({ active_game, all_games }),
            toNano('0.9'),
        );
    }

    it('SetRetranslator - owner can repoint GM at a new retranslator address', async () => {
        const newR = await SC_System.blockchain.treasury('newRetranslator');
        SC_System.messageResult = await SC_System.gameManager.sendSetRetranslator(
            SC_System.ownerAccount.getSender(),
            GAS_COST_SET_RETRANSLATOR + toNano('0.05'),
            newR.address,
        );
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: SC_System.gameManager.address,
            success: true,
        });
        expect(await SC_System.gameManager.getRetranslatorAddress()).toEqualAddress(newR.address);
    });

    it('SetRetranslator - non-owner is rejected', async () => {
        const nonOwner = await SC_System.blockchain.treasury('nonOwner');
        const before = await SC_System.gameManager.getRetranslatorAddress();
        SC_System.messageResult = await SC_System.gameManager.sendSetRetranslator(
            nonOwner.getSender(),
            GAS_COST_SET_RETRANSLATOR + toNano('0.05'),
            nonOwner.address,
        );
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: nonOwner.address,
            to: SC_System.gameManager.address,
            success: false,
            exitCode: 920, // ERR_INVALID_OWNER_SENDER
        });
        // Unchanged.
        expect(await SC_System.gameManager.getRetranslatorAddress()).toEqualAddress(before);
    });

    it('SetGamesInfo on R* (via redirect) - owner can set games info with validation', async () => {
        const game = SC_System.game;
        const allGamesCell = beginCell()
            .storeUint(1, 2).storeAddress(game.address) // active_game (first)
            .storeUint(1, 2).storeAddress(game.address) // second game (same for test)
            .storeUint(0, 2)
            .endCell();

        SC_System.messageResult = await setGamesInfo(game.address, allGamesCell);
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.retranslator.address,
            success: true,
        });

        const storedGamesInfo = await SC_System.retranslator.getGamesInfo();
        expect(storedGamesInfo).not.toBeNull();
        expect(storedGamesInfo?.active_game).toEqualAddress(game.address);
    });

    it('SetGamesInfo on R* - validation fails if first game is not active_game', async () => {
        const game = SC_System.game;
        const otherGame = await SC_System.blockchain.treasury('otherGame');
        const allGamesCell = beginCell()
            .storeUint(1, 2).storeAddress(otherGame.address) // wrong first game
            .storeUint(0, 2)
            .endCell();

        SC_System.messageResult = await setGamesInfo(game.address, allGamesCell);
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.retranslator.address,
            success: false,
            exitCode: 929, // ERR_INVALID_GAMES_INFO
        });
    });

    it('SetGamesInfo on R* with 7 games - verify structure', async () => {
        const game = SC_System.game;
        const games: Address[] = [game.address];
        for (let i = 1; i < 7; i++) {
            const gameTreasury = await SC_System.blockchain.treasury(`game${i}`);
            games.push(gameTreasury.address);
        }

        const firstCell = beginCell()
            .storeUint(1, 2).storeAddress(games[0])
            .storeUint(1, 2).storeAddress(games[1])
            .storeUint(2, 2) // go to ref
            .endCell();
        const secondCell = beginCell()
            .storeUint(1, 2).storeAddress(games[2])
            .storeUint(1, 2).storeAddress(games[3])
            .storeUint(1, 2).storeAddress(games[4])
            .storeUint(2, 2) // go to ref
            .endCell();
        const thirdCell = beginCell()
            .storeUint(1, 2).storeAddress(games[5])
            .storeUint(1, 2).storeAddress(games[6])
            .storeUint(0, 2)
            .endCell();
        const secondCellWithRef = beginCell().storeBuilder(secondCell.asBuilder()).storeRef(thirdCell).endCell();
        const allGamesCell = beginCell().storeBuilder(firstCell.asBuilder()).storeRef(secondCellWithRef).endCell();

        SC_System.messageResult = await setGamesInfo(games[0], allGamesCell);
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.retranslator.address,
            success: true,
        });

        const storedGamesInfo = await SC_System.retranslator.getGamesInfo();
        expect(storedGamesInfo).not.toBeNull();
        expect(storedGamesInfo?.active_game).toEqualAddress(games[0]);

        const allGamesSlice = storedGamesInfo!.all_games.beginParse();
        expect(allGamesSlice.loadUint(2)).toBe(1);
        expect(allGamesSlice.loadAddress()).toEqualAddress(games[0]);
        expect(allGamesSlice.loadUint(2)).toBe(1);
        expect(allGamesSlice.loadAddress()).toEqualAddress(games[1]);
    });
});
