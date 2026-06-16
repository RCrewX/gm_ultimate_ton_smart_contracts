// SPDX-License-Identifier: UNLICENSED
import "storage"

// NFTPrinter message surface — based on tep/nft/messages.tolk.
//
// Collection surface = DeployNft (mint) + EditNftItem (admin content-edit) +
// ChangeCollectionAdmin (lets the owner re-point admin if GM is replaced) +
// RequestRoyaltyParams (TEP-62 query). The item-side structs (NftItemInitAtDeployment,
// AskToChangeOwnership, RequestStaticData, …) keep the tep/nft wire shape so the
// printer NFT item stays a drop-in TEP-62 item. `content` is now the structured
// Cell<NFTContent> (see storage.tolk) instead of a Cell<SnakeString>.

struct NftItemInitAtDeployment {
    ownerAddress: address
    content: Cell<NFTContent>
}

// collection -> item: replace the item's individual content (authority = collection).
struct (0x00000005) SetNftContent {
    queryId: uint64
    newContent: Cell<NFTContent>
}

struct (0x693d3950) RequestRoyaltyParams {
    queryId: uint64
}

struct (0xa8cb00ad) ResponseRoyaltyParams {
    queryId: uint64
    royaltyParams: RoyaltyParams
}

struct (0x00000001) DeployNft {
    queryId: uint64
    itemIndex: uint64
    attachTonAmount: coins
    initParams: Cell<NftItemInitAtDeployment>
}

struct (0x00000003) ChangeCollectionAdmin {
    queryId: uint64
    newAdminAddress: address
}

// admin (== GM) -> collection: edit one item's content. The collection forwards
// SetNftContent to the item at `itemAddress` (the item checks sender == collection).
// `newContent` is an opaque-to-GM/R* Cell<NFTContent>; only this contract types it.
struct (0x00000006) EditNftItem {
    queryId: uint64
    itemAddress: address
    newContent: Cell<NFTContent>
}

struct (0x2fcb26a2) RequestStaticData {
    queryId: uint64
}

struct (0x8b771735) ResponseStaticData {
    queryId: uint64
    itemIndex: uint256
    collectionAddress: address
}

struct (0x05138d91) NotificationForNewOwner {
    queryId: uint64
    oldOwnerAddress: address
    payload: RemainingBitsAndRefs
}

struct (0xd53276db) ReturnExcessesBack {
    queryId: uint64
}

// TEP-62 transfer (NFTPrinter items are transferable): custom_payload is (Maybe ^Cell)
struct (0x5fcc3d14) AskToChangeOwnership {
    queryId: uint64
    newOwnerAddress: address
    sendExcessesTo: address?
    customPayload: cell?
    forwardTonAmount: coins
    forwardPayload: RemainingBitsAndRefs
}

// =============================================================================
//  ⚒  ANVIL — the two-item combine / single-item transform+melt message flow.
//
//  Gate chain (brief): user -> item1[owner] -> item2[owner + prev-addr] ->
//  collection[item-addr] -> GM -> R*[printer-addr + validate + compute] -> GM ->
//  collection[GM] -> item1[printer; update] -> item2[prev; destroy + cashback].
//  Items report their REAL stored {origin,type,tier}; R* validates against those.
// =============================================================================

// ANVIL send modes + recipe/outcome codes (shared by the item and the collection).
const ANVIL_SEND_CARRY_ALL: int = 128;
const ANVIL_SEND_DESTROY_IF_ZERO: int = 32;

const ANVIL_RECIPE_COMBINE: uint8 = 1;
const ANVIL_RECIPE_MULTISPLAV: uint8 = 2;
const ANVIL_RECIPE_ZERO_TYPE: uint8 = 3;
const ANVIL_RECIPE_ZERO_TIER: uint8 = 4;
const ANVIL_RECIPE_MELT: uint8 = 5;

const ANVIL_OUT_UPDATE: uint8 = 1;          // overwrite item1 content
const ANVIL_OUT_UPDATE_DESTROY: uint8 = 2;  // overwrite item1 + destroy item2
const ANVIL_OUT_MELT: uint8 = 3;            // destroy item1 (RUDA minted separately)

// Reported on-chain attributes of one NFT item (byte-identical to retranslator.tolk).
// `seen` is the type-5 native's provenance Bloom filter (null for non-type-5);
// the item reports it up-chain so R*'s multisplav arm can check/extend it.
struct AnvilItemAttrs {
    index: uint64
    origin: address
    itemType: uint64
    tier: uint64
    seen: cell?
}

// R1 envelope to GM (opcode matches game_manager/static.tolk). The collection
// wraps an ANVIL request in here; GM forwards it to R* as R2 (opaque).
struct (0x52310001) R1 {
    data: cell
}

// ---- R1.data variants the collection builds for R* (match retranslator.tolk) ----
struct (0x416e7643) AnvilCombine {     // "AnvC" — two-item (COMBINE / MULTISPLAV)
    recipe: uint8
    owner: address
    item1: Cell<AnvilItemAttrs>
    item2: Cell<AnvilItemAttrs>
}
struct (0x416e7654) AnvilTransform {   // "AnvT" — single-item (ZERO_TYPE / ZERO_TIER)
    recipe: uint8
    owner: address
    item1: Cell<AnvilItemAttrs>
}
struct (0x416e764d) AnvilMelt {        // "AnvM" — single-item burn -> RUDA
    owner: address
    item1: Cell<AnvilItemAttrs>
}

// ---- R* -> collection (via GM R4): apply the computed outcome (match retranslator.tolk) ----
struct (0x416e7641) PrinterAnvilApply { // "AnvA"
    queryId: uint64
    kind: uint8
    item1Index: uint64
    newContent: Cell<NFTContent>   // ignored for MELT (kind 3)
    item2Index: uint64             // valid only for UPDATE_DESTROY (kind 2)
    owner: address
}

// ---- item-flow messages ----
// user -> item1 : initiate a recipe (item1 = the surviving/updated item).
struct (0x416e7601) AnvilInit {
    queryId: uint64
    recipe: uint8
    hasSecond: bool        // two-item recipe?
    item2Index: uint64     // the sacrificed item's index (when hasSecond)
}
// item1 -> item2 : carry item1's reported attrs to item2 (two-item).
struct (0x416e7602) AnvilHop {
    queryId: uint64
    recipe: uint8
    owner: address
    item1: Cell<AnvilItemAttrs>
}
// item (item1 single, or item2 double) -> collection : report attrs.
struct (0x416e7603) AnvilReportToCollection {
    queryId: uint64
    recipe: uint8
    owner: address
    isDouble: bool
    item1: Cell<AnvilItemAttrs>
    item2: Cell<AnvilItemAttrs>?   // present only when isDouble
}
// collection -> item1 (combine) : overwrite content, then destroy item2.
struct (0x416e7604) SetNftContentAndDestroy {
    queryId: uint64
    newContent: Cell<NFTContent>
    item2Index: uint64
    cashbackTo: address
}
// item1 -> item2 (combine) : destroy the sacrificed item, cashback to user.
struct (0x416e7605) AnvilDestroyFromSibling {
    queryId: uint64
    item1Index: uint64
    cashbackTo: address
}
// collection -> item1 (melt) : destroy item1, cashback to user.
struct (0x416e7606) AnvilDestroy {
    queryId: uint64
    cashbackTo: address
}
