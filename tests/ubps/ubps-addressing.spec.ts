// SPDX-License-Identifier: UNLICENSED
// Mechanic: deterministic addressing for all 4 UBPS schemes.
//   U  = f(UBPS, U-code, user)        Q  = f(UBPS, Q-code, question_id)
//   A  = f(UBPS, A-code, Q, answer_id) BS = f(UBPS, BS-code, index)   (B = BS + root flag)
// Cross-check: wrapper off-chain calc == master get-method == actually-deployed address.
import { toNano } from '@ton/core';
import '@ton/test-utils';
import { UbpsCodes, UbpsSystem, compileUbps, initUbps } from './ubps_setup';
import { Question } from '../../wrappers/ubps/Question';
import { Answer } from '../../wrappers/ubps/Answer';
import { Unit } from '../../wrappers/ubps/Unit';
import { stringId, buildStringCell, emptyCell } from '../../wrappers/ubps/types';

describe('UBPS addressing (deterministic, all 4 schemes)', () => {
    let codes: UbpsCodes;
    let S: UbpsSystem;
    beforeAll(async () => { codes = await compileUbps(); });
    beforeEach(async () => { S = await initUbps(codes); }, 60000);

    it('Unit address = f(master, user): wrapper == getter == deployed; per-user distinct', async () => {
        const a1 = S.ubps.unitAddress(S.user.address, codes.unitCode);
        const a1getter = await S.ubps.getUnitAddress(S.user.address);
        expect(a1getter).toEqualAddress(a1);

        // Same user -> same address (idempotent calc).
        expect(S.ubps.unitAddress(S.user.address, codes.unitCode)).toEqualAddress(a1);
        // Different user -> different address.
        const a2 = S.ubps.unitAddress(S.user2.address, codes.unitCode);
        expect(a2.equals(a1)).toBe(false);

        // Actually-deployed Unit lands at the computed address.
        const unit = Unit.createFromConfig({ ubpsMaster: S.ubps.address, userAddress: S.user.address }, codes.unitCode);
        expect(unit.address).toEqualAddress(a1);
    });

    it('Question address = f(master, question_id): wrapper == getter == deployed', async () => {
        const id = stringId('Are you happy?');
        const wrapped = S.ubps.questionAddress(id, codes.questionCode);
        expect(await S.ubps.getQuestionAddress(id)).toEqualAddress(wrapped);

        // Deploy via the master activation -> the Q materializes at the computed address.
        const res = await S.ubps.sendActivateQuestion(S.user.getSender(), toNano('0.5'), id, buildStringCell('Are you happy?'));
        expect(res.transactions).toHaveTransaction({ from: S.ubps.address, to: wrapped, success: true });
        // The contract that materialized at the computed address is the active Question.
        expect(await S.blockchain.openContract(Question.createFromAddress(wrapped)).getActive()).toBe(true);
    });

    it('Answer address = f(master, Q, answer_id): wrapper == getter == deployed', async () => {
        const qId = stringId('Q?');
        const qAddr = S.ubps.questionAddress(qId, codes.questionCode);
        const aId = stringId('Yes');
        const wrapped = S.ubps.answerAddress(qAddr, aId, codes.answerCode);
        expect(await S.ubps.getAnswerAddress(qAddr, aId)).toEqualAddress(wrapped);

        await S.ubps.sendActivateQuestion(S.user.getSender(), toNano('0.5'), qId, buildStringCell('Q?'));
        const res = await S.ubps.sendActivateAnswer(S.user.getSender(), toNano('0.5'), qAddr, aId, buildStringCell('Yes'));
        expect(res.transactions).toHaveTransaction({ from: S.ubps.address, to: wrapped, success: true });
        const a = S.blockchain.openContract(Answer.createFromAddress(wrapped));
        expect(await a.getQuestionAddress()).toEqualAddress(qAddr);
    });

    it('Answer address depends on BOTH the Question and the answer_id', async () => {
        const qA = S.ubps.questionAddress(stringId('QA'), codes.questionCode);
        const qB = S.ubps.questionAddress(stringId('QB'), codes.questionCode);
        const aId = stringId('Yes');
        // Same answer_id, different Question -> different Answer address.
        expect(S.ubps.answerAddress(qA, aId, codes.answerCode).equals(S.ubps.answerAddress(qB, aId, codes.answerCode))).toBe(false);
        // Same Question, different answer_id -> different Answer address.
        const aId2 = stringId('No');
        expect(S.ubps.answerAddress(qA, aId, codes.answerCode).equals(S.ubps.answerAddress(qA, aId2, codes.answerCode))).toBe(false);
    });

    it('BeliefSet address = f(master, index): wrapper == getter == deployed; per-index distinct', async () => {
        const a0 = S.ubps.beliefSetAddress(0, codes.beliefSetCode);
        expect(await S.ubps.getBeliefSetAddress(0)).toEqualAddress(a0);
        const a1 = S.ubps.beliefSetAddress(1, codes.beliefSetCode);
        expect(a1.equals(a0)).toBe(false);

        const res = await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), false, 0, 0, emptyCell(), emptyCell());
        expect(res.transactions).toHaveTransaction({ from: S.ubps.address, to: a0, success: true });
    });

    it('impersonation cannot collide: a child claiming a different master gets a different address', async () => {
        const id = stringId('Are you happy?');
        const real = S.ubps.questionAddress(id, codes.questionCode);
        // A Question whose stored master is a stranger lands elsewhere.
        const fake = Question.createFromConfig({ ubpsMaster: S.user2.address, questionId: id }, codes.questionCode);
        expect(fake.address.equals(real)).toBe(false);
    });
});
