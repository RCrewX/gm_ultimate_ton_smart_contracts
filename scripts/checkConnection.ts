// SPDX-License-Identifier: UNLICENSED
/**
 * Check Connection Script
 *
 * Tests connectivity to all configured TON API providers using the ton-provider-system package.
 * Provider definitions are loaded from node_modules/ton-provider-system/rpc.json.
 * API keys are read from environment variables (.env).
 *
 * Usage:
 *   pnpm check-connection
 *   pnpm blueprint run checkConnection
 */

import * as dotenv from 'dotenv';
import {
    createRegistry,
    createHealthChecker,
    type Network,
    type ProviderHealthResult,
} from 'ton-provider-system';

// Load environment variables
dotenv.config();

interface ConnectionResult {
    provider: string;
    providerId: string;
    network: Network;
    endpoint: string;
    status: 'ok' | 'error' | 'not_configured';
    latencyMs?: number;
    seqno?: number;
    blocksBehind?: number;
    error?: string;
}

function printResult(result: ConnectionResult): void {
    if (result.status === 'ok') {
        console.log(`  ✓ ${result.provider} (${result.latencyMs}ms)`);
        console.log(`    Endpoint: ${result.endpoint}`);
        console.log(`    Seqno: ${result.seqno}, Blocks behind: ${result.blocksBehind}`);
    } else if (result.status === 'error') {
        console.log(`  ✗ ${result.provider}`);
        console.log(`    Endpoint: ${result.endpoint}`);
        console.log(`    Error: ${result.error}`);
    } else {
        console.log(`  ⚠ ${result.provider} - Not configured`);
    }
    console.log('');
}

function printSummary(results: ConnectionResult[]): void {
    console.log('=== Connection Summary ===\n');

    const table: string[] = [];
    table.push('Provider              | Network  | Status         | Latency  | Seqno');
    table.push('--------------------- | -------- | -------------- | -------- | -----');

    for (const result of results) {
        const provider = result.provider.substring(0, 21).padEnd(21);
        const network = result.network.padEnd(8);
        let status: string;
        let latency: string;
        let seqno: string;

        switch (result.status) {
            case 'ok':
                status = '✓ OK'.padEnd(14);
                latency = result.latencyMs ? `${result.latencyMs}ms`.padEnd(8) : '-'.padEnd(8);
                seqno = result.seqno?.toString() || '-';
                break;
            case 'error':
                status = '✗ Error'.padEnd(14);
                latency = '-'.padEnd(8);
                seqno = '-';
                break;
            case 'not_configured':
                status = '⚠ Not Config'.padEnd(14);
                latency = '-'.padEnd(8);
                seqno = '-';
                break;
        }

        table.push(`${provider} | ${network} | ${status} | ${latency} | ${seqno}`);
    }

    console.log(table.join('\n'));
    console.log('');
}

async function checkAllConnections(): Promise<ConnectionResult[]> {
    const results: ConnectionResult[] = [];

    console.log('=== TON Provider System Connection Check ===\n');
    console.log('Loading providers from ton-provider-system package...\n');

    // Load registry (from ton-provider-system package)
    const registry = await createRegistry();
    const healthChecker = createHealthChecker({
        timeoutMs: 15000,
        maxBlocksBehind: 10,
    });

    // Test testnet providers
    console.log('--- Testing Testnet Providers ---\n');
    const testnetProviders = registry.getProvidersForNetwork('testnet');

    if (testnetProviders.length === 0) {
        console.log('  No testnet providers configured.\n');
    } else {
        for (const provider of testnetProviders) {
            console.log(`Testing ${provider.name}...`);
            const healthResult = await healthChecker.testProvider(provider);

            const result: ConnectionResult = {
                provider: provider.name,
                providerId: provider.id,
                network: 'testnet',
                endpoint: healthResult.cachedEndpoint || provider.endpointV2,
                status: healthResult.success ? 'ok' : 'error',
                latencyMs: healthResult.latencyMs || undefined,
                seqno: healthResult.seqno || undefined,
                blocksBehind: healthResult.blocksBehind,
                error: healthResult.error,
            };

            results.push(result);
            printResult(result);
        }
    }

    // Test mainnet providers
    console.log('--- Testing Mainnet Providers ---\n');
    const mainnetProviders = registry.getProvidersForNetwork('mainnet');

    if (mainnetProviders.length === 0) {
        console.log('  No mainnet providers configured.\n');
    } else {
        for (const provider of mainnetProviders) {
            console.log(`Testing ${provider.name}...`);
            const healthResult = await healthChecker.testProvider(provider);

            const result: ConnectionResult = {
                provider: provider.name,
                providerId: provider.id,
                network: 'mainnet',
                endpoint: healthResult.cachedEndpoint || provider.endpointV2,
                status: healthResult.success ? 'ok' : 'error',
                latencyMs: healthResult.latencyMs || undefined,
                seqno: healthResult.seqno || undefined,
                blocksBehind: healthResult.blocksBehind,
                error: healthResult.error,
            };

            results.push(result);
            printResult(result);
        }
    }

    return results;
}

function printRecommendations(results: ConnectionResult[]): void {
    console.log('=== Recommendations ===\n');

    const testnetWorking = results.filter((r) => r.network === 'testnet' && r.status === 'ok');
    const mainnetWorking = results.filter((r) => r.network === 'mainnet' && r.status === 'ok');

    // Find best providers (lowest latency)
    const bestTestnet = testnetWorking.sort((a, b) => (a.latencyMs || Infinity) - (b.latencyMs || Infinity))[0];
    const bestMainnet = mainnetWorking.sort((a, b) => (a.latencyMs || Infinity) - (b.latencyMs || Infinity))[0];

    if (testnetWorking.length === 0) {
        console.log('⚠ No working testnet providers found!');
        console.log('  Configure API keys in .env file');
        console.log('  Recommended: Set CHAINSTACK_KEY_TESTNET for best performance\n');
    } else {
        console.log(`✓ Testnet: ${testnetWorking.length} provider(s) working`);
        if (bestTestnet) {
            console.log(`  Best: ${bestTestnet.provider} (${bestTestnet.latencyMs}ms)\n`);
        }
    }

    if (mainnetWorking.length === 0) {
        console.log('⚠ No working mainnet providers found!');
        console.log('  Configure API keys in .env file');
        console.log('  Recommended: Set CHAINSTACK_KEY_MAINNET or QUICKNODE_KEY_MAINNET\n');
    } else {
        console.log(`✓ Mainnet: ${mainnetWorking.length} provider(s) working`);
        if (bestMainnet) {
            console.log(`  Best: ${bestMainnet.provider} (${bestMainnet.latencyMs}ms)\n`);
        }
    }

    // Show env var hints
    const missingKeys: string[] = [];
    const envVars = [
        'CHAINSTACK_KEY_TESTNET',
        'CHAINSTACK_KEY_MAINNET',
        'QUICKNODE_KEY_MAINNET',
        'GETBLOCK_KEY_MAINNET',
        'ONFINALITY_KEY_TESTNET',
        'TATUM_API_KEY_TESTNET',
        'TONCENTER_API_KEY',
    ];

    for (const envVar of envVars) {
        if (!process.env[envVar]) {
            missingKeys.push(envVar);
        }
    }

    if (missingKeys.length > 0) {
        console.log('💡 Configure these env vars in .env for more providers:');
        for (const key of missingKeys.slice(0, 3)) {
            console.log(`   ${key}`);
        }
        if (missingKeys.length > 3) {
            console.log(`   ... and ${missingKeys.length - 3} more`);
        }
    }

    console.log('');
}

// Main execution
async function main() {
    try {
        const results = await checkAllConnections();
        printSummary(results);
        printRecommendations(results);

        // Exit with error code if no connections work
        const anyWorking = results.some((r) => r.status === 'ok');
        if (!anyWorking) {
            process.exit(1);
        }
    } catch (error: any) {
        console.error('Fatal error:', error.message || error);
        process.exit(1);
    }
}

// Blueprint script export
export async function run() {
    await main();
}

// Allow direct execution with ts-node
if (require.main === module) {
    main();
}
