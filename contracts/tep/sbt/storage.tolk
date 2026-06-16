// SPDX-License-Identifier: UNLICENSED
// SnakeString describes a (potentially long) string inside a cell (same as NFT).
type SnakeString = slice

fun SnakeString.unpackFromSlice(mutate s: slice) {
    val snakeRemainder = s;
    s = createEmptySlice();
    return snakeRemainder
}

fun SnakeString.packToBuilder(self, mutate b: builder) {
    b.storeSlice(self)
}

// SBT item: uninitialized state (same layout as NFT for address calc).
struct SbtItemStorageNotInitialized {
    itemIndex: uint64
    collectionAddress: address
}

// Init params from collection: owner, content, optional authority (TEP-85).
struct SbtItemInitAtDeployment {
    ownerAddress: address
    content: Cell<SnakeString>
    authority: address?
}

// SBT item storage after init (TEP-85). ownerAddress becomes null after destroy.
struct SbtItemStorage {
    itemIndex: uint64
    collectionAddress: address
    ownerAddress: address?
    content: Cell<SnakeString>
    authority: address?
    revokedAt: uint64
}

// SBT collection storage (no royalty; TEP-85 does not require it).
struct SbtCollectionContent {
    collectionMetadata: cell
}

struct SbtCollectionStorage {
    adminAddress: address
    nextItemIndex: uint64
    content: Cell<SbtCollectionContent>
    sbtItemCode: cell
}

// Detect initialized vs not (same pattern as NFT: refs present = initialized).
struct SbtItemStorageMaybeNotInitialized {
    contractData: slice
}

fun SbtItemStorageMaybeNotInitialized.isInitialized(self) {
    return self.contractData.remainingRefsCount()
}

fun SbtItemStorageMaybeNotInitialized.parseNotInitialized(self) {
    return SbtItemStorageNotInitialized.fromSlice(self.contractData)
}

fun SbtItemStorageMaybeNotInitialized.parseInitialized(self) {
    return SbtItemStorage.fromSlice(self.contractData)
}

fun startLoadingSbtItemStorage(): SbtItemStorageMaybeNotInitialized {
    return {
        contractData: contract.getData().beginParse()
    }
}

fun SbtCollectionStorage.load() {
    return SbtCollectionStorage.fromCell(contract.getData())
}

fun SbtCollectionStorage.save(self) {
    contract.setData(self.toCell())
}

fun SbtItemStorage.save(self) {
    contract.setData(self.toCell())
}

fun calcDeployedSbtItem(itemIndex: uint64, collectionAddress: address, sbtItemCode: cell): AutoDeployAddress {
    val emptyStorage: SbtItemStorageNotInitialized = {
        itemIndex,
        collectionAddress,
    };
    return {
        stateInit: {
            code: sbtItemCode,
            data: emptyStorage.toCell()
        }
    }
}
