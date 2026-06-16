// SPDX-License-Identifier: UNLICENSED
// Mechanic: gas snapshots for the UBPS operations. Sanity ceilings (NOT exact equality)
// + a reserveValue floor check: every contract that processed a message retains at least
// the storage tax (no under-reserve). Costs are logged for the result report.
import { toNano, fromNano, Address } from '@ton/core';
import type { SendMessageResult } from '@ton/sandbox';
import '@ton/test-utils';
import { UbpsCodes, UbpsSystem, compileUbps, initUbps } from './ubps_setup';
import { stringId, buildStringCell, buildAddressSet, emptyCell, BASIC_STORAGE_TAX } from '../../wrappers/ubps/types';

describe('UBPS gas snapshots', () => {
    let codes: UbpsCodes;
    let S: UbpsSystem;
    beforeAll(async () => { codes = await compileUbps(); });
    beforeEach(async () => { S = await initUbps(codes); }, 60000);

    const CEILING = toNano('0.2'); // generous sanity ceiling per op (sum of all hop fees)

    function totalFees(res: SendMessageResult): bigint {
        return res.transactions.reduce((s, t) => s + t.totalFees.coins, 0n);
    }
    async function balanceOf(addr: Address): Promise<bigint> {
        return (await S.blockchain.getContract(addr)).balance;
    }

    it('activate-Q gas under ceiling; Q retains >= storage tax', async () => {
        const id = stringId('Are you happy?');
        const qAddr = S.ubps.questionAddress(id, codes.questionCode);
        const res = await S.ubps.sendActivateQuestion(S.user.getSender(), toNano('0.5'), id, buildStringCell('Are you happy?'));
        const fee = totalFees(res);
        console.log(`[gas] activate-Q: ${fromNano(fee)} TON`);
        expect(fee).toBeLessThan(CEILING);
        expect(await balanceOf(qAddr)).toBeGreaterThanOrEqual(BASIC_STORAGE_TAX);
        expect(await balanceOf(S.ubps.address)).toBeGreaterThanOrEqual(BASIC_STORAGE_TAX);
    });

    it('activate-A gas under ceiling; A retains >= storage tax', async () => {
        const qAddr = S.ubps.questionAddress(stringId('q'), codes.questionCode);
        const aId = stringId('Yes');
        const aAddr = S.ubps.answerAddress(qAddr, aId, codes.answerCode);
        const res = await S.ubps.sendActivateAnswer(S.user.getSender(), toNano('0.5'), qAddr, aId, buildStringCell('Yes'));
        const fee = totalFees(res);
        console.log(`[gas] activate-A: ${fromNano(fee)} TON`);
        expect(fee).toBeLessThan(CEILING);
        expect(await balanceOf(aAddr)).toBeGreaterThanOrEqual(BASIC_STORAGE_TAX);
    });

    it('set-pointer gas under ceiling; Unit retains >= storage tax', async () => {
        const { Unit } = await import('../../wrappers/ubps/Unit');
        const unit = S.blockchain.openContract(Unit.createFromConfig({ ubpsMaster: S.ubps.address, userAddress: S.user.address }, codes.unitCode));
        await unit.sendDeploy(S.user.getSender(), toNano('0.1'));
        const res = await unit.sendSetPointer(S.user.getSender(), toNano('0.05'), S.user2.address);
        const fee = totalFees(res);
        console.log(`[gas] set-pointer: ${fromNano(fee)} TON`);
        expect(fee).toBeLessThan(CEILING);
        expect(await balanceOf(unit.address)).toBeGreaterThanOrEqual(BASIC_STORAGE_TAX);
    });

    it('create-BS and create-B gas under ceiling; BS retains >= storage tax', async () => {
        const aSet = buildAddressSet([S.user.address, S.user2.address]);
        const bsAddr = S.ubps.beliefSetAddress(0, codes.beliefSetCode);
        const resBs = await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), false, 2, 0, aSet, emptyCell());
        const feeBs = totalFees(resBs);
        console.log(`[gas] create-BS: ${fromNano(feeBs)} TON`);
        expect(feeBs).toBeLessThan(CEILING);
        expect(await balanceOf(bsAddr)).toBeGreaterThanOrEqual(BASIC_STORAGE_TAX);

        const bAddr = S.ubps.beliefSetAddress(1, codes.beliefSetCode);
        const resB = await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), true, 0, 1, emptyCell(), buildAddressSet([bsAddr]));
        const feeB = totalFees(resB);
        console.log(`[gas] create-B:  ${fromNano(feeB)} TON`);
        expect(feeB).toBeLessThan(CEILING);
        expect(await balanceOf(bAddr)).toBeGreaterThanOrEqual(BASIC_STORAGE_TAX);
    });
});
