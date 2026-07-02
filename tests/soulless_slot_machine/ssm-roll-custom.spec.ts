// SPDX-License-Identifier: UNLICENSED
import { Address, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import {
    CUSTOM_ALLOWED_AMOUNT,
    ONE_RUDA,
    expectedOutcome,
    OUT_NOTHING,
    OUT_NFT,
    OUT_RETURN_ESCROW,
    Opcodes,
    SsmErrors,
    SsmCheckerErrors,
    CUSTOM_VERIFY_TTL,
} from '../../wrappers/soulless_slot_machine/types';
import { SSMChecker } from '../../wrappers/soulless_slot_machine/SSMChecker';
import {
    setupSsmLight,
    setSeed,
    readRollSymbols,
    findEmittedRequest,
    findEscrowReturn,
    hasCashback,
    SsmLight,
} from './ssm_setup';

// =============================================================================
// Custom-jetton roll — verification via the ephemeral SSMChecker child (GM-B-001 /
// gm-fix-1b). SSM writes NO per-verification state: it deploys a checker keyed by
// (player, master), which does the TEP-89 handshake itself and hands SSM a
// VerifiedRoll (roll) or RefundEscrow (return escrow), then self-destructs.
//
// Here the "master" is a stand-in treasury we drive manually (it answers the
// checker's TEP-89 request). The full handshake against a REAL minter is the e2e spec.
// =============================================================================

const NOW = 1_900_000_000;
const ROLL_VALUE = toNano('1.5'); // > MIN_ROLL_VALUE (1.3)

describe('SSM custom-jetton roll (SSMChecker child)', () => {
    let S: SsmLight;
    let escrowWallet: SandboxContract<TreasuryContract>; // stand-in for the escrow jetton wallet W
    let customMaster: SandboxContract<TreasuryContract>; // the claimed custom master == origin
    let attacker: SandboxContract<TreasuryContract>;

    beforeEach(async () => {
        S = await setupSsmLight();
        S.blockchain.now = NOW;
        escrowWallet = await S.blockchain.treasury('ssmCustomWallet');
        customMaster = await S.blockchain.treasury('customMaster');
        attacker = await S.blockchain.treasury('attacker');
    });

    // Phase 1: escrow notification from W claiming `master`.
    function notify(master: Address, amount: bigint, value: bigint, queryId: bigint, w = escrowWallet) {
        return S.ssm.sendCustomTransferNotification(w.getSender(), value, amount, master, S.player.address, queryId);
    }

    async function openChecker(master: Address) {
        const addr = await S.ssm.getCheckerAddress(S.player.address, master);
        return S.blockchain.openContract(SSMChecker.createFromAddress(addr));
    }

    // Phase 2: `master` answers TEP-89 to the checker, vouching that `walletAddr` is its
    // wallet for owner=SSM. A genuine reply returns the escrow wallet W → SSM rolls.
    async function respond(master: SandboxContract<TreasuryContract>, walletAddr: Address, queryId: bigint, value = ROLL_VALUE) {
        const checker = await openChecker(master.address);
        return checker.sendResponseWalletAddress(master.getSender(), value, walletAddr, queryId, S.ssm.address);
    }

    async function checkerState(master: Address) {
        const checker = await openChecker(master);
        return checker.getCheckerState();
    }

    async function checkerGone(master: Address): Promise<boolean> {
        const addr = await S.ssm.getCheckerAddress(S.player.address, master);
        const c = await S.blockchain.getContract(addr);
        return c.accountState === undefined || c.accountState.type !== 'active';
    }

    // ---- Phase 1 behaviour ---------------------------------------------------

    it('phase 1 deploys a checker that asks the claimed master for its wallet — SSM does NOT roll or store state', async () => {
        const r = await notify(customMaster.address, CUSTOM_ALLOWED_AMOUNT, ROLL_VALUE, 1n);

        const checkerAddr = await S.ssm.getCheckerAddress(S.player.address, customMaster.address);
        // The checker (not SSM) asked the claimed master via TEP-89…
        expect(r.transactions).toHaveTransaction({
            from: checkerAddr,
            to: customMaster.address,
            op: Opcodes.OP_REQUEST_WALLET_ADDRESS,
            success: true,
        });
        // …and NO roll ran.
        expect(readRollSymbols(r, S.ssm.address)).toBeNull();

        // The pending verification lives on the checker, keyed by (player, master), with a TTL.
        const st = await checkerState(customMaster.address);
        expect(st.phase).toBe(1);
        expect(st.player).toEqualAddress(S.player.address);
        expect(st.master).toEqualAddress(customMaster.address);
        expect(st.escrowWallet).toEqualAddress(escrowWallet.address);
        expect(st.stake).toBe(CUSTOM_ALLOWED_AMOUNT);
        expect(st.deadline).toBe(NOW + CUSTOM_VERIFY_TTL);
    });

    it('rejects a custom stake that is not exactly 1_000_000 raw (no checker deployed)', async () => {
        const r = await notify(customMaster.address, 999_999n, ROLL_VALUE, 1n);
        expect(r.transactions).toHaveTransaction({
            to: S.ssm.address,
            success: false,
            exitCode: SsmErrors.ERR_INVALID_CUSTOM_AMOUNT,
        });
        expect(await checkerGone(customMaster.address)).toBe(true);
    });

    it('rejects a custom roll without enough attached TON (below MIN_ROLL_VALUE)', async () => {
        const r = await notify(customMaster.address, CUSTOM_ALLOWED_AMOUNT, toNano('0.5'), 1n);
        expect(r.transactions).toHaveTransaction({
            to: S.ssm.address,
            success: false,
            exitCode: SsmErrors.ERR_INSUFFICIENT_ROLL_VALUE,
        });
    });

    it('rejects a custom intake that claims the native RUDA master as origin (ERR_CUSTOM_ORIGIN_IS_NATIVE)', async () => {
        // Pinned regression: the "native NFT via the custom path" vector must be closed at intake.
        const r = await notify(S.rudaMaster.address, CUSTOM_ALLOWED_AMOUNT, ROLL_VALUE, 1n);
        expect(r.transactions).toHaveTransaction({
            to: S.ssm.address,
            success: false,
            exitCode: SsmErrors.ERR_CUSTOM_ORIGIN_IS_NATIVE,
        });
        // No verification started (no request, no checker).
        expect(r.transactions).not.toHaveTransaction({ op: Opcodes.OP_REQUEST_WALLET_ADDRESS });
        expect(await checkerGone(S.rudaMaster.address)).toBe(true);
    });

    // ---- Verified roll (happy path) -----------------------------------------

    it('happy path: the genuine master vouches for W → roll runs with the custom origin; the checker self-destructs', async () => {
        const stake = CUSTOM_ALLOWED_AMOUNT;
        const seen = new Set<string>();

        for (let seed = 1; seed <= 20; seed++) {
            const q = BigInt(seed);
            await notify(customMaster.address, stake, ROLL_VALUE, q);
            expect((await checkerState(customMaster.address)).phase).toBe(1);

            setSeed(S.blockchain, seed);
            const r = await respond(customMaster, escrowWallet.address, q);

            const symbols = readRollSymbols(r, S.ssm.address);
            expect(symbols).not.toBeNull();
            const exp = expectedOutcome(symbols!, false, stake);
            const req = findEmittedRequest(r, S.gm.address);
            const escrow = findEscrowReturn(r, escrowWallet.address);

            expect(hasCashback(r, S.player.address)).toBe(true);
            // The checker consumed itself on settle.
            expect(await checkerGone(customMaster.address)).toBe(true);

            if (exp.kind === OUT_NOTHING) {
                expect(req).toBeNull();
                expect(escrow).toBeNull(); // house keeps the escrow on a loss
                seen.add('nothing');
            } else if (exp.kind === OUT_NFT) {
                expect(escrow).toBeNull();
                if (req?.op !== 'mintNft') throw new Error(`seed ${seed}: expected mintNft, got ${req?.op}`);
                expect(req.receiver).toEqualAddress(S.player.address);
                expect(req.origin).toEqualAddress(customMaster.address); // proven custom origin
                expect(req.type).toBe(exp.nftType);
                expect(req.tier).toBe(exp.nftTier);
                if (exp.nftType === 5n) seen.add('type5');
                seen.add('nft');
            } else if (exp.kind === OUT_RETURN_ESCROW) {
                if (!escrow) throw new Error(`seed ${seed}: expected escrow return`);
                expect(escrow.amount).toBe(stake);
                expect(escrow.recipient).toEqualAddress(S.player.address);
                if (exp.mintRudaAmount > 0n) {
                    if (req?.op !== 'forwardMint') throw new Error(`seed ${seed}: expected +1 RUDA forwardMint`);
                    expect(req.amount).toBe(ONE_RUDA);
                    seen.add('escrow+ruda');
                } else {
                    expect(req).toBeNull();
                    seen.add('escrow');
                }
            }
        }

        expect(seen.has('nft')).toBe(true);
        expect(seen.has('escrow') || seen.has('escrow+ruda')).toBe(true);
    });

    // ---- Negative / failure paths -------------------------------------------

    it('forged notification: the master vouches for a DIFFERENT wallet than W → no roll, escrow refunded to the player', async () => {
        // W notified SSM claiming customMaster, but customMaster's real wallet for SSM is W_good.
        const wGood = await S.blockchain.treasury('customMasterRealWallet');
        await notify(customMaster.address, CUSTOM_ALLOWED_AMOUNT, ROLL_VALUE, 1n);

        setSeed(S.blockchain, 3);
        const r = await respond(customMaster, wGood.address, 1n); // vouches for W_good, not the notifier W

        // No roll; the checker returned the escrow to the player via W and self-destructed.
        expect(readRollSymbols(r, S.ssm.address)).toBeNull();
        const escrow = findEscrowReturn(r, escrowWallet.address);
        expect(escrow).not.toBeNull();
        expect(escrow!.amount).toBe(CUSTOM_ALLOWED_AMOUNT);
        expect(escrow!.recipient).toEqualAddress(S.player.address);
        expect(await checkerGone(customMaster.address)).toBe(true);
    });

    it('spoofed callback: a VerifiedRoll to SSM from a NON-checker address is rejected (ERR_INVALID_CHECKER_SENDER)', async () => {
        const r = await S.ssm.sendVerifiedRoll(attacker.getSender(), ROLL_VALUE, {
            player: S.player.address,
            master: customMaster.address,
            escrowWallet: escrowWallet.address,
            stake: CUSTOM_ALLOWED_AMOUNT,
            queryId: 1n,
        });
        expect(r.transactions).toHaveTransaction({
            to: S.ssm.address,
            success: false,
            exitCode: SsmErrors.ERR_INVALID_CHECKER_SENDER,
        });
        expect(readRollSymbols(r, S.ssm.address)).toBeNull();
    });

    it('spoofed callback: a RefundEscrow to SSM from a NON-checker address is rejected (ERR_INVALID_CHECKER_SENDER)', async () => {
        const r = await S.ssm.sendRefundEscrow(attacker.getSender(), ROLL_VALUE, {
            player: S.player.address,
            master: customMaster.address,
            escrowWallet: escrowWallet.address,
            stake: CUSTOM_ALLOWED_AMOUNT,
            queryId: 1n,
        });
        expect(r.transactions).toHaveTransaction({
            to: S.ssm.address,
            success: false,
            exitCode: SsmErrors.ERR_INVALID_CHECKER_SENDER,
        });
        expect(findEscrowReturn(r, escrowWallet.address)).toBeNull();
    });

    // ---- One-in-flight collision --------------------------------------------

    it('collision: a second intake for a busy (player, master) is refunded; the first verification is undisturbed', async () => {
        await notify(customMaster.address, CUSTOM_ALLOWED_AMOUNT, ROLL_VALUE, 1n);
        const before = await checkerState(customMaster.address);
        expect(before.phase).toBe(1);

        // A second escrow for the SAME (player, master) while the first is still verifying.
        const r = await notify(customMaster.address, CUSTOM_ALLOWED_AMOUNT, ROLL_VALUE, 2n);
        // The second intake is refunded to the player via W; no roll runs.
        const escrow = findEscrowReturn(r, escrowWallet.address);
        expect(escrow).not.toBeNull();
        expect(escrow!.recipient).toEqualAddress(S.player.address);
        expect(readRollSymbols(r, S.ssm.address)).toBeNull();

        // The first verification is untouched, still awaiting its answer.
        const after = await checkerState(customMaster.address);
        expect(after.phase).toBe(1);
        expect(after.deadline).toBe(before.deadline);
    });

    // ---- Timeout reclaim (through the real checker) --------------------------

    it('an expired escrow is reclaimed by the player through the checker (escrow refunded, checker gone)', async () => {
        await notify(customMaster.address, CUSTOM_ALLOWED_AMOUNT, ROLL_VALUE, 7n);

        S.blockchain.now = NOW + CUSTOM_VERIFY_TTL + 1;
        const checker = await openChecker(customMaster.address);
        const r = await checker.sendReclaim(S.player.getSender(), toNano('0.2'), 7n);

        const escrow = findEscrowReturn(r, escrowWallet.address);
        expect(escrow).not.toBeNull();
        expect(escrow!.amount).toBe(CUSTOM_ALLOWED_AMOUNT);
        expect(escrow!.recipient).toEqualAddress(S.player.address);
        expect(await checkerGone(customMaster.address)).toBe(true);
    });

    it('reclaim before the TTL is rejected (ERR_CHECKER_NOT_EXPIRED); the checker survives', async () => {
        await notify(customMaster.address, CUSTOM_ALLOWED_AMOUNT, ROLL_VALUE, 7n);
        const checker = await openChecker(customMaster.address);
        const r = await checker.sendReclaim(S.player.getSender(), toNano('0.2'), 7n);
        expect(r.transactions).toHaveTransaction({
            to: checker.address,
            success: false,
            exitCode: SsmCheckerErrors.ERR_CHECKER_NOT_EXPIRED,
        });
        expect((await checkerState(customMaster.address)).phase).toBe(1);
    });
});
