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
} from '../../wrappers/game_manager/RetranslatorTypes';

// =============================================================================
// Pure ANVIL recipe engine: exhaustive coverage of EVERY recipe AND every
// rejection, through the real Tolk get_anvil_outcome (a side-effect-free getter
// that wraps computeAnvil). No GM/printer/items needed — recipe logic in isolation.
// =============================================================================

describe('ANVIL recipe engine (pure, via get_anvil_outcome)', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let R: SandboxContract<Retranslator>;

    // Distinct origins. N = native (RUDA master); A, B = two custom origins.
    let N: SandboxContract<TreasuryContract>;
    let A: SandboxContract<TreasuryContract>;
    let B: SandboxContract<TreasuryContract>;

    beforeAll(async () => {
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('anvilOwner');
        N = await blockchain.treasury('nativeMaster');
        A = await blockchain.treasury('originA');
        B = await blockchain.treasury('originB');

        const code = await compile('Retranslator');
        // get_anvil_outcome is pure (no storage reads) — a bare R* suffices.
        R = blockchain.openContract(
            Retranslator.createFromConfig({ gameManagerAddress: owner.address, ownerAddress: owner.address }, code),
        );
        await R.sendDeploy(owner.getSender(), toNano('0.5'));
    });

    function input(partial: Partial<AnvilGetInput> & { recipe: number }): AnvilGetInput {
        return {
            i1Origin: A.address, i1Type: 0, i1Tier: 0,
            i2Origin: A.address, i2Type: 0, i2Tier: 0,
            nativeOrigin: N.address,
            ...partial,
        };
    }

    // Low-level call returning the VM exit code (for rejection cases).
    async function exitOf(inp: AnvilGetInput): Promise<number> {
        const rc = await blockchain.getContract(R.address);
        try {
            const res = await rc.get('get_anvil_outcome', anvilGetArgs(inp) as any);
            return res.exitCode;
        } catch (e: any) {
            return e.exitCode ?? -1;
        }
    }

    // ---- COMBINE (tier-up) -------------------------------------------------
    describe('combine', () => {
        it('I(2|3|A)+I(2|3|A) -> I(2|4|A)', async () => {
            const o = await R.getAnvilOutcome(input({
                recipe: AnvilRecipe.COMBINE,
                i1Origin: A.address, i1Type: 2, i1Tier: 3,
                i2Origin: A.address, i2Type: 2, i2Tier: 3,
            }));
            expect(o.kind).toBe(AnvilOutcomeKind.UPDATE_DESTROY);
            expect(o.newOrigin).toEqualAddress(A.address);
            expect(o.newType).toBe(2n);
            expect(o.newTier).toBe(4n);
            expect(o.rudaAmount).toBe(0n);
        });

        it('type0 tier cap: 9+9 -> 10 ok, 10+10 -> reject', async () => {
            const ok = await R.getAnvilOutcome(input({ recipe: AnvilRecipe.COMBINE, i1Type: 0, i1Tier: 9, i2Type: 0, i2Tier: 9 }));
            expect(ok.newTier).toBe(10n);
            expect(await exitOf(input({ recipe: AnvilRecipe.COMBINE, i1Type: 0, i1Tier: 10, i2Type: 0, i2Tier: 10 }))).toBe(AnvilErrors.TIER_CAP);
        });

        it('rejects type / tier / origin mismatch', async () => {
            expect(await exitOf(input({ recipe: AnvilRecipe.COMBINE, i1Type: 2, i1Tier: 3, i2Type: 3, i2Tier: 3 }))).toBe(AnvilErrors.TYPE_MISMATCH);
            expect(await exitOf(input({ recipe: AnvilRecipe.COMBINE, i1Type: 2, i1Tier: 3, i2Type: 2, i2Tier: 4 }))).toBe(AnvilErrors.TIER_MISMATCH);
            expect(await exitOf(input({ recipe: AnvilRecipe.COMBINE, i1Origin: A.address, i2Origin: B.address, i1Type: 2, i1Tier: 3, i2Type: 2, i2Tier: 3 }))).toBe(AnvilErrors.ORIGIN_MISMATCH);
        });

        it('two same-origin type5 -> forbidden (use multisplav)', async () => {
            expect(await exitOf(input({ recipe: AnvilRecipe.COMBINE, i1Origin: A.address, i2Origin: A.address, i1Type: 5, i1Tier: 2, i2Type: 5, i2Tier: 2 }))).toBe(AnvilErrors.SAME_ORIGIN_MULTISPLAV);
        });
    });

    // ---- MULTISPLAV --------------------------------------------------------
    describe('multisplav', () => {
        it('I(5|2|N)+I(5|0|B) -> I(5|3|N)', async () => {
            const o = await R.getAnvilOutcome(input({
                recipe: AnvilRecipe.MULTISPLAV,
                i1Origin: N.address, i1Type: 5, i1Tier: 2,
                i2Origin: B.address, i2Type: 5, i2Tier: 0,
            }));
            expect(o.kind).toBe(AnvilOutcomeKind.UPDATE_DESTROY);
            expect(o.newOrigin).toEqualAddress(N.address);
            expect(o.newType).toBe(5n);
            expect(o.newTier).toBe(3n);
        });

        it('rejects: primary not native / sacrifice not tier0 / not type5 / same origin', async () => {
            expect(await exitOf(input({ recipe: AnvilRecipe.MULTISPLAV, i1Origin: A.address, i1Type: 5, i1Tier: 2, i2Origin: B.address, i2Type: 5, i2Tier: 0 }))).toBe(AnvilErrors.MULTISPLAV_PRIMARY_NOT_NATIVE);
            expect(await exitOf(input({ recipe: AnvilRecipe.MULTISPLAV, i1Origin: N.address, i1Type: 5, i1Tier: 2, i2Origin: B.address, i2Type: 5, i2Tier: 1 }))).toBe(AnvilErrors.MULTISPLAV_SACRIFICE_NOT_TIER0);
            expect(await exitOf(input({ recipe: AnvilRecipe.MULTISPLAV, i1Origin: N.address, i1Type: 4, i1Tier: 2, i2Origin: B.address, i2Type: 5, i2Tier: 0 }))).toBe(AnvilErrors.NOT_TYPE5);
            expect(await exitOf(input({ recipe: AnvilRecipe.MULTISPLAV, i1Origin: N.address, i1Type: 5, i1Tier: 2, i2Origin: N.address, i2Type: 5, i2Tier: 0 }))).toBe(AnvilErrors.SAME_ORIGIN_MULTISPLAV);
        });
    });

    // ---- ZERO-TYPE / ZERO-TIER --------------------------------------------
    it('zero-type: I(3|4|A) -> I(0|4|A)', async () => {
        const o = await R.getAnvilOutcome(input({ recipe: AnvilRecipe.ZERO_TYPE, i1Origin: A.address, i1Type: 3, i1Tier: 4 }));
        expect(o.kind).toBe(AnvilOutcomeKind.UPDATE);
        expect(o.newType).toBe(0n);
        expect(o.newTier).toBe(4n);
        expect(o.newOrigin).toEqualAddress(A.address);
    });

    it('zero-tier: I(3|4|A) -> I(3|0|A)', async () => {
        const o = await R.getAnvilOutcome(input({ recipe: AnvilRecipe.ZERO_TIER, i1Origin: A.address, i1Type: 3, i1Tier: 4 }));
        expect(o.kind).toBe(AnvilOutcomeKind.UPDATE);
        expect(o.newType).toBe(3n);
        expect(o.newTier).toBe(0n);
    });

    // ---- MELT --------------------------------------------------------------
    describe('melt', () => {
        it('native I(2|3|N) -> 10^3-1 raw RUDA', async () => {
            const o = await R.getAnvilOutcome(input({ recipe: AnvilRecipe.MELT, i1Origin: N.address, i1Type: 2, i1Tier: 3 }));
            expect(o.kind).toBe(AnvilOutcomeKind.MELT);
            expect(o.rudaAmount).toBe(999n);
        });

        it('native I(0|10|N) -> 10^10-1 (native path wins the overlap)', async () => {
            const o = await R.getAnvilOutcome(input({ recipe: AnvilRecipe.MELT, i1Origin: N.address, i1Type: 0, i1Tier: 10 }));
            expect(o.rudaAmount).toBe(10n ** 10n - 1n);
        });

        it('non-native I(0|10|A) -> 100 RUDA', async () => {
            const o = await R.getAnvilOutcome(input({ recipe: AnvilRecipe.MELT, i1Origin: A.address, i1Type: 0, i1Tier: 10 }));
            expect(o.rudaAmount).toBe(100n); // MELT_HUNDRED_RUDA raw (0-decimal)
        });

        it('rejects non-native melt that is not I(0|10|R)', async () => {
            expect(await exitOf(input({ recipe: AnvilRecipe.MELT, i1Origin: A.address, i1Type: 2, i1Tier: 3 }))).toBe(AnvilErrors.MELT_NON_NATIVE);
            expect(await exitOf(input({ recipe: AnvilRecipe.MELT, i1Origin: A.address, i1Type: 0, i1Tier: 9 }))).toBe(AnvilErrors.MELT_NON_NATIVE);
        });

        it('rejects native melt above the 10^K tier guard', async () => {
            expect(await exitOf(input({ recipe: AnvilRecipe.MELT, i1Origin: N.address, i1Type: 2, i1Tier: 31 }))).toBe(AnvilErrors.TIER_TOO_HIGH);
        });
    });

    it('unknown recipe rejects', async () => {
        expect(await exitOf(input({ recipe: 9 }))).toBe(AnvilErrors.UNKNOWN_RECIPE);
    });
});
