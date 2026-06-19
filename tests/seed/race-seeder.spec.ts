// SPDX-License-Identifier: UNLICENSED
/**
 * Sandbox proof of the race seeder's core sequence: deploy a pilot ship and run N NORMAL
 * moves along a direction, opening the first N cells of that lane. Mirrors the live seeder
 * (pilot signs deploy + every move). Verifies each of the 3 main lanes lands at the
 * position the seeder predicts (expectedPosition) and that lanes are independent (3 pilot
 * ships coexist on one game) — this replaces a live run for correctness.
 */
import { toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { Ship } from '../../wrappers/ton_race_game/Ship';
import { MoveMode } from '../../wrappers/ton_race_game/structs';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { pilotShip, expectedPosition, directionMode } from '../../scripts/seed/raceModule';

describe('race seeder — pilots explore the 3 main lanes via normal moves', () => {
    let SC: ContractSystem;

    beforeEach(async () => {
        SC = await initContractSystem();
    }, 120000);

    afterEach(() => {
        cleanupContractSystem(SC);
        SC = null as any;
    });

    async function runPilot(name: string, dirName: string, moves: number): Promise<SandboxContract<Ship>> {
        const dir = directionMode(dirName);
        const pilot: SandboxContract<TreasuryContract> = await SC.blockchain.treasury(name);
        const ship = SC.blockchain.openContract(pilotShip(pilot.address, SC.game.address, SC.shipCode, SC.coordinateCellCode));
        await ship.sendDeploy(pilot.getSender(), toNano('5'));
        for (let i = 0; i < moves; i++) {
            await ship.sendMove(pilot.getSender(), toNano('1'), dir);
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
        await ship.sendMove((await SC.blockchain.treasury('pilotResume')).getSender(), toNano('1'), MoveMode.UP);
        const gd2 = await ship.getCurrentGameData();
        expect(Number(gd2!.xy.y)).toBe(3);
    });
});
