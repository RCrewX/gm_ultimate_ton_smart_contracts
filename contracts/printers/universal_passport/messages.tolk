// SPDX-License-Identifier: UNLICENSED
import "storage"

// UniversalBlockchainPassport message surface — derived from the gate-fixed tep/sbtn
// item protocol. The TEP-standard item messages (init, ProveOwnership, RequestOwner,
// Destroy, Revoke, ownership replies, static-data, transfer-reject) keep their
// canonical opcodes so the proven item behaviour is preserved. On top of that the
// passport adds:
//   * PassportOwnerInit  — OWNER self-deploy (any id) with EMPTY content (§3.3)
//   * SetPassportSystemContent / SetPassportOwnerContent — the per-FIELD write split
//     (§3.4/§3.5). BOTH arrive collection->item; the item has NO direct owner op. The
//     op IDENTITY (system vs owner) is what bounds which fields a write may touch; R*
//     enforces WHO may invoke which op. Field-level authority = R* op-gating × item
//     op-merge, so neither op can clobber the other family's fields.
//   * EditPassportItem (system edit) / EditPassportOwnerContent (owner-field edit) /
//     PassportDeploy / RevokePassportItem — the collection ops the GM->R* pipe drives.

// Collection -> item init (system mint path). Authority = collection. individualContent
// is the typed (per-id) content cell — see storage.tolk; may be a zeroed emptyContentForId.
struct (0x7e488f18) PassportInit {
    queryId: uint64
    individualContent: cell
}

// OWNER self-deploy (§3.3): the owner sends this WITH the item stateInit to activate
// their own passport(id) with EMPTY (zeroed) content. Gated to storage.ownerAddress.
struct (0x55504900) PassportOwnerInit {   // "UPI\0"
    queryId: uint64
}

// collection -> item: SYSTEM content write. Carries the per-id SYSTEM payload ONLY
// (e.g. id=0 -> reputation); the item MERGES it, preserving owner fields (nickname).
// Authority = collection (the GM->R* pipe). Keeps opcode for wire continuity.
struct (0x6f89f5e4) SetPassportSystemContent {
    queryId: uint64
    newContent: cell
}

// collection -> item: OWNER-FIELD content write (currently nickname, id=0). Gated to
// collectionAddress (same authority as the system write — the GM->R* pipe). The op
// IDENTITY restricts it to the OWNER field family: the item merges newContent as the
// nickname ONLY, preserving the system reputation. R* gates WHO may request it (the
// passport owner, bound to the GM-attested initiator). `newContent` = a Cell<SnakeString>.
struct (0x6f89f5e5) SetPassportOwnerContent {
    queryId: uint64
    newContent: cell   // Cell<SnakeString> (the nickname)
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

// Collection system-mint (owner-bound: owner, index, then init). Drives PassportInit.
struct (0x00000001) PassportDeploy {
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
struct (0x00000004) RevokePassportItem {
    queryId: uint64
    itemAddress: address
}

// admin (== GM) -> collection: SYSTEM content edit of one item. The collection forwards
// SetPassportSystemContent to the item (item checks sender == collection). `newContent`
// is the per-id SYSTEM payload; GM/R* never parse it.
struct (0x00000007) EditPassportItem {
    queryId: uint64
    itemAddress: address
    newContent: cell
}

// admin (== GM, driven by R*) -> collection: OWNER-FIELD content edit (nickname).
// Unlike EditPassportItem, the owner CANNOT pass an arbitrary itemAddress — R* binds
// `ownerAddress` to the GM-attested initiator and the collection DERIVES the item
// address from (ownerAddress, index), so an owner can only ever reach THEIR OWN
// passport. The collection forwards SetPassportOwnerContent to that item.
struct (0x00000008) EditPassportOwnerContent {
    queryId: uint64
    ownerAddress: address
    index: uint256
    newContent: cell   // Cell<SnakeString> (the nickname)
}

// TEP-62 opcode: a passport (soulbound) must reject transfer.
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
