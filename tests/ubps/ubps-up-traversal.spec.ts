// SPDX-License-Identifier: UNLICENSED
// Mechanic: UP (Unit Pointer) traversal message-flow —
//   owner -UP-> Unit -UP-> ... -UP-> Unit -UP-> BS, BS refunds the original owner.
// A Unit forwards the SAME TraverseUp{origOwner} to its `up` carrying all remaining gas
// (editing nothing); a BS — or a Unit with an empty pointer — is the terminal and refunds
// origOwner. Each Unit asserts it has UBPS_UP_HOP_VALUE before forwarding, so a follow
// cycle is bounded by gas (no infinite loop, no on-chain cycle check).
import { toNano, Address } from '@ton/core';
import type { SandboxContract, TreasuryContract, SendMessageResult } from '@ton/sandbox';
import '@ton/test-utils';
import { UbpsCodes, UbpsSystem, compileUbps, initUbps } from './ubps_setup';
import { Unit } from '../../wrappers/ubps/Unit';
import { BeliefSet } from '../../wrappers/ubps/BeliefSet';
import {
    Opcodes, Errors, BASIC_STORAGE_TAX, UBPS_UP_HOP_VALUE, emptyCell,
} from '../../wrappers/ubps/types';

describe('UBPS UP traversal (owner -> Unit -> ... -> BS, refund origOwner)', () => {
    let codes: UbpsCodes;
    let S: UbpsSystem;
    beforeAll(async () => { codes = await compileUbps(); });
    beforeEach(async () => { S = await initUbps(codes); }, 60000);

    async function balanceOf(addr: Address): Promise<bigint> {
        return (await S.blockchain.getContract(addr)).balance;
    }
    function txCount(res: SendMessageResult): number {
        return res.transactions.length;
    }

    // Deploy a Unit owned by `owner`, optionally pointing at `up`.
    async function deployUnit(owner: SandboxContract<TreasuryContract>, up: Address | null = null) {
        const unit = S.blockchain.openContract(
            Unit.createFromConfig({ ubpsMaster: S.ubps.address, userAddress: owner.address }, codes.unitCode),
        );
        await unit.sendDeploy(owner.getSender(), toNano('0.1'));
        if (up !== null) {
            await unit.sendSetPointer(owner.getSender(), toNano('0.05'), up);
        }
        return unit;
    }

    it('full chain: owner -> Unit_A -> Unit_B -> BS; BS refunds origOwner, intermediates keep their reserve', async () => {
        // Terminal BS at index 0 (deployed + populated via the master).
        const bsAddr = S.ubps.beliefSetAddress(0, codes.beliefSetCode);
        await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), true, 0, 0, emptyCell(), emptyCell());

        // Unit_B (owned by user2) points at the BS; Unit_A (owned by user) points at Unit_B.
        const unitB = await deployUnit(S.user2, bsAddr);
        const unitA = await deployUnit(S.user, unitB.address);

        const balABefore = await balanceOf(unitA.address);
        const balBBefore = await balanceOf(unitB.address);

        // The initiator funds UBPS_UP_HOP_VALUE × depth (2 unit hops + headroom).
        const fund = UBPS_UP_HOP_VALUE * 5n; // generous so it reaches the BS
        const res = await unitA.sendTraverseUp(S.user.getSender(), fund, S.user.address);

        // It walked all the way: A forwarded to B, B forwarded to BS.
        expect(res.transactions).toHaveTransaction({ from: unitA.address, to: unitB.address, op: Opcodes.OP_TRAVERSE_UP, success: true });
        expect(res.transactions).toHaveTransaction({ from: unitB.address, to: bsAddr, op: Opcodes.OP_TRAVERSE_UP, success: true });
        // The BS terminal refunded origOwner (= S.user) with ReturnExcessesBack.
        expect(res.transactions).toHaveTransaction({ from: bsAddr, to: S.user.address, op: Opcodes.OP_RETURN_EXCESSES_BACK, success: true });

        // Intermediates edited nothing and kept (about) their prior balance + tax — they did
        // NOT pocket the traversal value (it was forwarded onward).
        const balAAfter = await balanceOf(unitA.address);
        const balBAfter = await balanceOf(unitB.address);
        expect(balAAfter).toBeGreaterThanOrEqual(BASIC_STORAGE_TAX);
        expect(balBAfter).toBeGreaterThanOrEqual(BASIC_STORAGE_TAX);
        // No more than dust above their pre-traversal balance (they kept their reserve, not the gas).
        expect(balAAfter).toBeLessThan(balABefore + UBPS_UP_HOP_VALUE);
        expect(balBAfter).toBeLessThan(balBBefore + UBPS_UP_HOP_VALUE);
        // Pointers unchanged (traversal edits nothing).
        expect((await unitA.getPointer())!).toEqualAddress(unitB.address);
        expect((await unitB.getPointer())!).toEqualAddress(bsAddr);
        console.log(`[up] full chain txs=${txCount(res)} (owner->A->B->BS->refund)`);
    });

    it('empty pointer: a Unit with up==null is the terminal — it refunds origOwner and forwards nothing', async () => {
        const unit = await deployUnit(S.user, null); // up == null
        const res = await unit.sendTraverseUp(S.user.getSender(), UBPS_UP_HOP_VALUE * 3n, S.user.address);

        // Refunded origOwner directly; never forwarded anywhere.
        expect(res.transactions).toHaveTransaction({ from: unit.address, to: S.user.address, op: Opcodes.OP_RETURN_EXCESSES_BACK, success: true });
        // Exactly two txs in the path beyond the external: the inbound to the Unit + its refund out.
        expect(res.transactions).toHaveTransaction({ to: unit.address, op: Opcodes.OP_TRAVERSE_UP, success: true, outMessagesCount: 1 });
        expect(await unit.getPointer()).toBeNull(); // unchanged
    });

    it('under-gassed TraverseUp is rejected by the Unit gas-assert (610); funds bounce back', async () => {
        const target = S.ubps.beliefSetAddress(0, codes.beliefSetCode);
        const unit = await deployUnit(S.user, target); // up != null -> must forward
        // Below UBPS_UP_HOP_VALUE (0.02) but enough to cover compute -> the gas-assert fires.
        const res = await unit.sendTraverseUp(S.user.getSender(), toNano('0.015'), S.user.address);
        expect(res.transactions).toHaveTransaction({ to: unit.address, success: false, exitCode: Errors.ERR_UBPS_UP_VALUE_TOO_LOW });
        // The inbound (bounceable) value bounced back to the initiator — nothing forwarded onward.
        expect(res.transactions).toHaveTransaction({ from: unit.address, to: S.user.address, inMessageBounced: true });
        expect(res.transactions).not.toHaveTransaction({ from: unit.address, to: target });
    });

    it('Unit->Unit follow cycle terminates: gas runs out, a hop asserts 610, no infinite loop', async () => {
        // A <-> B cycle: A.up = B, B.up = A.
        const unitB = await deployUnit(S.user2, null);
        const unitA = await deployUnit(S.user, unitB.address);
        await unitB.sendSetPointer(S.user2.getSender(), toNano('0.05'), unitA.address);

        // Bounded gas: each hop burns gas + re-asserts the floor, so the cycle must stop.
        const res = await unitA.sendTraverseUp(S.user.getSender(), toNano('0.1'), S.user.address);

        // The fact that the sandbox returned at all proves termination (an infinite loop would hang).
        // The gas-assert is what stopped it (not a content/cycle check).
        expect(res.transactions).toHaveTransaction({ success: false, exitCode: Errors.ERR_UBPS_UP_VALUE_TOO_LOW });
        // Bounded number of hops — sanity ceiling well below "runaway".
        expect(txCount(res)).toBeLessThan(40);
        console.log(`[up] cycle terminated after ${txCount(res)} txs (gas-bounded)`);
    });
});
