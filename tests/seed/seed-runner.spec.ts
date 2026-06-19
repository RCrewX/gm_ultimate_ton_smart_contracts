// SPDX-License-Identifier: UNLICENSED
/**
 * Pure unit tests for the unified seed runner's selection + the seeders' pure helpers.
 * No blockchain — these replace nothing on-chain; they pin the wiring (module selection,
 * direction→position math, per-token content) that the sandbox specs build on.
 */
import { selectModules } from '../../scripts/seed';
import { directionMode, expectedPosition } from '../../scripts/seed/raceModule';
import { tokenContentUri } from '../../scripts/seed/tokensModule';
import { MoveMode } from '../../wrappers/ton_race_game/structs';

describe('unified seed runner — selection', () => {
    it('null/empty → all modules in canonical order (ubps → tokens → race)', () => {
        expect(selectModules(null)).toEqual(['ubps', 'tokens', 'race']);
        expect(selectModules([])).toEqual(['ubps', 'tokens', 'race']);
    });

    it('--only subset is returned in canonical order, case-insensitive', () => {
        expect(selectModules(['race', 'tokens'])).toEqual(['tokens', 'race']);
        expect(selectModules(['TOKENS'])).toEqual(['tokens']);
        expect(selectModules(['ubps'])).toEqual(['ubps']);
    });

    it('rejects unknown module names', () => {
        expect(() => selectModules(['nope'])).toThrow(/Unknown module/);
        expect(() => selectModules(['race', 'bogus'])).toThrow(/bogus/);
    });
});

describe('race helpers — direction math', () => {
    it('maps the 3 main direction names to MoveMode; rejects others', () => {
        expect(directionMode('LEFT')).toBe(MoveMode.LEFT);
        expect(directionMode('up')).toBe(MoveMode.UP);
        expect(directionMode('Right')).toBe(MoveMode.RIGHT);
        expect(() => directionMode('EXIT')).toThrow();
        expect(() => directionMode('diagonal')).toThrow();
    });

    it('expectedPosition: every move does y+1; LEFT x-1, UP x0, RIGHT x+1', () => {
        expect(expectedPosition(MoveMode.UP, 10)).toEqual({ x: 0n, y: 10n });
        expect(expectedPosition(MoveMode.LEFT, 10)).toEqual({ x: -10n, y: 10n });
        expect(expectedPosition(MoveMode.RIGHT, 10)).toEqual({ x: 10n, y: 10n });
    });
});

describe('tokens helpers — per-label content', () => {
    it('each label gets a distinct off-chain content URI', () => {
        const labels = ['A', 'B', 'C', 'D', 'E'];
        const uris = labels.map(tokenContentUri);
        expect(new Set(uris).size).toBe(labels.length);
        expect(tokenContentUri('A')).toContain('/A.json');
    });
});
