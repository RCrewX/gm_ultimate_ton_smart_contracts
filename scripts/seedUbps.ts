// SPDX-License-Identifier: UNLICENSED
/**
 * UBPS test-data seeding CLI.
 *
 * Reads a UBPS Seed Format v1 JSON (scripts/seedUbps/SCHEMA.md) and populates a live
 * UBPS deployment with questions / answers / beliefSets / beliefs and per-user Units
 * + pointers. Idempotent + resumable (every entity is skipped if already on-chain).
 *
 *   pnpm seed:ubps:testnet --file <seed.json>          # live (USER runs this)
 *   pnpm seed:ubps:dry     --file <seed.json>          # plan only, sends nothing
 *   ts-node scripts/seedUbps.ts --testnet --file <f> [--dry-run] [--users <n>]
 *
 * Env: MNEMONIC | PRIVATE_KEY (deployer) + TEST_USERS_SEED (testnet-only master seed
 * for the deterministic test wallets). Mainnet is REFUSED. See scripts/seedUbps/README.md.
 */
import * as dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { validateSeed, mergeSeedFragments, SeedNetwork, SeedFragment, UbpsSeed } from './seedUbps/types';
import { run, deployerInfo } from './seedUbps/seedSteps';

dotenv.config();

interface Cli {
    network: SeedNetwork;
    file: string | null;
    includes: string[];
    dryRun: boolean;
    deployerInfo: boolean;
    usersCap?: number;
}

function parseCli(argv: string[]): Cli {
    let network: SeedNetwork = 'testnet';
    let file: string | null = null;
    const includes: string[] = [];
    let dryRun = false;
    let deployerInfoMode = false;
    let usersCap: number | undefined;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--testnet') network = 'testnet';
        else if (a === '--mainnet') network = 'mainnet';
        else if (a === '--dry-run') dryRun = true;
        else if (a === '--deployer-info' || a === '--deployer_info') deployerInfoMode = true;
        else if (a === '--yes' || a === '-y') { /* reserved */ }
        else if (a === '--file' && argv[i + 1]) file = argv[++i];
        else if ((a === '--include' || a === '--fragment') && argv[i + 1]) includes.push(argv[++i]);
        else if (a === '--users' && argv[i + 1]) {
            const n = Number(argv[++i]);
            if (!Number.isInteger(n) || n < 0) throw new Error('--users must be a non-negative integer');
            usersCap = n;
        } else if (a === '--help' || a === '-h') {
            printHelp();
            process.exit(0);
        }
    }
    return { network, file, includes, dryRun, deployerInfo: deployerInfoMode, usersCap };
}

function printHelp(): void {
    console.log(`
UBPS test-data seeder

Usage:
  ts-node scripts/seedUbps.ts --testnet --file <seed.json> [--dry-run] [--users <n>]
  ts-node scripts/seedUbps.ts --testnet --deployer-info [--file <seed.json>]

Flags:
  --testnet         Target testnet (default).
  --mainnet         REFUSED — mainnet seeding is not enabled.
  --file <path>     Seed JSON in UBPS Seed Format v1. Required to seed; optional with
                    --deployer-info (then also sizes the requirement + lists user wallets).
  --include <path>  Merge a reusable seed FRAGMENT (questions/answers/beliefSets, e.g.
                    scripts/seedUbps/canon.json) INTO the --file seed before validating.
                    Repeatable. Merge is by id + idempotent (ids already in the seed are
                    skipped), so a seed can just reference shared ids like "bs.canon".
  --dry-run         Compute + print the full plan + manifest preview; send NOTHING.
  --deployer-info   READ-ONLY: print the deployer (active) wallet address + current
                    balance + required TON (and the derived user wallets). Sends nothing.
                    Run this first to fund the deployer before the live seed.
  --users <n>       Cap the number of users seeded (partial run).
  --yes             Reserved (no-op for now).

Env:
  MNEMONIC | PRIVATE_KEY   Deployer wallet (signs Q/A/BS + funds test wallets).
  TEST_USERS_SEED          Testnet-only master seed for deterministic test wallets.
`);
}

/** Read a JSON file or exit the process on a read/parse error. */
function readJson(file: string): unknown {
    try {
        return JSON.parse(readFileSync(file, 'utf-8'));
    } catch (e: any) {
        console.error(`ERROR: cannot read/parse ${file}: ${e?.message ?? e}`);
        process.exit(1);
    }
}

/** Read + (optionally) merge --include fragments + validate (exits on any error). */
function loadAndValidate(file: string, includes: string[], network: SeedNetwork, opts?: { allowMainnet?: boolean }) {
    let raw = readJson(file) as UbpsSeed;
    if (includes && includes.length > 0) {
        const frags = includes.map(f => readJson(f) as SeedFragment);
        const m = mergeSeedFragments(raw, frags);
        raw = m.seed;
        console.log(
            `Merged ${includes.length} fragment(s): +${m.added.questions}Q +${m.added.answers}A +${m.added.beliefSets}BS ` +
            `(skipped already-present ${m.skipped.questions}Q/${m.skipped.answers}A/${m.skipped.beliefSets}BS).`,
        );
    }
    const v = validateSeed(raw, network, opts);
    if (!v.ok || !v.seed) {
        console.error(`ERROR: seed validation failed (${v.errors.length} issue(s)):`);
        for (const err of v.errors) console.error(`  - ${err}`);
        process.exit(1);
    }
    console.log(`Seed OK: ${v.seed.questions.length} Q, ${v.seed.answers.length} A, ${v.seed.beliefSets.length} BS, ${v.seed.users.length} users.`);
    return v.seed;
}

async function main(): Promise<void> {
    const cli = parseCli(process.argv.slice(2));

    // Deployer-info mode is READ-ONLY (no sends) → allowed on mainnet too, so you can
    // check a mainnet deployer address/balance. --file is OPTIONAL here (without it:
    // just the deployer address + balance). NOTE: for --deployer-info we skip seed
    // network/flag validation against mainnet so the read-only query still works.
    if (cli.deployerInfo) {
        const seed = cli.file ? loadAndValidate(cli.file, cli.includes, cli.network, { allowMainnet: true }) : null;
        await deployerInfo({ network: cli.network, seed, usersCap: cli.usersCap });
        return;
    }

    // Seeding / dry-run: mainnet is refused (this gate guards the SEND paths).
    if (cli.network === 'mainnet') {
        console.error('ERROR: mainnet seeding not enabled. Re-run with --testnet (or use --deployer-info for a read-only mainnet check).');
        process.exit(1);
    }

    if (!cli.file) {
        console.error('ERROR: --file <seed.json> is required.');
        printHelp();
        process.exit(1);
    }
    const seed = loadAndValidate(cli.file, cli.includes, cli.network);
    await run({ network: cli.network, seed, dryRun: cli.dryRun, usersCap: cli.usersCap });
    console.log('\nDone.');
}

main().catch(e => {
    console.error('Fatal:', e?.message ?? e);
    process.exit(1);
});
