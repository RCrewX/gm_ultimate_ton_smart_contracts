// SPDX-License-Identifier: UNLICENSED
/**
 * UBPS module — a THIN ADAPTER over the existing UBPS seeder (scripts/seedUbps/*). It
 * does NOT change UBPS behaviour (the plan's stop-condition): it loads + validates a UBPS
 * seed file exactly as scripts/seedUbps.ts does, then delegates to the existing
 * `run()` / `estimateDeployerCost()`. UBPS self-manages its OWN ResilientProvider +
 * deployer + balance preflight internally (so it is a black box here) — the shared ctx's
 * provider/deployer/codes are intentionally ignored for this module.
 *
 * Requires a --ubps-file. When UBPS is selected (e.g. via `--all`) but no file is given,
 * the module SKIPS with a clear notice instead of failing the whole run.
 */
import { readFileSync } from 'fs';
import { validateSeed, mergeSeedFragments, SeedFragment, UbpsSeed } from '../seedUbps/types';
import { run as ubpsRun, estimateDeployerCost } from '../seedUbps/seedSteps';
import { SeedContext, SeedOptions, SeedModule, CostEstimate, ManifestPart, fmtTon } from './lib/context';

function readJson(file: string): unknown {
    return JSON.parse(readFileSync(file, 'utf-8'));
}

/** Load + merge --ubps-include fragments + validate (throws on any error). Mirrors seedUbps.ts loadAndValidate. */
function loadAndValidate(file: string, includes: string[], network: 'testnet'): UbpsSeed {
    let raw = readJson(file) as UbpsSeed;
    if (includes.length > 0) {
        const frags = includes.map(f => readJson(f) as SeedFragment);
        raw = mergeSeedFragments(raw, frags).seed;
    }
    const v = validateSeed(raw, network);
    if (!v.ok || !v.seed) {
        throw new Error(`UBPS seed validation failed:\n  - ${v.errors.join('\n  - ')}`);
    }
    return v.seed;
}

export const ubpsModule: SeedModule = {
    name: 'ubps',

    async estimateCost(_ctx: SeedContext, opts: SeedOptions): Promise<CostEstimate> {
        if (!opts.ubpsFile) {
            return { required: 0n, breakdown: { note: 'no --ubps-file given → UBPS will be skipped' } };
        }
        const seed = loadAndValidate(opts.ubpsFile, opts.ubpsIncludes, 'testnet');
        const users = opts.usersCap != null ? Math.min(opts.usersCap, seed.users.length) : seed.users.length;
        const est = estimateDeployerCost({ questions: seed.questions.length, answers: seed.answers.length, beliefSets: seed.beliefSets.length, users });
        return {
            required: est.required,
            breakdown: {
                questions: String(seed.questions.length), answers: String(seed.answers.length),
                beliefSets: String(seed.beliefSets.length), users: String(users),
                total: `${fmtTon(est.required)} TON`,
            },
        };
    },

    async run(ctx: SeedContext, opts: SeedOptions): Promise<ManifestPart> {
        if (!opts.ubpsFile) {
            console.log('\n=== ubps seed: SKIPPED (no --ubps-file given) ===');
            return { module: 'ubps', summary: { deployed: 0, skipped: 0, funded: 0, errors: 0 }, skipped: true };
        }
        const seed = loadAndValidate(opts.ubpsFile, opts.ubpsIncludes, 'testnet');
        console.log(`\n=== ubps seed (delegated to scripts/seedUbps) ${ctx.dryRun ? '[DRY-RUN]' : '[LIVE]'} ===`);
        console.log(`UBPS seed OK: ${seed.questions.length} Q, ${seed.answers.length} A, ${seed.beliefSets.length} BS, ${seed.users.length} users.`);
        // UBPS opens its OWN provider/deployer + runs its OWN preflight (black box).
        const m = await ubpsRun({ network: 'testnet', seed, dryRun: ctx.dryRun, usersCap: opts.usersCap });
        return { module: 'ubps', summary: m.summary, ubps: m };
    },
};
