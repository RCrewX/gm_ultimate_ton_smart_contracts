// SPDX-License-Identifier: UNLICENSED
// Mechanic: B (final public profile) = a BeliefSet with root=true. Same index-based
// addressing and the same MAX_A/MAX_BS caps as a BS; a Unit's UP pointing at a B is the
// published-profile case.
import { toNano, Address } from '@ton/core';
import '@ton/test-utils';
import { UbpsCodes, UbpsSystem, compileUbps, initUbps } from './ubps_setup';
import { BeliefSet } from '../../wrappers/ubps/BeliefSet';
import { Unit } from '../../wrappers/ubps/Unit';
import { buildAddressSet, emptyCell, Errors, MAX_BS } from '../../wrappers/ubps/types';

describe('UBPS final B (BS with root flag)', () => {
    let codes: UbpsCodes;
    let S: UbpsSystem;
    beforeAll(async () => { codes = await compileUbps(); });
    beforeEach(async () => { S = await initUbps(codes); }, 60000);

    function openBs(addr: Address) {
        return S.blockchain.openContract(BeliefSet.createFromAddress(addr));
    }

    it('master creates a B (root=true) holding BS addresses; get_root()==true; same addressing', async () => {
        const bsRefs = buildAddressSet([
            S.ubps.beliefSetAddress(10, codes.beliefSetCode),
            S.ubps.beliefSetAddress(11, codes.beliefSetCode),
        ]);
        const bAddr = S.ubps.beliefSetAddress(0, codes.beliefSetCode); // B uses the SAME index scheme
        const res = await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), true, 0, 2, emptyCell(), bsRefs);
        expect(res.transactions).toHaveTransaction({ from: S.ubps.address, to: bAddr, success: true });

        const b = openBs(bAddr);
        expect(await b.getRoot()).toBe(true);
        expect(await b.getCreated()).toBe(true);
        expect(await b.getIndex()).toBe(0n);
        const sets = await b.getSets();
        expect(sets.bsCount).toBe(2);
        expect(sets.bsSet.equals(bsRefs)).toBe(true);
    });

    it('a Unit UP pointing at a B is stored (the public-profile case)', async () => {
        const bAddr = S.ubps.beliefSetAddress(0, codes.beliefSetCode);
        await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), true, 0, 0, emptyCell(), emptyCell());

        const unit = S.blockchain.openContract(Unit.createFromConfig({ ubpsMaster: S.ubps.address, userAddress: S.user.address }, codes.unitCode));
        await unit.sendDeploy(S.user.getSender(), toNano('0.1'));
        await unit.sendSetPointer(S.user.getSender(), toNano('0.05'), bAddr);
        expect((await unit.getPointer())!).toEqualAddress(bAddr);
    });

    it('B obeys the same MAX_BS cap (MAX_BS+1 rejected at creation, 605)', async () => {
        const res = await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), true, 0, MAX_BS + 1, emptyCell(), emptyCell());
        expect(res.transactions).toHaveTransaction({ to: S.ubps.address, success: false, exitCode: Errors.ERR_UBPS_TOO_MANY_BS });
    });
});
