// SPDX-License-Identifier: UNLICENSED
//
// Part A (ship-ton-economics-fix, 2026-06-22): WithdrawExcessTON — owner reclaim of the ship's
// surplus standing balance. Owner-WALLET only (never a session key — the external session path
// only decodes move/exit, so a session key can never form this internal op). The ship keeps
// WITHDRAW_KEEP_AMOUNT and sends the rest back to userAddress; game state is untouched.
import { Cell, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { Opcodes, WITHDRAW_KEEP_AMOUNT, GAS_COST_WITHDRAW } from '../../wrappers/ton_race_game/types';

// Exit codes (contracts/ton_race_game/static/errors.tolk)
const ERR_INVALID_USER_SENDER = 912;
const ERR_MESSAGE_VALUE_TOO_LOW = 904;
const ERR_NOT_ENOUGH_BALANCE = 706;

describe('Ship - WithdrawExcessTON (Part A)', () => {
    let SC_System: ContractSystem;
    let otherUser: SandboxContract<TreasuryContract>;

    beforeEach(async () => {
        SC_System = await initContractSystem();
        otherUser = await SC_System.blockchain.treasury('otherUser');
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(SC_System);
        SC_System = null as any;
        otherUser = null as any;
    });

    it('owner reclaim: succeeds, refunds surplus to owner, leaves ~WITHDRAW_KEEP_AMOUNT, game state untouched', async () => {
        const ship = SC_System.ownerShip;
        // Top the ship up so it carries a clear surplus above the keep floor.
        await SC_System.ownerAccount.send({ to: ship.address, value: toNano('3'), body: Cell.EMPTY });

        const gameBefore = await ship.getCurrentGameData();
        const balanceBefore = await ship.getTonBalance();
        expect(balanceBefore).toBeGreaterThan(WITHDRAW_KEEP_AMOUNT);

        const res = await ship.sendWithdrawExcessTON(SC_System.ownerAccount.getSender(), toNano('0.1'));

        expect(res.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: ship.address,
            success: true,
            op: Opcodes.OP_WITHDRAW_EXCESS_TON,
        });
        // Surplus sent back to the owner wallet (ReturnExcessesBack body).
        expect(res.transactions).toHaveTransaction({
            from: ship.address,
            to: SC_System.ownerAccount.address,
            success: true,
            op: Opcodes.OP_RETURN_EXCESSES_BACK,
        });

        // Ship is left holding exactly the keep floor (reserve is EXACT-amount).
        const balanceAfter = await ship.getTonBalance();
        expect(balanceAfter).toBeGreaterThanOrEqual(WITHDRAW_KEEP_AMOUNT - toNano('0.01'));
        expect(balanceAfter).toBeLessThanOrEqual(WITHDRAW_KEEP_AMOUNT + toNano('0.02'));

        // Game state (position / HP / rewards) is untouched.
        const gameAfter = await ship.getCurrentGameData();
        expect(gameAfter?.xy.x).toBe(gameBefore?.xy.x);
        expect(gameAfter?.xy.y).toBe(gameBefore?.xy.y);
        expect(gameAfter?.hp).toBe(gameBefore?.hp);
        expect(await ship.getMovementInProcess()).toBe(false);
    });

    it('non-owner is rejected (ERR_INVALID_USER_SENDER) and no funds leave the ship', async () => {
        const ship = SC_System.ownerShip;
        await SC_System.ownerAccount.send({ to: ship.address, value: toNano('3'), body: Cell.EMPTY });
        const balanceBefore = await ship.getTonBalance();

        const res = await ship.sendWithdrawExcessTON(otherUser.getSender(), toNano('0.1'));

        expect(res.transactions).toHaveTransaction({
            from: otherUser.address,
            to: ship.address,
            success: false,
            op: Opcodes.OP_WITHDRAW_EXCESS_TON,
            exitCode: ERR_INVALID_USER_SENDER,
        });
        // Nothing was withdrawn (balance only grew by the incoming gas, never dropped).
        const balanceAfter = await ship.getTonBalance();
        expect(balanceAfter).toBeGreaterThanOrEqual(balanceBefore);
    });

    it('value below GAS_COST_WITHDRAW is rejected (ERR_MESSAGE_VALUE_TOO_LOW)', async () => {
        const ship = SC_System.ownerShip;
        await SC_System.ownerAccount.send({ to: ship.address, value: toNano('3'), body: Cell.EMPTY });

        const res = await ship.sendWithdrawExcessTON(
            SC_System.ownerAccount.getSender(),
            GAS_COST_WITHDRAW - toNano('0.005')
        );

        expect(res.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: ship.address,
            success: false,
            op: Opcodes.OP_WITHDRAW_EXCESS_TON,
            exitCode: ERR_MESSAGE_VALUE_TOO_LOW,
        });
    });

    it('no reclaimable surplus (balance at the keep floor) is rejected (ERR_NOT_ENOUGH_BALANCE)', async () => {
        const ship = SC_System.ownerShip;
        // First drain down to the keep floor with a valid withdraw.
        await SC_System.ownerAccount.send({ to: ship.address, value: toNano('3'), body: Cell.EMPTY });
        await ship.sendWithdrawExcessTON(SC_System.ownerAccount.getSender(), toNano('0.1'));
        const atFloor = await ship.getTonBalance();
        expect(atFloor).toBeLessThanOrEqual(WITHDRAW_KEEP_AMOUNT + toNano('0.02'));

        // A second withdraw now finds no surplus above the floor.
        const res = await ship.sendWithdrawExcessTON(SC_System.ownerAccount.getSender(), toNano('0.05'));

        expect(res.transactions).toHaveTransaction({
            from: SC_System.ownerAccount.address,
            to: ship.address,
            success: false,
            op: Opcodes.OP_WITHDRAW_EXCESS_TON,
            exitCode: ERR_NOT_ENOUGH_BALANCE,
        });
    });
});
