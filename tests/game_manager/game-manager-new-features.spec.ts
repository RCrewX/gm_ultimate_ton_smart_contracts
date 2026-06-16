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

    // Relay a SetGamesInfo to R* through GM. Named slots: active_game MUST equal the
    // ssm or ton_race_game slot; ubps is registration-only.
    async function setGamesInfo(info: {
        active_game: Address;
        ssm?: Address | null;
        ton_race_game?: Address | null;
        ubps?: Address | null;
    }) {
        return SC_System.gameManager.sendRedirectMessage(
            SC_System.ownerAccount.getSender(),
            toNano('1'),
            SC_System.retranslator.address,
            Retranslator.setGamesInfoMessage({
                active_game: info.active_game,
                ssm: info.ssm ?? null,
                ton_race_game: info.ton_race_game ?? null,
                ubps: info.ubps ?? null,
            }),
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
        SC_System.messageResult = await setGamesInfo({
            active_game: game.address,
            ton_race_game: game.address,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.retranslator.address,
            success: true,
        });

        const storedGamesInfo = await SC_System.retranslator.getGamesInfo();
        expect(storedGamesInfo).not.toBeNull();
        expect(storedGamesInfo?.active_game).toEqualAddress(game.address);
    });

    it('SetGamesInfo on R* - validation fails if active_game is not a reward slot', async () => {
        const game = SC_System.game;
        const otherGame = await SC_System.blockchain.treasury('otherGame');
        // active_game (game) is not present in either reward slot -> 929.
        SC_System.messageResult = await setGamesInfo({
            active_game: game.address,
            ssm: null,
            ton_race_game: otherGame.address,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.retranslator.address,
            success: false,
            exitCode: 929, // ERR_INVALID_GAMES_INFO
        });
    });

    // Replaces the former "7-game all_games list" structural test: the registry is
    // now NAMED SLOTS, so we set ssm + ton_race_game + ubps and read them back.
    it('SetGamesInfo on R* with named slots - verify structure', async () => {
        const game = SC_System.game;
        const ssmStandIn = await SC_System.blockchain.treasury('ssmGame');
        const ubpsStandIn = await SC_System.blockchain.treasury('ubpsMaster');

        SC_System.messageResult = await setGamesInfo({
            active_game: game.address,
            ssm: ssmStandIn.address,
            ton_race_game: game.address,
            ubps: ubpsStandIn.address,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.retranslator.address,
            success: true,
        });

        const storedGamesInfo = await SC_System.retranslator.getGamesInfo();
        expect(storedGamesInfo).not.toBeNull();
        expect(storedGamesInfo?.active_game).toEqualAddress(game.address);
        expect(storedGamesInfo?.ssm).toEqualAddress(ssmStandIn.address);
        expect(storedGamesInfo?.ton_race_game).toEqualAddress(game.address);
        expect(storedGamesInfo?.ubps).toEqualAddress(ubpsStandIn.address);
    });

    // Replaces the former "invalid first game" case: active_game must be a reward slot.
    it('SetGamesInfo on R* rejects an active_game that is not a reward slot (929)', async () => {
        const stranger = await SC_System.blockchain.treasury('stranger');
        SC_System.messageResult = await setGamesInfo({
            active_game: stranger.address, // matches neither ssm nor ton_race_game
            ssm: null,
            ton_race_game: SC_System.game.address,
        });
        expect(SC_System.messageResult.transactions).toHaveTransaction({
            from: SC_System.gameManager.address,
            to: SC_System.retranslator.address,
            success: false,
            exitCode: 929, // ERR_INVALID_GAMES_INFO
        });
    });
});
