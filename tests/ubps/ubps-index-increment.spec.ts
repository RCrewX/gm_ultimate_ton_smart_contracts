// SPDX-License-Identifier: UNLICENSED
// Mechanic: the master-mediated BS/B index counter. Each successful create increments
// nextBsIndex by exactly 1; each BS/B materializes at its index-derived address; a
// rejected create does not advance the counter. Sandbox is sequential => deterministic.
import { toNano } from '@ton/core';
import '@ton/test-utils';
import { UbpsCodes, UbpsSystem, compileUbps, initUbps } from './ubps_setup';
import { BeliefSet } from '../../wrappers/ubps/BeliefSet';
import { emptyCell, MAX_A, Errors } from '../../wrappers/ubps/types';

describe('UBPS BS/B index increment (master-mediated)', () => {
    let codes: UbpsCodes;
    let S: UbpsSystem;
    beforeAll(async () => { codes = await compileUbps(); });
    beforeEach(async () => { S = await initUbps(codes); }, 60000);

    it('starts at 0 and increments by exactly 1 per successful create', async () => {
        expect(await S.ubps.getNextBsIndex()).toBe(0n);
        for (let i = 0; i < 3; i++) {
            const expectedAddr = S.ubps.beliefSetAddress(i, codes.beliefSetCode);
            const res = await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), i === 2, 0, 0, emptyCell(), emptyCell());
            expect(res.transactions).toHaveTransaction({ from: S.ubps.address, to: expectedAddr, success: true });
            expect(await S.ubps.getNextBsIndex()).toBe(BigInt(i + 1));
            // The BS at this index actually exists with the right stored index.
            expect(await S.blockchain.openContract(BeliefSet.createFromAddress(expectedAddr)).getIndex()).toBe(BigInt(i));
        }
    });

    it('sequential creates land at distinct, predictable addresses', async () => {
        await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), false, 0, 0, emptyCell(), emptyCell());
        await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), true, 0, 0, emptyCell(), emptyCell());
        const a0 = S.ubps.beliefSetAddress(0, codes.beliefSetCode);
        const a1 = S.ubps.beliefSetAddress(1, codes.beliefSetCode);
        expect(a0.equals(a1)).toBe(false);
        expect(await S.blockchain.openContract(BeliefSet.createFromAddress(a0)).getRoot()).toBe(false);
        expect(await S.blockchain.openContract(BeliefSet.createFromAddress(a1)).getRoot()).toBe(true);
    });

    it('a rejected create (over cap) does NOT advance the index', async () => {
        await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), false, 0, 0, emptyCell(), emptyCell());
        expect(await S.ubps.getNextBsIndex()).toBe(1n);
        const bad = await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), false, MAX_A + 1, 0, emptyCell(), emptyCell());
        expect(bad.transactions).toHaveTransaction({ to: S.ubps.address, success: false, exitCode: Errors.ERR_UBPS_TOO_MANY_A });
        expect(await S.ubps.getNextBsIndex()).toBe(1n); // unchanged
        // Next valid create reuses the not-consumed index 1.
        const ok = await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), false, 0, 0, emptyCell(), emptyCell());
        expect(ok.transactions).toHaveTransaction({ from: S.ubps.address, to: S.ubps.beliefSetAddress(1, codes.beliefSetCode), success: true });
        expect(await S.ubps.getNextBsIndex()).toBe(2n);
    });
});
