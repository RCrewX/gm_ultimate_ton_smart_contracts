// SPDX-License-Identifier: UNLICENSED
/**
 * Unified seed runner — ONE command to populate a freshly-deployed testnet with starter
 * data across the seedable modules: UBPS (delegated), test tokens, and ton_race_game pilots.
 * Runs ALL (default) or a selected subset, over one shared provider/deployer/network, with a
 * combined cost preflight, --dry-run, mainnet refusal, and a per-module manifest.
 *
 *   pnpm seed:testnet                         # all modules (ubps skipped unless --ubps-file)
 *   pnpm seed:testnet -- --only race,tokens   # subset
 *   pnpm seed:dry                             # plan + combined cost, sends NOTHING
 *   ts-node scripts/seed.ts --testnet --only tokens --owner <addr> --amount 1000000
 *
 * Env: MNEMONIC | PRIVATE_KEY (deployer) + TEST_USERS_SEED (testnet-only seed for the
 * deterministic pilot wallets). Mainnet is REFUSED. The LIVE run is the USER's — the agent
 * only authors + dry-runs this (it holds no keys and sends nothing).
 */
import * as dotenv from 'dotenv';
import { Address } from '@ton/core';
import {
    SeedContext, SeedOptions, SeedModule, CostEstimate,
    compileSeedCodes, loadDeployment, loadDeployerAsync, deploymentInfoExists, fmtTon,
} from './seed/lib/context';
import { ResilientProvider, getBalance } from './seed/lib/rpc';
import { fmtAddr } from './seed/lib/context';
import { tokensModule } from './seed/tokensModule';
import { raceModule } from './seed/raceModule';
import { ubpsModule } from './seed/ubpsModule';

dotenv.config();

type ModuleName = 'ubps' | 'race' | 'tokens';
const ALL_MODULES: ModuleName[] = ['ubps', 'tokens', 'race']; // canonical run order (UBPS → tokens → race)
const MODULES: Record<ModuleName, SeedModule> = { ubps: ubpsModule, tokens: tokensModule, race: raceModule };

/** Pure module selection: null/empty → all; otherwise the named subset (in canonical order). Throws on unknown. */
export function selectModules(only: string[] | null): ModuleName[] {
    if (!only || only.length === 0) return [...ALL_MODULES];
    const set = new Set(only.map(s => s.toLowerCase().trim()).filter(Boolean));
    const unknown = [...set].filter(n => !ALL_MODULES.includes(n as ModuleName));
    if (unknown.length) throw new Error(`Unknown module(s): ${unknown.join(', ')} (valid: ${ALL_MODULES.join(', ')})`);
    return ALL_MODULES.filter(n => set.has(n));
}

interface Cli {
    network: 'testnet' | 'mainnet';
    dryRun: boolean;
    only: string[] | null;
    opts: SeedOptions;
}

function parseList(s: string): string[] {
    return s.split(',').map(x => x.trim()).filter(Boolean);
}

function parseCli(argv: string[]): Cli {
    let network: 'testnet' | 'mainnet' = 'testnet';
    let dryRun = false;
    let only: string[] | null = null;
    const opts: SeedOptions = {
        tokens: ['A', 'B', 'C', 'D', 'E'],
        tokenAmount: 1_000_000n,
        owner: null,
        pilots: 3,
        moves: 10,
        directions: ['LEFT', 'UP', 'RIGHT'],
        pilotIndexBase: 1000,
        ubpsFile: null,
        ubpsIncludes: [],
        usersCap: undefined,
    };
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--testnet') network = 'testnet';
        else if (a === '--mainnet') network = 'mainnet';
        else if (a === '--dry-run') dryRun = true;
        else if (a === '--all') only = null;
        else if (a === '--yes' || a === '-y') { /* reserved */ }
        else if ((a === '--only' || a === '--modules') && argv[i + 1]) only = parseList(argv[++i]);
        else if (a === '--tokens' && argv[i + 1]) opts.tokens = parseList(argv[++i]);
        else if (a === '--amount' && argv[i + 1]) {
            const n = BigInt(argv[++i]);
            if (n <= 0n) throw new Error('--amount must be a positive integer (raw units)');
            opts.tokenAmount = n;
        } else if (a === '--owner' && argv[i + 1]) opts.owner = Address.parse(argv[++i]);
        else if (a === '--pilots' && argv[i + 1]) opts.pilots = intArg(argv[++i], '--pilots', 0);
        else if (a === '--moves' && argv[i + 1]) opts.moves = intArg(argv[++i], '--moves', 0);
        else if (a === '--directions' && argv[i + 1]) opts.directions = parseList(argv[++i]);
        else if (a === '--pilot-index-base' && argv[i + 1]) opts.pilotIndexBase = intArg(argv[++i], '--pilot-index-base', 0);
        else if (a === '--ubps-file' && argv[i + 1]) opts.ubpsFile = argv[++i];
        else if ((a === '--ubps-include' || a === '--include') && argv[i + 1]) opts.ubpsIncludes.push(argv[++i]);
        else if (a === '--users' && argv[i + 1]) opts.usersCap = intArg(argv[++i], '--users', 0);
        else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
        else if (!a.startsWith('-')) positional.push(a);
    }
    if (only === null && positional.length > 0) only = positional; // `seed race tokens`
    if (opts.directions.length === 0) throw new Error('--directions must list at least one of LEFT|UP|RIGHT');
    return { network, dryRun, only, opts };
}

function intArg(s: string, name: string, min: number): number {
    const n = Number(s);
    if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`);
    return n;
}

function printHelp(): void {
    console.log(`
Unified seed runner — ubps + tokens + ton_race_game pilots, one command.

Usage:
  ts-node scripts/seed.ts --testnet [--all | --only ubps,tokens,race] [--dry-run] [flags]

Selection:
  --all                 Run every module (default). UBPS is skipped unless --ubps-file is given.
  --only <a,b,c>        Run a subset (comma list): ubps, tokens, race. Positional names also work.

Tokens module:
  --tokens A,B,C,D,E    Labels to deploy (default A..E). Each is a plain standalone jetton master.
  --owner <addr>        Mint recipient (default = deployer). Point at YOUR browser wallet to test SSM.
  --amount <raw>        Raw units minted per token (default 1000000; jettons are 0-decimal 1:1).

Race module (ton_race_game):
  --pilots <n>          Pilot ships (default 3). ~2.8 TON each (~8.5 TON for 3 @10 moves; move value recycles).
  --moves <n>           Normal moves per pilot (default 10) — opens the first n cells of its lane.
  --directions L,U,R    Lanes, one per pilot cyclically (default LEFT,UP,RIGHT).
  --pilot-index-base <n>  Wallet-index namespace offset (default 1000; keeps pilots off UBPS users).

UBPS module (delegated to scripts/seedUbps):
  --ubps-file <path>    UBPS Seed Format v1 JSON (required to run UBPS; else UBPS is skipped).
  --ubps-include <path> Merge a reusable fragment (repeatable).
  --users <n>           Cap UBPS users.

Common:
  --testnet             Target testnet (default).  --mainnet  REFUSED.
  --dry-run             Print the plan + combined cost; send NOTHING.

Env: MNEMONIC | PRIVATE_KEY (deployer) + TEST_USERS_SEED (deterministic pilot wallets).

Provider / log controls (all optional):
  SEED_PROVIDER_LOG_LEVEL   debug | info | warn | error  (default warn — hides per-provider
                            info spam; keeps failovers/failures/errors). 'debug' restores all.
  SEED_MAX_PROVIDER_RESTARTS    cap the per-action provider-restart budget (default 12; 0 = give
                            up immediately — use for unattended runs that must never churn).
  SEED_PROVIDER_RESTART_WAIT_MS wait between a teardown and a fresh provider (default 60000).
  TON_RPC_ENDPOINT          pin ONE endpoint (skips the 5-node failover churn + most 429s), e.g.
                            'https://testnet.toncenter.com/api/v2/jsonRPC?api_key=<TONCENTER_API_KEY>'.

Quieting the package's own '[ConfigParser] … not set' / 429 lines (NOT covered by the log level —
they are a direct console.warn in ton-provider-system): set the keys you actually hold in .env —
TONCENTER_API_KEY, CHAINSTACK_KEY_TESTNET, TATUM_API_KEY_TESTNET, ONFINALITY_KEY_TESTNET. A key that
is referenced but unset drops that provider ("API key not resolved"); set it or accept fewer nodes.
`);
}

async function main(): Promise<void> {
    const cli = parseCli(process.argv.slice(2));

    if (cli.network === 'mainnet') {
        console.error('ERROR: mainnet seeding not enabled. Re-run with --testnet.');
        process.exit(1);
    }

    const selected = selectModules(cli.only);
    console.log(`\n=== unified seed (${cli.network}) ${cli.dryRun ? '[DRY-RUN — no sends]' : '[LIVE]'} ===`);
    console.log(`modules: ${selected.join(', ')}`);

    if (cli.dryRun && !deploymentInfoExists()) {
        console.warn('! deployment_info/deployment_latest.json not found — addresses cannot be resolved.');
    }

    // ---- shared context ----
    const need = { race: selected.includes('race'), tokens: selected.includes('tokens') };
    const codes = await compileSeedCodes(need);
    const deployment = loadDeployment();
    const prov = await ResilientProvider.start(cli.network);
    if (!cli.dryRun && !prov) throw new Error('Live seeding requires a working RPC; aborting.');

    let deployer = null as Awaited<ReturnType<typeof loadDeployerAsync>> | null;
    try { deployer = await loadDeployerAsync(); } catch (e: any) {
        if (!cli.dryRun) throw e;
        console.warn(`! ${e.message} — dry-run will not resolve deployer-derived addresses.`);
    }

    const ctx: SeedContext = {
        network: 'testnet',
        dryRun: cli.dryRun,
        live: !cli.dryRun,
        prov,
        deployer,
        deployment,
        codes,
    };

    // ---- combined cost preflight ----
    console.log('\n[Preflight] combined cost estimate:');
    const estimates: { name: ModuleName; est: CostEstimate }[] = [];
    let total = 0n;
    for (const name of selected) {
        const est = await MODULES[name].estimateCost(ctx, cli.opts);
        estimates.push({ name, est });
        total += est.required;
        console.log(`  - ${name}: ~${fmtTon(est.required)} TON  ${JSON.stringify(est.breakdown)}`);
    }
    console.log(`  => TOTAL required: ~${fmtTon(total)} TON (worst case; a resume skips already-seeded work)`);
    if (need.race) console.log('  NOTE: race dominates the cost (~2.8 TON/pilot @10 moves); the per-move value recycles via wallet cashback, so most of the hold is recoverable.');

    if (!cli.dryRun) {
        if (!deployer || !prov) throw new Error('Live run needs MNEMONIC/PRIVATE_KEY + RPC.');
        const balance = await getBalance(prov, true, deployer.wallet.address);
        console.log(`  deployer ${fmtAddr(deployer.wallet.address, cli.network)} balance: ${fmtTon(balance)} TON`);
        if (balance < total) {
            throw new Error(`Insufficient deployer gas: ${fmtTon(balance)} TON < required ~${fmtTon(total)} TON. Top up (or run a smaller subset / --pilots) and retry.`);
        }
        console.log('  ✓ deployer balance sufficient.');
    } else {
        console.log('  (dry-run: balance not checked.)');
    }

    // ---- run selected modules sequentially over the shared ctx ----
    const parts: any[] = [];
    for (const name of selected) {
        const part = await MODULES[name].run(ctx, cli.opts);
        parts.push(part);
    }

    // ---- combined summary ----
    console.log('\n=== combined summary ===');
    for (const p of parts) console.log(`  ${p.module}: ${JSON.stringify(p.summary)}${p.skipped ? ' (skipped)' : ''}`);

    if (prov && prov.restarts > 0) console.log(`Provider restarts during run: ${prov.restarts}`);
    prov?.dispose();
    console.log('\nDone.');
}

// Only run when invoked directly (ts-node scripts/seed.ts) — NOT when imported (tests
// import selectModules). Without this guard, importing this file would start a live run.
if (require.main === module) {
    main().catch(e => {
        console.error('Fatal:', e?.message ?? e);
        process.exit(1);
    });
}
