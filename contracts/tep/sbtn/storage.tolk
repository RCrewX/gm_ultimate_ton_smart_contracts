// SPDX-License-Identifier: UNLICENSED
import "messages"

// SBTN (TEP-6666): unused legacy 3-field reduction (index, collection, owner). NOT the canonical
// StateInit data — address derivation uses the full SbtnItemStorage (see calcDeployedSbtnItem below).
struct SbtnItemData {
    index: uint256
    collectionAddress: address
    ownerAddress: address
}

// Full storage after sbtn_init: index, collection, owner, active, revokedAt, individualContent.
// destroy only deactivates (active = false) and does NOT clear owner — owner is immutable (part of
// the deterministic StateInit, so it fixes the item address). revoke stamps revokedAt; collection is
// the revoke authority.
struct SbtnItemStorage {
    index: uint256
    collectionAddress: address
    ownerAddress: address
    active: bool
    revokedAt: uint64
    individualContent: cell
}

fun SbtnItemStorage.load() {
    return SbtnItemStorage.fromCell(contract.getData())
}

fun SbtnItemStorage.save(self) {
    contract.setData(self.toCell())
}


// SBTN collection storage (same idea as SBT: admin, next_item_index, content, sbtn_item_code).
struct SbtnCollectionContent {
    collectionMetadata: cell
}

struct SbtnCollectionStorage {
    adminAddress: address
    nextItemIndex: uint256
    content: Cell<SbtnCollectionContent>
    sbtnItemCode: cell
}

fun SbtnCollectionStorage.load() {
    return SbtnCollectionStorage.fromCell(contract.getData())
}

fun SbtnCollectionStorage.save(self) {
    contract.setData(self.toCell())
}

// Address derivation (SBTN_02 §2.2): StateInit with data = SbtnItemStorage (extended layout per implementation note).
fun calcDeployedSbtnItem(index: uint256, collectionAddress: address, ownerAddress: address, sbtnItemCode: cell): AutoDeployAddress {
    val storage: SbtnItemStorage = {
        index,
        collectionAddress,
        ownerAddress,
        active: DEFAULT_ACTIVE_STATE,
        revokedAt: DEFAULT_REVOKED_AT,
        individualContent: empty_cell(),
    };
    return {
        stateInit: {
            code: sbtnItemCode,
            data: storage.toCell()
        }
    }
}


fun empty_cell() : cell {
    return beginCell().endCell();
}
