// SPDX-License-Identifier: UNLICENSED
// Mechanic: consolidated authorization + negative matrix. Each guarded path throws a
// NAMED UBPS error (codes from contracts/ubps/static.tolk); unknown opcodes hit the
// catch-all (0xFFFF). Sender gates: Q/A activation = master only; Unit UP = its user;
// BS populate = master only. Underfunded master ops = 607. Hash mismatch = 601.
import { toNano, beginCell, SendMode } from '@ton/core';
import '@ton/test-utils';
import { UbpsCodes, UbpsSystem, compileUbps, initUbps } from './ubps_setup';
import { Question } from '../../wrappers/ubps/Question';
import { Answer } from '../../wrappers/ubps/Answer';
import { Unit } from '../../wrappers/ubps/Unit';
import { stringId, buildStringCell, emptyCell, Opcodes, Errors } from '../../wrappers/ubps/types';

describe('UBPS authorization matrix', () => {
    let codes: UbpsCodes;
    let S: UbpsSystem;
    beforeAll(async () => { codes = await compileUbps(); });
    beforeEach(async () => { S = await initUbps(codes); }, 60000);

    it('Question activation: only the master may activate (non-master -> 608)', async () => {
        const id = stringId('q');
        const qAddr = S.ubps.questionAddress(id, codes.questionCode);
        const q = S.blockchain.openContract(Question.createFromConfig({ ubpsMaster: S.ubps.address, questionId: id }, codes.questionCode));
        await q.sendDeploy(S.user.getSender(), toNano('0.1'));
        const body = beginCell().storeUint(Opcodes.OP_ACTIVATE_QUESTION_MSG, 32).storeRef(buildStringCell('q')).endCell();
        const res = await S.user2.send({ to: qAddr, value: toNano('0.1'), body, sendMode: SendMode.PAY_GAS_SEPARATELY });
        expect(res.transactions).toHaveTransaction({ to: qAddr, success: false, exitCode: Errors.ERR_UBPS_NOT_MASTER });
    });

    it('Answer activation: only the master may activate (non-master -> 608)', async () => {
        const qAddr = S.ubps.questionAddress(stringId('q'), codes.questionCode);
        const aId = stringId('a');
        const aAddr = S.ubps.answerAddress(qAddr, aId, codes.answerCode);
        const a = S.blockchain.openContract(Answer.createFromConfig({ ubpsMaster: S.ubps.address, questionAddress: qAddr, answerId: aId }, codes.answerCode));
        await a.sendDeploy(S.user.getSender(), toNano('0.1'));
        const body = beginCell().storeUint(Opcodes.OP_ACTIVATE_ANSWER_MSG, 32).storeRef(buildStringCell('a')).endCell();
        const res = await S.user2.send({ to: aAddr, value: toNano('0.1'), body, sendMode: SendMode.PAY_GAS_SEPARATELY });
        expect(res.transactions).toHaveTransaction({ to: aAddr, success: false, exitCode: Errors.ERR_UBPS_NOT_MASTER });
    });

    it('Unit pointer: only the unit user may set it (non-user -> 606)', async () => {
        const unit = S.blockchain.openContract(Unit.createFromConfig({ ubpsMaster: S.ubps.address, userAddress: S.user.address }, codes.unitCode));
        await unit.sendDeploy(S.user.getSender(), toNano('0.1'));
        const res = await unit.sendSetPointer(S.user2.getSender(), toNano('0.05'), S.user2.address);
        expect(res.transactions).toHaveTransaction({ to: unit.address, success: false, exitCode: Errors.ERR_UBPS_INVALID_OWNER_SENDER });
    });

    it('BeliefSet populate: only the master may populate (non-master -> 608)', async () => {
        const bsAddr = S.ubps.beliefSetAddress(0, codes.beliefSetCode);
        await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), false, 0, 0, emptyCell(), emptyCell());
        const body = beginCell().storeUint(Opcodes.OP_POPULATE_BELIEF_SET, 32)
            .storeBit(false).storeUint(0, 16).storeUint(0, 16).storeRef(emptyCell()).storeRef(emptyCell()).endCell();
        const res = await S.user2.send({ to: bsAddr, value: toNano('0.1'), body, sendMode: SendMode.PAY_GAS_SEPARATELY });
        expect(res.transactions).toHaveTransaction({ to: bsAddr, success: false, exitCode: Errors.ERR_UBPS_NOT_MASTER });
    });

    it('master ops underfunded -> 607 (Q / A / BS)', async () => {
        const low = toNano('0.02');
        const rq = await S.ubps.sendActivateQuestion(S.user.getSender(), low, stringId('q'), buildStringCell('q'));
        expect(rq.transactions).toHaveTransaction({ to: S.ubps.address, success: false, exitCode: Errors.ERR_UBPS_VALUE_TOO_LOW });
        const qAddr = S.ubps.questionAddress(stringId('q'), codes.questionCode);
        const ra = await S.ubps.sendActivateAnswer(S.user.getSender(), low, qAddr, stringId('a'), buildStringCell('a'));
        expect(ra.transactions).toHaveTransaction({ to: S.ubps.address, success: false, exitCode: Errors.ERR_UBPS_VALUE_TOO_LOW });
        const rb = await S.ubps.sendCreateBeliefSet(S.user.getSender(), low, false, 0, 0, emptyCell(), emptyCell());
        expect(rb.transactions).toHaveTransaction({ to: S.ubps.address, success: false, exitCode: Errors.ERR_UBPS_VALUE_TOO_LOW });
    });

    it('hash mismatch on the master -> 601 (Q and A)', async () => {
        const rq = await S.ubps.sendActivateQuestion(S.user.getSender(), toNano('0.5'), stringId('real-q'), buildStringCell('other-q'));
        expect(rq.transactions).toHaveTransaction({ to: S.ubps.address, success: false, exitCode: Errors.ERR_UBPS_HASH_MISMATCH });
        const qAddr = S.ubps.questionAddress(stringId('q'), codes.questionCode);
        const ra = await S.ubps.sendActivateAnswer(S.user.getSender(), toNano('0.5'), qAddr, stringId('real-a'), buildStringCell('other-a'));
        expect(ra.transactions).toHaveTransaction({ to: S.ubps.address, success: false, exitCode: Errors.ERR_UBPS_HASH_MISMATCH });
    });

    it('unknown opcode to the master is rejected (catch-all 0xFFFF)', async () => {
        const body = beginCell().storeUint(0xdeadbeef, 32).storeUint(0, 8).endCell();
        const res = await S.user.send({ to: S.ubps.address, value: toNano('0.2'), body, sendMode: SendMode.PAY_GAS_SEPARATELY });
        expect(res.transactions).toHaveTransaction({ to: S.ubps.address, success: false, exitCode: 0xffff });
    });
});
