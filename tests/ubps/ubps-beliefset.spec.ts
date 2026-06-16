// SPDX-License-Identifier: UNLICENSED
// Mechanic: BeliefSet (BS) creation + invariants. Created ONCE by the master with full
// content, then immutable. Size caps MAX_A/MAX_BS enforced at creation. NO on-chain
// dedup/belief-validity (concept #2). Counts are DECLARED (aCount/bsCount), not derived
// from the opaque set cells — an implementation decision (off-chain validity model).
import { toNano, beginCell, SendMode, Address } from '@ton/core';
import '@ton/test-utils';
import { UbpsCodes, UbpsSystem, compileUbps, initUbps } from './ubps_setup';
import { BeliefSet } from '../../wrappers/ubps/BeliefSet';
import { buildAddressSet, emptyCell, Opcodes, Errors, MAX_A, MAX_BS } from '../../wrappers/ubps/types';

describe('UBPS BeliefSet creation + invariants', () => {
    let codes: UbpsCodes;
    let S: UbpsSystem;
    beforeAll(async () => { codes = await compileUbps(); });
    beforeEach(async () => { S = await initUbps(codes); }, 60000);

    function openBs(addr: Address) {
        return S.blockchain.openContract(BeliefSet.createFromAddress(addr));
    }

    it('master creates a BS (root=false): content stored, getters correct', async () => {
        const aSet = buildAddressSet([S.user.address, S.user2.address]);
        const bsSet = emptyCell();
        const bsAddr = S.ubps.beliefSetAddress(0, codes.beliefSetCode);
        const res = await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), false, 2, 0, aSet, bsSet);
        expect(res.transactions).toHaveTransaction({ from: S.ubps.address, to: bsAddr, success: true });

        const bs = openBs(bsAddr);
        expect(await bs.getCreated()).toBe(true);
        expect(await bs.getRoot()).toBe(false);
        expect(await bs.getIndex()).toBe(0n);
        expect(await bs.getMaster()).toEqualAddress(S.ubps.address);
        const sets = await bs.getSets();
        expect(sets.aCount).toBe(2);
        expect(sets.bsCount).toBe(0);
        expect(sets.aSet.equals(aSet)).toBe(true);
    });

    it('limits: exactly MAX_A / MAX_BS succeeds; MAX_A+1 and MAX_BS+1 are rejected (604/605)', async () => {
        // Declared counts at the cap succeed (opaque sets need not enumerate every addr).
        const ok = await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), false, MAX_A, MAX_BS, emptyCell(), emptyCell());
        expect(ok.transactions).toHaveTransaction({ to: S.ubps.address, success: true });
        expect(await S.ubps.getNextBsIndex()).toBe(1n);

        const tooManyA = await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), false, MAX_A + 1, 0, emptyCell(), emptyCell());
        expect(tooManyA.transactions).toHaveTransaction({ to: S.ubps.address, success: false, exitCode: Errors.ERR_UBPS_TOO_MANY_A });

        const tooManyBs = await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), false, 0, MAX_BS + 1, emptyCell(), emptyCell());
        expect(tooManyBs.transactions).toHaveTransaction({ to: S.ubps.address, success: false, exitCode: Errors.ERR_UBPS_TOO_MANY_BS });

        // Rejected creates did NOT advance the index.
        expect(await S.ubps.getNextBsIndex()).toBe(1n);
    });

    it('no on-chain dedup/validity: duplicate A addresses are accepted (concept #2)', async () => {
        const dup = buildAddressSet([S.user.address, S.user.address, S.user.address]);
        const bsAddr = S.ubps.beliefSetAddress(0, codes.beliefSetCode);
        const res = await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), false, 3, 0, dup, emptyCell());
        expect(res.transactions).toHaveTransaction({ to: bsAddr, success: true });
        expect(await openBs(bsAddr).getCreated()).toBe(true);
    });

    it('immutability: a non-master PopulateBeliefSet is rejected (608); no setter exists', async () => {
        // Create the BS normally (created=true).
        const bsAddr = S.ubps.beliefSetAddress(0, codes.beliefSetCode);
        await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), false, 0, 0, emptyCell(), emptyCell());
        expect(await openBs(bsAddr).getCreated()).toBe(true);

        // Anyone other than the master trying to (re)populate is rejected at the BS.
        const body = beginCell().storeUint(Opcodes.OP_POPULATE_BELIEF_SET, 32)
            .storeBit(true).storeUint(9, 16).storeUint(0, 16).storeRef(emptyCell()).storeRef(emptyCell()).endCell();
        const res = await S.user2.send({ to: bsAddr, value: toNano('0.1'), body, sendMode: SendMode.PAY_GAS_SEPARATELY });
        expect(res.transactions).toHaveTransaction({ to: bsAddr, success: false, exitCode: Errors.ERR_UBPS_NOT_MASTER });

        // State unchanged (still root=false, counts 0).
        const sets = await openBs(bsAddr).getSets();
        expect(sets.aCount).toBe(0);
        expect(await openBs(bsAddr).getRoot()).toBe(false);
        // NOTE: the BS's own ALREADY_CREATED guard (603) is defense-in-depth and is not
        // reachable through the master (monotonic index never re-targets a created BS).
    });

    it('value below UBPS_MIN_OP_VALUE is rejected (607)', async () => {
        const res = await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.01'), false, 0, 0, emptyCell(), emptyCell());
        expect(res.transactions).toHaveTransaction({ to: S.ubps.address, success: false, exitCode: Errors.ERR_UBPS_VALUE_TOO_LOW });
    });
});
