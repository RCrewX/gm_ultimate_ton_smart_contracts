// SPDX-License-Identifier: UNLICENSED
/**
 * Resilience layer ON TOP OF ton-provider-system (the package is NOT modified).
 *
 * ton-provider-system already does per-request timeouts + rate-limit backoff +
 * provider failover internally. When its `withRateLimit(fn)` STILL throws, that means
 * the error escaped all of that — every provider in the pool failed the action. For an
 * unattended long run (e.g. seeding 100 users) we don't want that single escaped error
 * to kill the whole script ~⅓ of the way through. So this wrapper catches it, fully
 * tears the provider manager down (`destroy()` + `resetInstance()`), waits one minute,
 * brings up a FRESH manager + client, and retries the action.
 *
 * Because every retried action re-reads on-chain state before sending (see seedSteps),
 * a restart-and-retry is idempotent — it never double-sends.
 */
import { TonClient } from '@ton/ton';
import { ProviderManager, getTonClientWithRateLimit, type Network as ProviderNetwork } from 'ton-provider-system';
import { SeedNetwork } from './types';

/** Wait this long after closing a dead provider before bringing a fresh one up. */
export const PROVIDER_RESTART_WAIT_MS = 60_000;
/** Per-action restart budget (each action gets its own); 0 = give up immediately. */
export const MAX_PROVIDER_RESTARTS = 12;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Pure retry-with-recovery control flow (no network) — the heart of `attempt`, split
 * out so it can be unit-tested. Runs `fn`; on throw, calls `recover(err, i)` and retries,
 * up to `maxRestarts` recoveries before giving up and rethrowing a wrapped error.
 */
export async function runWithRestarts<T>(
    label: string,
    fn: () => Promise<T>,
    recover: (err: unknown, attempt: number) => Promise<void>,
    maxRestarts: number,
): Promise<T> {
    for (let i = 0; ; i++) {
        try {
            return await fn();
        } catch (e: any) {
            if (i >= maxRestarts) {
                throw new Error(`${label}: still failing after ${i} provider restart(s): ${e?.message ?? e}`);
            }
            await recover(e, i);
        }
    }
}

/** A live client + the package's rate-limited runner. Rebuilt on every restart. */
export interface LiveRpc {
    client: TonClient;
    withRateLimit: <T>(fn: () => Promise<T>, maxRetries?: number) => Promise<T>;
}

export class ResilientProvider {
    readonly network: SeedNetwork;
    private pm: ProviderManager;
    live: LiveRpc;
    private readonly customEndpoint?: string;
    /** Total restarts performed across the whole run (for logging/reporting). */
    restarts = 0;

    private constructor(network: SeedNetwork, pm: ProviderManager, live: LiveRpc, customEndpoint?: string) {
        this.network = network;
        this.pm = pm;
        this.live = live;
        this.customEndpoint = customEndpoint;
    }

    /** Bring up the first provider + client. Returns null if even the initial init fails. */
    static async start(network: SeedNetwork): Promise<ResilientProvider | null> {
        try {
            const custom = (process.env.TON_RPC_ENDPOINT || '').trim() || undefined;
            const { pm, live } = await ResilientProvider.bringUp(network, custom);
            return new ResilientProvider(network, pm, live, custom);
        } catch (e: any) {
            console.warn(`! RPC init failed (${e?.message ?? e}); planning will assume an empty chain.`);
            return null;
        }
    }

    private static async bringUp(network: SeedNetwork, custom?: string): Promise<{ pm: ProviderManager; live: LiveRpc }> {
        const pm = ProviderManager.getInstance();
        await pm.init(network as ProviderNetwork);
        if (custom) pm.setCustomEndpoint(custom);
        const live = await getTonClientWithRateLimit(pm);
        return { pm, live };
    }

    /**
     * Close the current provider, wait one minute, and bring up a fresh one. Retries
     * the bring-up itself a few times (the network may still be flapping) before giving up.
     */
    async restart(reason: string): Promise<void> {
        this.restarts++;
        console.warn(`  ↻ provider restart #${this.restarts} (${reason}). Closing + waiting ${PROVIDER_RESTART_WAIT_MS / 1000}s…`);
        // Best-effort: let the package release its health-check timers + drop the singleton.
        try { this.pm.destroy(); } catch { /* ignore */ }
        try { ProviderManager.resetInstance(); } catch { /* ignore */ }
        await sleep(PROVIDER_RESTART_WAIT_MS);
        for (let attempt = 1; ; attempt++) {
            try {
                const { pm, live } = await ResilientProvider.bringUp(this.network, this.customEndpoint);
                this.pm = pm;
                this.live = live;
                console.warn(`  ✓ provider restarted (#${this.restarts}); resuming.`);
                return;
            } catch (e: any) {
                if (attempt >= 5) throw new Error(`provider could not be re-initialized after restart: ${e?.message ?? e}`);
                console.warn(`  … re-init attempt ${attempt} failed (${e?.message ?? e}); waiting ${PROVIDER_RESTART_WAIT_MS / 1000}s and retrying…`);
                await sleep(PROVIDER_RESTART_WAIT_MS);
            }
        }
    }

    /**
     * RESILIENT runner. Run `fn` against the live client. If it throws (i.e. the error
     * already bypassed ton-provider-system's own retry/failover), close + wait 1 min +
     * restart the provider, then retry — up to `maxRestarts` times. `fn` MUST re-read the
     * state it needs from the passed `LiveRpc` (never close over a stale client), and for
     * sends it must re-check the skip condition so a retry can't double-send.
     */
    async attempt<T>(label: string, fn: (rpc: LiveRpc) => Promise<T>, maxRestarts = MAX_PROVIDER_RESTARTS): Promise<T> {
        return runWithRestarts(
            label,
            () => fn(this.live),
            async (e: any) => {
                console.warn(`  ! ${label} failed past ton-provider-system failover: ${e?.message ?? e}`);
                // Inform the package too (best-effort), then hard-restart on top of it.
                try { this.pm.reportError(e instanceof Error ? e : new Error(String(e))); } catch { /* ignore */ }
                await this.restart(`error in "${label}"`);
            },
            maxRestarts,
        );
    }

    /** BEST-EFFORT single read (no restart). Returns `fallback` on any error. For dry-run / read-only planning. */
    async read<T>(label: string, fn: (rpc: LiveRpc) => Promise<T>, fallback: T): Promise<T> {
        try {
            return await fn(this.live);
        } catch (e: any) {
            console.warn(`  ! ${label} read failed (using fallback): ${e?.message ?? e}`);
            return fallback;
        }
    }

    /** Tear everything down at the end of a run (stops health-check timers). */
    dispose(): void {
        try { this.pm.destroy(); } catch { /* ignore */ }
    }
}
