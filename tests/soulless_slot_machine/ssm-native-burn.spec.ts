// SPDX-License-Identifier: UNLICENSED
import { toNano } from '@ton/core';
import '@ton/test-utils';
import {
    RUDA_AMOUNT_10,
    RUDA_AMOUNT_100,
    RUDA_AMOUNT_1000,
    expectedOutcome,
    OUT_NOTHING,
    OUT_NFT,
    OUT_MINT_RUDA,
} from '../../wrappers/soulless_slot_machine/types';
import {
    setupSsmLight,
    setSeed,
    readRollSymbols,
    findEmittedRequest,
    findBurnRequest,
    findEscrowReturn,
    hasCashback,
    SsmLight,
} from './ssm_setup';

// =============================================================================
// SSM native-stake BURN (honest burn-and-mint). The native RUDA stake is BURNED
// on EVERY native roll — win, loss, or token-back — via an R1{SsmBurnStake}
// emitted to GM (here a stand-in). The downstream R* arm builds AskToBurn to GM's
// own RUDA wallet exactly like the owner RequestBurn path (proven to actually
// burn supply in tests/printers/multisplav-mint.spec.ts) and gates the request
// like a mint (registered game — proven by printers-e2e). So asserting SSM emits
// the correct burn envelope, plus those proven primitives, is the full burn.
//
// Symmetry asserted here: stake in == SsmBurnStake.amount (burned); any token
// payout is a SEPARATE freshly-minted ForwardMintRequest (minted).
// =============================================================================

describe('SSM native stake burn (burn-and-mint)', () => {
    let S: SsmLight;

    beforeEach(async () => {
        S = await setupSsmLight();
    });

    for (const stake of [RUDA_AMOUNT_10, RUDA_AMOUNT_100, RUDA_AMOUNT_1000]) {
        it(`burns exactly the staked ${stake} on EVERY native outcome (win + loss)`, async () => {
            const kinds = new Set<number>();

            // A loss (000) is only ~1/27 per roll, so a fixed seed window is unreliable.
            // Scan until BOTH a loss and a win have been seen (early-break), asserting the
            // burn on every single roll regardless of outcome (the real property: the
            // native burn is unconditional). The cap makes a miss statistically impossible.
            for (let seed = 1; seed <= 300 && !(kinds.has(OUT_NOTHING) && (kinds.has(OUT_NFT) || kinds.has(OUT_MINT_RUDA))); seed++) {
                setSeed(S.blockchain, seed);
                const r = await S.ssm.sendJettonUsed(S.gm.getSender(), toNano('1.5'), stake, S.player.address, BigInt(seed));

                const symbols = readRollSymbols(r, S.ssm.address);
                expect(symbols).not.toBeNull();
                const exp = expectedOutcome(symbols!, true, stake);
                kinds.add(exp.kind);

                // (1) The stake is ALWAYS burned, for the exact staked amount.
                const burn = findBurnRequest(r, S.gm.address);
                if (!burn) throw new Error(`seed ${seed}: native roll did not burn the stake`);
                expect(burn.amount).toBe(stake);

                // (2) Cashback is always returned; native never returns escrow.
                expect(hasCashback(r, S.player.address)).toBe(true);
                expect(findEscrowReturn(r, S.ssm.address)).toBeNull();

                // (3) Any token payout is a SEPARATE fresh mint (minted, not the stake back).
                const req = findEmittedRequest(r, S.gm.address);
                if (exp.kind === OUT_NOTHING) {
                    expect(req).toBeNull(); // loss: burn happened, but no reward mint/NFT
                } else if (exp.kind === OUT_MINT_RUDA) {
                    if (req?.op !== 'forwardMint') throw new Error(`seed ${seed}: expected forwardMint`);
                    expect(req.amount).toBe(exp.mintRudaAmount); // freshly minted payout
                } else if (exp.kind === OUT_NFT) {
                    if (req?.op !== 'mintNft') throw new Error(`seed ${seed}: expected mintNft`);
                    expect(req.origin).toEqualAddress(S.rudaMaster.address);
                }
            }

            // The burn was exercised across at least a loss AND a win.
            expect(kinds.has(OUT_NOTHING)).toBe(true);
            expect(kinds.has(OUT_NFT) || kinds.has(OUT_MINT_RUDA)).toBe(true);
        });
    }

    it('777 jackpot: burns the stake AND mints 10x fresh (burn-and-mint symmetry)', async () => {
        // Find a seed that rolls 777 (all SEVEN), then assert burn==stake and mint==10x.
        const stake = RUDA_AMOUNT_100;
        let found = false;
        for (let seed = 1; seed <= 400 && !found; seed++) {
            setSeed(S.blockchain, seed);
            const r = await S.ssm.sendJettonUsed(S.gm.getSender(), toNano('1.5'), stake, S.player.address, BigInt(seed));
            const symbols = readRollSymbols(r, S.ssm.address);
            if (symbols === null) continue;
            const exp = expectedOutcome(symbols, true, stake);
            if (exp.kind === OUT_MINT_RUDA && exp.mintRudaAmount === stake * 10n) {
                const burn = findBurnRequest(r, S.gm.address);
                expect(burn?.amount).toBe(stake);                 // burned the stake
                const req = findEmittedRequest(r, S.gm.address);
                expect(req?.op).toBe('forwardMint');
                if (req?.op === 'forwardMint') expect(req.amount).toBe(stake * 10n); // minted 10x
                found = true;
            }
        }
        expect(found).toBe(true); // a 777 was actually rolled and asserted
    });
});
