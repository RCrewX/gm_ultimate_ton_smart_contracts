// SPDX-License-Identifier: UNLICENSED
// Mechanic: follow chains (subscriptions) — ON-CHAIN LAYER ONLY. Each Unit just stores
// its UP; there is NO on-chain traversal and NO cycle detection (concept #4 — that is a
// backend responsibility). These tests assert only what the contracts do: store verbatim.
import { toNano, Address } from '@ton/core';
import '@ton/test-utils';
import { UbpsCodes, UbpsSystem, compileUbps, initUbps } from './ubps_setup';
import { Unit } from '../../wrappers/ubps/Unit';

describe('UBPS subscriptions (follow chains, on-chain layer)', () => {
    let codes: UbpsCodes;
    let S: UbpsSystem;
    beforeAll(async () => { codes = await compileUbps(); });
    beforeEach(async () => { S = await initUbps(codes); }, 60000);

    async function unitFor(user: { address: Address; getSender: () => any }) {
        const u = S.blockchain.openContract(Unit.createFromConfig({ ubpsMaster: S.ubps.address, userAddress: user.address }, codes.unitCode));
        await u.sendDeploy(user.getSender(), toNano('0.1'));
        return u;
    }

    it('U1 -> U2 -> B: each hop stores its own UP (no on-chain traversal)', async () => {
        const u1 = await unitFor(S.user);
        const u2 = await unitFor(S.user2);
        const bAddr = S.ubps.beliefSetAddress(0, codes.beliefSetCode);

        // U2 follows B; U1 follows U2.
        await u2.sendSetPointer(S.user2.getSender(), toNano('0.05'), bAddr);
        await u1.sendSetPointer(S.user.getSender(), toNano('0.05'), u2.address);

        // On-chain: each Unit only knows its direct UP. Resolution U1->U2->B is off-chain.
        expect((await u1.getPointer())!).toEqualAddress(u2.address);
        expect((await u2.getPointer())!).toEqualAddress(bAddr);
    });

    it('U1 -> U2 -> U1 (cycle): accepted on-chain, both pointers stored (no cycle check)', async () => {
        const u1 = await unitFor(S.user);
        const u2 = await unitFor(S.user2);

        await u1.sendSetPointer(S.user.getSender(), toNano('0.05'), u2.address);
        const res = await u2.sendSetPointer(S.user2.getSender(), toNano('0.05'), u1.address);
        // No throw: the contract does not detect the cycle (off-chain concern #4).
        expect(res.transactions).toHaveTransaction({ to: u2.address, success: true });

        expect((await u1.getPointer())!).toEqualAddress(u2.address);
        expect((await u2.getPointer())!).toEqualAddress(u1.address);
    });

    it('a Unit may even point at itself (self-loop) — accepted on-chain', async () => {
        const u1 = await unitFor(S.user);
        const res = await u1.sendSetPointer(S.user.getSender(), toNano('0.05'), u1.address);
        expect(res.transactions).toHaveTransaction({ to: u1.address, success: true });
        expect((await u1.getPointer())!).toEqualAddress(u1.address);
    });
});
