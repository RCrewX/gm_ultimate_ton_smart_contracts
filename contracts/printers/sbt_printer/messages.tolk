// SPDX-License-Identifier: UNLICENSED
import "storage"

// SBTPrinter message surface — based on tep/sbtn/messages.tolk.
//
// v1 collection surface = DeploySbtn (mint) + RevokeSbtnItem (collection→item
// Revoke) + ChangeCollectionAdmin. The item-side structs (SbtnInit, Revoke,
// Destroy, ProveOwnership, …) are kept byte-identical to tep/sbtn so the reused
// (gate-fixed) SBTNItem code interoperates. NO individualContent-edit in v1
// (individualContent stays a set-once opaque cell).

// SBTN init: collection sends; item sets active=true + content. Authority = collection.
// individualContent is the opaque (Cell<SBTContent>) cell — see storage.tolk.
struct (0x7e488f18) SbtnInit {
    queryId: uint64
    individualContent: cell
}

// collection -> item: replace the item's individualContent (authority = collection).
struct (0x6f89f5e4) SetSbtContent {
    queryId: uint64
    newContent: cell
}

struct (0x04ded148) ProveOwnership {
    queryId: uint64
    destination: address
    forwardPayload: cell
    withContent: bool
}

struct (0xd0c3bfea) RequestOwner {
    queryId: uint64
    destination: address
    forwardPayload: cell
    withContent: bool
}

struct (0x1f04537a) Destroy {
    queryId: uint64
}

struct (0x6f89f5e3) Revoke {
    queryId: uint64
}

struct (0x0524c7ae) OwnershipProof {
    queryId: uint64
    itemId: uint256
    owner: address
    data: cell
    revokedAt: uint64
    content: cell?
}

struct (0x0dd607e3) OwnerInfo {
    queryId: uint64
    itemId: uint256
    initiator: address
    owner: address
    data: cell
    revokedAt: uint64
    content: cell?
}

struct (0xd53276db) Excesses {
    queryId: uint64
}

struct (0x2fcb26a2) RequestStaticData {
    queryId: uint64
}

struct (0x8b771735) ResponseStaticData {
    queryId: uint64
    itemIndex: uint256
    collectionAddress: address
}

// Collection mint (owner-bound: owner, index, then sbtn_init).
struct (0x00000001) DeploySbtn {
    queryId: uint64
    ownerAddress: address
    index: uint256
    attachTonAmount: coins
    individualContent: cell
}

struct (0x00000003) ChangeCollectionAdmin {
    queryId: uint64
    newAdminAddress: address
}

// Collection forwards Revoke to item (only collection can revoke).
struct (0x00000004) RevokeSbtnItem {
    queryId: uint64
    itemAddress: address
}

// admin (== GM) -> collection: edit one item's content. The collection forwards
// SetSbtContent to the item (the item checks sender == collection). `newContent`
// is the opaque Cell<SBTContent>; GM/R* never parse it.
struct (0x00000007) EditSbtItem {
    queryId: uint64
    itemAddress: address
    newContent: cell
}

// TEP-62 opcode: SBTN must reject transfer.
struct (0x5fcc3d14) AskToChangeOwnership {
    queryId: uint64
    newOwnerAddress: address
    sendExcessesTo: address?
    customPayload: cell?
    forwardTonAmount: coins
    forwardPayload: RemainingBitsAndRefs
}


const DEFAULT_ACTIVE_STATE: bool = false;
const DEFAULT_REVOKED_AT: uint64 = 0;
