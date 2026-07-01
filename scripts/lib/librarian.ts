// SPDX-License-Identifier: UNLICENSED
/**
 * librarian.ts — publish the real child codes to the TON masterchain global library via
 * one `Librarian` account PER CODE (library-cell deploy mode, Phase 2).
 *
 * A library reference cell (see `library.ts` `toLibraryCell`) only resolves at TVM run
 * time if the real code has been published to the masterchain global library. Publishing
 * is a RUNTIME action: a running masterchain (workchain -1) contract calls SETLIBCODE(code,
 * 2). It is NOT done via a StateInit `library` field — the TVM executor rejects a fresh
 * account whose StateInit carries `library` (compute skip `cskip_bad_state`), which is why
 * the earlier WalletV4-keeper-with-StateInit.libraries approach was retired.
 *
 * Each `Librarian` instance publishes ONE code (deterministic per-code wc-1 address) and is
 * admin-controlled: the deployer can withdraw the surplus above a rent floor, re-publish
 * after a rent lapse, or remove the library. See contracts/librarian/librarian.tolk and
 * wrappers/librarian/Librarian.ts.
 */
import { Address, Cell, Dictionary, DictionaryValue, contractAddress, toNano } from '@ton/core';
import { librarianConfigToCell, LIBRARIAN_WORKCHAIN } from '../../wrappers/librarian/Librarian';

export { LIBRARIAN_WORKCHAIN };

/**
 * Generous testnet default PER librarian: masterchain account storage + the published
 * library-storage reserve + deploy gas. Masterchain storage is ~1000x basechain; sized
 * generously for testnet and calibrated from the live storage phase + acceptance run. Keep
 * in sync with LIBRARIAN_RENT_FLOOR in contracts/librarian/librarian.tolk (funding must
 * exceed the floor so a withdraw can reclaim a real surplus).
 */
export const LIBRARIAN_FUNDING = toNano('3');

export interface SimpleLibrary {
    public: boolean;
    root: Cell;
}

/**
 * TL-B `SimpleLib$_ public:Bool root:^Cell`. Retained ONLY to build the `blockchain.libs`
 * seed for @ton/sandbox tests (the sandbox has no global-library context, so a library-mode
 * child cannot resolve its code unless we seed the published roots). It is NOT used to
 * deploy anything on-chain any more — the on-chain publish is the Librarian's SETLIBCODE.
 */
export const SimpleLibraryValue: DictionaryValue<SimpleLibrary> = {
    serialize(src, builder) {
        builder.storeBit(src.public);
        builder.storeRef(src.root);
    },
    parse(slice) {
        return { public: slice.loadBit(), root: slice.loadRef() };
    },
};

/** Key (bigint) for a code in the library dict = its 256-bit representation hash. */
export function libraryKey(code: Cell): bigint {
    return BigInt('0x' + code.hash().toString('hex'));
}

/**
 * Build a `libraries` dictionary (hash -> { public:true, root:code }) — the sandbox
 * `blockchain.libs` seed for tests. `public:true` mirrors what a live Librarian publishes.
 */
export function buildLibrariesDict(realCodes: Cell[]): Dictionary<bigint, SimpleLibrary> {
    const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), SimpleLibraryValue);
    for (const code of realCodes) {
        dict.set(libraryKey(code), { public: true, root: code });
    }
    return dict;
}

export interface LibrarianPlan {
    /** The real (full) code this librarian publishes. */
    publishedCode: Cell;
    /** The plain {code: librarianCode, data} account init (NO `library` field → deploys fine). */
    init: { code: Cell; data: Cell };
    /** The librarian account address on workchain -1 (deterministic per {librarianCode, admin, code}). */
    address: Address;
    /** The published code's 256-bit representation hash (hex). */
    codeHash: string;
}

/**
 * Build the masterchain (wc -1) `Librarian` account init + address for ONE real code.
 * `adminAddress` (the deployer/owner) may later withdraw the surplus / re-publish / remove.
 * The address depends on {librarianCode, adminAddress, code}, so it is deterministic and
 * differs per published code. The init is a plain {code, data} — deploy it via the normal
 * internal-message path; its empty-body deploy message triggers the SETLIBCODE publish.
 */
export function buildLibrarianPlan(realCode: Cell, adminAddress: Address, librarianCode: Cell): LibrarianPlan {
    const data = librarianConfigToCell({ adminAddress, code: realCode, published: false });
    const init = { code: librarianCode, data };
    const address = contractAddress(LIBRARIAN_WORKCHAIN, init);
    return { publishedCode: realCode, init, address, codeHash: realCode.hash().toString('hex') };
}
