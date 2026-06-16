#!/usr/bin/env ts-node
// SPDX-License-Identifier: UNLICENSED
/**
 * Helper script to run Blueprint commands with the best available provider.
 *
 * This script uses the ton-provider-system package to automatically select
 * the best provider based on availability and latency.
 * Provider definitions are loaded from node_modules/ton-provider-system/rpc.json.
 * API keys are read from environment variables (.env).
 *
 * Usage:
 *   ts-node scripts/runWithChainstack.ts <script> [--mainnet] [options]
 *
 * Options are passed to scripts via environment variables (Blueprint limitation):
 *   --id <n>       Sets SCRIPT_ID env var (for deploySystem, testExternalShipStation)
 *   --up           Sets SCRIPT_DIRECTION=up (for moveShip)
 *   --down         Sets SCRIPT_DIRECTION=down (for moveShip)
 *   --left         Sets SCRIPT_DIRECTION=left (for moveShip)
 *   --right        Sets SCRIPT_DIRECTION=right (for moveShip)
 *   --exit         Sets SCRIPT_DIRECTION=exit (for moveShip)
 *   --count <n>    Sets SCRIPT_COUNT env var (for moveShip)
 *
 * Examples:
 *   pnpm chainstack deploySystem
 *   pnpm chainstack deploySystem --mainnet
 *   pnpm chainstack deploySystem --id 4
 *   pnpm chainstack moveShip --up
 *   pnpm chainstack moveShip --up --count 3
 *   pnpm chainstack testExternalShipStation --id 10
 */

import { spawn } from 'child_process';
import * as dotenv from 'dotenv';
import {
    createRegistry,
    createHealthChecker,
    type Network,
} from 'ton-provider-system';

// Load environment variables
dotenv.config();

async function getBestEndpoint(network: Network): Promise<string | null> {
    try {
        // Load registry (from ton-provider-system package) and health checker
        const registry = await createRegistry();
        const healthChecker = createHealthChecker({ timeoutMs: 10000 });

        // Get providers for network
        const providers = registry.getDefaultOrderForNetwork(network);

        if (providers.length === 0) {
            console.error(`No providers configured for ${network}`);
            return null;
        }

        console.log(`Testing ${providers.length} providers for ${network}...`);

        // Test providers in order until one works
        for (const provider of providers) {
            console.log(`  Testing ${provider.name}...`);
            const result = await healthChecker.testProvider(provider);

            if (result.success && result.cachedEndpoint) {
                console.log(`  ✓ ${provider.name} available (${result.latencyMs}ms)`);
                return result.cachedEndpoint;
            } else {
                console.log(`  ✗ ${provider.name}: ${result.error || 'Failed'}`);
            }
        }

        return null;
    } catch (error: any) {
        console.error(`Error getting best endpoint: ${error.message}`);
        return null;
    }
}

function getFallbackEndpoint(network: Network): string {
    // Try environment variables first (backward compatibility)
    if (network === 'mainnet') {
        const mainnetEndpoint = process.env.CHAINSTACK_API_MAINNET_V2 ||
            process.env.CHAINSTACK_API_MAINNET_V3;
        if (mainnetEndpoint) {
            return mainnetEndpoint.endsWith('/jsonRPC')
                ? mainnetEndpoint
                : `${mainnetEndpoint}/jsonRPC`;
        }
        return 'https://toncenter.com/api/v2/jsonRPC';
    }

    const testnetEndpoint = process.env.CHAINSTACK_API_V2 ||
        process.env.CHAINSTACK_API_V3;
    if (testnetEndpoint) {
        return testnetEndpoint.endsWith('/jsonRPC')
            ? testnetEndpoint
            : `${testnetEndpoint}/jsonRPC`;
    }
    return 'https://testnet.toncenter.com/api/v2/jsonRPC';
}

async function main() {
    const args = process.argv.slice(2);

    // Parse arguments
    let scriptName: string | undefined;
    let isMainnet = false;
    const envVars: Record<string, string> = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--mainnet') {
            isMainnet = true;
        } else if (arg === '--testnet') {
            isMainnet = false;
        } else if (arg === '--id' && args[i + 1]) {
            envVars.SCRIPT_ID = args[++i];
        } else if (arg === '--count' && args[i + 1]) {
            envVars.SCRIPT_COUNT = args[++i];
        } else if (arg === '--up') {
            envVars.SCRIPT_DIRECTION = 'up';
        } else if (arg === '--down') {
            envVars.SCRIPT_DIRECTION = 'down';
        } else if (arg === '--left') {
            envVars.SCRIPT_DIRECTION = 'left';
        } else if (arg === '--right') {
            envVars.SCRIPT_DIRECTION = 'right';
        } else if (arg === '--exit') {
            envVars.SCRIPT_DIRECTION = 'exit';
        } else if (!scriptName && !arg.startsWith('-')) {
            scriptName = arg;
        }
    }

    if (!scriptName) {
        console.error('Usage: pnpm chainstack <script> [--mainnet] [options]');
        console.error('');
        console.error('Options (passed via env vars due to Blueprint limitation):');
        console.error('  --id <n>       Subcontract/ship ID');
        console.error('  --up/down/left/right/exit   Movement direction');
        console.error('  --count <n>    Number of moves');
        console.error('');
        console.error('Examples:');
        console.error('  pnpm chainstack deploySystem');
        console.error('  pnpm chainstack deploySystem --mainnet');
        console.error('  pnpm chainstack deploySystem --id 4');
        console.error('  pnpm chainstack moveShip --up');
        console.error('  pnpm chainstack moveShip --up --count 3');
        console.error('  pnpm chainstack testExternalShipStation --id 10');
        process.exit(1);
    }

    const network: Network = isMainnet ? 'mainnet' : 'testnet';

    console.log(`\n=== Provider Selection for ${network} ===\n`);

    // Get best endpoint
    let endpoint = await getBestEndpoint(network);

    if (!endpoint) {
        console.warn('\nNo providers available, trying fallback...');
        endpoint = getFallbackEndpoint(network);
        console.log(`Using fallback: ${endpoint}`);
    }

    console.log(`\nSelected endpoint: ${endpoint}\n`);

    // Construct blueprint command
    const blueprintArgs = [
        'run',
        scriptName,
        '--custom',
        endpoint,
        '--custom-version',
        'v2',
        '--custom-type',
        network,
        '--mnemonic',
    ];

    console.log(`Running: blueprint ${blueprintArgs.join(' ')}`);
    console.log(`Network: ${network}`);
    if (Object.keys(envVars).length > 0) {
        console.log(`Script options: ${JSON.stringify(envVars)}`);
    }
    console.log('');

    // Merge environment variables.
    // Force the wallet version deploySystem.ts uses to derive the owner (WalletContractV4 / V4R2).
    // Blueprint's `--mnemonic` provider defaults to V5R1, which produces a DIFFERENT address from
    // the same seed — so owner-gated actions (moveShip, testExternalShipStation) would be sent from
    // a non-owner wallet and bounce (ERR_INVALID_USER_SENDER). Since deploySystem.ts is hardcoded to
    // V4R2, the on-chain owner is ALWAYS V4R2, so we override any WALLET_VERSION inherited from .env
    // here (WALLET_VERSION is placed LAST so it wins over both process.env and envVars).
    const childEnv = { ...process.env, ...envVars, WALLET_VERSION: 'v4r2' };
    console.log('Wallet version: v4r2 (forced to match deploySystem.ts owner; overrides .env)');

    // Spawn blueprint process
    const child = spawn('npx', ['blueprint', ...blueprintArgs], {
        stdio: 'inherit',
        cwd: process.cwd(),
        env: childEnv,
    });

    child.on('error', (err) => {
        console.error('Failed to start blueprint:', err.message);
        process.exit(1);
    });

    child.on('close', (code) => {
        process.exit(code ?? 0);
    });
}

main();
