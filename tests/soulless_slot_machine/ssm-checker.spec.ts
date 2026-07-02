// SPDX-License-Identifier: UNLICENSED
import { Address, Cell, toNano } from '@ton/core';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { SSMChecker } from '../../wrappers/soulless_slot_machine/SSMChecker';
import { CUSTOM_ALLOWED_AMOUNT, Opcodes, SsmCheckerErrors, CUSTOM_VERIFY_TTL } from '../../wrappers/soulless_slot_machine/types';

// =============================================================================
// SSMChecker unit tests — the ephemeral custom-intake verifier child, driven
// DIRECTLY (an "ssm" stand-in treasury plays the owning SoullessSlotMachine).
// Proves: SSM-only StartVerify gate; the TEP-89 request; master-only answer gate;
// match -> VerifiedRoll + self-destruct; mismatch -> RefundEscrow + self-destruct;
// busy-collision refund; timeout Reclaim; phase/auth guards.
// =============================================================================

const NOW = 1_900_000_000;
const VALUE = toNano('1.3');
const DEADLINE = NOW + CUSTOM_VERIFY_TTL;

describe('SSMChecker (custom-intake verifier child)', () => {
    let blockchain: Blockchain;
    let checkerCode: Cell;
    let ssm: SandboxContract<TreasuryContract>;      // stand-in for the owning SSM
    let player: SandboxContract<TreasuryContract>;
    let master: SandboxContract<TreasuryContract>;   // the claimed jetton master
    let escrowWallet: SandboxContract<TreasuryContract>; // W: SSM's wallet for `master`
    let attacker: SandboxContract<TreasuryContract>;

    beforeAll(async () => {
        checkerCode = await compile('SSMChecker');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = NOW;
        ssm = await blockchain.treasury('ssmStandIn');
        player = await blockchain.treasury('player');
        master = await blockchain.treasury('master');
        escrowWallet = await blockchain.treasury('escrowW');
        attacker = await blockchain.treasury('attacker');
    });

    // Open the checker for (player, master); its first message auto-attaches the init.
    function openChecker(masterAddr: Address = master.address) {
        return blockchain.openContract(
            SSMChecker.createFromConfig({ ssmAddress: ssm.address, player: player.address, master: masterAddr }, checkerCode),
        );
    }

    function startVerify(
        c: SandboxContract<SSMChecker>,
        via: SandboxContract<TreasuryContract>,
        opts: { w?: Address; stake?: bigint; queryId?: bigint; value?: bigint; deadline?: number } = {},
    ) {
        return c.sendStartVerify(via.getSender(), opts.value ?? VALUE, {
            escrowWallet: opts.w ?? escrowWallet.address,
            stake: opts.stake ?? CUSTOM_ALLOWED_AMOUNT,
            queryId: opts.queryId ?? 1n,
            deadline: opts.deadline ?? DEADLINE,
        });
    }

    async function accountGone(addr: Address): Promise<boolean> {
        const c = await blockchain.getContract(addr);
        return c.accountState === undefined || c.accountState.type !== 'active';
    }

    // ---- StartVerify gate + Phase 1 -----------------------------------------

    it('StartVerify from a non-SSM sender is rejected (ERR_CHECKER_INVALID_SSM_SENDER)', async () => {
        const c = openChecker();
        const r = await startVerify(c, attacker);
        expect(r.transactions).toHaveTransaction({
            to: c.address,
            success: false,
            exitCode: SsmCheckerErrors.ERR_CHECKER_INVALID_SSM_SENDER,
        });
    });

    it('StartVerify from SSM records the escrow and queries the master via TEP-89', async () => {
        const c = openChecker();
        const r = await startVerify(c, ssm, { queryId: 5n });

        // The checker asked the claimed master for its wallet-for-SSM.
        expect(r.transactions).toHaveTransaction({
            from: c.address,
            to: master.address,
            op: Opcodes.OP_REQUEST_WALLET_ADDRESS,
            success: true,
        });

        const st = await c.getCheckerState();
        expect(st.phase).toBe(1);
        expect(st.player).toEqualAddress(player.address);
        expect(st.master).toEqualAddress(master.address);
        expect(st.escrowWallet).toEqualAddress(escrowWallet.address);
        expect(st.stake).toBe(CUSTOM_ALLOWED_AMOUNT);
        expect(st.deadline).toBe(DEADLINE);
    });

    // ---- Phase 2 (master answers) -------------------------------------------

    it('match: the queried master vouches for W → VerifiedRoll to SSM, checker self-destructs', async () => {
        const c = openChecker();
        await startVerify(c, ssm, { queryId: 7n });

        const r = await c.sendResponseWalletAddress(master.getSender(), VALUE, escrowWallet.address, 7n, ssm.address);
        expect(r.transactions).toHaveTransaction({
            from: c.address,
            to: ssm.address,
            op: Opcodes.OP_VERIFIED_ROLL,
            success: true,
        });
        // Not a RefundEscrow, and the checker is gone.
        expect(r.transactions).not.toHaveTransaction({ from: c.address, op: Opcodes.OP_REFUND_ESCROW });
        expect(await accountGone(c.address)).toBe(true);
    });

    it('mismatch: the master vouches for a DIFFERENT wallet → RefundEscrow to SSM, checker self-destructs', async () => {
        const wGood = await blockchain.treasury('masterRealWallet');
        const c = openChecker();
        await startVerify(c, ssm, { queryId: 8n });

        const r = await c.sendResponseWalletAddress(master.getSender(), VALUE, wGood.address, 8n, ssm.address);
        expect(r.transactions).toHaveTransaction({
            from: c.address,
            to: ssm.address,
            op: Opcodes.OP_REFUND_ESCROW,
            success: true,
        });
        expect(r.transactions).not.toHaveTransaction({ from: c.address, op: Opcodes.OP_VERIFIED_ROLL });
        expect(await accountGone(c.address)).toBe(true);
    });

    it('a null wallet answer (master has no wallet) → RefundEscrow, self-destruct', async () => {
        const c = openChecker();
        await startVerify(c, ssm, { queryId: 9n });
        const r = await c.sendResponseWalletAddress(master.getSender(), VALUE, null, 9n, ssm.address);
        expect(r.transactions).toHaveTransaction({ from: c.address, to: ssm.address, op: Opcodes.OP_REFUND_ESCROW, success: true });
        expect(await accountGone(c.address)).toBe(true);
    });

    it('an answer from someone other than the queried master is rejected (ERR_CHECKER_NOT_MASTER); the checker survives', async () => {
        const c = openChecker();
        await startVerify(c, ssm, { queryId: 3n });
        const r = await c.sendResponseWalletAddress(attacker.getSender(), VALUE, escrowWallet.address, 3n, ssm.address);
        expect(r.transactions).toHaveTransaction({
            to: c.address,
            success: false,
            exitCode: SsmCheckerErrors.ERR_CHECKER_NOT_MASTER,
        });
        expect((await c.getCheckerState()).phase).toBe(1); // undisturbed
    });

    it('an answer echoing the WRONG owner is rejected (ERR_CHECKER_NOT_MASTER)', async () => {
        const c = openChecker();
        await startVerify(c, ssm, { queryId: 4n });
        // Master answers but echoes owner = attacker (not the SSM we asked for).
        const r = await c.sendResponseWalletAddress(master.getSender(), VALUE, escrowWallet.address, 4n, attacker.address);
        expect(r.transactions).toHaveTransaction({
            to: c.address,
            success: false,
            exitCode: SsmCheckerErrors.ERR_CHECKER_NOT_MASTER,
        });
        expect((await c.getCheckerState()).phase).toBe(1);
    });

    it('an answer before any StartVerify (phase 0) is rejected (ERR_CHECKER_BAD_PHASE)', async () => {
        const c = openChecker();
        // Master answers a never-started verification → phase 0 → bad phase. (The master
        // is also the deploying sender here, so the account may init then throw.)
        const r = await c.sendResponseWalletAddress(master.getSender(), VALUE, escrowWallet.address, 1n, ssm.address);
        expect(r.transactions).toHaveTransaction({
            to: c.address,
            success: false,
            exitCode: SsmCheckerErrors.ERR_CHECKER_BAD_PHASE,
        });
    });

    // ---- Busy collision ------------------------------------------------------

    it('a second StartVerify for a busy checker refunds THAT intake and leaves the live one untouched', async () => {
        const c = openChecker();
        await startVerify(c, ssm, { queryId: 1n });
        const before = await c.getCheckerState();

        const r = await startVerify(c, ssm, { queryId: 2n });
        // The second intake is bounced back to SSM as a RefundEscrow carrying queryId 2.
        expect(r.transactions).toHaveTransaction({
            from: c.address,
            to: ssm.address,
            op: Opcodes.OP_REFUND_ESCROW,
            success: true,
        });
        // The live verification (queryId 1) is untouched and still awaiting its answer.
        const after = await c.getCheckerState();
        expect(after.phase).toBe(1);
        expect(after.deadline).toBe(before.deadline);
    });

    // ---- Timeout reclaim -----------------------------------------------------

    it('Reclaim before the deadline is rejected (ERR_CHECKER_NOT_EXPIRED)', async () => {
        const c = openChecker();
        await startVerify(c, ssm, { queryId: 1n });
        const r = await c.sendReclaim(player.getSender(), toNano('0.2'), 1n);
        expect(r.transactions).toHaveTransaction({
            to: c.address,
            success: false,
            exitCode: SsmCheckerErrors.ERR_CHECKER_NOT_EXPIRED,
        });
        expect((await c.getCheckerState()).phase).toBe(1);
    });

    it('Reclaim by a stranger is rejected (ERR_CHECKER_RECLAIM_NOT_AUTH)', async () => {
        const c = openChecker();
        await startVerify(c, ssm, { queryId: 1n });
        blockchain.now = DEADLINE + 1;
        const r = await c.sendReclaim(attacker.getSender(), toNano('0.2'), 1n);
        expect(r.transactions).toHaveTransaction({
            to: c.address,
            success: false,
            exitCode: SsmCheckerErrors.ERR_CHECKER_RECLAIM_NOT_AUTH,
        });
        expect((await c.getCheckerState()).phase).toBe(1);
    });

    it('Reclaim by the player after the deadline → RefundEscrow, self-destruct', async () => {
        const c = openChecker();
        await startVerify(c, ssm, { queryId: 1n });
        blockchain.now = DEADLINE + 1;
        const r = await c.sendReclaim(player.getSender(), toNano('0.2'), 1n);
        expect(r.transactions).toHaveTransaction({
            from: c.address,
            to: ssm.address,
            op: Opcodes.OP_REFUND_ESCROW,
            success: true,
        });
        expect(await accountGone(c.address)).toBe(true);
    });

    it('Reclaim by the owning SSM after the deadline is also authorized', async () => {
        const c = openChecker();
        await startVerify(c, ssm, { queryId: 1n });
        blockchain.now = DEADLINE + 1;
        const r = await c.sendReclaim(ssm.getSender(), toNano('0.2'), 1n);
        expect(r.transactions).toHaveTransaction({ from: c.address, to: ssm.address, op: Opcodes.OP_REFUND_ESCROW, success: true });
        expect(await accountGone(c.address)).toBe(true);
    });
});
