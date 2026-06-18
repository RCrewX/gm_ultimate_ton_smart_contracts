// SPDX-License-Identifier: UNLICENSED
/**
 * Unit test for the PURE retro change-detection logic
 * (scripts/lib/changeClassifier.ts). Synthetic hash maps only — no RPC, no
 * blueprint, no sandbox contracts — so it is light and deterministic.
 *
 * Run alone (test discipline): one spec file, never the whole suite:
 *   NODE_OPTIONS='--max-old-space-size=8192 --expose-gc' npx jest --runInBand tests/scripts/change-classifier.spec.ts
 */
import {
    classifyChanges,
    planRetroActions,
    orphanWarning,
    TrackedDescriptor,
} from '../../scripts/lib/changeClassifier';

// Helper: build a descriptor with explicit compiled/on-chain hashes.
function d(
    key: string,
    role: TrackedDescriptor['role'],
    compiledHash: string,
    onChainHash: string | null,
    kind?: TrackedDescriptor['kind'],
): TrackedDescriptor {
    return { key, role, kind, oldAddr: onChainHash === null ? null : `addr:${key}`, compiledHash, onChainHash };
}

const SAME = 'aaaa';
const DIFF_OLD = 'bbbb';

describe('classifyChanges', () => {
    it('marks everything unchanged when on-chain hashes match compiled', () => {
        const report = classifyChanges([
            d('gameManager', 'gm', SAME, SAME),
            d('retranslator', 'rstar', SAME, SAME),
            d('jettonMinter', 'leaf', SAME, SAME, 'jettonMinter'),
        ]);
        expect(report.gmChanged).toBe(false);
        expect(report.rStarChanged).toBe(false);
        expect(report.leafChanges).toHaveLength(0);
        expect(report.unchanged).toEqual(['gameManager', 'retranslator', 'jettonMinter']);
    });

    it('flags GM as changed when its hash differs', () => {
        const report = classifyChanges([d('gameManager', 'gm', SAME, DIFF_OLD)]);
        expect(report.gmChanged).toBe(true);
        expect(report.gmNotDeployed).toBe(false);
    });

    it('flags GM as notDeployed when on-chain hash is null', () => {
        const report = classifyChanges([d('gameManager', 'gm', SAME, null)]);
        expect(report.gmChanged).toBe(false);
        expect(report.gmNotDeployed).toBe(true);
    });

    it('flags R* changed and routes leaf changes with kind + oldAddr', () => {
        const report = classifyChanges([
            d('retranslator', 'rstar', SAME, DIFF_OLD),
            d('games.ton_race_game.game', 'leaf', SAME, DIFF_OLD, 'ton_race_game'),
            d('games.soulless_slot_machine.ssm', 'leaf', SAME, SAME, 'ssm'),
        ]);
        expect(report.rStarChanged).toBe(true);
        expect(report.leafChanges).toHaveLength(1);
        expect(report.leafChanges[0]).toMatchObject({
            key: 'games.ton_race_game.game',
            kind: 'ton_race_game',
            status: 'changed',
            oldAddr: 'addr:games.ton_race_game.game',
        });
        expect(report.unchanged).toContain('games.soulless_slot_machine.ssm');
    });

    it('treats a leaf with no on-chain code as a notDeployed leaf change', () => {
        const report = classifyChanges([d('games.ubps.ubps', 'leaf', SAME, null, 'ubps')]);
        expect(report.leafChanges).toEqual([
            { key: 'games.ubps.ubps', kind: 'ubps', oldAddr: null, status: 'notDeployed' },
        ]);
    });

    it('throws if a leaf descriptor is missing its kind', () => {
        expect(() => classifyChanges([d('jettonMinter', 'leaf', SAME, DIFF_OLD)])).toThrow(/missing its kind/);
    });
});

describe('planRetroActions', () => {
    it('REFUSES when GM changed (require --mode hard)', () => {
        const plan = planRetroActions(
            classifyChanges([
                d('gameManager', 'gm', SAME, DIFF_OLD),
                d('retranslator', 'rstar', SAME, DIFF_OLD), // even with R* change, GM wins → refuse
            ]),
        );
        expect(plan.refuse).toBe(true);
        expect(plan.refuseReason).toMatch(/--mode hard/);
        expect(plan.swap).toBe(false);
        expect(plan.leafRedeploys).toHaveLength(0);
    });

    it('REFUSES when GM is not deployed', () => {
        const plan = planRetroActions(classifyChanges([d('gameManager', 'gm', SAME, null)]));
        expect(plan.refuse).toBe(true);
        expect(plan.refuseReason).toMatch(/no live code/);
    });

    it('REFUSES when R* is not deployed (nothing to migrate from → hard)', () => {
        const plan = planRetroActions(
            classifyChanges([
                d('gameManager', 'gm', SAME, SAME),
                d('retranslator', 'rstar', SAME, null),
            ]),
        );
        expect(plan.refuse).toBe(true);
        expect(plan.refuseReason).toMatch(/--mode hard/);
        expect(plan.swap).toBe(false);
    });

    it('swaps R* AND re-registers changed leaves (the combo case)', () => {
        const plan = planRetroActions(
            classifyChanges([
                d('gameManager', 'gm', SAME, SAME),
                d('retranslator', 'rstar', SAME, DIFF_OLD),
                d('jettonMinter', 'leaf', SAME, DIFF_OLD, 'jettonMinter'),
                d('nftPrinter', 'leaf', SAME, SAME, 'nftPrinter'),
            ]),
        );
        expect(plan.refuse).toBe(false);
        expect(plan.swap).toBe(true);
        expect(plan.leafRedeploys.map((l) => l.key)).toEqual(['jettonMinter']);
        expect(plan.upToDate).toBe(false);
    });

    it('redeploys only leaves when GM + R* are unchanged', () => {
        const plan = planRetroActions(
            classifyChanges([
                d('gameManager', 'gm', SAME, SAME),
                d('retranslator', 'rstar', SAME, SAME),
                d('games.soulless_slot_machine.ssm', 'leaf', SAME, DIFF_OLD, 'ssm'),
            ]),
        );
        expect(plan.swap).toBe(false);
        expect(plan.leafRedeploys.map((l) => l.key)).toEqual(['games.soulless_slot_machine.ssm']);
    });

    it('reports up-to-date when nothing changed', () => {
        const plan = planRetroActions(
            classifyChanges([
                d('gameManager', 'gm', SAME, SAME),
                d('retranslator', 'rstar', SAME, SAME),
            ]),
        );
        expect(plan.upToDate).toBe(true);
        expect(plan.refuse).toBe(false);
        expect(plan.swap).toBe(false);
        expect(plan.leafRedeploys).toHaveLength(0);
    });
});

describe('orphanWarning', () => {
    it('warns for stateful leaves', () => {
        expect(orphanWarning('ton_race_game')).toMatch(/ships/i);
        expect(orphanWarning('jettonMinter')).toMatch(/RUDA/);
        expect(orphanWarning('nftPrinter')).toMatch(/NFT/);
        expect(orphanWarning('passportPrinter')).toMatch(/passport/i);
        expect(orphanWarning('ubps')).toMatch(/Units/);
    });

    it('returns null for ephemeral SSM slots (no scary warning)', () => {
        expect(orphanWarning('ssm')).toBeNull();
    });
});
