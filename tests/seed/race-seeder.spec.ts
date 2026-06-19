// SPDX-License-Identifier: UNLICENSED
/**
 * Sandbox proof of the race seeder's core sequence: deploy a pilot ship and run N NORMAL
 * moves along a direction, opening the first N cells of that lane. Mirrors the live seeder
 * (pilot signs deploy + every move). Verifies each of the 3 main lanes lands at the
 * position the seeder predicts (expectedPosition) and that lanes are independent (3 pilot
 * ships coexist on one game) — this replaces a live run for correctness.
 */
import { fromNano, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { Ship } from '../../wrappers/ton_race_game/Ship';
import { MoveMode } from '../../wrappers/ton_race_game/structs';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import {
    pilotShip, expectedPosition, directionMode,
    pilotFunding, RACE_MOVE_VALUE, RACE_SHIP_DEPLOY_VALUE,
} from '../../scripts/seed/raceModule';

describe('race seeder — pilots explore the 3 main lanes via normal moves', () => {
    let SC: ContractSystem;

    beforeEach(async () => {
        SC = await initContractSystem();
    }, 120000);

    afterEach(() => {
        cleanupContractSystem(SC);
        SC = null as any;
    });

    // Mirror the LIVE seeder exactly: deploy with RACE_SHIP_DEPLOY_VALUE, attach RACE_MOVE_VALUE
    // per move (the real constants, not hardcoded 5/1).
    async function runPilot(name: string, dirName: string, moves: number): Promise<SandboxContract<Ship>> {
        const dir = directionMode(dirName);
        const pilot: SandboxContract<TreasuryContract> = await SC.blockchain.treasury(name);
        const ship = SC.blockchain.openContract(pilotShip(pilot.address, SC.game.address, SC.shipCode, SC.coordinateCellCode));
        await ship.sendDeploy(pilot.getSender(), RACE_SHIP_DEPLOY_VALUE);
        for (let i = 0; i < moves; i++) {
            await ship.sendMove(pilot.getSender(), RACE_MOVE_VALUE, dir);
        }
        return ship;
    }

    it('UP / LEFT / RIGHT pilots land at the predicted positions (independent lanes)', async () => {
        const MOVES = 3;

        const upShip = await runPilot('pilotUp', 'UP', MOVES);
        const leftShip = await runPilot('pilotLeft', 'LEFT', MOVES);
        const rightShip = await runPilot('pilotRight', 'RIGHT', MOVES);

        const up = await upShip.getCurrentGameData();
        const left = await leftShip.getCurrentGameData();
        const right = await rightShip.getCurrentGameData();

        expect(up).not.toBeNull();
        expect(left).not.toBeNull();
        expect(right).not.toBeNull();

        const expUp = expectedPosition(MoveMode.UP, MOVES);
        const expLeft = expectedPosition(MoveMode.LEFT, MOVES);
        const expRight = expectedPosition(MoveMode.RIGHT, MOVES);

        expect(up!.xy).toEqual(expUp);
        expect(left!.xy).toEqual(expLeft);
        expect(right!.xy).toEqual(expRight);

        // y == moves done (the seeder's resume signal)
        expect(Number(up!.xy.y)).toBe(MOVES);
    });

    it('movesDone resumes from the ship position (y == count of moves)', async () => {
        const ship = await runPilot('pilotResume', 'UP', 2);
        const gd = await ship.getCurrentGameData();
        expect(Number(gd!.xy.y)).toBe(2);

        // one more move continues the lane to y=3 (idempotent resume continues here)
        await ship.sendMove((await SC.blockchain.treasury('pilotResume')).getSender(), RACE_MOVE_VALUE, MoveMode.UP);
        const gd2 = await ship.getCurrentGameData();
        expect(Number(gd2!.xy.y)).toBe(3);
    });

    // The funding gate: prove the right-sized pilotFunding() actually completes a full pilot run
    // (deploy + every move, no insufficient-funds / 607) AND is not ~3× over-provisioned. A pilot
    // wallet funded with EXACTLY pilotFunding(MOVES, true) must finish; the leftover (recoverable
    // balance left holding) must be small — i.e. we anchored to real consumption, not over-funded.
    it('a wallet funded with exactly pilotFunding() completes deploy + all moves, with small leftover', async () => {
        const MOVES = 10;
        const FUND = pilotFunding(MOVES, true);

        // A treasury seeded with EXACTLY the seeder's hold-requirement — if the model under-funds,
        // a deploy/move send would throw (cannot afford); if it lands, FUND is sufficient.
        const pilot = await SC.blockchain.treasury('pilotFunded', { balance: FUND });
        const ship = SC.blockchain.openContract(pilotShip(pilot.address, SC.game.address, SC.shipCode, SC.coordinateCellCode));

        const before = await pilot.getBalance();
        await ship.sendDeploy(pilot.getSender(), RACE_SHIP_DEPLOY_VALUE);
        for (let i = 0; i < MOVES; i++) {
            await ship.sendMove(pilot.getSender(), RACE_MOVE_VALUE, MoveMode.UP);
        }
        const after = await pilot.getBalance();

        const gd = await ship.getCurrentGameData();
        // (a) every move landed — no 607 / insufficient-funds mid-run.
        expect(Number(gd!.xy.y)).toBe(MOVES);

        // Measured net consumption (gas burned + new-cell storage lock; the move value recycles).
        const consumed = before - after;
        const leftover = after; // recoverable balance left holding in the pilot wallet
        // eslint-disable-next-line no-console
        console.log(`[funding] FUND=${fromNano(FUND)} consumed=${fromNano(consumed)} leftover=${fromNano(leftover)} (${MOVES} moves)`);

        // (b) the estimate genuinely covers real consumption (not under-funded) — with a healthy
        //     margin: real burn is ~1.2 TON, so FUND must comfortably exceed it ...
        expect(consumed).toBeLessThan(FUND);
        expect(consumed * 2n).toBeLessThan(FUND); // ≥2× cushion over measured consumption
        // ... and is NOT over-provisioned: the recoverable balance left holding is small (the
        //     working-capital + buffer cushion, not a ~3× pile).
        expect(leftover).toBeLessThan(toNano('2'));
        // sanity: FUND for 3 pilots × 10 moves is an order below the old ~48 TON, in a tight band.
        expect(FUND * 3n).toBeLessThan(toNano('12'));
        expect(FUND * 3n).toBeGreaterThan(toNano('6'));
    });
});
