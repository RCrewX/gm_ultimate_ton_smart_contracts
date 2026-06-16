// SPDX-License-Identifier: UNLICENSED
import { external, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { keyPairFromSeed } from '@ton/crypto';
import { Ship, buildShipSessionMoveExternal } from '../../wrappers/ton_race_game/Ship';
import { Opcodes } from '../../wrappers/ton_race_game/types';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';

// MoveMode: LEFT=0 UP=1 RIGHT=2 EXIT=3
const MOVE_UP = 1;
const NOW = 1_900_000_000;

// Native session error codes (contracts/ton_race_game/static/errors.tolk).
const ERR_INVALID_USER_SENDER = 912;
const ERR_INVALID_SIGNATURE = 950;
const ERR_BAD_SEQNO = 951;
const ERR_SESSION_EXPIRED = 953;
const ERR_INVALID_MOVE_MODE = 956;
const ERR_BUDGET_EXHAUSTED = 957;
const ERR_NO_SESSION = 960;

/**
 * Native session-key control in the Ship contract: the wallet owner authorises a browser
 * session key ONCE (internal SetSessionKey), after which the ship accepts Ed25519-signed
 * EXTERNAL messages for move/exit only — no wallet popup per move, no W5 extension. The
 * ship stays owned by userAddress; the session is the tightest possible authority.
 */
describe('Ship — native session-key move/exit (external-signed)', () => {
    let SC: ContractSystem;
    let ship: SandboxContract<Ship>;
    let sessionKp: { publicKey: Buffer; secretKey: Buffer };
    let wrongKp: { publicKey: Buffer; secretKey: Buffer };
    let sessionPub: bigint;

    beforeEach(async () => {
        SC = await initContractSystem();
        SC.blockchain.now = NOW;

        sessionKp = keyPairFromSeed(Buffer.alloc(32, 0x22));
        wrongKp = keyPairFromSeed(Buffer.alloc(32, 0x33));
        sessionPub = BigInt('0x' + sessionKp.publicKey.toString('hex'));

        // A fresh ship owned by the owner wallet (userAddress == ownerAccount), funded so it
        // can self-fund external moves from its float.
        ship = SC.blockchain.openContract(
            Ship.createFromConfig(
                {
                    userAddress: SC.ownerAccount.address,
                    gameAddress: SC.game.address,
                    coordinateCellCode: SC.coordinateCellCode,
                },
                SC.shipCode,
            ),
        );
        await ship.sendDeploy(SC.ownerAccount.getSender(), toNano('5'));
    }, 120000);

    afterEach(() => {
        cleanupContractSystem(SC);
        SC = null as any;
    });

    // Authorise a session (one internal, owner-signed message).
    async function authorise(validUntil: number, movesLeft: number) {
        await ship.sendSetSessionKey(SC.ownerAccount.getSender(), toNano('0.05'), {
            sessionPublicKey: sessionPub,
            validUntil,
            movesLeft,
        });
    }

    // A ship that has never completed a move sits at the origin. NOTE: a fresh ship's getter
    // reports a default {xy:(0,0), hp:100} (pre-existing behaviour: the get method materialises
    // a default GameFields even though storage is null) — so "did not move" means "still at (0,0)".
    async function expectStillAtOrigin() {
        const gd = await ship.getCurrentGameData();
        expect(gd).not.toBeNull();
        expect(gd!.xy.x).toBe(0n);
        expect(gd!.xy.y).toBe(0n);
    }

    // Send a session-signed external and return its exit code (undefined if accepted/succeeded).
    async function sendExternal(args: {
        secretKey?: Buffer;
        seqno: number;
        validUntil: number;
        moveMode: number;
    }): Promise<number | undefined> {
        const body = buildShipSessionMoveExternal({
            sessionSecretKey: args.secretKey ?? sessionKp.secretKey,
            seqno: args.seqno,
            validUntil: args.validUntil,
            moveMode: args.moveMode,
        });
        try {
            await SC.blockchain.sendMessage(external({ to: ship.address, body }));
            return undefined;
        } catch (e: any) {
            return e?.exitCode;
        }
    }

    it('1) happy: authorise then external move passes; seqno advances, budget decrements, ship moves', async () => {
        await authorise(NOW + 3600, 5);
        expect(await ship.getSessionPublicKey()).toBe(sessionPub);
        expect(await ship.getSessionSeqno()).toBe(0);
        expect(await ship.getSessionMovesLeft()).toBe(5);

        const balanceBefore = await ship.getTonBalance();

        const body = buildShipSessionMoveExternal({
            sessionSecretKey: sessionKp.secretKey,
            seqno: 0,
            validUntil: NOW + 3600,
            moveMode: MOVE_UP,
        });
        const res = await SC.blockchain.sendMessage(external({ to: ship.address, body }));

        // The move pipeline runs from the ship itself (funded by its float).
        expect(res.transactions).toHaveTransaction({
            from: ship.address,
            op: Opcodes.OP_MOVE_SHIP_TO_CC,
            success: true,
        });
        expect(res.transactions).toHaveTransaction({
            to: ship.address,
            op: Opcodes.OP_MOVE_END,
            success: true,
        });

        // Auto mode: the cashback stays ON the ship — MoveEnd must NOT refund the owner,
        // so the float is preserved for the next session move (no owner top-up between moves).
        expect(res.transactions).not.toHaveTransaction({
            from: ship.address,
            to: SC.ownerAccount.address,
            op: Opcodes.OP_RETURN_EXCESSES_BACK,
        });
        // The ship keeps (almost) all of its balance — only gas is burned, not a whole float
        // drained to the owner. (A drained move would drop the ship toward its storage floor.)
        const balanceAfter = await ship.getTonBalance();
        expect(balanceAfter).toBeGreaterThan(balanceBefore - toNano('0.5'));

        // Ship advanced (0,0) -> (0,1); the session metered the move.
        const gd = await ship.getCurrentGameData();
        expect(gd).not.toBeNull();
        expect(gd!.xy.x).toBe(0n);
        expect(gd!.xy.y).toBe(1n);
        expect(await ship.getSessionSeqno()).toBe(1);
        expect(await ship.getSessionMovesLeft()).toBe(4);
    });

    it('2) bad signature is rejected (ERR_INVALID_SIGNATURE) and the ship pays nothing', async () => {
        await authorise(NOW + 3600, 5);
        const balanceBefore = await ship.getTonBalance();

        const exit = await sendExternal({ secretKey: wrongKp.secretKey, seqno: 0, validUntil: NOW + 3600, moveMode: MOVE_UP });
        expect(exit).toBe(ERR_INVALID_SIGNATURE);

        // Rejected before acceptExternalMessage → no gas drain, no state change.
        expect(await ship.getTonBalance()).toBe(balanceBefore);
        expect(await ship.getSessionSeqno()).toBe(0);
        await expectStillAtOrigin();
    });

    it('3) replay of an already-used seqno is rejected (ERR_BAD_SEQNO)', async () => {
        await authorise(NOW + 3600, 5);
        // First move advances seqno 0 -> 1.
        expect(await sendExternal({ seqno: 0, validUntil: NOW + 3600, moveMode: MOVE_UP })).toBeUndefined();
        expect(await ship.getSessionSeqno()).toBe(1);

        // Resending seqno 0 is replayed → rejected.
        const exit = await sendExternal({ seqno: 0, validUntil: NOW + 3600, moveMode: MOVE_UP });
        expect(exit).toBe(ERR_BAD_SEQNO);
        expect(await ship.getSessionSeqno()).toBe(1);
    });

    it('4) an expired session can no longer move (ERR_SESSION_EXPIRED)', async () => {
        await authorise(NOW + 100, 5);
        // Warp past the session time-box.
        SC.blockchain.now = NOW + 200;
        const exit = await sendExternal({ seqno: 0, validUntil: NOW + 100, moveMode: MOVE_UP });
        expect(exit).toBe(ERR_SESSION_EXPIRED);
        expect(await ship.getSessionSeqno()).toBe(0);
        await expectStillAtOrigin();
    });

    it('5) the move budget is enforced (ERR_BUDGET_EXHAUSTED once movesLeft hits 0)', async () => {
        await authorise(NOW + 3600, 1);
        // Spend the only budgeted move.
        expect(await sendExternal({ seqno: 0, validUntil: NOW + 3600, moveMode: MOVE_UP })).toBeUndefined();
        expect(await ship.getSessionMovesLeft()).toBe(0);

        // Next external is over budget.
        const exit = await sendExternal({ seqno: 1, validUntil: NOW + 3600, moveMode: MOVE_UP });
        expect(exit).toBe(ERR_BUDGET_EXHAUSTED);
        expect(await ship.getSessionSeqno()).toBe(1);
    });

    it('6) scope: a session key cannot use a moveMode outside move/exit (ERR_INVALID_MOVE_MODE)', async () => {
        await authorise(NOW + 3600, 5);
        const exit = await sendExternal({ seqno: 0, validUntil: NOW + 3600, moveMode: 7 });
        expect(exit).toBe(ERR_INVALID_MOVE_MODE);
        expect(await ship.getSessionSeqno()).toBe(0);
    });

    it('7) revoke (SetSessionKey pubkey=0) kills the session (ERR_NO_SESSION)', async () => {
        await authorise(NOW + 3600, 5);
        // Revoke = SetSessionKey with sessionPublicKey 0.
        await ship.sendSetSessionKey(SC.ownerAccount.getSender(), toNano('0.05'), {
            sessionPublicKey: 0n,
            validUntil: 0,
            movesLeft: 0,
        });
        expect(await ship.getSessionPublicKey()).toBe(0n);

        const exit = await sendExternal({ seqno: 0, validUntil: NOW + 3600, moveMode: MOVE_UP });
        expect(exit).toBe(ERR_NO_SESSION);
        await expectStillAtOrigin();
    });

    it('8) SetSessionKey is userAddress-gated (ERR_INVALID_USER_SENDER for a stranger)', async () => {
        const stranger: SandboxContract<TreasuryContract> = await SC.blockchain.treasury('stranger');
        const res = await ship.sendSetSessionKey(stranger.getSender(), toNano('0.05'), {
            sessionPublicKey: sessionPub,
            validUntil: NOW + 3600,
            movesLeft: 5,
        });
        expect(res.transactions).toHaveTransaction({
            from: stranger.address,
            to: ship.address,
            success: false,
            exitCode: ERR_INVALID_USER_SENDER,
        });
        // No session was set.
        expect(await ship.getSessionPublicKey()).toBe(0n);
    });
});
