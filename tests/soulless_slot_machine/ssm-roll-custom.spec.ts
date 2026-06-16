// SPDX-License-Identifier: UNLICENSED
import { toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import {
    CUSTOM_ALLOWED_AMOUNT,
    ONE_RUDA,
    expectedOutcome,
    OUT_NOTHING,
    OUT_NFT,
    OUT_RETURN_ESCROW,
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
// Custom-jetton roll: the fully SEPARATE escrow-and-return path. Intake is a
// TEP-74 transfer-notification delivered DIRECTLY by SSM's own custom wallet
// (here a stand-in treasury == in.senderAddress == escrowWallet). The claimed
// master is trusted as the NFT origin (locked decision 4). Escrow is returned to
// that same wallet; NFT wins mint with the custom origin; 777 -> NFT type5.
// =============================================================================

describe('SSM custom-jetton roll', () => {
    let S: SsmLight;
    let customWallet: SandboxContract<TreasuryContract>; // stand-in for SSM's custom jetton wallet
    let customMaster: SandboxContract<TreasuryContract>; // the custom jetton master == origin

    beforeEach(async () => {
        S = await setupSsmLight();
        customWallet = await S.blockchain.treasury('ssmCustomWallet');
        customMaster = await S.blockchain.treasury('customMaster');
    });

    function rollCustom(value: bigint, amount: bigint, queryId: bigint) {
        return S.ssm.sendCustomTransferNotification(
            customWallet.getSender(),
            value,
            amount,
            customMaster.address,
            S.player.address,
            queryId,
        );
    }

    it('rejects a custom stake that is not exactly 1_000_000 raw', async () => {
        const r = await rollCustom(toNano('1.5'), 999_999n, 1n);
        expect(r.transactions).toHaveTransaction({
            to: S.ssm.address,
            success: false,
            exitCode: 944, // ERR_INVALID_CUSTOM_AMOUNT
        });
    });

    it('rejects a custom roll without enough attached TON', async () => {
        const r = await rollCustom(toNano('0.5'), CUSTOM_ALLOWED_AMOUNT, 1n);
        expect(r.transactions).toHaveTransaction({
            to: S.ssm.address,
            success: false,
            exitCode: 945, // ERR_INSUFFICIENT_ROLL_VALUE
        });
    });

    it('routes every rolled outcome per the custom map; escrow returns to the custom wallet; always cashes back', async () => {
        const stake = CUSTOM_ALLOWED_AMOUNT;
        const seen = new Set<string>();

        for (let seed = 1; seed <= 20; seed++) {
            setSeed(S.blockchain, seed);
            const r = await rollCustom(toNano('1.5'), stake, BigInt(seed));

            const symbols = readRollSymbols(r, S.ssm.address);
            expect(symbols).not.toBeNull();
            const exp = expectedOutcome(symbols!, false, stake);
            const req = findEmittedRequest(r, S.gm.address);
            const escrow = findEscrowReturn(r, customWallet.address);

            expect(hasCashback(r, S.player.address)).toBe(true);

            if (exp.kind === OUT_NOTHING) {
                expect(req).toBeNull();
                expect(escrow).toBeNull(); // house keeps the escrow on a loss
                seen.add('nothing');
            } else if (exp.kind === OUT_NFT) {
                // NFT wins (incl. 777 -> type5,tier0) keep the escrow, mint with custom origin.
                expect(escrow).toBeNull();
                if (req?.op !== 'mintNft') throw new Error(`seed ${seed}: expected mintNft, got ${req?.op}`);
                expect(req.receiver).toEqualAddress(S.player.address);
                expect(req.origin).toEqualAddress(customMaster.address); // custom origin
                expect(req.type).toBe(exp.nftType);
                expect(req.tier).toBe(exp.nftTier);
                if (exp.nftType === 5n) seen.add('type5');
                seen.add('nft');
            } else if (exp.kind === OUT_RETURN_ESCROW) {
                // 070 / 077: return the escrowed custom jetton to the player.
                if (!escrow) throw new Error(`seed ${seed}: expected escrow return`);
                expect(escrow.amount).toBe(stake);
                expect(escrow.recipient).toEqualAddress(S.player.address);
                if (exp.mintRudaAmount > 0n) {
                    // 077: also mint +1 RUDA via the native mint pipe.
                    if (req?.op !== 'forwardMint') throw new Error(`seed ${seed}: expected +1 RUDA forwardMint`);
                    expect(req.amount).toBe(ONE_RUDA);
                    seen.add('escrow+ruda');
                } else {
                    expect(req).toBeNull();
                    seen.add('escrow');
                }
            }
        }

        // NFT and escrow-return branches must both have been exercised by real rolls.
        expect(seen.has('nft')).toBe(true);
        expect(seen.has('escrow') || seen.has('escrow+ruda')).toBe(true);
    });
});
