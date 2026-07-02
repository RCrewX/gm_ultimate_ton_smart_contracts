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
    CUSTOM_VERIFY_TTL,
} from '../../wrappers/soulless_slot_machine/types';
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
// Custom-jetton roll — TEP-89 TWO-PHASE, escrow-and-verify (GM-B-001).
//
// Phase 1: an escrow wallet W notifies SSM (TransferNotificationForRecipient) with a
//   claimed master. SSM records a pending roll keyed by W and emits RequestWalletAddress
//   to the claimed master. NO roll runs yet; the claimed origin is UNPROVEN.
// Phase 2: the master answers (ResponseWalletAddress). Only if it vouches for exactly W
//   (and is the queried master) does SSM roll, with that master as the NFT origin.
//
// Here the "master" is a stand-in treasury we drive manually — it lets us prove the SSM
// verification logic (happy path, forged notification, sender mismatch, timeout reclaim,
// native-origin rejection). The full handshake against a REAL minter lives in the e2e spec.
// =============================================================================

const NOW = 1_900_000_000;
const ROLL_VALUE = toNano('1.5');

describe('SSM custom-jetton roll (TEP-89 two-phase)', () => {
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

    // Phase 2: `master` answers TEP-89, vouching that `walletAddr` is its wallet for owner=SSM.
    function respond(master: SandboxContract<TreasuryContract>, walletAddr: Address, queryId: bigint, value = ROLL_VALUE) {
        return S.ssm.sendResponseWalletAddress(master.getSender(), value, walletAddr, queryId, S.ssm.address);
    }

    // ---- Phase 1 behaviour ---------------------------------------------------

    it('phase 1 records a pending escrow and asks the claimed master for its wallet — it does NOT roll yet', async () => {
        const r = await notify(customMaster.address, CUSTOM_ALLOWED_AMOUNT, ROLL_VALUE, 1n);

        // SSM asked the claimed master via TEP-89…
        expect(r.transactions).toHaveTransaction({
            from: S.ssm.address,
            to: customMaster.address,
            op: Opcodes.OP_REQUEST_WALLET_ADDRESS,
            success: true,
        });
        // …and NO roll ran (no RollResult came back to SSM).
        expect(readRollSymbols(r, S.ssm.address)).toBeNull();

        // The pending record is keyed by W with the claimed master + a TTL deadline.
        const pending = await S.ssm.getPendingRoll(escrowWallet.address);
        expect(pending).not.toBeNull();
        expect(pending!.player).toEqualAddress(S.player.address);
        expect(pending!.stake).toBe(CUSTOM_ALLOWED_AMOUNT);
        expect(pending!.master).toEqualAddress(customMaster.address);
        expect(pending!.deadline).toBe(NOW + CUSTOM_VERIFY_TTL);
    });

    it('rejects a custom stake that is not exactly 1_000_000 raw (no pending record)', async () => {
        const r = await notify(customMaster.address, 999_999n, ROLL_VALUE, 1n);
        expect(r.transactions).toHaveTransaction({
            to: S.ssm.address,
            success: false,
            exitCode: SsmErrors.ERR_INVALID_CUSTOM_AMOUNT,
        });
        expect(await S.ssm.getPendingRoll(escrowWallet.address)).toBeNull();
    });

    it('rejects a custom roll without enough attached TON', async () => {
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
        // No request emitted, no escrow recorded.
        expect(r.transactions).not.toHaveTransaction({ from: S.ssm.address, op: Opcodes.OP_REQUEST_WALLET_ADDRESS });
        expect(await S.ssm.getPendingRoll(escrowWallet.address)).toBeNull();
    });

    // ---- Phase 2 verification ------------------------------------------------

    it('happy path: the genuine master vouches for W → roll runs with the custom origin; every outcome routes correctly', async () => {
        const stake = CUSTOM_ALLOWED_AMOUNT;
        const seen = new Set<string>();

        for (let seed = 1; seed <= 20; seed++) {
            const q = BigInt(seed);
            // Phase 1: escrow + verify request.
            await notify(customMaster.address, stake, ROLL_VALUE, q);
            expect(await S.ssm.getPendingRoll(escrowWallet.address)).not.toBeNull();

            // Phase 2: master vouches for exactly W → SSM rolls. Seed drives the reels.
            setSeed(S.blockchain, seed);
            const r = await respond(customMaster, escrowWallet.address, q);

            const symbols = readRollSymbols(r, S.ssm.address);
            expect(symbols).not.toBeNull();
            const exp = expectedOutcome(symbols!, false, stake);
            const req = findEmittedRequest(r, S.gm.address);
            const escrow = findEscrowReturn(r, escrowWallet.address);

            expect(hasCashback(r, S.player.address)).toBe(true);
            // The pending record was consumed by the verified roll.
            expect(await S.ssm.getPendingRoll(escrowWallet.address)).toBeNull();

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

    it('forged notification: the master vouches for a DIFFERENT wallet than W → no roll, escrow stays pending', async () => {
        // W notified SSM claiming customMaster, but customMaster's real wallet for SSM is W_good.
        const wGood = await S.blockchain.treasury('customMasterRealWallet');
        await notify(customMaster.address, CUSTOM_ALLOWED_AMOUNT, ROLL_VALUE, 1n);

        setSeed(S.blockchain, 3);
        const r = await respond(customMaster, wGood.address, 1n); // vouches for W_good, not the notifier W

        // The reply matches no pending record (pending is keyed by W, not W_good) → rejected.
        expect(r.transactions).toHaveTransaction({
            to: S.ssm.address,
            success: false,
            exitCode: SsmErrors.ERR_NO_PENDING_ROLL,
        });
        // No roll, and the (forged) escrow at W is untouched — it is reclaimable on timeout.
        expect(readRollSymbols(r, S.ssm.address)).toBeNull();
        expect(await S.ssm.getPendingRoll(escrowWallet.address)).not.toBeNull();
    });

    it('a reply for W from someone other than the queried master is rejected (ERR_VERIFY_SENDER_MISMATCH); the record survives', async () => {
        await notify(customMaster.address, CUSTOM_ALLOWED_AMOUNT, ROLL_VALUE, 1n);

        // The attacker (not the queried master) tries to vouch for W to trigger/cancel the roll.
        const r = await respond(attacker, escrowWallet.address, 1n);
        expect(r.transactions).toHaveTransaction({
            to: S.ssm.address,
            success: false,
            exitCode: SsmErrors.ERR_VERIFY_SENDER_MISMATCH,
        });
        expect(readRollSymbols(r, S.ssm.address)).toBeNull();
        // The genuine pending record is NOT cancelled by the forged reply.
        expect(await S.ssm.getPendingRoll(escrowWallet.address)).not.toBeNull();
    });

    // ---- Timeout reclaim -----------------------------------------------------

    it('an expired pending escrow can be reclaimed by the player (escrow refunded, record cleared)', async () => {
        await notify(customMaster.address, CUSTOM_ALLOWED_AMOUNT, ROLL_VALUE, 7n);
        expect(await S.ssm.getPendingRoll(escrowWallet.address)).not.toBeNull();

        // Warp past the verify TTL, then the player reclaims.
        S.blockchain.now = NOW + CUSTOM_VERIFY_TTL + 1;
        const r = await S.ssm.sendReclaimExpiredEscrow(S.player.getSender(), toNano('0.2'), escrowWallet.address, 7n);

        const escrow = findEscrowReturn(r, escrowWallet.address);
        expect(escrow).not.toBeNull();
        expect(escrow!.amount).toBe(CUSTOM_ALLOWED_AMOUNT);
        expect(escrow!.recipient).toEqualAddress(S.player.address);
        expect(await S.ssm.getPendingRoll(escrowWallet.address)).toBeNull();
    });

    it('reclaim before the TTL is rejected (ERR_ESCROW_NOT_EXPIRED)', async () => {
        await notify(customMaster.address, CUSTOM_ALLOWED_AMOUNT, ROLL_VALUE, 7n);
        const r = await S.ssm.sendReclaimExpiredEscrow(S.player.getSender(), toNano('0.2'), escrowWallet.address, 7n);
        expect(r.transactions).toHaveTransaction({
            to: S.ssm.address,
            success: false,
            exitCode: SsmErrors.ERR_ESCROW_NOT_EXPIRED,
        });
        expect(await S.ssm.getPendingRoll(escrowWallet.address)).not.toBeNull();
    });

    it('reclaim by a stranger (not player nor owner) is rejected (ERR_RECLAIM_NOT_AUTHORIZED)', async () => {
        await notify(customMaster.address, CUSTOM_ALLOWED_AMOUNT, ROLL_VALUE, 7n);
        S.blockchain.now = NOW + CUSTOM_VERIFY_TTL + 1;
        const r = await S.ssm.sendReclaimExpiredEscrow(attacker.getSender(), toNano('0.2'), escrowWallet.address, 7n);
        expect(r.transactions).toHaveTransaction({
            to: S.ssm.address,
            success: false,
            exitCode: SsmErrors.ERR_RECLAIM_NOT_AUTHORIZED,
        });
        expect(await S.ssm.getPendingRoll(escrowWallet.address)).not.toBeNull();
    });

    it('reclaim of a non-existent escrow is rejected (ERR_NO_PENDING_ROLL)', async () => {
        S.blockchain.now = NOW + CUSTOM_VERIFY_TTL + 1;
        const r = await S.ssm.sendReclaimExpiredEscrow(S.player.getSender(), toNano('0.2'), escrowWallet.address, 7n);
        expect(r.transactions).toHaveTransaction({
            to: S.ssm.address,
            success: false,
            exitCode: SsmErrors.ERR_NO_PENDING_ROLL,
        });
    });
});
