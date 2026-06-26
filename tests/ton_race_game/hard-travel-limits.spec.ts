// SPDX-License-Identifier: UNLICENSED
import { beginCell, toNano, fromNano } from '@ton/core';
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem, buildJettonUsageForwardPayload } from '../test_utils';
import { MoveMode, type HardTravelInfo } from '../../wrappers/ton_race_game/structs';
import { Opcodes, HARD_TRAVEL_MIN_VALUE, JettonUsageMode, BASIC_SHIP_HP } from '../../wrappers/ton_race_game/types';
import { Opcodes as GameManagerOpcodes } from '../../wrappers/game_manager/types';
import { JettonWallet } from '../../wrappers/tep/jetton/JettonWallet';

describe('Hard Travel - Limits', () => {
    let SC_System: ContractSystem;

    beforeEach(async () => {
        SC_System = await initContractSystem();
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
    });

    function makeHardTravelInfo(overrides: Partial<HardTravelInfo> = {}): HardTravelInfo {
        return {
            mode: MoveMode.UP,
            gasLimit: toNano('2'),
            hpLimit: 1n,
            maxTurns: 3,
            ...overrides,
        };
    }

    it('end by maxTurns (maxTurns=0): 1 move then HardTravelMoveEnd', async () => {
        const info = makeHardTravelInfo({ maxTurns: 0 });
        const value = HARD_TRAVEL_MIN_VALUE + toNano('1');

        SC_System.messageResult = await SC_System.ownerShip.sendHardTravel(
            SC_System.ownerAccount.getSender(),
            value,
            info
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_HARD_TRAVEL_MOVE_END,
        });
        expect(await SC_System.ownerShip.getMovementInProcess()).toBe(false);
        const gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        expect(gameData!.xy.y).toBe(1n);
    });

    it('end by maxTurns (maxTurns=2): 3 moves then HardTravelMoveEnd, final y=3', async () => {
        const info = makeHardTravelInfo({ maxTurns: 2 });
        // The walk continues only while carried value >= info.gasLimit (coordinate_cell.tolk),
        // so to make maxTurns (not gas) the limiter the value must stay above gasLimit across all
        // 3 hops. Size it off gasLimit (per-hop burn is ~0.02 TON), NOT the right-sized floor.
        const value = info.gasLimit + toNano('1.5');

        SC_System.messageResult = await SC_System.ownerShip.sendHardTravel(
            SC_System.ownerAccount.getSender(),
            value,
            info
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_HARD_TRAVEL_MOVE_END,
        });
        expect(await SC_System.ownerShip.getMovementInProcess()).toBe(false);
        const gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        expect(gameData!.xy.y).toBe(3n);
    });

    it('end by maxTurns (maxTurns=99): mint/upgrade ship HP, high gas, trip runs 100 moves then ends by turns', async () => {
        const initialGameData = await SC_System.ownerShip.getCurrentGameData();
        const initialHP = initialGameData?.hp ?? BASIC_SHIP_HP;

        const gameManagerJettonWalletAddress = await SC_System.jettonMinter.getWalletAddress(SC_System.gameManager.address);
        const gameManagerJettonWallet = SC_System.blockchain.openContract(
            JettonWallet.createFromAddress(gameManagerJettonWalletAddress)
        );

        const ownerBalance = await SC_System.ownerJettonWallet.getJettonBalance();
        expect(ownerBalance).toBeGreaterThan(0n);

        const transferAmount = toNano('200');
        const forwardPayload = buildJettonUsageForwardPayload(
            SC_System.game.address,
            SC_System.ownerShip.address,
            JettonUsageMode.SHIP_UPGRADE
        );

        for (let i = 0; i < 3; i++) {
            SC_System.messageResult = await SC_System.ownerJettonWallet.sendTransfer(
                SC_System.ownerAccount.getSender(),
                toNano('0.2'),
                transferAmount,
                SC_System.gameManager.address,
                SC_System.ownerAccount.address,
                beginCell().endCell(),
                toNano('0.1'),
                forwardPayload
            );
            expect(SC_System.messageResult.transactions).toHaveTransaction({
                from: gameManagerJettonWallet.address,
                to: SC_System.gameManager.address,
                success: true,
                op: GameManagerOpcodes.OP_TRANSFER_NOTIFICATION_FOR_RECIPIENT,
            });
            expect(SC_System.messageResult.transactions).toHaveTransaction({
                from: SC_System.game.address,
                to: SC_System.ownerShip.address,
                success: true,
                op: Opcodes.OP_SHIP_UPGRADE,
            });
        }

        const afterUpgrades = await SC_System.ownerShip.getCurrentGameData();
        expect(afterUpgrades).not.toBeNull();
        expect(afterUpgrades!.hp).toBeGreaterThan(initialHP);

        const info = makeHardTravelInfo({
            maxTurns: 99,
            gasLimit: toNano('5'),
            hpLimit: 1n,
        });
        const value = HARD_TRAVEL_MIN_VALUE + toNano('15');

        const initialBalance = await SC_System.ownerAccount.getBalance();
        SC_System.messageResult = await SC_System.ownerShip.sendHardTravel(
            SC_System.ownerAccount.getSender(),
            value,
            info
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_HARD_TRAVEL_MOVE_END,
        });
        expect(await SC_System.ownerShip.getMovementInProcess()).toBe(false);

        const gameData = await SC_System.ownerShip.getCurrentGameData();
        expect(gameData).not.toBeNull();
        expect(gameData!.xy.x).toBe(0n);
        // maxTurns=99: we process turnIndex 0..99 (100 moves), so final y = 100
        expect(gameData!.xy.y).toBe(100n);

        const finalBalance = await SC_System.ownerAccount.getBalance();
        const gasUsed = initialBalance - finalBalance;
        expect(gasUsed).toBeLessThanOrEqual(value);
        expect(gasUsed).toBeGreaterThan(0n);

        expect(gameData!.hp).toBeGreaterThan(0n);

        const gasUsedTon = fromNano(gasUsed);
        const valueTon = fromNano(value);
        console.log(`HardTravel maxTurns=99 (100 moves): gas used ${gasUsedTon} TON (value sent ${valueTon} TON), final (${gameData!.xy.x}, ${gameData!.xy.y}), ship HP ${gameData!.hp}`);
    });

    it('end by gasLimit (low gas): trip ends when remaining value < gasLimit', async () => {
        const info = makeHardTravelInfo({ gasLimit: toNano('1.05') });
        const value = HARD_TRAVEL_MIN_VALUE + toNano('0.1');

        SC_System.messageResult = await SC_System.ownerShip.sendHardTravel(
            SC_System.ownerAccount.getSender(),
            value,
            info
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_HARD_TRAVEL_MOVE_END,
        });
        expect(await SC_System.ownerShip.getMovementInProcess()).toBe(false);
    });

    it('end by hpLimit: trip ends when ship_hp < hpLimit', async () => {
        const info = makeHardTravelInfo({ hpLimit: 50n, maxTurns: 10, gasLimit: toNano('3') });
        const value = HARD_TRAVEL_MIN_VALUE + toNano('2');

        SC_System.messageResult = await SC_System.ownerShip.sendHardTravel(
            SC_System.ownerAccount.getSender(),
            value,
            info
        );

        expect(SC_System.messageResult.transactions).toHaveTransaction({
            to: SC_System.ownerShip.address,
            success: true,
            op: Opcodes.OP_HARD_TRAVEL_MOVE_END,
        });
        expect(await SC_System.ownerShip.getMovementInProcess()).toBe(false);
    });
});
