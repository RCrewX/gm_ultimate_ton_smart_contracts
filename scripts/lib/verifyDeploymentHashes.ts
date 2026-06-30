// SPDX-License-Identifier: UNLICENSED
/**
 * verifyDeploymentHashes — guard that the checked-in deployment artifact matches the source.
 *
 * Asserts that EVERY `contractCodes.*.hash` recorded in
 * `deployment_info/deployment_latest.json` equals the hash of the freshly compiled
 * contract (via the canonical `compileAllContracts` + `buildFullContractCodes` — the same
 * single source of truth the deploy/ABI producer uses). Both sides use the SAME hash scheme
 * (`sha256(cell.toBoc())`, via `getContractCodeData`); do NOT compare against the
 * `build/*.compiled.json` "hash" field — that is the TVM *cell hash* (`cell.hash()`), a
 * DIFFERENT value, and comparing the two schemes always falsely mismatches.
 *
 * SCOPE / LIMITATION (read this): this compares the ARTIFACT to the SOURCE. It does NOT, and
 * cannot without RPC, compare the code actually live ON-CHAIN. So it catches "someone edited a
 * contract but forgot to regenerate deployment_latest.json", but it will NOT catch an on-chain
 * skew where the artifact already reflects new source yet the deployed contracts are stale
 * (the actual ERR_INVALID_SHIP_SENDER_FOR_MOVE / move-919 class). A true on-chain guard must
 * fetch the live code via RPC and compare it to source.
 *
 * Exits NON-ZERO on any discrepancy so this can be a CI gate / post-regenerate assertion.
 *
 * Run:  pnpm verify:hashes   (alias for `ts-node scripts/lib/verifyDeploymentHashes.ts`)
 *
 * NOTE on placement: this is intentionally NOT wired as a *blocking pre-step inside*
 * `deploySystem.ts`. Before a corrective redeploy the artifact is, by definition, stale, so a
 * blocking pre-deploy check would refuse the very deploy that fixes the skew. The right homes
 * are: (a) CI on the repo (the checked-in artifact must match source), and/or (b) a post-deploy
 * assertion after the artifact has been regenerated. Both are satisfied by running this script.
 */
import { compileAllContracts, buildFullContractCodes } from './abiCore';
import { readDeploymentData } from '../../lib/buildOutput';

/** Recursively flatten a contractCodes tree into { dotted.path: hash }. */
function flattenHashes(obj: any, prefix = ''): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of Object.keys(obj ?? {})) {
        const value = obj[key];
        if (value && typeof value === 'object') {
            if (typeof value.hash === 'string') {
                out[prefix + key] = value.hash;
            } else {
                Object.assign(out, flattenHashes(value, prefix + key + '.'));
            }
        }
    }
    return out;
}

interface FlatEntry { hash: string; isLibrary?: boolean; fullCodeHash?: string }

/**
 * Like flattenHashes, but keep each leaf's library metadata so a library-mode artifact
 * can be checked against source correctly (its primary `hash` is the LIBRARY-CELL hash,
 * not the full-code hash — so comparing it to the source full-code hash would falsely
 * mismatch; we compare the leaf's `fullCode` to source instead).
 */
function flattenEntries(obj: any, prefix = ''): Record<string, FlatEntry> {
    const out: Record<string, FlatEntry> = {};
    for (const key of Object.keys(obj ?? {})) {
        const value = obj[key];
        if (value && typeof value === 'object') {
            if (typeof value.hash === 'string') {
                out[prefix + key] = {
                    hash: value.hash,
                    isLibrary: value.isLibrary === true,
                    fullCodeHash: value.fullCode?.hash,
                };
            } else {
                Object.assign(out, flattenEntries(value, prefix + key + '.'));
            }
        }
    }
    return out;
}

export interface HashVerificationResult {
    ok: boolean;
    mismatches: string[]; // "path: artifact <hashA> != source <hashB>"
    missing: string[];    // present in freshly compiled source, absent from the artifact
    extra: string[];      // present in the artifact, not produced by the source
}

/**
 * Compile the contracts fresh and compare every code hash to the checked-in
 * deployment_latest.json. Pure check — reads source + the artifact, mutates nothing.
 */
export async function verifyDeploymentHashes(): Promise<HashVerificationResult> {
    const compiled = await compileAllContracts();
    const expected = flattenHashes(buildFullContractCodes(compiled));

    const data = readDeploymentData();
    const actual = flattenEntries(data.contractCodes ?? {});

    const mismatches: string[] = [];
    const missing: string[] = [];
    for (const [key, expHash] of Object.entries(expected)) {
        const a = actual[key];
        if (a === undefined) {
            missing.push(key);
        } else if (a.isLibrary) {
            // Library-mode entry: `a.hash` is the library-cell hash. The real code lives
            // in `fullCode` — that is what must match source. (TODO: also rebuild the
            // library cell from source and compare its boc hash to `a.hash` for a full
            // round-trip check — cheap to add when the retro path needs it.)
            if (!a.fullCodeHash) {
                mismatches.push(`${key}: isLibrary but no fullCode hash recorded`);
            } else if (a.fullCodeHash !== expHash) {
                mismatches.push(`${key}: library fullCode ${a.fullCodeHash.slice(0, 16)}… != source ${expHash.slice(0, 16)}…`);
            }
        } else if (a.hash !== expHash) {
            mismatches.push(`${key}: artifact ${a.hash.slice(0, 16)}… != source ${expHash.slice(0, 16)}…`);
        }
    }
    const extra = Object.keys(actual).filter((k) => !(k in expected));

    const ok = mismatches.length === 0 && missing.length === 0 && extra.length === 0;
    return { ok, mismatches, missing, extra };
}

async function main(): Promise<void> {
    const { ok, mismatches, missing, extra } = await verifyDeploymentHashes();
    if (ok) {
        console.log('✅ deployment_latest.json contractCodes match freshly compiled source — no skew.');
        process.exit(0);
    }
    console.error('❌ Deployment hash skew detected — deployed/recorded code != current source:');
    for (const m of mismatches) console.error(`   MISMATCH  ${m}`);
    for (const k of missing) console.error(`   MISSING   ${k} (in source, absent from artifact)`);
    for (const k of extra) console.error(`   EXTRA     ${k} (in artifact, not produced by source)`);
    console.error('\nRedeploy from current source (e.g. pnpm deploy:testnet) so the artifact is regenerated,');
    console.error('then re-run `pnpm verify:hashes`. Do NOT hand-edit deployment_latest.json.');
    process.exit(1);
}

// Run only when invoked directly (so it can also be imported as a CI/post-deploy assertion).
if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
