// SPDX-License-Identifier: UNLICENSED
import "messages"

// =============================================================================
// UniversalBlockchainPassport storage — derived from the gate-fixed tep/sbtn item
// layout (so the item WIRE layout stays compatible and address derivation is the
// proven owner-bound scheme). The item is OWNER-BOUND: its address is a pure
// function of (owner, id, collection, code) — `id` == the item's `index`. Content
// is NEVER part of the address-determining init (LOCKED design §3.9): reputation /
// nickname / activity / avatar edits do NOT move the address.
//
// CONTENT MODEL (LOCKED §3.4) — TYPED PER id, WRITER enforced PER field.
//   Governing rule: every content field is SYSTEM-WRITE ONLY by default; a field is
//   OWNER-writable ONLY if explicitly flagged. v1 schema (selected by the item id):
//     id=0 (CORE)     : reputation: uint256       (SYSTEM)
//                       nickname:   Cell<SnakeString> (OWNER — the explicit exception)
//     id=1 (ACTIVITY) : onchainActivity: uint256  (SYSTEM)
//     id=2 (AVATAR)   : avatarUrl: Cell<SnakeString> (SYSTEM; "admin" = platform authority)
//     id>=3           : opaque/extensible (SYSTEM unless a field is later flagged OWNER)
//   SYSTEM writes arrive collection->item (the GM->R*->collection pipe); the OWNER
//   nickname write is a DIRECT owner-gated op. Writes MERGE per field (an id=0 system
//   write keeps the owner's nickname, and vice-versa). individualContent is persisted
//   as an opaque `cell`; THIS file is its authoritative typed schema (GM/R* never parse it).
// =============================================================================
type SnakeString = slice

fun SnakeString.unpackFromSlice(mutate s: slice) {
    val snakeRemainder = s;
    s = createEmptySlice();
    return snakeRemainder
}

fun SnakeString.packToBuilder(self, mutate b: builder) {
    b.storeSlice(self)
}

// --- Passport content ids (the item's `index` selects the schema) ---
const PASSPORT_ID_CORE: uint256 = 0;      // reputation (SYSTEM) + nickname (OWNER)
const PASSPORT_ID_ACTIVITY: uint256 = 1;  // onchain_activity (SYSTEM)
const PASSPORT_ID_AVATAR: uint256 = 2;    // avatar url (SYSTEM)

// id=0 full content: a SYSTEM field + an OWNER field share one cell, so writes merge.
struct PassportCoreContent {
    reputation: uint256          // SYSTEM-only
    nickname: Cell<SnakeString>  // OWNER-writable (explicit flag)
}

// id=0 SYSTEM write payload — ONLY the system field(s). The item merges this into the
// stored core content, preserving the owner's nickname.
struct PassportCoreSystemUpdate {
    reputation: uint256
}

// id=1 content (SYSTEM only — system payload == full content).
struct PassportActivityContent {
    onchainActivity: uint256
}

// id=2 content (SYSTEM only — system payload == full content).
struct PassportAvatarContent {
    avatarUrl: Cell<SnakeString>
}

fun emptyStringCell(): Cell<SnakeString> {
    return (beginCell().endCell() as Cell<SnakeString>);
}

// Canonical EMPTY (zeroed) content per id — set on owner self-deploy so the typed
// parsers always succeed (no raw-empty-cell special-casing on every read/merge).
fun emptyContentForId(id: uint256): cell {
    if (id == PASSPORT_ID_CORE) {
        return PassportCoreContent { reputation: 0, nickname: emptyStringCell() }.toCell();
    }
    if (id == PASSPORT_ID_ACTIVITY) {
        return PassportActivityContent { onchainActivity: 0 }.toCell();
    }
    if (id == PASSPORT_ID_AVATAR) {
        return PassportAvatarContent { avatarUrl: emptyStringCell() }.toCell();
    }
    return beginCell().endCell(); // id>=3: opaque empty
}

// Canonical StateInit data — index, collection, owner only (content excluded → §3.9).
struct PassportItemData {
    index: uint256
    collectionAddress: address
    ownerAddress: address
}

// Full storage after init.
struct PassportItemStorage {
    index: uint256
    collectionAddress: address
    ownerAddress: address
    active: bool
    revokedAt: uint64
    individualContent: cell
}

fun PassportItemStorage.load() {
    return PassportItemStorage.fromCell(contract.getData())
}

fun PassportItemStorage.save(self) {
    contract.setData(self.toCell())
}

struct PassportCollectionContent {
    collectionMetadata: cell
}

// FEATURE-SPACE: version + extra appended after the proven base head.
struct PassportPrinterCollectionStorage {
    adminAddress: address
    nextItemIndex: uint256
    content: Cell<PassportCollectionContent>
    passportItemCode: cell
    version: uint32       // printer storage version (1 for v1)
    extra: cell?          // open-ended; add fields here without changing the head
}

fun PassportPrinterCollectionStorage.load() {
    return PassportPrinterCollectionStorage.fromCell(contract.getData())
}

fun PassportPrinterCollectionStorage.save(self) {
    contract.setData(self.toCell())
}

// Address derivation: StateInit data = PassportItemStorage with empty content
// (index, collection, owner, active=false, revokedAt=0, empty content). Content is
// excluded from the determinant — see emptyContentForId / §3.9.
fun calcDeployedPassportItem(index: uint256, collectionAddress: address, ownerAddress: address, passportItemCode: cell): AutoDeployAddress {
    val storage: PassportItemStorage = {
        index,
        collectionAddress,
        ownerAddress,
        active: DEFAULT_ACTIVE_STATE,
        revokedAt: DEFAULT_REVOKED_AT,
        individualContent: empty_cell(),
    };
    return {
        stateInit: {
            code: passportItemCode,
            data: storage.toCell()
        }
    }
}

fun empty_cell(): cell {
    return beginCell().endCell();
}
