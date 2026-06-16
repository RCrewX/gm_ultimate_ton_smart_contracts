// SPDX-License-Identifier: UNLICENSED
import { Config } from '@ton/blueprint';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Blueprint configuration with Chainstack API support.
 *
 * IMPORTANT: When Chainstack is configured, use --custom flag instead of --testnet/--mainnet:
 *   pnpm blueprint run deploySystem --custom --mnemonic
 *
 * The --testnet and --mainnet flags override the config with default toncenter endpoints.
 *
 * Chainstack endpoints are read from environment variables:
 * - CHAINSTACK_API_V2: Testnet v2 endpoint (e.g., https://ton-testnet.core.chainstack.com/xxx/api/v2)
 * - CHAINSTACK_API_V3: Testnet v3 endpoint
 * - CHAINSTACK_API_MAINNET_V2: Mainnet v2 endpoint
 * - CHAINSTACK_API_MAINNET_V3: Mainnet v3 endpoint
 *
 * Falls back to toncenter.com if Chainstack is not configured.
 */

/**
 * Determine network type from CLI args
 */
function getNetworkType(): 'testnet' | 'mainnet' {
    const args = process.argv;
    if (args.includes('--mainnet')) {
        return 'mainnet';
    }
    return 'testnet';
}

/**
 * Get Chainstack endpoint based on network type.
 *
 * NOTE: this endpoint feeds the blueprint NetworkProvider, which BROADCASTS external
 * messages. We deliberately do NOT derive it from CHAINSTACK_KEY_TESTNET/_MAINNET here:
 * the Chainstack testnet node serves reads fine but fails external-message emulation
 * ("cannot fetch config params: configuration parameter 43 is invalid"). Sends therefore
 * stay on a send-capable node (toncenter fallback below), while keyed Chainstack reads are
 * wired in lib/chainstack.ts. An explicit, send-capable CHAINSTACK_API_V2/_V3 URL is still
 * honored if you set one.
 */
function getChainstackEndpoint(network: 'testnet' | 'mainnet'): string | undefined {
    if (network === 'mainnet') {
        return process.env.CHAINSTACK_API_MAINNET_V2 || process.env.CHAINSTACK_API_MAINNET_V3;
    }
    return process.env.CHAINSTACK_API_V2 || process.env.CHAINSTACK_API_V3;
}

/**
 * Get fallback endpoint based on network type
 */
function getFallbackEndpoint(network: 'testnet' | 'mainnet'): string {
    if (network === 'mainnet') {
        return 'https://toncenter.com/api/v2/jsonRPC';
    }
    return 'https://testnet.toncenter.com/api/v2/jsonRPC';
}

const networkType = getNetworkType();
const chainstackEndpoint = getChainstackEndpoint(networkType);
const endpoint = chainstackEndpoint || getFallbackEndpoint(networkType);

// Log which endpoint is being used (only when running scripts, not during tests)
const isRunningScript = process.argv.some(arg => arg.includes('blueprint') || arg.includes('run'));
const isRunningTest = process.argv.some(arg => arg.includes('jest') || arg.includes('test'));
if (isRunningScript && !isRunningTest) {
    if (chainstackEndpoint) {
        console.log(`[Blueprint Config] Using Chainstack endpoint for ${networkType}: ${endpoint}`);
    } else {
        console.log(`[Blueprint Config] Chainstack not configured for ${networkType}, using toncenter fallback`);
    }
}

export const config: Config = {
    separateCompilables: true,

    // Network configuration - uses custom endpoint
    // Note: This only works with --custom flag, not --testnet/--mainnet
    network: {
        endpoint: endpoint,
        version: 'v2',
        type: networkType,
        key: process.env.TONCENTER_API_KEY,
    },
};