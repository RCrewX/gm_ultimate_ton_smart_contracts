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
    AnvilSystem,
} from './anvil_setup';

// =============================================================================
// ANVIL single-item transforms: zero-type and zero-tier. item1 -> collection ->
// GM -> R* -> GM -> collection -> item1 (content overwrite, item stays alive).
// =============================================================================

describe('ANVIL transforms (zero-type / zero-tier)', () => {
    let S: AnvilSystem;
    let originR: SandboxContract<TreasuryContract>;

    beforeEach(async () => {
        S = await setupAnvil();
        originR = await S.blockchain.treasury('originR');
    }, 120000);

    it('zero-type: I(3|4|R) -> I(0|4|R), item stays alive', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: originR.address, type: 3, tier: 4 });
        await S.user.send({ to: i1.address, value: toNano('1'), body: anvilInitBody(AnvilRecipe.ZERO_TYPE, false, 0) });

        const c = await itemContent(S, i1.address);
        expect(c.origin).toEqualAddress(originR.address);
        expect(c.type).toBe(0n);
        expect(c.tier).toBe(4n);
        expect(await itemAlive(S, i1.address)).toBe(true);
    });

    it('zero-tier: I(3|4|R) -> I(3|0|R), item stays alive', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: originR.address, type: 3, tier: 4 });
        await S.user.send({ to: i1.address, value: toNano('1'), body: anvilInitBody(AnvilRecipe.ZERO_TIER, false, 0) });

        const c = await itemContent(S, i1.address);
        expect(c.type).toBe(3n);
        expect(c.tier).toBe(0n);
        expect(await itemAlive(S, i1.address)).toBe(true);
    });

    it('gate: AnvilInit from a non-owner is rejected', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: originR.address, type: 3, tier: 4 });
        const stranger = await S.blockchain.treasury('strangerT');
        const r = await stranger.send({ to: i1.address, value: toNano('1'), body: anvilInitBody(AnvilRecipe.ZERO_TYPE, false, 0) });
        expect(r.transactions).toHaveTransaction({
            from: stranger.address,
            to: i1.address,
            success: false,
            exitCode: 401, // ERROR_NOT_FROM_OWNER
        });
    });
});
