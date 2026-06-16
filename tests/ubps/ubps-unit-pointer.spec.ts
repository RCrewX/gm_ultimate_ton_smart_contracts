// SPDX-License-Identifier: UNLICENSED
// Mechanic: Unit (U) + the single Unit Pointer (UP). Unit is the ONLY mutable type.
// Only the unit's user may move the pointer; it may point at ANY address (no on-chain
// membership check — concept #6) or be cleared to null; freely re-settable.
import { toNano, Address } from '@ton/core';
import '@ton/test-utils';
import { UbpsCodes, UbpsSystem, compileUbps, initUbps } from './ubps_setup';
import { Unit } from '../../wrappers/ubps/Unit';
import { Errors } from '../../wrappers/ubps/types';

describe('UBPS Unit pointer', () => {
    let codes: UbpsCodes;
    let S: UbpsSystem;
    beforeAll(async () => { codes = await compileUbps(); });
    beforeEach(async () => { S = await initUbps(codes); }, 60000);

    async function deployUnit(user: Address) {
        const unit = S.blockchain.openContract(Unit.createFromConfig({ ubpsMaster: S.ubps.address, userAddress: user }, codes.unitCode));
        await unit.sendDeploy(S.user.getSender(), toNano('0.1'));
        return unit;
    }

    it('deploys with a null pointer; master/user getters correct', async () => {
        const unit = await deployUnit(S.user.address);
        expect(await unit.getPointer()).toBeNull();
        expect(await unit.getUser()).toEqualAddress(S.user.address);
        expect(await unit.getMaster()).toEqualAddress(S.ubps.address);
    });

    it('only the user may set the pointer; a stranger is rejected (606)', async () => {
        const unit = await deployUnit(S.user.address);
        const stranger = await S.blockchain.treasury('stranger');
        const bad = await unit.sendSetPointer(stranger.getSender(), toNano('0.05'), stranger.address);
        expect(bad.transactions).toHaveTransaction({
            to: unit.address, success: false, exitCode: Errors.ERR_UBPS_INVALID_OWNER_SENDER,
        });
        expect(await unit.getPointer()).toBeNull(); // unchanged
    });

    it('points at an arbitrary address verbatim (NO membership check), then clears to null', async () => {
        const unit = await deployUnit(S.user.address);
        // Arbitrary non-UBPS address (a plain treasury) — accepted and stored verbatim.
        await unit.sendSetPointer(S.user.getSender(), toNano('0.05'), S.user2.address);
        expect((await unit.getPointer())!).toEqualAddress(S.user2.address);
        // Clear to null.
        await unit.sendSetPointer(S.user.getSender(), toNano('0.05'), null);
        expect(await unit.getPointer()).toBeNull();
    });

    it('freely re-settable: BS/B target, then another Unit target, then back', async () => {
        const unit = await deployUnit(S.user.address);
        const bAddr = S.ubps.beliefSetAddress(7, codes.beliefSetCode);        // a B/BS address
        const otherUnit = S.ubps.unitAddress(S.user2.address, codes.unitCode); // a follow target

        await unit.sendSetPointer(S.user.getSender(), toNano('0.05'), bAddr);
        expect((await unit.getPointer())!).toEqualAddress(bAddr);

        await unit.sendSetPointer(S.user.getSender(), toNano('0.05'), otherUnit);
        expect((await unit.getPointer())!).toEqualAddress(otherUnit);

        await unit.sendSetPointer(S.user.getSender(), toNano('0.05'), bAddr);
        expect((await unit.getPointer())!).toEqualAddress(bAddr);
    });
});
