// SPDX-License-Identifier: UNLICENSED
// NFTPrinter storage — based on tep/nft/storage.tolk.
//
// Distinct from the base NFT collection in ONE way: NftPrinterCollectionStorage
// carries FEATURE-SPACE (`version`, `extra`) so the printer can grow (e.g. a
// future content-edit recipe) WITHOUT a layout-breaking change. The item side
// (NftItemStorage / NftItemStorageNotInitialized / calcDeployedNftItem) is kept
// byte-identical to tep/nft so the printer can reuse the proven NFTItem code as
// its `nftItemCode` and interoperate with it unchanged.

// SnakeString: short strings stored as-is; long strings as nested refs.
type SnakeString = slice

fun SnakeString.unpackFromSlice(mutate s: slice) {
    val snakeRemainder = s;
    s = createEmptySlice();
    return snakeRemainder
}

fun SnakeString.packToBuilder(self, mutate b: builder) {
    b.storeSlice(self)
}


struct RoyaltyParams {
    numerator: uint16
    denominator: uint16
    royaltyAddress: address
}

// =============================================================================
//  NFTContent — the NFT item's structured, ON-CHAIN individual content.
//  Schema: { origin: address, type: uint64, tier: uint64, seen: Maybe(^Cell) }.
//  `itemType` carries the user-facing `type` attribute (renamed because `type`
//  is a Tolk keyword; the wire layout is address+uint64+uint64 + a trailing
//  Maybe(^Cell), so the TS wrapper exposes it as `type`). The item persists this
//  as `Cell<NFTContent>`; it is opaque to GM and R* (they forward it unparsed).
//
//  ⚒ `seen` is the multisplav (type-5) provenance Bloom filter — the set of
//  foreign origins already alloyed into a native I(5|*|N). It is NULL for every
//  non-type-5 item (a single trailing '0' bit; TEP-62 transfer/static-data never
//  parse content, so this layout extension is transparent to them). Only R*'s
//  multisplav arm reads/writes it; the item just stores whatever R* computed.
//  CONSUMER NOTE: the published NFT decoder must learn this trailing Maybe(^Cell).
// =============================================================================
struct NFTContent {
    origin: address     // who/what minted this NFT (game or owner-supplied origin)
    itemType: uint64    // the `type` attribute
    tier: uint64
    seen: cell?         // ⚒ multisplav Bloom provenance filter; null for non-type-5
}

// FEATURE-SPACE: version + extra are appended AFTER the proven base layout so the
// head (admin..royaltyParams) stays identical to tep/nft and the wrapper/tests can
// rely on the same field order.
struct NftPrinterCollectionStorage {
    adminAddress: address
    nextItemIndex: uint64
    content: Cell<CollectionContent>
    nftItemCode: cell
    royaltyParams: Cell<RoyaltyParams>
    version: uint32       // printer storage version (1 for v1)
    extra: cell?          // open-ended; add fields here without changing the head
}

struct CollectionContent {
    collectionMetadata: cell
    commonContent: Cell<SnakeString>
}

// --- item side: storage layout identical in WIRE to tep/nft (the printer NFT
//     item reuses this layout; the only schema change is `content` is now a
//     `Cell<NFTContent>` ref instead of a `Cell<SnakeString>` ref — same single
//     ref, so address derivation is unchanged). ---

struct NftItemStorage {
    itemIndex: uint64
    collectionAddress: address
    ownerAddress: address
    content: Cell<NFTContent>
}

struct NftItemStorageNotInitialized {
    itemIndex: uint64
    collectionAddress: address
}


fun NftPrinterCollectionStorage.load() {
    return NftPrinterCollectionStorage.fromCell(contract.getData())
}

fun NftPrinterCollectionStorage.save(self) {
    contract.setData(self.toCell())
}

// --- item-storage loader: an NFT item is either uninitialized (only
//     itemIndex+collection, no content ref) or initialized (full NftItemStorage
//     with a content ref). Detect by ref presence, same trick as tep/nft. ---

struct NftItemStorageMaybeNotInitialized {
    contractData: slice
}

fun NftItemStorageMaybeNotInitialized.isInitialized(self) {
    return self.contractData.remainingRefsCount();
}

fun NftItemStorageMaybeNotInitialized.parseNotInitialized(self) {
    return NftItemStorageNotInitialized.fromSlice(self.contractData)
}

fun NftItemStorageMaybeNotInitialized.parseInitialized(self) {
    return NftItemStorage.fromSlice(self.contractData)
}

fun startLoadingNftItemStorage(): NftItemStorageMaybeNotInitialized {
    return {
        contractData: contract.getData().beginParse()
    }
}

fun NftItemStorage.save(self) {
    contract.setData(self.toCell())
}


fun calcDeployedNftItem(itemIndex: uint64, collectionAddress: address, nftItemCode: cell): AutoDeployAddress {
    val emptyNftItemStorage: NftItemStorageNotInitialized = {
        itemIndex,
        collectionAddress,
    };

    return {
        stateInit: {
            code: nftItemCode,
            data: emptyNftItemStorage.toCell()
        }
    }
}
