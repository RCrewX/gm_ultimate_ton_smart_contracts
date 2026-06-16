// SPDX-License-Identifier: UNLICENSED
import { Address, beginCell, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { AnvilRecipe, AnvilErrors, ANVIL_OPCODES } from '../../wrappers/game_manager/RetranslatorTypes';
import { encodeR1 } from '../../wrappers/game_manager/types';
import { setupAnvil, mintItem, anvilInitBody, itemContent, itemAlive, AnvilSystem } from './anvil_setup';

// =============================================================================
// ANVIL recipe-ARITY guard (regression for a real exploit).
//
// The item flow lets the USER choose both the recipe AND hasSecond in AnvilInit.
// Without an arity guard, reporting a two-item recipe on the single-item path
// (recipe=COMBINE, hasSecond=false) routes to R*'s AnvilTransform arm, where
// computeAnvil(COMBINE, i1, i1) returns UPDATE_DESTROY with item2Index=0 — a FREE
// tier-up that ALSO destroys NFT index 0 (any owner's item). The reverse (a
// single-item recipe on the two-item path) is just as wrong. R* must reject the
// mismatch with ERR_ANVIL_RECIPE_ARITY (986) before computing anything.
// =============================================================================

describe('ANVIL recipe-arity guard', () => {
    let S: AnvilSystem;
    let originR: SandboxContract<TreasuryContract>;

    beforeEach(async () => {
        S = await setupAnvil();
        originR = await S.blockchain.treasury('arityR');
    }, 120000);

    it('COMBINE on the single-item path is rejected; NFT index 0 survives, item1 not tiered up', async () => {
        // Victim minted FIRST so it occupies index 0 — the item the exploit destroys.
        const victim = await mintItem(S, originR.address, { origin: originR.address, type: 0, tier: 1 });
        expect(victim.index).toBe(0);
        const i1 = await mintItem(S, S.user.address, { origin: originR.address, type: 0, tier: 2 });

        const r = await S.user.send({ to: i1.address, value: toNano('1'), body: anvilInitBody(AnvilRecipe.COMBINE, false, 0) });
        expect(r.transactions).toHaveTransaction({
            to: S.retranslator.address,
            success: false,
            exitCode: AnvilErrors.RECIPE_ARITY, // 986
        });
        expect((await itemContent(S, i1.address)).tier).toBe(2n); // no free tier-up
        expect(await itemAlive(S, victim.address)).toBe(true);    // index-0 NOT destroyed
    });

    it('MULTISPLAV on the single-item path is rejected', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: S.nativeMaster, type: 5, tier: 2 });
        const r = await S.user.send({ to: i1.address, value: toNano('1'), body: anvilInitBody(AnvilRecipe.MULTISPLAV, false, 0) });
        expect(r.transactions).toHaveTransaction({
            to: S.retranslator.address,
            success: false,
            exitCode: AnvilErrors.RECIPE_ARITY,
        });
    });

    it('MELT on the two-item path is rejected; both items survive', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: S.nativeMaster, type: 2, tier: 3 });
        const i2 = await mintItem(S, S.user.address, { origin: S.nativeMaster, type: 2, tier: 3 });
        const r = await S.user.send({ to: i1.address, value: toNano('1.5'), body: anvilInitBody(AnvilRecipe.MELT, true, i2.index) });
        expect(r.transactions).toHaveTransaction({
            to: S.retranslator.address,
            success: false,
            exitCode: AnvilErrors.RECIPE_ARITY,
        });
        expect(await itemAlive(S, i1.address)).toBe(true);
        expect(await itemAlive(S, i2.address)).toBe(true);
    });

    it('ZERO_TYPE on the two-item path is rejected; both items survive, item1 unchanged', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: originR.address, type: 3, tier: 4 });
        const i2 = await mintItem(S, S.user.address, { origin: originR.address, type: 3, tier: 4 });
        const r = await S.user.send({ to: i1.address, value: toNano('1.5'), body: anvilInitBody(AnvilRecipe.ZERO_TYPE, true, i2.index) });
        expect(r.transactions).toHaveTransaction({
            to: S.retranslator.address,
            success: false,
            exitCode: AnvilErrors.RECIPE_ARITY,
        });
        expect((await itemContent(S, i1.address)).type).toBe(3n);
        expect(await itemAlive(S, i2.address)).toBe(true);
    });

    it('R* rejects an ANVIL request whose initiator is NOT the printer (ERR_ANVIL_NOT_PRINTER)', async () => {
        // GM forwards anyone's R1 as R2 with initiator = sender. A stranger crafting an
        // AnvilCombine directly therefore reaches R* with a non-printer initiator and is
        // rejected by assertAnvilFromPrinter BEFORE any item is touched.
        const attrs = (index: number, who: Address) =>
            beginCell().storeUint(index, 64).storeAddress(who).storeUint(0, 64).storeUint(0, 64).storeBit(0).endCell();
        const anvilCombine = beginCell()
            .storeUint(ANVIL_OPCODES.OP_ANVIL_COMBINE, 32)
            .storeUint(AnvilRecipe.COMBINE, 8)
            .storeAddress(originR.address)
            .storeRef(attrs(0, originR.address))
            .storeRef(attrs(1, originR.address))
            .endCell();
        const r = await originR.send({ to: S.gameManager.address, value: toNano('0.5'), body: encodeR1({ data: anvilCombine }) });
        expect(r.transactions).toHaveTransaction({
            to: S.retranslator.address,
            success: false,
            exitCode: AnvilErrors.NOT_PRINTER, // 981
        });
    });

    it('positive control: legit COMBINE (2-item) and ZERO_TYPE (1-item) still succeed', async () => {
        const a = await mintItem(S, S.user.address, { origin: originR.address, type: 2, tier: 1 });
        const b = await mintItem(S, S.user.address, { origin: originR.address, type: 2, tier: 1 });
        await S.user.send({ to: a.address, value: toNano('1.5'), body: anvilInitBody(AnvilRecipe.COMBINE, true, b.index) });
        expect((await itemContent(S, a.address)).tier).toBe(2n);
        expect(await itemAlive(S, b.address)).toBe(false);

        const c = await mintItem(S, S.user.address, { origin: originR.address, type: 3, tier: 4 });
        await S.user.send({ to: c.address, value: toNano('1'), body: anvilInitBody(AnvilRecipe.ZERO_TYPE, false, 0) });
        expect((await itemContent(S, c.address)).type).toBe(0n);
        expect(await itemAlive(S, c.address)).toBe(true);
    });
});
