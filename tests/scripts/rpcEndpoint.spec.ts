// SPDX-License-Identifier: UNLICENSED
/**
 * Unit coverage for the deploy RPC-endpoint handling (scripts/lib/rpcEndpoint.ts).
 *
 * PREMISE NOTE: a prior plan assumed `--rpc-endpoint` was a no-op that never reached the
 * client. It is NOT — `ProviderManager.setCustomEndpoint(url)` IS honored (getBestProvider
 * short-circuits on it), so `getEndpoint()` returns the pinned URL verbatim (query string,
 * incl. `?api_key=`, preserved) and every TonClient built from it uses that URL. This was
 * proven with a standalone Node probe (`node` require of the package: `getEndpoint()` ===
 * the pinned URL, activeProvider.type === 'custom'). It can NOT be asserted inside jest here
 * because the package's config loader uses a dynamic `import()` that ts-jest (CommonJS)
 * rejects without --experimental-vm-modules — a harness limitation, not a behavior change.
 */
import {
    resolveCustomEndpoint,
    endpointHasUnresolvedPlaceholder,
    poolEndpointWarning,
} from '../../scripts/lib/rpcEndpoint';

describe('resolveCustomEndpoint — precedence + api key', () => {
    it('returns null when nothing is set (pool mode)', () => {
        expect(resolveCustomEndpoint(undefined, undefined, {})).toBeNull();
        expect(resolveCustomEndpoint('   ', undefined, {})).toBeNull();
    });

    it('--rpc-endpoint beats both env vars', () => {
        const r = resolveCustomEndpoint('https://cli/x', undefined, {
            DEPLOY_RPC_ENDPOINT: 'https://deploy/x',
            TON_RPC_ENDPOINT: 'https://legacy/x',
        });
        expect(r).toEqual({ endpoint: 'https://cli/x', apiKey: undefined, source: '--rpc-endpoint' });
    });

    it('DEPLOY_RPC_ENDPOINT beats TON_RPC_ENDPOINT', () => {
        const r = resolveCustomEndpoint(undefined, undefined, {
            DEPLOY_RPC_ENDPOINT: 'https://deploy/x',
            TON_RPC_ENDPOINT: 'https://legacy/x',
        });
        expect(r?.endpoint).toBe('https://deploy/x');
        expect(r?.source).toBe('DEPLOY_RPC_ENDPOINT');
    });

    it('TON_RPC_ENDPOINT is the lowest precedence', () => {
        const r = resolveCustomEndpoint(undefined, undefined, { TON_RPC_ENDPOINT: 'https://legacy/x' });
        expect(r?.source).toBe('TON_RPC_ENDPOINT');
    });

    it('api key: --rpc-api-key beats DEPLOY_RPC_API_KEY; blank ⇒ undefined', () => {
        expect(resolveCustomEndpoint('https://x/y', 'CLIKEY', { DEPLOY_RPC_API_KEY: 'ENVKEY' })?.apiKey).toBe('CLIKEY');
        expect(resolveCustomEndpoint('https://x/y', undefined, { DEPLOY_RPC_API_KEY: 'ENVKEY' })?.apiKey).toBe('ENVKEY');
        expect(resolveCustomEndpoint('https://x/y', '  ', {})?.apiKey).toBeUndefined();
    });
});

describe('unresolved-placeholder detection (the non-pinned pool footgun)', () => {
    const chainstackUnresolved = 'https://ton-testnet.core.chainstack.com/{key}/api/v2/jsonRPC';

    it('detects a {placeholder} and passes a clean URL', () => {
        expect(endpointHasUnresolvedPlaceholder(chainstackUnresolved)).toBe(true);
        expect(endpointHasUnresolvedPlaceholder('https://testnet.toncenter.com/api/v2/jsonRPC?api_key=abc')).toBe(false);
    });

    it('poolEndpointWarning is actionable (names the key env + pin options) for a placeholder URL', () => {
        const w = poolEndpointWarning(chainstackUnresolved, 'testnet');
        expect(w).toBeTruthy();
        expect(w).toContain('CHAINSTACK_KEY_TESTNET');
        expect(w).toContain('--rpc-endpoint');
        expect(w).toContain('--rpc-api-key');
    });

    it('poolEndpointWarning is null for a clean URL', () => {
        expect(poolEndpointWarning('https://testnet.toncenter.com/api/v2/jsonRPC?api_key=abc', 'testnet')).toBeNull();
    });
});
