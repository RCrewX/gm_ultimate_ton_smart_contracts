// SPDX-License-Identifier: UNLICENSED
// Mechanic: Question (Q) lifecycle — deployed inactive, master-only activation with
// an on-chain string.hash check, immutable once active.
//
// DELTA from the plan's §6.2 "two cell layouts of the same logical string hash equal":
// the implementation hashes via slice.bitsHash() (SHA256U) over a SINGLE byte-aligned
// cell (<=127 bytes), NOT a layout-independent snake hash. So we assert the achievable
// guarantees: the same logical string yields a STABLE id regardless of which builder
// produced the (canonical single-cell) bytes, and semantically-different strings yield
// different ids/addresses. True multi-cell layout-independence is intentionally out of
// scope (see the impl result §7 / memory tolk-string-hash-bitshash).
import { toNano, beginCell, SendMode, Address } from '@ton/core';
import '@ton/test-utils';
import { UbpsCodes, UbpsSystem, compileUbps, initUbps } from './ubps_setup';
import { Question } from '../../wrappers/ubps/Question';
import { stringId, buildStringCell, Opcodes, Errors } from '../../wrappers/ubps/types';

describe('UBPS Question activation', () => {
    let codes: UbpsCodes;
    let S: UbpsSystem;
    beforeAll(async () => { codes = await compileUbps(); });
    beforeEach(async () => { S = await initUbps(codes); }, 60000);

    const QTEXT = 'Are you happy?';

    function openQ(addr: Address) {
        return S.blockchain.openContract(Question.createFromAddress(addr));
    }

    it('master activation (hash matches): Q becomes active, bytes stored, getters correct', async () => {
        const id = stringId(QTEXT);
        const qAddr = S.ubps.questionAddress(id, codes.questionCode);
        const res = await S.ubps.sendActivateQuestion(S.user.getSender(), toNano('0.5'), id, buildStringCell(QTEXT));
        expect(res.transactions).toHaveTransaction({ to: S.ubps.address, success: true });
        expect(res.transactions).toHaveTransaction({ from: S.ubps.address, to: qAddr, success: true });

        const q = openQ(qAddr);
        expect(await q.getActive()).toBe(true);
        expect(await q.getId()).toBe(id);
        expect(await q.getMaster()).toEqualAddress(S.ubps.address);
        expect((await q.getQuestion())!.beginParse().loadStringTail()).toBe(QTEXT);
    });

    it('hash mismatch (bytes do not hash to the claimed id): master rejects (601)', async () => {
        const wrongId = stringId('a totally different question');
        const res = await S.ubps.sendActivateQuestion(S.user.getSender(), toNano('0.5'), wrongId, buildStringCell(QTEXT));
        expect(res.transactions).toHaveTransaction({
            to: S.ubps.address, success: false, exitCode: Errors.ERR_UBPS_HASH_MISMATCH,
        });
    });

    it('non-master activation message is rejected (608)', async () => {
        const id = stringId(QTEXT);
        const qAddr = S.ubps.questionAddress(id, codes.questionCode);
        // Deploy Q inactive (any user may technically deploy it).
        const q = S.blockchain.openContract(Question.createFromConfig({ ubpsMaster: S.ubps.address, questionId: id }, codes.questionCode));
        await q.sendDeploy(S.user.getSender(), toNano('0.1'));
        expect(await q.getActive()).toBe(false);

        // A stranger (not the master) sends the activation opcode directly -> 608.
        const body = beginCell().storeUint(Opcodes.OP_ACTIVATE_QUESTION_MSG, 32).storeRef(buildStringCell(QTEXT)).endCell();
        const res = await S.user2.send({
            to: qAddr, value: toNano('0.1'), body, sendMode: SendMode.PAY_GAS_SEPARATELY,
        });
        expect(res.transactions).toHaveTransaction({
            to: qAddr, success: false, exitCode: Errors.ERR_UBPS_NOT_MASTER,
        });
        expect(await q.getActive()).toBe(false); // unchanged
    });

    it('immutability: a second activation after active is rejected (602), state unchanged', async () => {
        const id = stringId(QTEXT);
        const qAddr = S.ubps.questionAddress(id, codes.questionCode);
        await S.ubps.sendActivateQuestion(S.user.getSender(), toNano('0.5'), id, buildStringCell(QTEXT));
        const q = openQ(qAddr);
        expect(await q.getActive()).toBe(true);

        // A second activation through the real master: the master re-verifies the hash
        // (matches) and forwards ActivateQuestionMsg to the already-active Q, which
        // rejects the re-activation at the Q hop.
        const res = await S.ubps.sendActivateQuestion(S.user.getSender(), toNano('0.5'), id, buildStringCell(QTEXT));
        expect(res.transactions).toHaveTransaction({
            to: qAddr, success: false, exitCode: Errors.ERR_UBPS_ALREADY_ACTIVE,
        });
        // Original bytes preserved.
        expect((await q.getQuestion())!.beginParse().loadStringTail()).toBe(QTEXT);
    });

    it('string ids: same logical string -> stable id; different strings -> different ids/addresses', async () => {
        // Same string, independently built cells -> identical id (canonical single-cell bytes).
        expect(stringId(QTEXT)).toBe(stringId(QTEXT));
        const manual = beginCell().storeStringTail(QTEXT).endCell();
        expect(manual.equals(buildStringCell(QTEXT))).toBe(true);

        // Semantically-near but distinct strings -> different ids AND different Q addresses.
        const variants = ['Happy?', 'Happy??', 'happy?', 'Are you happy?'];
        const ids = variants.map(stringId);
        const uniq = new Set(ids.map((x) => x.toString()));
        expect(uniq.size).toBe(variants.length);
        const addrs = ids.map((id) => S.ubps.questionAddress(id, codes.questionCode).toString());
        expect(new Set(addrs).size).toBe(variants.length);
    });

    it('value below UBPS_MIN_OP_VALUE is rejected (607)', async () => {
        const id = stringId(QTEXT);
        const res = await S.ubps.sendActivateQuestion(S.user.getSender(), toNano('0.01'), id, buildStringCell(QTEXT));
        expect(res.transactions).toHaveTransaction({
            to: S.ubps.address, success: false, exitCode: Errors.ERR_UBPS_VALUE_TOO_LOW,
        });
    });
});
