// SPDX-License-Identifier: UNLICENSED
import { toNano } from '@ton/core';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { Retranslator } from '../../wrappers/game_manager/Retranslator';
import {
    AnvilRecipe,
    AnvilOutcomeKind,
    AnvilErrors,
    anvilGetArgs,
    AnvilGetInput,
    TIER_CAP_TYPE0,
    SAFETY_TIER_CAP,
    MELT_MAX_TIER,
    TYPE_GENERIC,
    TYPE_MULTISPLAV,
    MULTISPLAV_TIER_CAP,
} from '../../wrappers/game_manager/RetranslatorTypes';

// =============================================================================
// ANVIL tier caps + melt exactness + type space — the closing-plan rules, proven
// through the pure on-chain engine (get_anvil_outcome) and get_anvil_caps. No
// GM/printer/items needed.
//   * combine: type 0 caps at 10; EVERY other type caps at SAFETY_TIER_CAP.
//   * melt:    native I(X|K|N) -> exact 10^K-1 (overflow-safe to MELT_MAX_TIER);
//              non-native cap-out I(0|10|R) -> 100 RUDA for ANY origin.
//   * type space: TYPE_GENERIC=0, TYPE_MULTISPLAV=5; zero-type yields TYPE_GENERIC.
// =============================================================================

describe('ANVIL caps + melt exactness + type space (pure)', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let R: SandboxContract<Retranslator>;
    let N: SandboxContract<TreasuryContract>; // native (RUDA master)
    let A: SandboxContract<TreasuryContract>; // a custom origin
    let B: SandboxContract<TreasuryContract>;

    beforeAll(async () => {
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('capsOwner');
        N = await blockchain.treasury('nativeMaster');
        A = await blockchain.treasury('originA');
        B = await blockchain.treasury('originB');
        const code = await compile('Retranslator');
        R = blockchain.openContract(
            Retranslator.createFromConfig({ gameManagerAddress: owner.address, ownerAddress: owner.address }, code),
        );
        await R.sendDeploy(owner.getSender(), toNano('0.5'));
    }, 120000);

    function input(partial: Partial<AnvilGetInput> & { recipe: number }): AnvilGetInput {
        return {
            i1Origin: A.address, i1Type: 0, i1Tier: 0,
            i2Origin: A.address, i2Type: 0, i2Tier: 0,
            nativeOrigin: N.address,
            ...partial,
        };
    }
    async function exitOf(inp: AnvilGetInput): Promise<number> {
        const rc = await blockchain.getContract(R.address);
        try {
            const res = await rc.get('get_anvil_outcome', anvilGetArgs(inp) as any);
            return res.exitCode;
        } catch (e: any) {
            return e.exitCode ?? -1;
        }
    }

    it('get_anvil_caps matches the wrapper constants', async () => {
        const caps = await R.getAnvilCaps();
        expect(caps.genericCap).toBe(TIER_CAP_TYPE0);
        expect(caps.safetyCap).toBe(SAFETY_TIER_CAP);
        expect(caps.multisplavCap).toBe(MULTISPLAV_TIER_CAP);
        expect(caps.meltMaxTier).toBe(MELT_MAX_TIER);
        expect(caps.typeGeneric).toBe(TYPE_GENERIC);
        expect(caps.typeMultisplav).toBe(TYPE_MULTISPLAV);
    });

    // ---- combine tier caps -------------------------------------------------
    it('type 0 combine caps at 10 (9+9 ok, 10+10 rejects with TIER_CAP)', async () => {
        const ok = await R.getAnvilOutcome(input({ recipe: AnvilRecipe.COMBINE, i1Type: 0, i1Tier: 9, i2Type: 0, i2Tier: 9 }));
        expect(ok.newTier).toBe(10n);
        expect(await exitOf(input({ recipe: AnvilRecipe.COMBINE, i1Type: 0, i1Tier: 10, i2Type: 0, i2Tier: 10 }))).toBe(AnvilErrors.TIER_CAP);
    });

    it('non-generic type (1) combine caps at SAFETY_TIER_CAP, not 10', async () => {
        // Would be rejected if it were capped at 10 — proves the type routing.
        const mid = await R.getAnvilOutcome(input({ recipe: AnvilRecipe.COMBINE, i1Type: 1, i1Tier: 50, i2Type: 1, i2Tier: 50 }));
        expect(mid.newType).toBe(1n);
        expect(mid.newTier).toBe(51n);
        // At the ceiling: K+1 == SAFETY_TIER_CAP ok; one past it rejects with SAFETY_TIER_CAP.
        const ok = await R.getAnvilOutcome(input({ recipe: AnvilRecipe.COMBINE, i1Type: 1, i1Tier: SAFETY_TIER_CAP - 1, i2Type: 1, i2Tier: SAFETY_TIER_CAP - 1 }));
        expect(ok.newTier).toBe(BigInt(SAFETY_TIER_CAP));
        expect(await exitOf(input({ recipe: AnvilRecipe.COMBINE, i1Type: 1, i1Tier: SAFETY_TIER_CAP, i2Type: 1, i2Tier: SAFETY_TIER_CAP }))).toBe(AnvilErrors.SAFETY_TIER_CAP);
    });

    it('a high type (7) is generic-with-safety-cap (no special semantics)', async () => {
        const r = await R.getAnvilOutcome(input({ recipe: AnvilRecipe.COMBINE, i1Type: 7, i1Tier: 3, i2Type: 7, i2Tier: 3 }));
        expect(r.newType).toBe(7n);
        expect(r.newTier).toBe(4n);
        expect(await exitOf(input({ recipe: AnvilRecipe.COMBINE, i1Type: 7, i1Tier: SAFETY_TIER_CAP, i2Type: 7, i2Tier: SAFETY_TIER_CAP }))).toBe(AnvilErrors.SAFETY_TIER_CAP);
    });

    // ---- melt exactness ----------------------------------------------------
    it('native melt I(X|K|N) -> exact 10^K-1 for several K incl. the cap', async () => {
        for (const K of [0, 1, 3, 10, 20, MELT_MAX_TIER]) {
            const o = await R.getAnvilOutcome(input({ recipe: AnvilRecipe.MELT, i1Origin: N.address, i1Type: 2, i1Tier: K }));
            expect(o.kind).toBe(AnvilOutcomeKind.MELT);
            expect(o.rudaAmount).toBe(10n ** BigInt(K) - 1n);
        }
    });

    it('native melt above MELT_MAX_TIER is rejected (overflow guard)', async () => {
        expect(await exitOf(input({ recipe: AnvilRecipe.MELT, i1Origin: N.address, i1Type: 2, i1Tier: MELT_MAX_TIER + 1 }))).toBe(AnvilErrors.TIER_TOO_HIGH);
    });

    it('non-native cap-out: I(0|10|R) -> 100 RUDA for ANY origin', async () => {
        for (const origin of [A.address, B.address]) {
            const o = await R.getAnvilOutcome(input({ recipe: AnvilRecipe.MELT, i1Origin: origin, i1Type: 0, i1Tier: 10 }));
            expect(o.kind).toBe(AnvilOutcomeKind.MELT);
            expect(o.rudaAmount).toBe(100n); // MELT_HUNDRED_RUDA raw (0-decimal)
        }
        // Any other non-native melt is rejected.
        expect(await exitOf(input({ recipe: AnvilRecipe.MELT, i1Origin: A.address, i1Type: 0, i1Tier: 9 }))).toBe(AnvilErrors.MELT_NON_NATIVE);
        expect(await exitOf(input({ recipe: AnvilRecipe.MELT, i1Origin: A.address, i1Type: 1, i1Tier: 10 }))).toBe(AnvilErrors.MELT_NON_NATIVE);
    });

    // ---- zero recipes + type-space routing --------------------------------
    it('zero-type yields TYPE_GENERIC (0); zero-tier yields tier 0', async () => {
        const zt = await R.getAnvilOutcome(input({ recipe: AnvilRecipe.ZERO_TYPE, i1Origin: A.address, i1Type: 3, i1Tier: 4 }));
        expect(zt.newType).toBe(BigInt(TYPE_GENERIC));
        expect(zt.newTier).toBe(4n);
        const zr = await R.getAnvilOutcome(input({ recipe: AnvilRecipe.ZERO_TIER, i1Origin: A.address, i1Type: 3, i1Tier: 4 }));
        expect(zr.newType).toBe(3n);
        expect(zr.newTier).toBe(0n);
    });

    it('regression: same-origin type-5 combine still forbidden (multisplav-only tier-up)', async () => {
        expect(await exitOf(input({ recipe: AnvilRecipe.COMBINE, i1Origin: A.address, i2Origin: A.address, i1Type: 5, i1Tier: 2, i2Type: 5, i2Tier: 2 }))).toBe(AnvilErrors.SAME_ORIGIN_MULTISPLAV);
    });
});
