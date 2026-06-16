// SPDX-License-Identifier: UNLICENSED
/**
 * Chainstack API Utilities
 *
 * This module provides utilities for interacting with TON blockchain via Chainstack API.
 * It supports both API v2 and v3 endpoints and provides fallback to other public endpoints.
 *
 * NOTE: This module is kept for backward compatibility.
 * For new code, use the ton-provider-system package instead:
 *
 * ```typescript
 * import { ProviderManager, NodeAdapter } from 'ton-provider-system';
 *
 * const pm = ProviderManager.getInstance();
 * await pm.init('testnet');
 *
 * const adapter = new NodeAdapter(pm);
 * const state = await adapter.getAddressState(address);
 * ```
 *
 * Environment Variables:
 * - CHAINSTACK_API_V2: Chainstack API v2 endpoint (e.g., https://ton-testnet.core.chainstack.com/xxx/api/v2)
 * - CHAINSTACK_API_V3: Chainstack API v3 endpoint (e.g., https://ton-testnet.core.chainstack.com/xxx/api/v3)
 * - CHAINSTACK_API_MAINNET_V2: Chainstack API v2 endpoint for mainnet
 * - CHAINSTACK_API_MAINNET_V3: Chainstack API v3 endpoint for mainnet
 */

import { Address, beginCell, Cell } from '@ton/core';
import { createRegistry } from 'ton-provider-system';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// ============================================================================
// Types
// ============================================================================

export type Network = 'testnet' | 'mainnet';

export interface ChainstackEndpoints {
    v2: string;
    v3: string;
}

export interface AddressInfo {
    state: string;
    balance: bigint;
    lastTransactionId?: {
        lt: string;
        hash: string;
    };
}

export interface GetMethodResult {
    exit_code: number;
    stack: any[];
}

// ============================================================================
// Endpoint Resolution
// ============================================================================

/**
 * Get Chainstack endpoints for the specified network.
 * Falls back to public endpoints if Chainstack is not configured.
 *
 * @param network - The network to get endpoints for
 * @returns Object with v2 and v3 endpoint URLs
 */
/**
 * Build a Chainstack endpoint base URL from a bare API key, mirroring the
 * `ton-provider-system` rpc.json template (keyEnvVar: CHAINSTACK_KEY_TESTNET /
 * CHAINSTACK_KEY_MAINNET). This unifies env-var naming so a single key variable
 * works across every code path (blueprint provider, lib helpers, the chainstack
 * runner), instead of requiring full URLs in CHAINSTACK_API_V2/_V3.
 *
 * Returns a base URL ending in /api/v2 or /api/v3 (no /jsonRPC), matching the
 * format the other endpoints in this module use.
 */
export function chainstackEndpointFromKey(network: Network, version: 'v2' | 'v3'): string | undefined {
    const key = (network === 'mainnet'
        ? process.env.CHAINSTACK_KEY_MAINNET
        : process.env.CHAINSTACK_KEY_TESTNET
    )?.trim();
    if (!key) return undefined;
    const host = network === 'mainnet'
        ? 'ton-mainnet.core.chainstack.com'
        : 'ton-testnet.core.chainstack.com';
    return `https://${host}/${key}/api/${version}`;
}

export function getChainstackEndpoints(network: Network): ChainstackEndpoints {
    if (network === 'mainnet') {
        return {
            v2:
                process.env.CHAINSTACK_API_MAINNET_V2 ||
                process.env.CHAINSTACK_API_V2?.replace('testnet', 'mainnet') ||
                chainstackEndpointFromKey('mainnet', 'v2') ||
                'https://toncenter.com/api/v2',
            v3:
                process.env.CHAINSTACK_API_MAINNET_V3 ||
                process.env.CHAINSTACK_API_V3?.replace('testnet', 'mainnet') ||
                chainstackEndpointFromKey('mainnet', 'v3') ||
                'https://toncenter.com/api/v3',
        };
    }

    // Testnet
    return {
        v2:
            process.env.CHAINSTACK_API_V2 ||
            chainstackEndpointFromKey('testnet', 'v2') ||
            'https://testnet.toncenter.com/api/v2',
        v3:
            process.env.CHAINSTACK_API_V3 ||
            chainstackEndpointFromKey('testnet', 'v3') ||
            'https://testnet.toncenter.com/api/v3',
    };
}

/**
 * Endpoint base for BROADCASTING external messages. Always a send-capable public node
 * (toncenter), because some keyed providers — notably the Chainstack testnet node — serve
 * reads/get-methods fine but fail external-message emulation with "cannot fetch config
 * params: configuration parameter 43 is invalid". Use this ONLY for sends; keep
 * getChainstackEndpoints() (keyed, fast) for the read-heavy calls. Override via
 * TONCENTER_SEND_ENDPOINT if you have a different send-capable node.
 */
export function getSendEndpoint(network: Network): string {
    if (process.env.TONCENTER_SEND_ENDPOINT) {
        return process.env.TONCENTER_SEND_ENDPOINT;
    }
    return network === 'mainnet'
        ? 'https://toncenter.com/api/v2'
        : 'https://testnet.toncenter.com/api/v2';
}

/**
 * Check if Chainstack API is configured for the specified network.
 *
 * @param network - The network to check
 * @returns true if Chainstack is configured
 */
export function isChainstackConfigured(network: Network): boolean {
    if (network === 'mainnet') {
        return !!(
            process.env.CHAINSTACK_API_MAINNET_V2 ||
            process.env.CHAINSTACK_API_MAINNET_V3 ||
            process.env.CHAINSTACK_KEY_MAINNET
        );
    }
    return !!(
        process.env.CHAINSTACK_API_V2 ||
        process.env.CHAINSTACK_API_V3 ||
        process.env.CHAINSTACK_KEY_TESTNET
    );
}

/**
 * Convert any endpoint to v2 base URL.
 * Handles various endpoint formats (v2, v3, jsonRPC).
 *
 * @param endpoint - Any endpoint URL
 * @returns v2 base URL without trailing slash
 */
export function toV2Base(endpoint: string): string {
    return endpoint.replace(/\/api\/v3\b/, '/api/v2').replace(/\/api\/v2\/?$/, '/api/v2');
}

/**
 * Convert any endpoint to v3 base URL.
 *
 * @param endpoint - Any endpoint URL
 * @returns v3 base URL without trailing slash
 */
export function toV3Base(endpoint: string): string {
    return endpoint.replace(/\/api\/v2\b/, '/api/v3').replace(/\/api\/v3\/?$/, '/api/v3');
}

// ============================================================================
// Multi-provider failover (via ton-provider-system)
// ============================================================================
//
// This is the "centralize in the shared lib" migration: the legacy hand-rolled HTTP calls
// below now fail over across the providers defined by ton-provider-system (rpc.json + env
// keys: CHAINSTACK_KEY_TESTNET, TONCENTER_API_KEY, ...) instead of hitting a single endpoint.
// The caller's preferred endpoint is always tried first, so existing routing is preserved
// (reads → keyed Chainstack, sends → toncenter); other providers are backups. It degrades
// gracefully to single-endpoint behavior if the registry can't be loaded.

type EndpointKind = 'read' | 'send';

// Lazily-loaded, per-network provider order from ton-provider-system. Cached (built once).
const _providerOrderCache = new Map<Network, Promise<Array<{ type: string; endpointV2: string }>>>();

function getProviderOrder(network: Network): Promise<Array<{ type: string; endpointV2: string }>> {
    let cached = _providerOrderCache.get(network);
    if (!cached) {
        cached = createRegistry()
            .then((registry) =>
                registry.getDefaultOrderForNetwork(network).map((p) => ({
                    type: p.type as string,
                    endpointV2: p.endpointV2,
                })))
            .catch(() => [] as Array<{ type: string; endpointV2: string }>); // degrade to preferred-only
        _providerOrderCache.set(network, cached);
    }
    return cached;
}

/**
 * Ordered list of v2 base URLs to try. Preferred endpoint first; ton-provider-system providers
 * as backups. For sends we EXCLUDE Chainstack-type providers — that node serves reads but fails
 * external-message emulation ("config param 43 invalid").
 */
async function buildCandidates(network: Network, kind: EndpointKind, preferredBaseV2: string): Promise<string[]> {
    const candidates: string[] = [preferredBaseV2];
    for (const p of await getProviderOrder(network)) {
        if (kind === 'send' && p.type === 'chainstack') continue;
        const base = toV2Base(p.endpointV2);
        if (!candidates.includes(base)) candidates.push(base);
    }
    return candidates;
}

/**
 * Run a request against the preferred endpoint, failing over to other providers (read: all;
 * send: send-capable only) on error. Returns the first success.
 *
 * NOTE on sends: external messages broadcast here are seqno-protected (the subcontract bumps
 * extSeqno), so a retry on another provider is safe — a duplicate is rejected, not re-applied.
 */
async function fetchWithFailover<T>(
    preferredEndpoint: string,
    kind: EndpointKind,
    doRequest: (baseV2: string) => Promise<T>,
): Promise<T> {
    const network: Network = preferredEndpoint.includes('testnet') ? 'testnet' : 'mainnet';
    const candidates = await buildCandidates(network, kind, toV2Base(preferredEndpoint));
    const errors: string[] = [];
    for (const baseV2 of candidates) {
        try {
            return await doRequest(baseV2);
        } catch (e: any) {
            errors.push(`${baseV2}: ${e?.message ?? String(e)}`);
        }
    }
    throw new Error(`All ${kind} endpoints failed (${candidates.length} tried):\n  ${errors.join('\n  ')}`);
}

/**
 * Get the primary endpoint for a network (prefers v2 for compatibility).
 *
 * @param network - The network
 * @returns The primary endpoint URL
 */
export function getPrimaryEndpoint(network: Network): string {
    const endpoints = getChainstackEndpoints(network);
    // Prefer v2 as it's more widely supported
    return endpoints.v2;
}

/**
 * Log Chainstack configuration status.
 *
 * @param network - The network to log for
 */
export function logChainstackConfig(network: Network): void {
    const endpoints = getChainstackEndpoints(network);
    const isConfigured = isChainstackConfigured(network);

    console.log(`\n--- Provider Configuration (${network}) ---`);
    if (isConfigured) {
        console.log('✓ Chainstack API is configured');
        console.log(`  API v2: ${endpoints.v2}`);
        console.log(`  API v3: ${endpoints.v3}`);
    } else {
        console.log('⚠ Chainstack API not configured, using public endpoints');
        console.log(`  API v2: ${endpoints.v2}`);
        console.log(`  API v3: ${endpoints.v3}`);
        console.log('  To use Chainstack, set CHAINSTACK_KEY_TESTNET (or CHAINSTACK_KEY_MAINNET) in .env');
        console.log('  (a full URL in CHAINSTACK_API_V2/_V3 still takes precedence if set)');
    }
    console.log('');
}

// ============================================================================
// API Response Helpers
// ============================================================================

/**
 * Unwrap TON API responses that may be in wrapped format { ok: true, result: ... }
 * or direct format { balance: ..., state: ... }
 *
 * @param json - The JSON response to unwrap
 * @returns The unwrapped data
 * @throws Error if ok=false
 */
export function unwrapTonApiResponse(json: any): any {
    if (json && typeof json === 'object' && 'ok' in json) {
        if (json.ok !== true) {
            const errorMsg = json.error || json.description || 'Unknown error';
            throw new Error(`TON API returned ok=false: ${errorMsg} (${JSON.stringify(json)})`);
        }
        return json.result ?? json;
    }
    return json;
}

/**
 * Extract bigint from TON stack item (handles both array and object formats).
 *
 * @param item - Stack item from runGetMethod
 * @returns The bigint value
 * @throws Error if format is unknown
 */
export function stackItemToBigInt(item: any): bigint {
    if (Array.isArray(item) && item.length >= 2) {
        return BigInt(item[1]);
    }
    if (item && typeof item === 'object' && typeof item.value === 'string') {
        return BigInt(item.value);
    }
    throw new Error(`Unknown stack item format: ${JSON.stringify(item)}`);
}

// ============================================================================
// API Calls
// ============================================================================

/**
 * Get address state (uninit, active, frozen).
 *
 * @param endpoint - The API endpoint
 * @param address - The address to check
 * @returns The state string
 */
export async function getAddressState(endpoint: string, address: Address): Promise<string> {
    return fetchWithFailover(endpoint, 'read', async (baseV2) => {
        const url = `${baseV2}/getAddressState?address=${encodeURIComponent(address.toString())}`;
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        const text = await res.text();

        let json: any;
        try {
            json = JSON.parse(text);
        } catch {
            throw new Error(`getAddressState non-JSON: HTTP ${res.status} body=${text.slice(0, 300)}`);
        }

        if (!res.ok) {
            throw new Error(`getAddressState failed: HTTP ${res.status} ${JSON.stringify(json)}`);
        }

        const data = unwrapTonApiResponse(json);
        // Handle case where unwrapped result is directly the state string
        if (typeof data === 'string') {
            return data;
        }
        // Handle case where state is in an object
        if (data && typeof data === 'object' && typeof data.state === 'string') {
            return data.state;
        }
        console.error('Unexpected getAddressState payload:', JSON.stringify(json, null, 2));
        throw new Error('getAddressState payload missing or invalid state field');
    });
}

/**
 * Get address balance in nanoTON.
 *
 * @param endpoint - The API endpoint
 * @param address - The address to check
 * @returns The balance as bigint
 */
export async function getAddressBalance(endpoint: string, address: Address): Promise<bigint> {
    return fetchWithFailover(endpoint, 'read', async (baseV2) => {
        const url = `${baseV2}/getAddressBalance?address=${encodeURIComponent(address.toString())}`;
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        const text = await res.text();

        let json: any;
        try {
            json = JSON.parse(text);
        } catch {
            throw new Error(`getAddressBalance non-JSON: HTTP ${res.status} body=${text.slice(0, 300)}`);
        }

        if (!res.ok) {
            throw new Error(`getAddressBalance failed: HTTP ${res.status} ${JSON.stringify(json)}`);
        }

        const data = unwrapTonApiResponse(json);
        // Handle case where unwrapped result is directly the balance string
        if (typeof data === 'string') {
            return BigInt(data);
        }
        // Handle case where balance is a number
        if (typeof data === 'number') {
            return BigInt(data);
        }
        // Handle case where balance is in an object
        if (data && typeof data === 'object') {
            if (data.balance !== undefined) {
                return BigInt(String(data.balance));
            }
        }
        console.error('Unexpected getAddressBalance payload:', JSON.stringify(json, null, 2));
        throw new Error('getAddressBalance payload missing or invalid balance field');
    });
}

/**
 * Get full address information including state and balance.
 *
 * @param endpoint - The API endpoint
 * @param address - The address to check
 * @returns Address information object
 */
export async function getAddressInfo(endpoint: string, address: Address): Promise<AddressInfo> {
    return fetchWithFailover(endpoint, 'read', async (baseV2) => {
        const url = `${baseV2}/getAddressInformation?address=${encodeURIComponent(address.toString())}`;

        const res = await fetch(url, { headers: { accept: 'application/json' } });
        const text = await res.text();

        let json: any;
        try {
            json = JSON.parse(text);
        } catch {
            throw new Error(`getAddressInformation non-JSON: HTTP ${res.status} body=${text.slice(0, 300)}`);
        }

        if (!res.ok) {
            throw new Error(`getAddressInformation failed: HTTP ${res.status} ${JSON.stringify(json)}`);
        }

        const data = unwrapTonApiResponse(json);

        if (data.state === undefined || data.balance === undefined) {
            console.log('Attempting fallback: calling getAddressState and getAddressBalance separately...');

            try {
                const state = await getAddressState(endpoint, address);
                const balance = await getAddressBalance(endpoint, address);
                return {
                    state,
                    balance,
                    lastTransactionId: data.last_transaction_id,
                };
            } catch (fallbackError: any) {
                throw new Error(
                    `getAddressInformation payload missing required fields (state/balance). Fallback also failed: ${fallbackError.message}`
                );
            }
        }

        return {
            state: data.state,
            balance: BigInt(String(data.balance)),
            lastTransactionId: data.last_transaction_id,
        };
    });
}

/**
 * Run a get method on a contract.
 *
 * @param endpoint - The API endpoint
 * @param address - The contract address
 * @param method - The method name
 * @param stack - Optional stack arguments
 * @returns The get method result
 */
export async function runGetMethod(
    endpoint: string,
    address: Address,
    method: string,
    stack: any[] = []
): Promise<GetMethodResult> {
    return fetchWithFailover(endpoint, 'read', async (baseV2) => {
        const url = `${baseV2}/runGetMethod`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
                address: address.toString(),
                method,
                stack,
            }),
        });

        const text = await res.text();
        let json: any;
        try {
            json = JSON.parse(text);
        } catch {
            throw new Error(`runGetMethod non-JSON: HTTP ${res.status} body=${text.slice(0, 300)}`);
        }

        if (!res.ok) {
            throw new Error(`runGetMethod failed: HTTP ${res.status} ${JSON.stringify(json)}`);
        }

        const data = unwrapTonApiResponse(json);
        if (data.exit_code === undefined) {
            console.error('Unexpected runGetMethod payload:', JSON.stringify(json, null, 2));
            throw new Error('runGetMethod payload missing exit_code field');
        }

        return data;
    });
}

/**
 * Send an external message via Chainstack sendQuery endpoint.
 *
 * @param endpoint - The API endpoint
 * @param address - The contract address
 * @param body - The message body cell
 * @param timeoutMs - Request timeout in milliseconds
 */
export async function sendExternalMessage(
    endpoint: string,
    address: Address,
    body: Cell,
    timeoutMs: number = 30000
): Promise<void> {
    // Wrap the signed body in an external-in message and broadcast via /sendBoc.
    //
    // We deliberately do NOT use /sendQuery: toncenter — the only node here that can emulate
    // external-message acceptance (the Chainstack testnet node fails with "cannot fetch config
    // params: configuration parameter 43 is invalid") — does not expose /sendQuery (it 405s).
    // /sendBoc is the portable path, so callers should pass a send-capable endpoint
    // (getSendEndpoint(), i.e. toncenter), NOT the keyed Chainstack read endpoint.
    //
    // External-in message (TL-B): ext_in_msg_info$10 src:addr_none dest:MsgAddressInt
    // import_fee:0, init:nothing (contract already deployed), body:^Cell (stored as a ref).
    const extMessage = beginCell()
        .storeUint(0b10, 2)      // ext_in_msg_info$10
        .storeUint(0, 2)         // src: addr_none$00
        .storeAddress(address)   // dest: the contract
        .storeCoins(0)           // import_fee
        .storeBit(false)         // init: nothing$0
        .storeBit(true)          // body: stored in a reference
        .storeRef(body)
        .endCell();

    await sendBoc(endpoint, extMessage.toBoc(), timeoutMs);
}

/**
 * Send a BOC (bag of cells) to the network.
 *
 * @param endpoint - The API endpoint
 * @param boc - The BOC as Buffer or base64 string
 * @param timeoutMs - Request timeout in milliseconds
 */
export async function sendBoc(
    endpoint: string,
    boc: Buffer | string,
    timeoutMs: number = 30000
): Promise<void> {
    const bocBase64 = typeof boc === 'string' ? boc : boc.toString('base64');

    await fetchWithFailover(endpoint, 'send', async (baseV2) => {
        const url = `${baseV2}/sendBoc`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    boc: bocBase64,
                }),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            const text = await res.text();
            let json: any;
            try {
                json = JSON.parse(text);
            } catch {
                throw new Error(`sendBoc non-JSON: HTTP ${res.status} body=${text.slice(0, 300)}`);
            }

            if (!res.ok) {
                console.error('Full sendBoc response:', JSON.stringify(json, null, 2));
                throw new Error(`sendBoc failed: HTTP ${res.status} ${JSON.stringify(json)}`);
            }

            // Unwrap and validate response
            unwrapTonApiResponse(json);
        } catch (error: any) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error(`sendBoc timeout after ${timeoutMs}ms`);
            }
            throw error;
        }
    });
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Wait for confirmation by polling a check function.
 *
 * @param checkFn - Function that returns true when confirmed
 * @param maxAttempts - Maximum number of polling attempts
 * @param pollDelay - Delay between attempts in milliseconds
 * @throws Error if confirmation times out
 */
export async function waitForConfirmation(
    checkFn: () => Promise<boolean>,
    maxAttempts: number = 30,
    pollDelay: number = 2000
): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
        await sleep(pollDelay);

        try {
            const confirmed = await checkFn();
            if (confirmed) {
                return;
            }
        } catch {
            // Ignore errors during polling
        }

        if (i < maxAttempts - 1) {
            process.stdout.write(`\rPolling... (${i + 1}/${maxAttempts})`);
        }
    }
    console.log(''); // New line after polling
    throw new Error('Confirmation timeout: operation not confirmed on-chain');
}

/**
 * Sleep for specified milliseconds.
 *
 * @param ms - Milliseconds to sleep
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if an address is deployed (active state).
 *
 * @param endpoint - The API endpoint
 * @param address - The address to check
 * @returns true if the contract is deployed and active
 */
export async function isContractDeployed(endpoint: string, address: Address): Promise<boolean> {
    try {
        const state = await getAddressState(endpoint, address);
        return state === 'active';
    } catch {
        return false;
    }
}
