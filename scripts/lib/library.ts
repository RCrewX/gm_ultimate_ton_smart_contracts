// SPDX-License-Identifier: UNLICENSED
/**
 * library.ts — opt-in "library cell" deploy mode helpers.
 *
 * A TON *library reference cell* is an exotic cell: 8-bit tag 0x02 + the 256-bit
 * representation hash of the real code cell. It resolves at TVM run time to a code
 * cell that was published once to the masterchain global library. Storing a child
 * contract's code as a library cell (instead of the full code) cuts per-instance
 * storage rent and per-deploy forward fees — a win that compounds across every
 * mass-replicated copy (jetton wallets, ships, coordinate cells, …).
 *
 * This module is DEPLOY-ONLY tooling. It never touches `.tolk` source: every parent
 * computes child addresses from a `cell` code parameter it holds in storage, and a
 * library cell hashes like any other cell — so wrapping the chosen code cells at the
 * single assembly point (abiCore) re-derives the whole stateInit graph consistently.
 *
 * Scope of THIS file (plan Phases 0–1, safe + self-contained):
 *   - `toLibraryCell`        — wrap a code cell as a library reference cell.
 *   - `buildSandboxLibs`     — build the `blockchain.libs` dict for @ton/sandbox tests.
 *   - selection + guard      — resolve which codes to library, refuse to library a singleton.
 *   - `applyLibraryMode`     — return a CompiledContracts clone with selected codes wrapped.
 *
 * NOT done here (gated on review — plan Phases 2–3):
 *   - masterchain keeper that publishes the real codes to the global library;
 *   - deployment_latest.json library-awareness (publish the library cell as the
 *     code entry + keep full code) and change-detection/verify library branches.
 * Until those land, library mode must NOT be used for a live deploy — a library
 * child can only execute once its code is published + funded on the masterchain.
 */
import { beginCell, Cell, Dictionary } from '@ton/core';
import type { CompiledContracts } from './abiCore';

/**
 * Wrap a compiled code cell as a TON library reference cell (exotic, tag 0x02).
 * The result hashes by its own representation, so addresses derived from it differ
 * from the full-code addresses — which is exactly why library mode is a whole-system
 * genesis choice, never a silent retrofit.
 */
export function toLibraryCell(code: Cell): Cell {
    return beginCell()
        .storeUint(2, 8)
        .storeBuffer(code.hash(), 32)
        .endCell({ exotic: true });
}

/**
 * Build the dictionary cell that @ton/sandbox's `Blockchain.libs` expects:
 * a direct Hashmap 256 -> Cell mapping each code's representation hash to the real
 * code cell. A sandbox blockchain cannot run a library-mode contract's get-methods
 * or receive logic unless its library context contains the resolved code.
 */
export function buildSandboxLibs(codes: Cell[]): Cell {
    const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    for (const code of codes) {
        dict.set(BigInt('0x' + code.hash().toString('hex')), code);
    }
    return beginCell().storeDictDirect(dict).endCell();
}

// ============================================================================
// Selectivity — which codes may be librarized (mass-replicated children) and
// which must NEVER be (singletons: one copy, so a library only adds masterchain
// rent for no rent saving). Keys are CompiledContracts fields.
// ============================================================================

/** Friendly selector name -> the CompiledContracts code field it controls. */
export const LIBRARY_ELIGIBLE: Readonly<Record<string, keyof CompiledContracts>> = {
    jettonWallet: 'jettonWalletCode',
    ship: 'shipCode',
    coordinateCell: 'coordinateCellCode',
    ssmSlot: 'ssmSlotCode',
    nftItem: 'nftItemCode',
    sbtItem: 'sbtItemCode',
    sbtnItem: 'sbtnItemCode',
    nftPrinterItem: 'nftPrinterItemCode',
    passportPrinterItem: 'passportPrinterItemCode',
    ubpsUnit: 'ubpsUnitCode',
    ubpsQuestion: 'ubpsQuestionCode',
    ubpsAnswer: 'ubpsAnswerCode',
    ubpsBeliefSet: 'ubpsBeliefSetCode',
};

/**
 * Singleton codes — exactly one instance per deployment. Hard-blocked from library
 * mode. Named for clear error messages; any selector not in LIBRARY_ELIGIBLE is
 * rejected, so this list is the human-readable "why" for the common mistakes.
 */
export const LIBRARY_SINGLETONS: ReadonlySet<string> = new Set([
    'gameManager',
    'retranslator',
    'game',
    'jettonMinter',
    'soullessSlotMachine',
    'ubps',
    'nftPrinter',
    'passportPrinter',
    'sbtCollection',
    'sbtnCollection',
    'subcontract',
]);

/** Default selection when library mode is on but no explicit LIBRARY_CODES given. */
export const DEFAULT_LIBRARY_CODES: readonly string[] = ['jettonWallet', 'ship', 'coordinateCell'];

export interface LibrarySelection {
    /** Whether library mode is active at all. When false, applyLibraryMode is a no-op. */
    enabled: boolean;
    /** Friendly selector names (keys of LIBRARY_ELIGIBLE) to librarize. */
    codes: readonly string[];
}

/**
 * Resolve library selection from environment:
 *   DEPLOY_LIBRARY_MODE=1   -> enable (any of 1/true/on/yes, case-insensitive)
 *   LIBRARY_CODES=a,b,c      -> explicit selector list (else DEFAULT_LIBRARY_CODES)
 * Validates the selection (throws on a singleton or unknown name) so a misconfigured
 * deploy fails fast rather than silently librarizing the wrong thing.
 */
export function resolveLibrarySelection(env: NodeJS.ProcessEnv = process.env): LibrarySelection {
    const raw = (env.DEPLOY_LIBRARY_MODE ?? '').trim().toLowerCase();
    const enabled = raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
    if (!enabled) {
        return { enabled: false, codes: [] };
    }
    const listed = (env.LIBRARY_CODES ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    const codes = listed.length > 0 ? listed : [...DEFAULT_LIBRARY_CODES];
    assertSelectable(codes);
    return { enabled: true, codes };
}

/**
 * Throw unless every selector names a library-eligible (mass-replicated) code.
 * Singletons and unknown names are rejected with an explanatory message — this is
 * the guardrail that keeps a master/singleton code from ever becoming a library.
 */
export function assertSelectable(codes: readonly string[]): void {
    for (const name of codes) {
        if (name in LIBRARY_ELIGIBLE) continue;
        if (LIBRARY_SINGLETONS.has(name)) {
            throw new Error(
                `library mode: "${name}" is a singleton contract and must never be a library cell ` +
                    `(it would only add masterchain rent for a single copy). Eligible: ${Object.keys(LIBRARY_ELIGIBLE).join(', ')}.`,
            );
        }
        throw new Error(
            `library mode: unknown code selector "${name}". Eligible: ${Object.keys(LIBRARY_ELIGIBLE).join(', ')}.`,
        );
    }
}

export interface AppliedLibraryMode {
    /** A CompiledContracts clone with selected code fields replaced by library cells. */
    effective: CompiledContracts;
    /** Per-selector record: friendly name, field, full-code hash, library-cell hash. */
    wrapped: Array<{ name: string; field: keyof CompiledContracts; codeHash: string; libraryHash: string }>;
}

/**
 * Return a shallow clone of `compiled` in which each selected, eligible code cell is
 * replaced by its library cell. The original (full) code cells are preserved on the
 * returned `wrapped[]` record (the publisher + json need them). When the selection is
 * disabled the clone is byte-identical to the input (same Cell references) — so the
 * default deploy path stays unchanged.
 *
 * Wrapping happens ONCE here, at the single assembly point. Codes embedded downstream
 * (Ship embeds coordinateCellCode; CoordinateCell embeds shipCode) read the same
 * wrapped cells, so the small reference propagates consistently with no double-wrap.
 */
export function applyLibraryMode(compiled: CompiledContracts, selection: LibrarySelection): AppliedLibraryMode {
    const effective: CompiledContracts = { ...compiled };
    const wrapped: AppliedLibraryMode['wrapped'] = [];
    if (!selection.enabled) {
        return { effective, wrapped };
    }
    assertSelectable(selection.codes);
    for (const name of selection.codes) {
        const field = LIBRARY_ELIGIBLE[name];
        const fullCode = compiled[field];
        const libCell = toLibraryCell(fullCode);
        effective[field] = libCell;
        wrapped.push({
            name,
            field,
            codeHash: fullCode.hash().toString('hex'),
            libraryHash: libCell.hash().toString('hex'),
        });
    }
    return { effective, wrapped };
}
