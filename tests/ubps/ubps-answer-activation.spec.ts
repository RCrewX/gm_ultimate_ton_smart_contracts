// SPDX-License-Identifier: UNLICENSED
// Mechanic: Answer (A) lifecycle — bound to a Question, deployed inactive, master-only
// activation with the on-chain string.hash check, immutable once active. Mirrors Q.
import { toNano, beginCell, SendMode, Address } from '@ton/core';
import '@ton/test-utils';
import { UbpsCodes, UbpsSystem, compileUbps, initUbps } from './ubps_setup';
import { Answer } from '../../wrappers/ubps/Answer';
import { stringId, buildStringCell, Opcodes, Errors } from '../../wrappers/ubps/types';

describe('UBPS Answer activation', () => {
    let codes: UbpsCodes;
    let S: UbpsSystem;
    beforeAll(async () => { codes = await compileUbps(); });
    beforeEach(async () => { S = await initUbps(codes); }, 60000);

    const ATEXT = 'Yes, absolutely';
    let qAddr: Address; // a (not-necessarily-activated) Question address to bind answers to

    beforeEach(() => {
        qAddr = S.ubps.questionAddress(stringId('Do you like TON?'), codes.questionCode);
    });

    function openA(addr: Address) {
        return S.blockchain.openContract(Answer.createFromAddress(addr));
    }

    it('master activation (hash matches): A active, bytes stored, Q binding returned', async () => {
        const aId = stringId(ATEXT);
        const aAddr = S.ubps.answerAddress(qAddr, aId, codes.answerCode);
        const res = await S.ubps.sendActivateAnswer(S.user.getSender(), toNano('0.5'), qAddr, aId, buildStringCell(ATEXT));
        expect(res.transactions).toHaveTransaction({ to: S.ubps.address, success: true });
        expect(res.transactions).toHaveTransaction({ from: S.ubps.address, to: aAddr, success: true });

        const a = openA(aAddr);
        expect(await a.getActive()).toBe(true);
        expect(await a.getId()).toBe(aId);
        expect(await a.getMaster()).toEqualAddress(S.ubps.address);
        expect(await a.getQuestionAddress()).toEqualAddress(qAddr);
        expect((await a.getAnswer())!.beginParse().loadStringTail()).toBe(ATEXT);
    });

    it('hash mismatch: master rejects (601)', async () => {
        const wrongId = stringId('No');
        const res = await S.ubps.sendActivateAnswer(S.user.getSender(), toNano('0.5'), qAddr, wrongId, buildStringCell(ATEXT));
        expect(res.transactions).toHaveTransaction({
            to: S.ubps.address, success: false, exitCode: Errors.ERR_UBPS_HASH_MISMATCH,
        });
    });

    it('non-master activation message is rejected (608)', async () => {
        const aId = stringId(ATEXT);
        const aAddr = S.ubps.answerAddress(qAddr, aId, codes.answerCode);
        const a = S.blockchain.openContract(Answer.createFromConfig(
            { ubpsMaster: S.ubps.address, questionAddress: qAddr, answerId: aId }, codes.answerCode));
        await a.sendDeploy(S.user.getSender(), toNano('0.1'));
        expect(await a.getActive()).toBe(false);

        const body = beginCell().storeUint(Opcodes.OP_ACTIVATE_ANSWER_MSG, 32).storeRef(buildStringCell(ATEXT)).endCell();
        const res = await S.user2.send({ to: aAddr, value: toNano('0.1'), body, sendMode: SendMode.PAY_GAS_SEPARATELY });
        expect(res.transactions).toHaveTransaction({
            to: aAddr, success: false, exitCode: Errors.ERR_UBPS_NOT_MASTER,
        });
        expect(await a.getActive()).toBe(false);
    });

    it('immutability: re-activation after active is rejected (602)', async () => {
        const aId = stringId(ATEXT);
        const aAddr = S.ubps.answerAddress(qAddr, aId, codes.answerCode);
        await S.ubps.sendActivateAnswer(S.user.getSender(), toNano('0.5'), qAddr, aId, buildStringCell(ATEXT));
        expect(await openA(aAddr).getActive()).toBe(true);

        const res = await S.ubps.sendActivateAnswer(S.user.getSender(), toNano('0.5'), qAddr, aId, buildStringCell(ATEXT));
        expect(res.transactions).toHaveTransaction({
            to: aAddr, success: false, exitCode: Errors.ERR_UBPS_ALREADY_ACTIVE,
        });
    });

    it('the same answer text under two different Questions yields two distinct, active A contracts', async () => {
        const qA = S.ubps.questionAddress(stringId('Q-A'), codes.questionCode);
        const qB = S.ubps.questionAddress(stringId('Q-B'), codes.questionCode);
        const aId = stringId(ATEXT);
        const addrA = S.ubps.answerAddress(qA, aId, codes.answerCode);
        const addrB = S.ubps.answerAddress(qB, aId, codes.answerCode);
        expect(addrA.equals(addrB)).toBe(false);

        await S.ubps.sendActivateAnswer(S.user.getSender(), toNano('0.5'), qA, aId, buildStringCell(ATEXT));
        await S.ubps.sendActivateAnswer(S.user.getSender(), toNano('0.5'), qB, aId, buildStringCell(ATEXT));
        expect(await openA(addrA).getQuestionAddress()).toEqualAddress(qA);
        expect(await openA(addrB).getQuestionAddress()).toEqualAddress(qB);
    });
});
