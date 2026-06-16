// SPDX-License-Identifier: UNLICENSED
import { toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { AnvilRecipe, AnvilErrors, MULTISPLAV_TIER_CAP } from '../../wrappers/game_manager/RetranslatorTypes';
import { setupAnvil, mintItem, anvilInitBody, itemContent, itemAlive, AnvilSystem } from './anvil_setup';

// =============================================================================
// ANVIL multisplav ALLOY — the provenance-filter behaviour end-to-end:
//   * I(5|K|N) + I(5|0|R) -> I(5|K+1|N): R is APPENDED to the native's `seen` set.
//   * a SECOND alloy of the SAME origin R is rejected (duplicate ALWAYS blocked,
//     no false-negative) — this is the real "same-origin" rule that REPLACES the
//     old naive two-item compare.
//   * a DIFFERENT origin still alloys (set grows monotonically).
//   * the type-5 tier safety cap is enforced.
//   * structural rejections (sacrifice not tier-0) still hold.
// =============================================================================

describe('ANVIL multisplav alloy (provenance filter)', () => {
    let S: AnvilSystem;
    let originR: SandboxContract<TreasuryContract>;
    let originR2: SandboxContract<TreasuryContract>;

    beforeEach(async () => {
        S = await setupAnvil();
        originR = await S.blockchain.treasury('alloyR');
        originR2 = await S.blockchain.treasury('alloyR2');
    }, 120000);

    it('alloy appends R to the native filter; tier +1; sacrifice destroyed', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: S.nativeMaster, type: 5, tier: 2 });
        const i2 = await mintItem(S, S.user.address, { origin: originR.address, type: 5, tier: 0 });

        await S.user.send({ to: i1.address, value: toNano('1.5'), body: anvilInitBody(AnvilRecipe.MULTISPLAV, true, i2.index) });

        const c1 = await itemContent(S, i1.address);
        expect(c1.origin).toEqualAddress(S.nativeMaster);
        expect(c1.type).toBe(5n);
        expect(c1.tier).toBe(3n);
        expect(await itemAlive(S, i2.address)).toBe(false);

        // R is now recorded in the native's provenance filter; R2 is not.
        expect(c1.seen).not.toBeNull();
        expect(await S.retranslator.getMultisplavProbablySeen(c1.seen!, originR.address)).toBe(true);
        expect(await S.retranslator.getMultisplavProbablySeen(c1.seen!, originR2.address)).toBe(false);
    });

    it('re-alloying the SAME origin R is rejected (duplicate always blocked)', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: S.nativeMaster, type: 5, tier: 2 });
        const i2 = await mintItem(S, S.user.address, { origin: originR.address, type: 5, tier: 0 });
        // First alloy: succeeds, R goes into the filter, i1 -> tier 3.
        await S.user.send({ to: i1.address, value: toNano('1.5'), body: anvilInitBody(AnvilRecipe.MULTISPLAV, true, i2.index) });
        expect((await itemContent(S, i1.address)).tier).toBe(3n);

        // Mint a SECOND tier-0 item with the SAME origin R and try to alloy it in.
        const i3 = await mintItem(S, S.user.address, { origin: originR.address, type: 5, tier: 0 });
        const r = await S.user.send({ to: i1.address, value: toNano('1.5'), body: anvilInitBody(AnvilRecipe.MULTISPLAV, true, i3.index) });
        expect(r.transactions).toHaveTransaction({
            to: S.retranslator.address,
            success: false,
            exitCode: AnvilErrors.MULTISPLAV_ORIGIN_ALREADY_SEEN, // 984
        });
        // Primary unchanged (still tier 3) and the duplicate sacrifice survives.
        expect((await itemContent(S, i1.address)).tier).toBe(3n);
        expect(await itemAlive(S, i3.address)).toBe(true);
    });

    it('a DIFFERENT origin still alloys; both end up in the filter', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: S.nativeMaster, type: 5, tier: 2 });
        const iR = await mintItem(S, S.user.address, { origin: originR.address, type: 5, tier: 0 });
        await S.user.send({ to: i1.address, value: toNano('1.5'), body: anvilInitBody(AnvilRecipe.MULTISPLAV, true, iR.index) });

        const iR2 = await mintItem(S, S.user.address, { origin: originR2.address, type: 5, tier: 0 });
        await S.user.send({ to: i1.address, value: toNano('1.5'), body: anvilInitBody(AnvilRecipe.MULTISPLAV, true, iR2.index) });

        const c1 = await itemContent(S, i1.address);
        expect(c1.tier).toBe(4n); // two successful alloys
        expect(await S.retranslator.getMultisplavProbablySeen(c1.seen!, originR.address)).toBe(true);
        expect(await S.retranslator.getMultisplavProbablySeen(c1.seen!, originR2.address)).toBe(true);
    });

    it('type-5 tier cap is enforced', async () => {
        // Primary already at the cap: the next alloy would exceed it.
        const i1 = await mintItem(S, S.user.address, { origin: S.nativeMaster, type: 5, tier: MULTISPLAV_TIER_CAP });
        const i2 = await mintItem(S, S.user.address, { origin: originR.address, type: 5, tier: 0 });
        const r = await S.user.send({ to: i1.address, value: toNano('1.5'), body: anvilInitBody(AnvilRecipe.MULTISPLAV, true, i2.index) });
        expect(r.transactions).toHaveTransaction({
            to: S.retranslator.address,
            success: false,
            exitCode: AnvilErrors.MULTISPLAV_TIER_CAP, // 983
        });
        expect((await itemContent(S, i1.address)).tier).toBe(BigInt(MULTISPLAV_TIER_CAP));
    });

    it('sacrifice with K != 0 is rejected (must be I(5|0|R))', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: S.nativeMaster, type: 5, tier: 2 });
        const i2 = await mintItem(S, S.user.address, { origin: originR.address, type: 5, tier: 1 });
        const r = await S.user.send({ to: i1.address, value: toNano('1.5'), body: anvilInitBody(AnvilRecipe.MULTISPLAV, true, i2.index) });
        expect(r.transactions).toHaveTransaction({
            to: S.retranslator.address,
            success: false,
            exitCode: AnvilErrors.MULTISPLAV_SACRIFICE_NOT_TIER0, // 977
        });
    });
});
