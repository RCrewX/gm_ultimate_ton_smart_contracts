// SPDX-License-Identifier: UNLICENSED
import { Address, external, toNano } from '@ton/core';
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
const ERR_EXPIRED = 952;
const ERR_SESSION_EXPIRED = 953;
const ERR_WRONG_SHIP = 954;
const ERR_INVALID_MOVE_MODE = 956;
const ERR_BUDGET_EXHAUSTED = 957;
const ERR_INSUFFICIENT_FLOAT = 958;
const ERR_NO_SESSION = 960;

/**
 * Native session-key control in the Ship contract: the wallet owner authorises a browser
 * session key ONCE (internal SetSessionKey), after which the ship accepts Ed25519-signed
 * EXTERNAL messages for move/exit only — no wallet popup per move, no W5 extension. The
 * ship stays owned by userAddress; the session is the tightest possible authority.
 *
 * GM-B-005: the signed SessionMoveInner now binds the ship address FIRST, so a move signed
 * for ship A cannot be replayed against ship B even when B shares the same session key.
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
        shipAddress?: Address;
        seqno: number;
        validUntil: number;
        moveMode: number;
    }): Promise<number | undefined> {
        const body = buildShipSessionMoveExternal({
            sessionSecretKey: args.secretKey ?? sessionKp.secretKey,
            shipAddress: args.shipAddress ?? ship.address,
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
            shipAddress: ship.address,
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

    it('9) a move whose signed validUntil is not bound to THIS session is rejected (ERR_EXPIRED)', async () => {
        await authorise(NOW + 3600, 5);
        // Signed validUntil (NOW+7200) mismatches the stored sessionValidUntil (NOW+3600):
        // the signature is not bound to this session window, so it is rejected before accept.
        const exit = await sendExternal({ seqno: 0, validUntil: NOW + 7200, moveMode: MOVE_UP });
        expect(exit).toBe(ERR_EXPIRED);
        expect(await ship.getSessionSeqno()).toBe(0);
        await expectStillAtOrigin();
    });

    it('10) a ship whose float is below one move is rejected (ERR_INSUFFICIENT_FLOAT)', async () => {
        // A poor ship: deployed with barely any TON, so its float can never fund SESSION_MOVE_FLOAT (1 TON).
        // Distinct userAddress ⇒ distinct address (so it does not collide with the funded `ship`).
        const poorUser = await SC.blockchain.treasury('poorUser');
        const poorShip = SC.blockchain.openContract(
            Ship.createFromConfig(
                { userAddress: poorUser.address, gameAddress: SC.game.address, coordinateCellCode: SC.coordinateCellCode },
                SC.shipCode,
            ),
        );
        await poorShip.sendDeploy(poorUser.getSender(), toNano('0.3'));
        await poorShip.sendSetSessionKey(poorUser.getSender(), toNano('0.02'), {
            sessionPublicKey: sessionPub,
            validUntil: NOW + 3600,
            movesLeft: 5,
        });
        expect(await poorShip.getTonBalance()).toBeLessThan(toNano('1'));

        const body = buildShipSessionMoveExternal({
            sessionSecretKey: sessionKp.secretKey,
            shipAddress: poorShip.address,
            seqno: 0,
            validUntil: NOW + 3600,
            moveMode: MOVE_UP,
        });
        let exit: number | undefined;
        try {
            await SC.blockchain.sendMessage(external({ to: poorShip.address, body }));
            exit = undefined;
        } catch (e: any) {
            exit = e?.exitCode;
        }
        expect(exit).toBe(ERR_INSUFFICIENT_FLOAT);
        expect(await poorShip.getSessionSeqno()).toBe(0);
    });

    // GM-B-005 regression: two ships share the SAME session key (and sit at the same seqno /
    // validUntil). A move signed for ship #1 must be rejected by ship #2 — the signed
    // shipAddress binds the envelope to its ship, so a cross-instance replay is impossible.
    it('11) cross-instance replay: a valid move for ship #1 is rejected by ship #2 (ERR_WRONG_SHIP)', async () => {
        // Ship #1 = the default `ship` (userAddress = ownerAccount).
        await authorise(NOW + 3600, 5);

        // Ship #2 = a different ship (different userAddress ⇒ different address), authorised
        // with the SAME session key so the signature validates against it too.
        const user2 = await SC.blockchain.treasury('user2');
        const ship2 = SC.blockchain.openContract(
            Ship.createFromConfig(
                { userAddress: user2.address, gameAddress: SC.game.address, coordinateCellCode: SC.coordinateCellCode },
                SC.shipCode,
            ),
        );
        await ship2.sendDeploy(user2.getSender(), toNano('5'));
        await ship2.sendSetSessionKey(user2.getSender(), toNano('0.05'), {
            sessionPublicKey: sessionPub,
            validUntil: NOW + 3600,
            movesLeft: 5,
        });
        expect(ship2.address.equals(ship.address)).toBe(false);

        // A move signed for ship #1 (shipAddress = ship.address), delivered to ship #2.
        const bodyForShip1 = buildShipSessionMoveExternal({
            sessionSecretKey: sessionKp.secretKey,
            shipAddress: ship.address,
            seqno: 0,
            validUntil: NOW + 3600,
            moveMode: MOVE_UP,
        });
        let exit: number | undefined;
        try {
            await SC.blockchain.sendMessage(external({ to: ship2.address, body: bodyForShip1 }));
            exit = undefined;
        } catch (e: any) {
            exit = e?.exitCode;
        }
        expect(exit).toBe(ERR_WRONG_SHIP);
        // Ship #2 did not move / advance its seqno.
        expect(await ship2.getSessionSeqno()).toBe(0);

        // The same envelope IS valid for its own ship #1.
        const res = await SC.blockchain.sendMessage(external({ to: ship.address, body: bodyForShip1 }));
        expect(res.transactions).toHaveTransaction({ from: ship.address, op: Opcodes.OP_MOVE_SHIP_TO_CC, success: true });
        expect(await ship.getSessionSeqno()).toBe(1);
    });
});
