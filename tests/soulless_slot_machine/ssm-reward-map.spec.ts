// SPDX-License-Identifier: UNLICENSED
import { toNano } from '@ton/core';
import '@ton/test-utils';
import { setupSsmLight, SsmLight } from './ssm_setup';
import {
    packSymbols,
    expectedOutcome,
    SYM_ZERO,
    SYM_SEVEN,
    SYM_X,
    OUT_NOTHING,
    OUT_NFT,
    OUT_MINT_RUDA,
    OUT_RETURN_ESCROW,
    ONE_RUDA,
} from '../../wrappers/soulless_slot_machine/types';

// =============================================================================
// Exhaustive unit tests of the PURE reward mapping, exercised through the actual
// Tolk get_reward(symbols, isNative, stake) getter (so we test the on-chain
// logic, not a TS copy). Every row of BOTH brief tables is asserted explicitly,
// and all 27 triples are cross-checked against the TS mirror.
// =============================================================================

const Z = SYM_ZERO, S = SYM_SEVEN, X = SYM_X;
const STAKE = toNano('100'); // a representative RUDA stake

describe('SSM reward mapping (pure, via get_reward)', () => {
    let S_: SsmLight;
    beforeAll(async () => {
        S_ = await setupSsmLight();
    });

    async function reward(reels: number[], isNative: boolean, stake = STAKE) {
        return S_.ssm.getReward(packSymbols(reels), isNative, stake);
    }

    // ---- NATIVE table (origin = RUDA) -------------------------------------
    describe('native table', () => {
        it('000 -> nothing', async () => {
            const r = await reward([Z, Z, Z], true);
            expect(r.kind).toBe(OUT_NOTHING);
            expect(r.mintRudaAmount).toBe(0n);
            expect(r.returnEscrow).toBe(false);
        });

        it('0x0 / x00 -> NFT type0 tier1', async () => {
            for (const reels of [[Z, X, Z], [X, Z, Z]]) {
                const r = await reward(reels, true);
                expect(r.kind).toBe(OUT_NFT);
                expect(r.nftType).toBe(0n);
                expect(r.nftTier).toBe(1n);
            }
        });

        it('077 -> tokens back + 1 RUDA (mint stake + 1)', async () => {
            const r = await reward([Z, S, S], true);
            expect(r.kind).toBe(OUT_MINT_RUDA);
            expect(r.mintRudaAmount).toBe(STAKE + ONE_RUDA);
            expect(r.returnEscrow).toBe(false);
        });

        it('070 -> tokens back (mint stake)', async () => {
            const r = await reward([Z, S, Z], true);
            expect(r.kind).toBe(OUT_MINT_RUDA);
            expect(r.mintRudaAmount).toBe(STAKE);
        });

        it('xx0 -> NFT type0 tier2', async () => {
            const r = await reward([X, X, Z], true);
            expect(r.kind).toBe(OUT_NFT);
            expect(r.nftType).toBe(0n);
            expect(r.nftTier).toBe(2n);
        });

        it('xx7 -> NFT type1 tier2', async () => {
            const r = await reward([X, X, S], true);
            expect(r.kind).toBe(OUT_NFT);
            expect(r.nftType).toBe(1n);
            expect(r.nftTier).toBe(2n);
        });

        it('x70 / 77x -> NFT type1 tier1', async () => {
            for (const reels of [[X, S, Z], [S, S, X]]) {
                const r = await reward(reels, true);
                expect(r.kind).toBe(OUT_NFT);
                expect(r.nftType).toBe(1n);
                expect(r.nftTier).toBe(1n);
            }
        });

        it('xxx -> NFT type0 tier3', async () => {
            const r = await reward([X, X, X], true);
            expect(r.kind).toBe(OUT_NFT);
            expect(r.nftType).toBe(0n);
            expect(r.nftTier).toBe(3n);
        });

        it('777 -> 10x tokens (mint stake*10)', async () => {
            const r = await reward([S, S, S], true);
            expect(r.kind).toBe(OUT_MINT_RUDA);
            expect(r.mintRudaAmount).toBe(STAKE * 10n);
            expect(r.returnEscrow).toBe(false);
        });
    });

    // ---- CUSTOM table (origin = custom master) ----------------------------
    describe('custom table', () => {
        it('000 -> nothing', async () => {
            const r = await reward([Z, Z, Z], false);
            expect(r.kind).toBe(OUT_NOTHING);
        });

        it('NFT rows identical to native (0x0/xx0/xx7/x70/77x/xxx)', async () => {
            expect((await reward([Z, X, Z], false)).nftTier).toBe(1n);
            expect((await reward([X, X, Z], false)).nftTier).toBe(2n);
            const xx7 = await reward([X, X, S], false);
            expect(xx7.nftType).toBe(1n);
            expect(xx7.nftTier).toBe(2n);
            expect((await reward([X, S, Z], false)).nftType).toBe(1n);
            expect((await reward([S, S, X], false)).nftTier).toBe(1n);
            expect((await reward([X, X, X], false)).nftTier).toBe(3n);
        });

        it('077 -> return escrow + 1 RUDA', async () => {
            const r = await reward([Z, S, S], false);
            expect(r.kind).toBe(OUT_RETURN_ESCROW);
            expect(r.returnEscrow).toBe(true);
            expect(r.mintRudaAmount).toBe(ONE_RUDA);
        });

        it('070 -> return escrow (no RUDA)', async () => {
            const r = await reward([Z, S, Z], false);
            expect(r.kind).toBe(OUT_RETURN_ESCROW);
            expect(r.returnEscrow).toBe(true);
            expect(r.mintRudaAmount).toBe(0n);
        });

        it('777 -> NFT type5 tier0 (the only non-native type-5 mint)', async () => {
            const r = await reward([S, S, S], false);
            expect(r.kind).toBe(OUT_NFT);
            expect(r.nftType).toBe(5n);
            expect(r.nftTier).toBe(0n);
            expect(r.returnEscrow).toBe(false);
        });
    });

    // ---- Exhaustive cross-check: all 27 triples, both paths -----------------
    it('all 27 triples match the reference for both native and custom', async () => {
        for (let a = 0; a < 3; a++) {
            for (let b = 0; b < 3; b++) {
                for (let c = 0; c < 3; c++) {
                    const symbols = packSymbols([a, b, c]);
                    for (const isNative of [true, false]) {
                        const got = await S_.ssm.getReward(symbols, isNative, STAKE);
                        const exp = expectedOutcome(symbols, isNative, STAKE);
                        expect(got.kind).toBe(exp.kind);
                        expect(got.nftType).toBe(exp.nftType);
                        expect(got.nftTier).toBe(exp.nftTier);
                        expect(got.mintRudaAmount).toBe(exp.mintRudaAmount);
                        expect(got.returnEscrow).toBe(exp.returnEscrow);
                    }
                }
            }
        }
    });
});
