// SPDX-License-Identifier: UNLICENSED
// Mechanic: create a Unit THROUGH the master (CreateUnit funnel) — an alternate to a
// user self-deploy so the master's tx history records the creation (backend discovery).
// INVARIANTS proven here:
//   * the via-master Unit lands at the SAME deterministic address as a self-deploy
//     (up is never in the stateInit; the initial pointer is applied post-deploy);
//   * the caller owns the Unit (userAddress = sender) — you can only create your own;
//   * the optional initial pointer is applied (InitUnitPointer, master-gated);
//   * SetPointer stays user-gated; InitUnitPointer is master-only AND init-only (it can
//     never override a pointer the user has set).
import { toNano, Address } from '@ton/core';
import '@ton/test-utils';
import { UbpsCodes, UbpsSystem, compileUbps, initUbps } from './ubps_setup';
import { Unit } from '../../wrappers/ubps/Unit';
import { Errors, Opcodes, encodeInitUnitPointer } from '../../wrappers/ubps/types';

describe('UBPS create Unit via master', () => {
    let codes: UbpsCodes;
    let S: UbpsSystem;
    beforeAll(async () => { codes = await compileUbps(); });
    beforeEach(async () => { S = await initUbps(codes); }, 60000);

    it('via-master Unit lands at the SAME address as a self-deploy, owned by the caller', async () => {
        const expected = S.ubps.unitAddress(S.user.address, codes.unitCode);

        const res = await S.ubps.sendCreateUnit(S.user.getSender(), toNano('0.5'), null);
        // The master funnels the creation: a tx FROM the master TO the deterministic Unit
        // address (this is what the backend watches).
        expect(res.transactions).toHaveTransaction({ from: S.ubps.address, to: expected, success: true });

        const unit = S.blockchain.openContract(Unit.createFromAddress(expected));
        expect(await unit.getUser()).toEqualAddress(S.user.address);   // owner = the caller
        expect(await unit.getMaster()).toEqualAddress(S.ubps.address);
        expect(await unit.getPointer()).toBeNull();                    // no initial pointer
    });

    it('a caller can only create their OWN Unit (different sender => different address)', async () => {
        const aUser = S.ubps.unitAddress(S.user.address, codes.unitCode);
        const aUser2 = S.ubps.unitAddress(S.user2.address, codes.unitCode);
        await S.ubps.sendCreateUnit(S.user.getSender(), toNano('0.5'), null);
        await S.ubps.sendCreateUnit(S.user2.getSender(), toNano('0.5'), null);
        expect(aUser.equals(aUser2)).toBe(false);
        expect(await S.blockchain.openContract(Unit.createFromAddress(aUser)).getUser()).toEqualAddress(S.user.address);
        expect(await S.blockchain.openContract(Unit.createFromAddress(aUser2)).getUser()).toEqualAddress(S.user2.address);
    });

    it('applies the optional initial pointer at creation', async () => {
        const target = S.ubps.beliefSetAddress(3, codes.beliefSetCode); // any address (no membership check)
        const addr = S.ubps.unitAddress(S.user.address, codes.unitCode);
        await S.ubps.sendCreateUnit(S.user.getSender(), toNano('0.5'), target);
        const unit = S.blockchain.openContract(Unit.createFromAddress(addr));
        expect((await unit.getPointer())!).toEqualAddress(target);
    });

    it('parity: via-master address == self-deploy address (the two paths converge)', async () => {
        // Self-deploy path for user2.
        const selfUnit = S.blockchain.openContract(
            Unit.createFromConfig({ ubpsMaster: S.ubps.address, userAddress: S.user2.address }, codes.unitCode),
        );
        await selfUnit.sendDeploy(S.user2.getSender(), toNano('0.1'));
        // Via-master path for user.
        const viaAddr = S.ubps.unitAddress(S.user.address, codes.unitCode);
        await S.ubps.sendCreateUnit(S.user.getSender(), toNano('0.5'), null);
        // Both equal the wrapper's deterministic calc for their respective owners.
        expect(selfUnit.address).toEqualAddress(S.ubps.unitAddress(S.user2.address, codes.unitCode));
        expect(viaAddr).toEqualAddress(S.ubps.unitAddress(S.user.address, codes.unitCode));
    });

    it('SetPointer stays user-gated after a via-master create; stranger rejected (606)', async () => {
        const addr = S.ubps.unitAddress(S.user.address, codes.unitCode);
        await S.ubps.sendCreateUnit(S.user.getSender(), toNano('0.5'), null);
        const unit = S.blockchain.openContract(Unit.createFromAddress(addr));

        const stranger = await S.blockchain.treasury('stranger');
        const bad = await unit.sendSetPointer(stranger.getSender(), toNano('0.05'), stranger.address);
        expect(bad.transactions).toHaveTransaction({ to: addr, success: false, exitCode: Errors.ERR_UBPS_INVALID_OWNER_SENDER });
        expect(await unit.getPointer()).toBeNull();

        // The owner CAN move it.
        await unit.sendSetPointer(S.user.getSender(), toNano('0.05'), S.user2.address);
        expect((await unit.getPointer())!).toEqualAddress(S.user2.address);
    });

    it('InitUnitPointer is master-only: a stranger is rejected (608 NOT_MASTER)', async () => {
        const addr = S.ubps.unitAddress(S.user.address, codes.unitCode);
        await S.ubps.sendCreateUnit(S.user.getSender(), toNano('0.5'), null);
        const stranger = await S.blockchain.treasury('stranger');
        const bad = await stranger.send({
            to: addr,
            value: toNano('0.05'),
            body: encodeInitUnitPointer(stranger.address),
        });
        expect(bad.transactions).toHaveTransaction({ to: addr, success: false, exitCode: Errors.ERR_UBPS_NOT_MASTER });
        expect(await S.blockchain.openContract(Unit.createFromAddress(addr)).getPointer()).toBeNull();
    });

    it('InitUnitPointer is init-only: a second via-master create cannot override a user-set pointer', async () => {
        const addr = S.ubps.unitAddress(S.user.address, codes.unitCode);
        const unit = S.blockchain.openContract(Unit.createFromAddress(addr));
        // Create with an initial pointer A.
        const ptrA = S.ubps.beliefSetAddress(1, codes.beliefSetCode);
        await S.ubps.sendCreateUnit(S.user.getSender(), toNano('0.5'), ptrA);
        expect((await unit.getPointer())!).toEqualAddress(ptrA);
        // User moves it to B.
        const ptrB = S.ubps.beliefSetAddress(2, codes.beliefSetCode);
        await unit.sendSetPointer(S.user.getSender(), toNano('0.05'), ptrB);
        expect((await unit.getPointer())!).toEqualAddress(ptrB);
        // A second CreateUnit (master re-sends InitUnitPointer with a different target) must
        // NOT clobber the user's pointer — it's a no-op because up is no longer null.
        const ptrC = S.ubps.beliefSetAddress(9, codes.beliefSetCode);
        await S.ubps.sendCreateUnit(S.user.getSender(), toNano('0.5'), ptrC);
        expect((await unit.getPointer())!).toEqualAddress(ptrB); // unchanged
    });

    it('the CreateUnit opcode is the published 0x55425004', () => {
        expect(Opcodes.OP_CREATE_UNIT).toBe(0x55425004);
        expect(Opcodes.OP_INIT_UNIT_POINTER).toBe(0x55425014);
    });
});
