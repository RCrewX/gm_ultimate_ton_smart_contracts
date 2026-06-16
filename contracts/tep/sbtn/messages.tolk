// SPDX-License-Identifier: UNLICENSED
import "storage"

// SBTN init (SBTN_02 §3.1): sbtn_init#7e488f18 — collection sends; item sets active=true, content. Authority = collection (not in message).
struct (0x7e488f18) SbtnInit {
    queryId: uint64
    individualContent: cell
}

// TEP-85 / SBT compatible: prove_ownership, request_owner, destroy, revoke, ownership_proof, owner_info, excesses.
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

// SBTN Collection: DeploySbtn (owner-bound: owner, index, then sbtn_init).
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

// Collection forwards Revoke to item (only collection can revoke; admin requests via collection).
struct (0x00000004) RevokeSbtnItem {
    queryId: uint64
    itemAddress: address
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
