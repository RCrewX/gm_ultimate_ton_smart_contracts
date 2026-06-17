// SPDX-License-Identifier: UNLICENSED
/**
 * changeClassifier.ts — the PURE diff + decision logic for retro deploys.
 *
 * Deliberately free of @ton/blueprint and wrapper imports so it is light and
 * unit-testable with synthetic hash maps (the RPC fetch + compile glue lives in
 * scripts/lib/changeDetection.ts, which feeds these functions). Comparing compiled
 * vs on-chain code hashes happens upstream; here we only route the result.
 *
 * HASH NUANCE (decided upstream, restated here): both `compiledHash` and
 * `onChainHash` are the TVM cell hash (`cell.hash()`), NOT the artifact's
 * `sha256(toBoc)`. This module never computes hashes — it only compares the
 * strings it is handed, so it is scheme-agnostic, but callers MUST hand it the
 * same scheme on both sides.
 */

// Every contract retro tracks falls into exactly one role. GM is the stable root
// (a change is a full migration → refuse). R* is the swappable brain (hot-swap).
// Everything else is a leaf (redeploy + re-register via a setter, or none).
export type ContractRole = 'gm' | 'rstar' | 'leaf';

// Leaf kinds drive the re-registration setter map (see retroUpdate Step 7) and the
// per-contract ORPHAN WARNING text (Step 6).
export type LeafKind =
    | 'ssm'
    | 'ton_race_game'
    | 'ubps'
    | 'nftPrinter'
    | 'sbtPrinter'
    | 'jettonMinter'
    | 'subcontract'
    | 'ownerShip';

/** One tracked contract, with its compiled hash and (maybe) its on-chain hash. */
export interface TrackedDescriptor {
    /** Dotted key into deployment_latest.json (e.g. "jettonMinter", "games.ton_race_game.game"). */
    key: string;
    role: ContractRole;
    /** Required for role 'leaf'; ignored otherwise. */
    kind?: LeafKind;
    /** Recorded bounceable address (null when the json has none → notDeployed). */
    oldAddr: string | null;
    /** TVM cell hash of the freshly compiled code (hex). */
    compiledHash: string;
    /**
     * TVM cell hash of the live on-chain code (hex), or null when the contract is
     * not deployed / not active (no recorded address, or RPC says inactive).
     */
    onChainHash: string | null;
}

export type LeafStatus = 'changed' | 'notDeployed';

export interface LeafChange {
    key: string;
    kind: LeafKind;
    oldAddr: string | null;
    status: LeafStatus;
}

export interface ChangeReport {
    /** GM code differs from on-chain. */
    gmChanged: boolean;
    /** GM has no live code (no address / inactive). */
    gmNotDeployed: boolean;
    /** R* code differs from on-chain. */
    rStarChanged: boolean;
    /** R* has no live code. */
    rStarNotDeployed: boolean;
    /** Leaves that need a redeploy (+ re-register): code changed OR not yet deployed. */
    leafChanges: LeafChange[];
    /** Keys whose code matches on-chain — nothing to do. */
    unchanged: string[];
}

/**
 * Pure classifier: route each tracked contract by (role, hash comparison) into a
 * ChangeReport. A descriptor with onChainHash === null is "notDeployed" (no live
 * code); otherwise it is "changed" when the hashes differ, else "unchanged".
 */
export function classifyChanges(descriptors: TrackedDescriptor[]): ChangeReport {
    const report: ChangeReport = {
        gmChanged: false,
        gmNotDeployed: false,
        rStarChanged: false,
        rStarNotDeployed: false,
        leafChanges: [],
        unchanged: [],
    };

    for (const d of descriptors) {
        const notDeployed = d.onChainHash === null;
        const changed = !notDeployed && d.onChainHash !== d.compiledHash;

        if (d.role === 'gm') {
            if (notDeployed) report.gmNotDeployed = true;
            else if (changed) report.gmChanged = true;
            else report.unchanged.push(d.key);
            continue;
        }
        if (d.role === 'rstar') {
            if (notDeployed) report.rStarNotDeployed = true;
            else if (changed) report.rStarChanged = true;
            else report.unchanged.push(d.key);
            continue;
        }
        // leaf
        if (!d.kind) throw new Error(`leaf descriptor ${d.key} is missing its kind`);
        if (notDeployed) {
            report.leafChanges.push({ key: d.key, kind: d.kind, oldAddr: d.oldAddr, status: 'notDeployed' });
        } else if (changed) {
            report.leafChanges.push({ key: d.key, kind: d.kind, oldAddr: d.oldAddr, status: 'changed' });
        } else {
            report.unchanged.push(d.key);
        }
    }
    return report;
}

export interface RetroPlan {
    /** True → retro must REFUSE (GM changed); see `refuseReason`. */
    refuse: boolean;
    refuseReason?: string;
    /** True → hot-swap R* (Step 4/5.3) before re-registering changed leaves. */
    swap: boolean;
    /** Leaves to redeploy (+ re-register on R*). */
    leafRedeploys: LeafChange[];
    /** Convenience: nothing to do at all. */
    upToDate: boolean;
}

/**
 * Pure decision tree (mirrors retroUpdate §6):
 *  1. GM changed/absent        → REFUSE (require --mode hard).
 *  2. R* ABSENT (not deployed) → REFUSE: a hot-swap migrates counters FROM the live
 *                                R*; with no R* to read, that is a fresh deploy → hard.
 *  3. R* changed (still live)  → swap, then re-register every changed leaf.
 *  4. only leaves changed      → redeploy + setter-update the existing R*.
 *  5. nothing                  → up to date.
 */
export function planRetroActions(report: ChangeReport): RetroPlan {
    if (report.gmChanged || report.gmNotDeployed) {
        const why = report.gmNotDeployed
            ? 'GameManager has no live code on this network'
            : 'GameManager code changed';
        return {
            refuse: true,
            refuseReason:
                `${why} — GM is the stable root and sole on-chain authority; ` +
                `changing it is a full system migration, not an incremental update. ` +
                `Re-run with \`--mode hard\`.`,
            swap: false,
            leafRedeploys: [],
            upToDate: false,
        };
    }
    if (report.rStarNotDeployed) {
        return {
            refuse: true,
            refuseReason:
                'Retranslator (R*) has no live code on this network — a hot-swap migrates the mint ' +
                'counters FROM the live R*, so there is nothing to swap from. This is a fresh/partial ' +
                'system; re-run with `--mode hard`.',
            swap: false,
            leafRedeploys: [],
            upToDate: false,
        };
    }

    const swap = report.rStarChanged;
    const leafRedeploys = report.leafChanges;
    const upToDate = !swap && leafRedeploys.length === 0;
    return { refuse: false, swap, leafRedeploys, upToDate };
}

/**
 * Per-contract ORPHAN WARNING text (Step 6). Returns null for stateless/ephemeral
 * leaves (no scary warning needed). Redeploying a stateful leaf moves it to a new
 * deterministic address, stranding every child whose address derived from the old one.
 */
export function orphanWarning(kind: LeafKind): string | null {
    switch (kind) {
        case 'ton_race_game':
            return 'ALL ships + coordinate cells (their addresses derive from the Game address) are ORPHANED.';
        case 'jettonMinter':
            return 'ALL RUDA jetton wallets + their balances (derived from the minter) are ORPHANED.';
        case 'nftPrinter':
            return 'ALL minted NFT items (derived from the NFT printer/collection) are ORPHANED.';
        case 'sbtPrinter':
            return 'ALL minted SBT items (derived from the SBT printer/collection) are ORPHANED.';
        case 'ubps':
            return 'ALL UBPS Units / Questions / Answers / BeliefSets (derived from the master) are ORPHANED.';
        case 'ownerShip':
            return "The owner's existing Ship + its coordinate cells (derived from the Game) are ORPHANED.";
        case 'subcontract':
            // Ship station: a relay subcontract; redeploy is address-stable per id, but a
            // CODE change still moves its address → any funds/state at the old one strand.
            return 'The ship-station subcontract redeploys to a NEW address (code changed) — any TON/state at the old one is stranded.';
        case 'ssm':
            // Slots are ephemeral (deployed + destroyed per roll) → nothing persistent to lose.
            return null;
        default:
            return null;
    }
}
