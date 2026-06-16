// SPDX-License-Identifier: UNLICENSED
import { toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { AnvilRecipe } from '../../wrappers/game_manager/RetranslatorTypes';
import {
    setupAnvil,
    mintItem,
    anvilInitBody,
    itemContent,
    itemAlive,
    gotCashback,
    AnvilSystem,
} from './anvil_setup';

// =============================================================================
// ANVIL combine (tier-up) — the full two-item chain through GM/R*/printer:
// item1[owner] -> item2[owner+prev] -> collection[item-addr] -> GM -> R* ->
// GM -> collection -> item1[update] -> item2[destroy + cashback].
// =============================================================================

describe('ANVIL combine (two-item tier-up)', () => {
    let S: AnvilSystem;
    let originR: SandboxContract<TreasuryContract>;

    beforeEach(async () => {
        S = await setupAnvil();
        originR = await S.blockchain.treasury('originR');
    }, 120000);

    it('I(2|3|R)+I(2|3|R) -> item1 becomes I(2|4|R), item2 destroyed, cashback to user', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: originR.address, type: 2, tier: 3 });
        const i2 = await mintItem(S, S.user.address, { origin: originR.address, type: 2, tier: 3 });

        const r = await S.user.send({
            to: i1.address,
            value: toNano('1.5'),
            body: anvilInitBody(AnvilRecipe.COMBINE, true, i2.index),
        });

        // item1 content tier-upped.
        const c1 = await itemContent(S, i1.address);
        expect(c1.origin).toEqualAddress(originR.address);
        expect(c1.type).toBe(2n);
        expect(c1.tier).toBe(4n);

        // item2 destroyed, user got cashback.
        expect(await itemAlive(S, i2.address)).toBe(false);
        expect(gotCashback(r, S.user.address)).toBe(true);
    });

    it('rejects when the two items differ (R* tier/type/origin gate) — item1 unchanged', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: originR.address, type: 2, tier: 3 });
        const i2 = await mintItem(S, S.user.address, { origin: originR.address, type: 2, tier: 4 }); // tier mismatch

        const r = await S.user.send({
            to: i1.address,
            value: toNano('1.5'),
            body: anvilInitBody(AnvilRecipe.COMBINE, true, i2.index),
        });

        // R* threw the tier-mismatch code; nothing was applied.
        expect(r.transactions).toHaveTransaction({
            to: S.retranslator.address,
            success: false,
            exitCode: 972, // ERR_ANVIL_TIER_MISMATCH
        });
        const c1 = await itemContent(S, i1.address);
        expect(c1.tier).toBe(3n); // unchanged
        expect(await itemAlive(S, i2.address)).toBe(true); // not destroyed
    });

    it('gate: AnvilInit from a non-owner is rejected by item1', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: originR.address, type: 2, tier: 3 });
        const i2 = await mintItem(S, S.user.address, { origin: originR.address, type: 2, tier: 3 });
        const stranger = await S.blockchain.treasury('strangerAnvil');

        const r = await stranger.send({
            to: i1.address,
            value: toNano('1.5'),
            body: anvilInitBody(AnvilRecipe.COMBINE, true, i2.index),
        });
        expect(r.transactions).toHaveTransaction({
            from: stranger.address,
            to: i1.address,
            success: false,
            exitCode: 401, // ERROR_NOT_FROM_OWNER
        });
    });

    it('gate: item2 owned by a different user is rejected (owner mismatch)', async () => {
        const other = await S.blockchain.treasury('otherUser');
        const i1 = await mintItem(S, S.user.address, { origin: originR.address, type: 2, tier: 3 });
        const i2 = await mintItem(S, other.address, { origin: originR.address, type: 2, tier: 3 });

        const r = await S.user.send({
            to: i1.address,
            value: toNano('1.5'),
            body: anvilInitBody(AnvilRecipe.COMBINE, true, i2.index),
        });
        expect(r.transactions).toHaveTransaction({
            to: i2.address,
            success: false,
            exitCode: 411, // ERROR_ANVIL_OWNER_MISMATCH
        });
        const c1 = await itemContent(S, i1.address);
        expect(c1.tier).toBe(3n); // unchanged
    });
});
