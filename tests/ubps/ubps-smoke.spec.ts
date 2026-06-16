// SPDX-License-Identifier: UNLICENSED
// Minimal UBPS smoke test — NOT the exhaustive suite (that is a separate plan).
// It validates the load-bearing invariants the rest of UBPS relies on:
//   * off-chain stringId() (sha256) == on-chain SHA256U (slice.bitsHash) — so the
//     master's hash check accepts a correctly-built question/answer;
//   * wrapper address calc == the master's get-method == where a child deploys;
//   * activation/creation flows + immutability + the Unit pointer + sender gates.
import { toNano, Cell } from '@ton/core';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { UBPS } from '../../wrappers/ubps/UBPS';
import { Question } from '../../wrappers/ubps/Question';
import { Answer } from '../../wrappers/ubps/Answer';
import { BeliefSet } from '../../wrappers/ubps/BeliefSet';
import { Unit } from '../../wrappers/ubps/Unit';
import { stringId, buildStringCell, buildAddressSet, emptyCell, Errors } from '../../wrappers/ubps/types';

describe('UBPS smoke (master + children)', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let ubps: SandboxContract<UBPS>;

    let ubpsCode: Cell, unitCode: Cell, questionCode: Cell, answerCode: Cell, beliefSetCode: Cell;

    beforeAll(async () => {
        ubpsCode = await compile('UBPS');
        unitCode = await compile('UBPSUnit');
        questionCode = await compile('UBPSQuestion');
        answerCode = await compile('UBPSAnswer');
        beliefSetCode = await compile('UBPSBeliefSet');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        user = await blockchain.treasury('user');
        ubps = blockchain.openContract(UBPS.createFromConfig({
            ownerAddress: owner.address, unitCode, questionCode, answerCode, beliefSetCode,
        }, ubpsCode));
        await ubps.sendDeploy(owner.getSender(), toNano('0.5'));
    }, 60000);

    it('address calc parity: wrapper == master get-method', async () => {
        const id = stringId('Are you happy?');
        const wrapperAddr = ubps.questionAddress(id, questionCode);
        const getterAddr = await ubps.getQuestionAddress(id);
        expect(getterAddr).toEqualAddress(wrapperAddr);
    });

    it('activate a Question: hash verified, Q deployed+active, bytes round-trip', async () => {
        const text = 'Are you happy?';
        const id = stringId(text);
        const bytes = buildStringCell(text);
        const qAddr = ubps.questionAddress(id, questionCode);

        const res = await ubps.sendActivateQuestion(user.getSender(), toNano('0.5'), id, bytes);
        // Master accepts and emits the activation (deploying Q at the deterministic addr).
        expect(res.transactions).toHaveTransaction({ from: ubps.address, to: qAddr, success: true });

        const q = blockchain.openContract(Question.createFromAddress(qAddr));
        expect(await q.getActive()).toBe(true);
        expect(await q.getId()).toBe(id);
        expect(await q.getMaster()).toEqualAddress(ubps.address);
        const stored = await q.getQuestion();
        expect(stored!.beginParse().loadStringTail()).toBe(text);
    });

    it('rejects a Question whose bytes do not hash to the claimed id (601)', async () => {
        const bytes = buildStringCell('the real question');
        const wrongId = stringId('a different question');
        const res = await ubps.sendActivateQuestion(user.getSender(), toNano('0.5'), wrongId, bytes);
        expect(res.transactions).toHaveTransaction({
            to: ubps.address, success: false, exitCode: Errors.ERR_UBPS_HASH_MISMATCH,
        });
    });

    it('activate an Answer bound to a Question', async () => {
        const qText = 'Do you like TON?';
        const qId = stringId(qText);
        await ubps.sendActivateQuestion(user.getSender(), toNano('0.5'), qId, buildStringCell(qText));
        const qAddr = ubps.questionAddress(qId, questionCode);

        const aText = 'Yes';
        const aId = stringId(aText);
        const aAddr = ubps.answerAddress(qAddr, aId, answerCode);
        const res = await ubps.sendActivateAnswer(user.getSender(), toNano('0.5'), qAddr, aId, buildStringCell(aText));
        expect(res.transactions).toHaveTransaction({ from: ubps.address, to: aAddr, success: true });

        const a = blockchain.openContract(Answer.createFromAddress(aAddr));
        expect(await a.getActive()).toBe(true);
        expect(await a.getQuestionAddress()).toEqualAddress(qAddr);
        expect((await a.getAnswer())!.beginParse().loadStringTail()).toBe(aText);
    });

    it('create a BeliefSet (root=true) at the next index; index increments', async () => {
        expect(await ubps.getNextBsIndex()).toBe(0n);
        const bsAddr = ubps.beliefSetAddress(0, beliefSetCode);
        const aSet = buildAddressSet([user.address, owner.address]);

        const res = await ubps.sendCreateBeliefSet(user.getSender(), toNano('0.5'), true, 2, 0, aSet, emptyCell());
        expect(res.transactions).toHaveTransaction({ from: ubps.address, to: bsAddr, success: true });
        expect(await ubps.getNextBsIndex()).toBe(1n);

        const bs = blockchain.openContract(BeliefSet.createFromAddress(bsAddr));
        expect(await bs.getCreated()).toBe(true);
        expect(await bs.getRoot()).toBe(true);
        expect(await bs.getIndex()).toBe(0n);
        const sets = await bs.getSets();
        expect(sets.aCount).toBe(2);
        expect(sets.bsCount).toBe(0);
    });

    it('rejects a BeliefSet over the MAX_A cap (604)', async () => {
        const res = await ubps.sendCreateBeliefSet(user.getSender(), toNano('0.5'), false, 101, 0, emptyCell(), emptyCell());
        expect(res.transactions).toHaveTransaction({
            to: ubps.address, success: false, exitCode: Errors.ERR_UBPS_TOO_MANY_A,
        });
    });

    it('Unit pointer: owner sets/clears it; a stranger is rejected (606)', async () => {
        const unit = blockchain.openContract(Unit.createFromConfig({
            ubpsMaster: ubps.address, userAddress: user.address,
        }, unitCode));
        await unit.sendDeploy(user.getSender(), toNano('0.1'));
        expect(await unit.getPointer()).toBeNull();

        await unit.sendSetPointer(user.getSender(), toNano('0.05'), owner.address);
        expect((await unit.getPointer())!).toEqualAddress(owner.address);

        // A non-user cannot move the pointer.
        const stranger = await blockchain.treasury('stranger');
        const bad = await unit.sendSetPointer(stranger.getSender(), toNano('0.05'), stranger.address);
        expect(bad.transactions).toHaveTransaction({
            to: unit.address, success: false, exitCode: Errors.ERR_UBPS_INVALID_OWNER_SENDER,
        });
        // Pointer unchanged, then cleared by the user.
        expect((await unit.getPointer())!).toEqualAddress(owner.address);
        await unit.sendSetPointer(user.getSender(), toNano('0.05'), null);
        expect(await unit.getPointer()).toBeNull();
    });
});
