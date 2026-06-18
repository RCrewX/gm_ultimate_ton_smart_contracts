// SPDX-License-Identifier: UNLICENSED
// Mechanic: PRECISE create-op payer refund. Every UBPS master create arm
// (ActivateQuestion / ActivateAnswer / CreateBeliefSet / CreateUnit) forwards a FIXED
// UBPS_CHILD_DEPLOY_VALUE to the deployed child and returns the remainder to the PAYER
// (in.senderAddress) via ReturnExcessesBack — nothing stranded (the old carry-all left
// ~0.139 TON on every child forever). This spec asserts, per op:
//   1. a ReturnExcessesBack tx goes master -> payer, success;
//   2. the refund amount  ≈ sent − UBPS_CHILD_DEPLOY_VALUE − gas  (tolerance band);
//   3. the payer's NET cost is small (≈ child budget + gas), ≪ the amount sent;
//   4. the deployed child holds ≈ UBPS_CHILD_DEPLOY_VALUE (NOT the old ~0.139 carry-all);
// plus a mini-schema cost check: ~10 nodes cost ≪ 10 × the old 0.15 TON/op.
import { toNano, fromNano, Address } from '@ton/core';
import type { SendMessageResult } from '@ton/sandbox';
import '@ton/test-utils';
import { UbpsCodes, UbpsSystem, compileUbps, initUbps } from './ubps_setup';
import {
    Opcodes, BASIC_STORAGE_TAX, UBPS_CHILD_DEPLOY_VALUE,
    stringId, buildStringCell, emptyCell,
} from '../../wrappers/ubps/types';

describe('UBPS create-op refund (precise: payer refunded, child funded to budget)', () => {
    let codes: UbpsCodes;
    let S: UbpsSystem;
    beforeAll(async () => { codes = await compileUbps(); });
    beforeEach(async () => { S = await initUbps(codes); }, 60000);

    async function balanceOf(addr: Address): Promise<bigint> {
        return (await S.blockchain.getContract(addr)).balance;
    }

    // Find the value (coins) of the ReturnExcessesBack message `from` -> `to`, or null.
    function refundValue(res: SendMessageResult, from: Address, to: Address): bigint | null {
        for (const tx of res.transactions) {
            const im = tx.inMessage;
            if (!im || im.info.type !== 'internal') continue;
            if (!im.info.src || !im.info.dest) continue;
            if (!im.info.src.equals(from) || !im.info.dest.equals(to)) continue;
            const s = im.body.beginParse();
            if (s.remainingBits < 32) continue;
            if (s.preloadUint(32) !== Opcodes.OP_RETURN_EXCESSES_BACK) continue;
            return im.info.value.coins;
        }
        return null;
    }

    // Assert the 4 refund invariants for one create op.
    async function assertRefund(
        opName: string,
        childAddr: Address,
        sent: bigint,
        runOp: () => Promise<SendMessageResult>,
    ) {
        const payerBefore = await S.user.getBalance();
        const res = await runOp();
        const payerAfter = await S.user.getBalance();

        // (1) ReturnExcessesBack: master -> payer, success.
        expect(res.transactions).toHaveTransaction({
            from: S.ubps.address, to: S.user.address,
            op: Opcodes.OP_RETURN_EXCESSES_BACK, success: true,
        });
        const refund = refundValue(res, S.ubps.address, S.user.address);
        expect(refund).not.toBeNull();

        // (2) refund ≈ sent − UBPS_CHILD_DEPLOY_VALUE − gas (strictly less by the gas; within 0.04).
        const expectedMax = sent - UBPS_CHILD_DEPLOY_VALUE;          // upper bound (zero gas)
        expect(refund!).toBeLessThan(expectedMax);
        expect(refund!).toBeGreaterThan(expectedMax - toNano('0.04'));

        // (3) payer NET cost is small (≈ child budget + gas) and ≪ what was sent.
        const net = payerBefore - payerAfter;
        expect(net).toBeGreaterThan(0n);
        expect(net).toBeLessThan(UBPS_CHILD_DEPLOY_VALUE + toNano('0.05')); // ≈ child + gas
        expect(net).toBeLessThan(sent / 2n);                               // proves the refund worked

        // (4) child funded to ≈ UBPS_CHILD_DEPLOY_VALUE — NOT the old stranded carry-all.
        const childBal = await balanceOf(childAddr);
        expect(childBal).toBeGreaterThanOrEqual(BASIC_STORAGE_TAX);
        expect(childBal).toBeLessThan(UBPS_CHILD_DEPLOY_VALUE + toNano('0.005'));
        expect(childBal).toBeLessThan(toNano('0.1')); // anti-regression vs the old ~0.139 strand

        console.log(`[refund] ${opName}: sent=${fromNano(sent)} refund=${fromNano(refund!)} ` +
            `net=${fromNano(net)} child=${fromNano(childBal)} TON`);
    }

    const SENT = toNano('0.5'); // generous; the bulk must come back as refund

    it('ActivateQuestion (Q): payer refunded, Q funded to budget', async () => {
        const qtext = 'Are you happy?';
        const id = stringId(qtext);
        const qAddr = S.ubps.questionAddress(id, codes.questionCode);
        await assertRefund('activate-Q', qAddr, SENT, () =>
            S.ubps.sendActivateQuestion(S.user.getSender(), SENT, id, buildStringCell(qtext)));
    });

    it('ActivateAnswer (A): payer refunded, A funded to budget', async () => {
        const qAddr = S.ubps.questionAddress(stringId('q'), codes.questionCode);
        const aId = stringId('Yes');
        const aAddr = S.ubps.answerAddress(qAddr, aId, codes.answerCode);
        await assertRefund('activate-A', aAddr, SENT, () =>
            S.ubps.sendActivateAnswer(S.user.getSender(), SENT, qAddr, aId, buildStringCell('Yes')));
    });

    it('CreateBeliefSet (BS): payer refunded, BS funded to budget', async () => {
        const bsAddr = S.ubps.beliefSetAddress(0, codes.beliefSetCode);
        await assertRefund('create-BS', bsAddr, SENT, () =>
            S.ubps.sendCreateBeliefSet(S.user.getSender(), SENT, false, 0, 0, emptyCell(), emptyCell()));
    });

    it('CreateUnit (U): payer refunded, U funded to budget', async () => {
        const uAddr = S.ubps.unitAddress(S.user.address, codes.unitCode);
        await assertRefund('create-U', uAddr, SENT, () =>
            S.ubps.sendCreateUnit(S.user.getSender(), SENT, null));
    });

    it('mini-schema: ~10 create ops cost FAR less than 10 × the old 0.15 TON/op', async () => {
        const N = 10;
        const before = await S.user.getBalance();
        // 10 distinct BeliefSets (monotonic index 0..9), each over-funded then refunded.
        for (let i = 0; i < N; i++) {
            await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.1'), false, 0, 0, emptyCell(), emptyCell());
        }
        const after = await S.user.getBalance();
        const net = before - after;
        const oldCost = toNano('0.15') * BigInt(N); // 1.5 TON — old carry-all spent+stranded
        expect(net).toBeLessThan(oldCost / 2n);      // ≪ : in practice ~4–5× cheaper
        // index advanced by exactly N (all ops landed).
        expect(await S.ubps.getNextBsIndex()).toBe(BigInt(N));
        console.log(`[refund] mini-schema ${N} nodes: net=${fromNano(net)} TON (old ≈ ${fromNano(oldCost)} TON)`);
    });
});
