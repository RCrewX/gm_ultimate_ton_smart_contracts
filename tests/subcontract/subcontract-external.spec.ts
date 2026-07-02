// SPDX-License-Identifier: UNLICENSED
import { beginCell, external, toNano, SendMode } from '@ton/core';
import { SandboxContract } from '@ton/sandbox';
import '@ton/test-utils';
import { keyPairFromSeed } from '@ton/crypto';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { Subcontract, buildSubcontractExternal } from '../../wrappers/subcontract/Subcontract';
import { Forward } from '../../wrappers/subcontract/types';

// Subcontract error codes (contracts/subcontract/static.tolk).
const ERR_INVALID_SIGNATURE = 930;
const ERR_BAD_SEQNO = 931;
const ERR_EXPIRED = 932;
const ERR_WRONG_INSTANCE = 933;

const NOW = 1_900_000_000;

// =============================================================================
// Owner-signed EXTERNAL message path. The sandbox ContractProvider does not expose
// external(), so we deliver the envelope with `blockchain.sendMessage(external(...))`
// (same pattern the Ship session spec uses) and read the real exit code. Every guard
// (signature → id → seqno → validUntil) runs BEFORE acceptExternalMessage, so a bad
// external is rejected at the computation phase and blockchain.sendMessage throws with
// the exitCode — no state change, no gas drain.
//
// GM-A-013/014: the old suite swallowed every failure in try/catch and asserted only
// `seqno did not increment` / `>= 0`, so it never proved WHICH check fired and never
// exercised the accept path. This rewrite asserts concrete exit codes and adds the
// cross-instance-replay regression that pins GM-A-001.
// =============================================================================

describe('Subcontract — external (owner-signed) messages', () => {
    let SC: ContractSystem;
    let ownerKp: { publicKey: Buffer; secretKey: Buffer };
    let wrongKp: { publicKey: Buffer; secretKey: Buffer };
    let ownerPub: bigint;

    beforeEach(async () => {
        SC = await initContractSystem();
        SC.blockchain.now = NOW;
        ownerKp = keyPairFromSeed(Buffer.alloc(32, 0x11));
        wrongKp = keyPairFromSeed(Buffer.alloc(32, 0x22));
        ownerPub = BigInt('0x' + ownerKp.publicKey.toString('hex'));
    }, 120000);

    afterEach(() => {
        cleanupContractSystem(SC);
        SC = null as any;
    });

    // Deploy a subcontract with the given id, funded so it can run a Forward.
    async function deploySub(id: bigint, funded = toNano('1')): Promise<SandboxContract<Subcontract>> {
        const sub = SC.blockchain.openContract(
            Subcontract.createFromConfig(
                { ownerAddress: SC.ownerAccount.address, id, ownerPublicKey: ownerPub },
                SC.subcontractCode,
            ),
        );
        await sub.sendDeploy(SC.ownerAccount.getSender(), toNano('0.5'));
        // Top the instance up so the external Forward has balance for gas + forward.
        await SC.ownerAccount.send({ to: sub.address, value: funded });
        return sub;
    }

    function forwardCmd(dest: any, forwardTonAmount = toNano('0.05')): Forward {
        return {
            queryId: 0n,
            destination: dest,
            forwardTonAmount,
            bounce: false,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            messageBody: beginCell().storeUint(0x12345678, 32).storeUint(42, 64).endCell(),
        };
    }

    // Deliver a signed external and return its exit code (undefined = accepted/succeeded).
    async function deliver(
        sub: SandboxContract<Subcontract>,
        args: { secretKey?: Buffer; id: bigint; seqno: number; validUntil: number; command: Forward },
    ): Promise<number | undefined> {
        const body = buildSubcontractExternal({
            secretKey: args.secretKey ?? ownerKp.secretKey,
            id: args.id,
            seqno: args.seqno,
            validUntil: args.validUntil,
            command: args.command,
        });
        try {
            await SC.blockchain.sendMessage(external({ to: sub.address, body }));
            return undefined;
        } catch (e: any) {
            return e?.exitCode;
        }
    }

    it('happy path: a valid owner-signed Forward is accepted; seqno advances and the message is forwarded', async () => {
        const sub = await deploySub(1n);
        const recipient = await SC.blockchain.treasury('recipient');
        expect(await sub.getExtSeqno()).toBe(0);

        const cmd = forwardCmd(recipient.address);
        const body = buildSubcontractExternal({ secretKey: ownerKp.secretKey, id: 1n, seqno: 0, validUntil: NOW + 3600, command: cmd });
        const res = await SC.blockchain.sendMessage(external({ to: sub.address, body }));

        // The subcontract forwarded to the recipient…
        expect(res.transactions).toHaveTransaction({
            from: sub.address,
            to: recipient.address,
            success: true,
        });
        // …and the seqno advanced exactly once (replay protection armed).
        expect(await sub.getExtSeqno()).toBe(1);
    });

    it('a wrong-key signature is rejected (ERR_INVALID_SIGNATURE) with no state change', async () => {
        const sub = await deploySub(1n);
        const recipient = await SC.blockchain.treasury('recipient');
        const exit = await deliver(sub, { secretKey: wrongKp.secretKey, id: 1n, seqno: 0, validUntil: NOW + 3600, command: forwardCmd(recipient.address) });
        expect(exit).toBe(ERR_INVALID_SIGNATURE);
        expect(await sub.getExtSeqno()).toBe(0);
    });

    it('an expired envelope is rejected (ERR_EXPIRED)', async () => {
        const sub = await deploySub(1n);
        const recipient = await SC.blockchain.treasury('recipient');
        const exit = await deliver(sub, { id: 1n, seqno: 0, validUntil: NOW - 1, command: forwardCmd(recipient.address) });
        expect(exit).toBe(ERR_EXPIRED);
        expect(await sub.getExtSeqno()).toBe(0);
    });

    it('a replayed seqno is rejected (ERR_BAD_SEQNO)', async () => {
        const sub = await deploySub(1n);
        const recipient = await SC.blockchain.treasury('recipient');
        // First valid external advances seqno 0 -> 1.
        expect(await deliver(sub, { id: 1n, seqno: 0, validUntil: NOW + 3600, command: forwardCmd(recipient.address) })).toBeUndefined();
        expect(await sub.getExtSeqno()).toBe(1);
        // Re-sending seqno 0 is a replay.
        const exit = await deliver(sub, { id: 1n, seqno: 0, validUntil: NOW + 3600, command: forwardCmd(recipient.address) });
        expect(exit).toBe(ERR_BAD_SEQNO);
        expect(await sub.getExtSeqno()).toBe(1);
    });

    it('an envelope signed for a different id is rejected (ERR_WRONG_INSTANCE)', async () => {
        const sub = await deploySub(7n);
        const recipient = await SC.blockchain.treasury('recipient');
        // Correctly signed by the owner, correct seqno + validity, but bound to id=8 not 7.
        const exit = await deliver(sub, { id: 8n, seqno: 0, validUntil: NOW + 3600, command: forwardCmd(recipient.address) });
        expect(exit).toBe(ERR_WRONG_INSTANCE);
        expect(await sub.getExtSeqno()).toBe(0);
    });

    // GM-A-001 regression: two instances share the SAME ownerPublicKey and sit at the SAME
    // seqno (0); only their `id` differs. An envelope that is fully valid for instance #1
    // must be rejected by instance #2 — proving the signed payload is instance-bound and a
    // cross-instance replay is impossible.
    it('cross-instance replay: a valid envelope for instance #1 is rejected by instance #2', async () => {
        const sub1 = await deploySub(100n);
        const sub2 = await deploySub(200n);
        const recipient = await SC.blockchain.treasury('recipient');
        expect(await sub1.getExtSeqno()).toBe(0);
        expect(await sub2.getExtSeqno()).toBe(0);

        // Build a valid envelope for instance #1 (id=100, seqno=0).
        const cmd = forwardCmd(recipient.address);
        const envForSub1 = buildSubcontractExternal({ secretKey: ownerKp.secretKey, id: 100n, seqno: 0, validUntil: NOW + 3600, command: cmd });

        // Deliver that exact envelope to instance #2 → rejected (id 100 != storage.id 200).
        let exit: number | undefined;
        try {
            await SC.blockchain.sendMessage(external({ to: sub2.address, body: envForSub1 }));
            exit = undefined;
        } catch (e: any) {
            exit = e?.exitCode;
        }
        expect(exit).toBe(ERR_WRONG_INSTANCE);
        expect(await sub2.getExtSeqno()).toBe(0);

        // The same envelope IS valid for its own instance #1.
        const res = await SC.blockchain.sendMessage(external({ to: sub1.address, body: envForSub1 }));
        expect(res.transactions).toHaveTransaction({ from: sub1.address, to: recipient.address, success: true });
        expect(await sub1.getExtSeqno()).toBe(1);
    });

    it('getters expose ownerPublicKey + seqno', async () => {
        const sub = await deploySub(6n);
        expect(await sub.getOwnerPublicKey()).toBe(ownerPub);
        expect(await sub.getExtSeqno()).toBe(0);
        expect(await sub.getId()).toBe(6n);
    });
});
