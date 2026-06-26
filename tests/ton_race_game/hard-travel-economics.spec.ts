// SPDX-License-Identifier: UNLICENSED
//
// Step-0 MEASUREMENT (ship-ton-economics-fix, 2026-06-22).
// Quantifies, per hard travel, where the inbound TON ends up:
//   - valueSent       : TON the client sent with RequestToHardTravel
//   - shipDelta       : change in the ship's STANDING balance (after - before)
//   - refundToOwner    : TON returned to the owner wallet (HardTravelMoveEnd cashback)
//   - elsewhere       : valueSent - refundToOwner - shipDelta  (gas burned + per-cell storage tax)
//
// FINDING (measured): a hard travel does NOT trap the large unspent fuel on the ship.
// RequestToHardTravel reserveValue()s the standing balance and carries ALL fuel into the walk;
// HardTravelMoveEnd reserveValue()s the standing balance again and refunds the surviving fuel to
// the owner. reserveValue() reserves (standingBalance + BASIC_STORAGE_TAX), so each of its two
// invocations per hard travel leaves one extra storage-tax on the ship => the ship grows by
// exactly 2 * BASIC_STORAGE_TAX (~0.02 TON) per travel. That growth is the intended gas-safety
// floor (keeps the contract storage-solvent) and is small + bounded + reclaimable via
// WithdrawExcessTON (Part A). The bulk leftover (gas burned + per-visited-cell storage tax)
// lands in the intermediate coordinate cells — NOT on the ship (withdraw-from-cell already
// exists on coordinate_cell). Hence Part B needs only the floor right-size, no refund repair.
// These tests pin shipDelta to ~2*tax and prove the right-sized HARD_TRAVEL_MIN_VALUE still
// funds a full maxTurns walk.
import { Address, toNano } from '@ton/core';
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { MoveMode, type HardTravelInfo } from '../../wrappers/ton_race_game/structs';
import { Opcodes, HARD_TRAVEL_MIN_VALUE } from '../../wrappers/ton_race_game/types';

const TWO_STORAGE_TAX = toNano('0.02');

describe('Hard Travel - economics (Step-0 measurement)', () => {
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

    // Sum the TON carried by internal messages ship -> owner (the HardTravelMoveEnd cashback).
    function refundToOwner(txs: any[], shipAddr: Address, ownerAddr: Address): bigint {
        let sum = 0n;
        for (const tx of txs) {
            const info = tx.inMessage?.info;
            if (info?.type === 'internal' && info.src?.equals(shipAddr) && info.dest?.equals(ownerAddr)) {
                sum += info.value.coins as bigint;
            }
        }
        return sum;
    }

    const fmt = (n: bigint) => (Number(n) / 1e9).toFixed(6);

    async function measure(label: string, info: HardTravelInfo, value: bigint) {
        const ship = SC_System.ownerShip;
        const owner = SC_System.ownerAccount.address;

        const shipBefore = await ship.getTonBalance();
        const res = await ship.sendHardTravel(SC_System.ownerAccount.getSender(), value, info);
        const shipAfter = await ship.getTonBalance();

        const shipDelta = shipAfter - shipBefore;
        const refund = refundToOwner((res as any).transactions, ship.address, owner);
        const elsewhere = value - refund - shipDelta;

        // The walk must complete (movement flag cleared, HardTravelMoveEnd landed on the ship).
        expect((res as any).transactions).toHaveTransaction({
            to: ship.address,
            success: true,
            op: Opcodes.OP_HARD_TRAVEL_MOVE_END,
        });
        expect(await ship.getMovementInProcess()).toBe(false);

        // eslint-disable-next-line no-console
        console.log(
            `[hard-travel] ${label.padEnd(34)} | sent=${fmt(value)} | shipDelta=${fmt(shipDelta)} ` +
                `| refundToOwner=${fmt(refund)} | elsewhere(gas+cells)=${fmt(elsewhere)}`
        );

        return { shipBefore, shipAfter, shipDelta, refund, elsewhere };
    }

    it('UP maxTurns=0 (1 hop) — ship grows only by the bounded gas-safety tax, fuel refunded', async () => {
        const m = await measure('UP maxTurns=0', makeHardTravelInfo({ mode: MoveMode.UP, maxTurns: 0 }), HARD_TRAVEL_MIN_VALUE + toNano('1'));
        // The ship retains (≈) its prior standing balance — a hard travel must not accumulate TON on it.
        // Ship grows by at most the bounded gas-safety margin (~2 * storage tax), never by the
        // large unspent fuel — that proves the fuel is refunded, not trapped on the ship.
        expect(m.shipDelta).toBeGreaterThanOrEqual(0n);
        expect(m.shipDelta).toBeLessThanOrEqual(TWO_STORAGE_TAX + toNano('0.005'));
        // The bulk of the fuel comes back to the owner.
        expect(m.refund).toBeGreaterThan(toNano('0.8'));
    });

    it('UP maxTurns=3 (up to 4 hops) — leftover lands off-ship (cells), ship grows only ~2*tax', async () => {
        const m = await measure('UP maxTurns=3', makeHardTravelInfo({ mode: MoveMode.UP, maxTurns: 3 }), HARD_TRAVEL_MIN_VALUE + toNano('1'));
        // Ship grows by at most the bounded gas-safety margin (~2 * storage tax), never by the
        // large unspent fuel — that proves the fuel is refunded, not trapped on the ship.
        expect(m.shipDelta).toBeGreaterThanOrEqual(0n);
        expect(m.shipDelta).toBeLessThanOrEqual(TWO_STORAGE_TAX + toNano('0.005'));
        expect(m.refund).toBeGreaterThan(toNano('0.5'));
    });

    it('LEFT maxTurns=2 — ship grows only ~2*tax', async () => {
        const m = await measure('LEFT maxTurns=2', makeHardTravelInfo({ mode: MoveMode.LEFT, maxTurns: 2 }), HARD_TRAVEL_MIN_VALUE + toNano('1'));
        // Ship grows by at most the bounded gas-safety margin (~2 * storage tax), never by the
        // large unspent fuel — that proves the fuel is refunded, not trapped on the ship.
        expect(m.shipDelta).toBeGreaterThanOrEqual(0n);
        expect(m.shipDelta).toBeLessThanOrEqual(TWO_STORAGE_TAX + toNano('0.005'));
    });

    it('RIGHT maxTurns=2 — ship grows only ~2*tax', async () => {
        const m = await measure('RIGHT maxTurns=2', makeHardTravelInfo({ mode: MoveMode.RIGHT, maxTurns: 2 }), HARD_TRAVEL_MIN_VALUE + toNano('1'));
        // Ship grows by at most the bounded gas-safety margin (~2 * storage tax), never by the
        // large unspent fuel — that proves the fuel is refunded, not trapped on the ship.
        expect(m.shipDelta).toBeGreaterThanOrEqual(0n);
        expect(m.shipDelta).toBeLessThanOrEqual(TWO_STORAGE_TAX + toNano('0.005'));
    });

    it('at the right-sized floor HARD_TRAVEL_MIN_VALUE — a maxTurns=3 walk still completes', async () => {
        // Send exactly the new minimum; the walk must still chain to HardTravelMoveEnd and clear.
        const m = await measure('floor exactly, maxTurns=3', makeHardTravelInfo({ mode: MoveMode.UP, maxTurns: 3 }), HARD_TRAVEL_MIN_VALUE);
        // No accumulation even at the floor.
        // Ship grows by at most the bounded gas-safety margin (~2 * storage tax), never by the
        // large unspent fuel — that proves the fuel is refunded, not trapped on the ship.
        expect(m.shipDelta).toBeGreaterThanOrEqual(0n);
        expect(m.shipDelta).toBeLessThanOrEqual(TWO_STORAGE_TAX + toNano('0.005'));
    });
});
