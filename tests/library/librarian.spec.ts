// SPDX-License-Identifier: UNLICENSED
/**
 * Librarian unit spec (plan §6.2) — the production public-library publisher.
 *
 * Proves, deterministically in the @ton/sandbox emulator:
 *   - deploy → ACTIVE on wc -1, genesis publish ran (published==true, get_code_hash == code
 *     hash, a SETLIBCODE output action fired);
 *   - idempotency: re-sending the genesis message does NOT re-publish (no new action);
 *   - admin Withdraw reclaims the surplus while keeping the rent floor (funds RECOVERABLE);
 *   - non-admin Withdraw is REJECTED (ERR_NOT_ADMIN), a floor-breaching Withdraw is REJECTED
 *     (ERR_BELOW_FLOOR);
 *   - RePublish re-emits SETLIBCODE; RemoveLib unpublishes (published==false); admin-only;
 *   - griefing: an unauthenticated unknown-op message can NOT drain the balance;
 *   - determinism: same {code, admin} → same wc -1 address.
 *
 * (Whether the sandbox resolves the published library globally is NOT modeled — that is the
 *  child-resolution / live-run concern; see libraryResolution.spec.ts + the live acceptance.)
 */
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { Librarian, LIBRARIAN_WORKCHAIN } from '../../wrappers/librarian/Librarian';

const RENT_FLOOR = toNano('1.0'); // must match LIBRARIAN_RENT_FLOOR in librarian.tolk
const ERR_NOT_ADMIN = 401;
const ERR_BELOW_FLOOR = 402;

/** actionPhase {success,total} for the tx that landed on `addr`, or null. */
function actionOnAccount(res: any, addr: Address): { success: boolean; total: number } | null {
    const tx = res.transactions.find(
        (t: any) => t.inMessage?.info?.type === 'internal' && t.inMessage.info.dest?.equals?.(addr),
    );
    const d = tx?.description;
    if (d?.type === 'generic' && d.actionPhase) return { success: d.actionPhase.success, total: d.actionPhase.totalActions };
    return null;
}

describe('Librarian — production public-library publisher', () => {
    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let code: Cell;
    let librarianCode: Cell;

    const balOf = async (addr: Address) => (await blockchain.getContract(addr)).balance;

    const deploy = async (value: bigint = toNano('5'), theCode: Cell = code) => {
        const lib = blockchain.openContract(
            Librarian.createFromConfig({ adminAddress: admin.address, code: theCode }, librarianCode),
        );
        const res = await lib.sendDeploy(admin.getSender(), value);
        return { lib, res };
    };

    beforeAll(async () => {
        code = await compile('JettonWallet'); // arbitrary real code to publish
        librarianCode = await compile('Librarian');
    }, 120000);

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        admin = await blockchain.treasury('admin');
        stranger = await blockchain.treasury('stranger');
    });

    it('deploys ACTIVE on wc -1 and publishes (published, code_hash, SETLIBCODE action)', async () => {
        const { lib, res } = await deploy();
        expect(lib.address.workChain).toBe(LIBRARIAN_WORKCHAIN);
        expect((await blockchain.getContract(lib.address)).accountState?.type).toBe('active');
        expect(await lib.getPublished()).toBe(true);
        expect(await lib.getAdmin()).toEqualAddress(admin.address);
        expect(await lib.getCodeHash()).toBe(BigInt('0x' + code.hash().toString('hex')));
        const action = actionOnAccount(res, lib.address);
        expect(action?.success).toBe(true);
        expect(action?.total).toBeGreaterThanOrEqual(1); // the SETLIBCODE action
    });

    it('idempotency: re-sending the genesis message does not re-publish (no new action)', async () => {
        const { lib } = await deploy();
        const again = await lib.sendDeploy(admin.getSender(), toNano('0.2'));
        // Still published, still the same admin — and the second empty-body tx emitted NO action
        // (publishOnce was skipped by the `published` guard), so it cannot re-publish or drain.
        expect(await lib.getPublished()).toBe(true);
        const action = actionOnAccount(again, lib.address);
        expect(action?.success).toBe(true);
        expect(action?.total).toBe(0);
    });

    it('determinism: same {code, admin} → same wc -1 address', () => {
        const a = Librarian.createFromConfig({ adminAddress: admin.address, code }, librarianCode);
        const b = Librarian.createFromConfig({ adminAddress: admin.address, code }, librarianCode);
        expect(a.address.equals(b.address)).toBe(true);
        expect(a.address.workChain).toBe(LIBRARIAN_WORKCHAIN);
    });

    it('admin Withdraw reclaims the surplus and keeps the rent floor', async () => {
        const { lib } = await deploy(toNano('5'));
        const before = await balOf(lib.address);
        expect(before).toBeGreaterThan(toNano('4')); // ~5 retained on the account after publish

        const res = await lib.sendWithdraw(admin.getSender());
        // A message flowed librarian → admin (the surplus return).
        expect(res.transactions).toHaveTransaction({ from: lib.address, to: admin.address, success: true });
        const after = await balOf(lib.address);
        // The account keeps ~the rent floor and no more; the surplus went back to admin.
        expect(after).toBeGreaterThan(toNano('0.9'));
        expect(after).toBeLessThan(toNano('1.1'));
        expect(after).toBeLessThan(before);
    });

    it('non-admin Withdraw is REJECTED (ERR_NOT_ADMIN), funds untouched', async () => {
        const { lib } = await deploy(toNano('5'));
        const before = await balOf(lib.address);
        const res = await lib.sendWithdraw(stranger.getSender());
        expect(res.transactions).toHaveTransaction({ from: stranger.address, to: lib.address, exitCode: ERR_NOT_ADMIN });
        // No surplus left the account (the reject bounced the poke; balance did not drop toward 0).
        expect(await balOf(lib.address)).toBeGreaterThan(before - toNano('0.1'));
        expect(await lib.getPublished()).toBe(true);
    });

    it('Withdraw that would breach the rent floor is REJECTED (ERR_BELOW_FLOOR)', async () => {
        // Fund BELOW the floor: genesis keeps all incoming value (no reserve), so ~0.5 remains.
        const { lib } = await deploy(toNano('0.5'));
        const res = await lib.sendWithdraw(admin.getSender());
        expect(res.transactions).toHaveTransaction({ from: admin.address, to: lib.address, exitCode: ERR_BELOW_FLOOR });
        expect((await balOf(lib.address))).toBeLessThan(RENT_FLOOR + toNano('0.1'));
        expect(await lib.getPublished()).toBe(true); // library stays published
    });

    it('RePublish re-emits a SETLIBCODE action (admin only)', async () => {
        const { lib } = await deploy();
        const ok = await lib.sendRePublish(admin.getSender());
        expect(await lib.getPublished()).toBe(true);
        expect(actionOnAccount(ok, lib.address)?.total).toBeGreaterThanOrEqual(1);
        // Non-admin RePublish is rejected.
        const bad = await lib.sendRePublish(stranger.getSender());
        expect(bad.transactions).toHaveTransaction({ from: stranger.address, to: lib.address, exitCode: ERR_NOT_ADMIN });
    });

    it('RemoveLib unpublishes (published==false); admin only', async () => {
        const { lib } = await deploy();
        // Non-admin remove rejected first.
        const bad = await lib.sendRemove(stranger.getSender());
        expect(bad.transactions).toHaveTransaction({ from: stranger.address, to: lib.address, exitCode: ERR_NOT_ADMIN });
        expect(await lib.getPublished()).toBe(true);
        // Admin remove: emits the mode-0 SETLIBCODE action and clears `published`.
        const ok = await lib.sendRemove(admin.getSender());
        expect(actionOnAccount(ok, lib.address)?.total).toBeGreaterThanOrEqual(1);
        expect(await lib.getPublished()).toBe(false);
        // ...and it can be re-published afterwards.
        await lib.sendRePublish(admin.getSender());
        expect(await lib.getPublished()).toBe(true);
    });

    it('griefing: an unauthenticated unknown-op message cannot drain the balance', async () => {
        const { lib } = await deploy(toNano('5'));
        const before = await balOf(lib.address);
        // A non-admin poke with an unknown opcode: `fromSlice` throws → tx aborts + bounces.
        const res = await stranger.send({
            to: lib.address,
            value: toNano('0.5'),
            body: beginCell().storeUint(0xdeadbeef, 32).storeUint(0, 64).endCell(),
        });
        expect(res.transactions).toHaveTransaction({ from: stranger.address, to: lib.address, success: false });
        // The balance was not drained (it can only grow from a bounced poke, never emptied).
        expect(await balOf(lib.address)).toBeGreaterThan(before - toNano('0.1'));
        expect(await lib.getPublished()).toBe(true);
    });
});
