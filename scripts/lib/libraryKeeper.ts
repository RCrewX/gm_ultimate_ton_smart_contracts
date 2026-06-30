// SPDX-License-Identifier: UNLICENSED
/**
 * libraryKeeper.ts — publish the real child codes to the TON masterchain global
 * library via a keeper account (library-cell deploy mode, Phase 2).
 *
 * A library reference cell (see `library.ts` `toLibraryCell`) only resolves at TVM
 * run time if the real code has been published to the masterchain global library.
 * Publishing = deploying a masterchain (workchain -1) account whose StateInit carries
 * a `libraries` dict mapping each code's representation hash -> { public:true, root:code }.
 * One keeper can carry several libraries.
 *
 * The keeper's code is a standard `WalletContractV4` controlled by the deployer key,
 * so it can be topped up / recovered later (masterchain library rent must stay paid,
 * or every referencing contract freezes). The keeper address is derived from the FULL
 * StateInit (incl. `libraries`), so it differs from the deployer's own wc0 wallet.
 *
 * No new compiled contract: we reuse `WalletContractV4` code (per the plan's "no new
 * compile target" constraint).
 */
import { beginCell, Cell, Dictionary, DictionaryValue, Address, toNano, StateInit, storeStateInit } from '@ton/core';
import { WalletContractV4 } from '@ton/ton';

/** Generous testnet default: masterchain deploy + an initial library-rent reserve. */
export const KEEPER_FUNDING = toNano('3');

/** Masterchain workchain id for the keeper account. */
export const KEEPER_WORKCHAIN = -1;

export interface SimpleLibrary {
    public: boolean;
    root: Cell;
}

/**
 * TL-B `SimpleLib$_ public:Bool root:^Cell` — the value type of StateInit `libraries`
 * (`HashmapE 256 SimpleLib`). @ton/core consumes whatever serializer the dictionary
 * was built with when it stores the StateInit, so we define it explicitly here.
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
 * Build the `libraries` dictionary (hash -> { public:true, root:code }) used for the
 * keeper StateInit. `public:true` makes the code resolvable by any contract globally.
 */
export function buildLibrariesDict(realCodes: Cell[]): Dictionary<bigint, SimpleLibrary> {
    const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), SimpleLibraryValue);
    for (const code of realCodes) {
        dict.set(libraryKey(code), { public: true, root: code });
    }
    return dict;
}

export interface KeeperPlan {
    /** Full StateInit (code = wallet, data = wallet init, libraries = published codes). */
    stateInit: StateInit;
    /** The keeper account address on workchain -1 (= hash of `initCell`). */
    address: Address;
    /** The exact init cell whose hash IS the keeper address (single source of truth). */
    initCell: Cell;
    /** The libraries dictionary (also usable as sandbox `blockchain.libs` source). */
    libraries: Dictionary<bigint, SimpleLibrary>;
    /** Published codes, in input order: the global-library dict key = the code's repr hash. */
    entries: Array<{ codeHash: string }>;
}

/**
 * Build the masterchain keeper StateInit + address for a set of real codes.
 * `deployerPublicKey` is the deployer wallet's public key (so the keeper wallet is
 * controllable by the same key for later top-ups).
 */
export function buildKeeperStateInit(realCodes: Cell[], deployerPublicKey: Buffer): KeeperPlan {
    // WalletContractV4 code/data are workchain-independent (data = seqno+subwallet+
    // pubkey+plugins); only the derived address differs per workchain. We take the
    // code+data and recompute the address on -1 WITH the libraries in the StateInit.
    const keeperWallet = WalletContractV4.create({ publicKey: deployerPublicKey, workchain: KEEPER_WORKCHAIN });
    if (!keeperWallet.init) {
        throw new Error('libraryKeeper: WalletContractV4 did not expose an init {code,data}.');
    }
    const libraries = buildLibrariesDict(realCodes);
    const stateInit: StateInit = {
        code: keeperWallet.init.code,
        data: keeperWallet.init.data,
        libraries,
    };
    // Single source of truth: build the init cell ONCE (with libraries) and derive the
    // address from THAT exact cell's hash. The address and the delivered deploy init are
    // then guaranteed to use the same serialization (asserted again at send time).
    const initCell = storeKeeperStateInitCell(stateInit);
    const address = new Address(KEEPER_WORKCHAIN, initCell.hash());
    // The global library dict is keyed by each code's representation hash.
    const entries = realCodes.map((code) => ({ codeHash: code.hash().toString('hex') }));
    return { stateInit, address, initCell, libraries, entries };
}

/**
 * Serialize a StateInit (incl. `libraries`) to a cell — used to compute/verify the
 * keeper address and to attach to a deploy message. Mirrors @ton/core's
 * `storeStateInit` for the fields we use (split_depth/special always absent here).
 */
export function storeKeeperStateInitCell(init: StateInit): Cell {
    const b = beginCell()
        .storeBit(0) // split_depth: nothing
        .storeBit(0) // special: nothing
        .storeMaybeRef(init.code)
        .storeMaybeRef(init.data);
    if (init.libraries) {
        b.storeDict(init.libraries);
    } else {
        b.storeBit(0);
    }
    return b.endCell();
}

/**
 * Mandatory pre-send gate: the StateInit the wallet send path will actually serialize
 * (via @ton/core `storeStateInit`, inside `internal()` → `createTransfer`) MUST hash to
 * the keeper address. If it does not, the delivered init would not match the destination,
 * the masterchain would ignore it, and the (funded) account would stay uninit — the exact
 * failure this whole fix guards against. Throw (refuse to send) on any mismatch.
 *
 * NOTE: against the current @ton/core@0.62 this always passes (verified: `storeStateInit`
 * serializes `libraries`, identical to `storeKeeperStateInitCell`). The assert exists so a
 * future version skew or serializer change can never silently ship a library-less init again.
 */
export function assertInitParity(plan: KeeperPlan): void {
    const addrHash = plan.address.hash.toString('hex');
    // 1) the single-source init cell must hash to the address (it is the address by construction).
    if (plan.initCell.hash().toString('hex') !== addrHash) {
        throw new Error(`Keeper init parity: initCell hash != address (internal inconsistency).`);
    }
    // 2) the cell the WALLET SEND will attach (storeStateInit) must hash to the address too.
    const deliverable = beginCell().store(storeStateInit(plan.stateInit)).endCell();
    if (deliverable.hash().toString('hex') !== addrHash) {
        throw new Error(
            `Keeper init parity FAILED: the deploy message's StateInit hashes to ` +
            `${deliverable.hash().toString('hex').slice(0, 16)}… but the keeper address is ` +
            `${addrHash.slice(0, 16)}… — the delivered init does not carry the libraries. ` +
            `Refusing to send (the keeper would stay uninit).`,
        );
    }
    if (!plan.stateInit.libraries || plan.stateInit.libraries.size === 0) {
        throw new Error('Keeper init parity: stateInit has no libraries — nothing to publish.');
    }
}
