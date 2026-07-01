// SPDX-License-Identifier: UNLICENSED
/**
 * rpcEndpoint.ts — pure, testable helpers for the deploy RPC-endpoint handling.
 *
 * Context (verified against ton-provider-system@0.3.0): a pinned endpoint set via
 * `ProviderManager.setCustomEndpoint(url)` IS honored — `getBestProvider` short-circuits on
 * the custom endpoint, so `getEndpoint()`/the built TonClient use the pinned URL (query
 * string, incl. `?api_key=`, preserved). What the URL cannot carry is a HEADER-based key
 * (Tatum's `x-api-key`); for that, pass the key separately (`--rpc-api-key`) so it is
 * attached to the TonClient as `apiKey`.
 *
 * The remaining real RPC footgun is the NON-pinned path: a pool provider whose key env is
 * unset resolves to a literal `{placeholder}` URL (e.g. chainstack `.../{key}/...`) and
 * 404s. These helpers detect that so the deploy can warn with an actionable fix.
 */

export type CustomEndpointSource = '--rpc-endpoint' | 'DEPLOY_RPC_ENDPOINT' | 'TON_RPC_ENDPOINT';

export interface ResolvedCustomEndpoint {
    /** The pinned endpoint URL (auth in the query string, e.g. toncenter `?api_key=`). */
    endpoint: string;
    /** Optional header API key (for Tatum-style `x-api-key`); attached to the TonClient. */
    apiKey?: string;
    /** Which input supplied the endpoint (for logging). */
    source: CustomEndpointSource;
}

/**
 * Resolve a pinned endpoint with precedence: `--rpc-endpoint` > `DEPLOY_RPC_ENDPOINT` >
 * `TON_RPC_ENDPOINT`. Returns null when none is set (pool mode). The header api key comes
 * from `--rpc-api-key` > `DEPLOY_RPC_API_KEY`.
 */
export function resolveCustomEndpoint(
    cliEndpoint: string | undefined,
    cliApiKey: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
): ResolvedCustomEndpoint | null {
    const fromCli = (cliEndpoint ?? '').trim();
    const fromDeploy = (env.DEPLOY_RPC_ENDPOINT ?? '').trim();
    const fromLegacy = (env.TON_RPC_ENDPOINT ?? '').trim();
    const endpoint = fromCli || fromDeploy || fromLegacy;
    if (!endpoint) return null;
    const source: CustomEndpointSource = fromCli
        ? '--rpc-endpoint'
        : fromDeploy
            ? 'DEPLOY_RPC_ENDPOINT'
            : 'TON_RPC_ENDPOINT';
    const apiKey = ((cliApiKey ?? '').trim() || (env.DEPLOY_RPC_API_KEY ?? '').trim()) || undefined;
    return { endpoint, apiKey, source };
}

/**
 * True if a resolved endpoint URL still carries an unresolved `{placeholder}` — the tell of
 * an unset provider key (e.g. chainstack `https://….core.chainstack.com/{key}/api/v2/...`).
 * Such an endpoint 404s; it must never be treated as the fatal deploy error over a real chain
 * response.
 */
export function endpointHasUnresolvedPlaceholder(endpoint: string): boolean {
    return /\{[^}]+\}/.test(endpoint);
}

/**
 * A concise, user-actionable warning for an unresolved-placeholder POOL endpoint, or null
 * when the endpoint is fine. `network` tailors the key-env hint (e.g. CHAINSTACK_KEY_TESTNET).
 * The placeholder carries no secret, so the URL is safe to echo.
 */
export function poolEndpointWarning(endpoint: string, network: string): string | null {
    if (!endpointHasUnresolvedPlaceholder(endpoint)) return null;
    const m = endpoint.match(/\{([^}]+)\}/);
    const placeholder = m ? m[1] : 'key';
    const net = network.toUpperCase();
    return (
        `RPC endpoint has an unresolved "{${placeholder}}" placeholder: ${endpoint}\n` +
        `   That provider will 404 on every request. Fix ONE of:\n` +
        `     • set the provider key env so it resolves (e.g. CHAINSTACK_KEY_${net}=<key>), or\n` +
        `     • pin a keyed endpoint: --rpc-endpoint "https://${network}.toncenter.com/api/v2/jsonRPC?api_key=<KEY>"\n` +
        `       (Tatum carries its key in a header, so pin its URL AND pass --rpc-api-key <KEY>).`
    );
}
