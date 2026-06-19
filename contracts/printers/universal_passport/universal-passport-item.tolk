// SPDX-License-Identifier: UNLICENSED
import "@stdlib/gas-payments"
import "errors"
import "storage"
import "messages"
import "fees-management"

// =============================================================================
// UniversalBlockchainPassport ITEM (compile target: UniversalBlockchainPassport).
//
// The proven soulbound item (collection-gated init, EXACT destroy-reserve, transfer
// rejected) PLUS the passport content model (LOCKED design §3.3/§3.4/§3.5):
//   * OWNER self-deploy for ANY id (PassportOwnerInit) — content starts EMPTY (zeroed
//     per id). The deterministic address (owner,id,collection,code) is unchanged whether
//     the item is owner-self-deployed or system-minted (PassportInit).
//   * ALL content writes come ONLY from the collection (== printer, admin == GM, driven
//     by the GM->R* pipe). The item has NO direct owner entrypoint — R* enforces WHO may
//     request a write; the item only enforces "from my collection authority" + the typed
//     per-field MERGE. Two collection-gated ops, split by FIELD family:
//       - SetPassportSystemContent : per-id SYSTEM payload; merges keeping owner fields.
//       - SetPassportOwnerContent  : the OWNER nickname (id=0); merges keeping reputation.
//   * Content is NEVER in the address-determining init (§3.9) — edits don't move the item.
// =============================================================================

type AllowedMessageToPassportItem =
    | PassportInit
    | PassportOwnerInit
    | SetPassportSystemContent
    | SetPassportOwnerContent
    | ProveOwnership
    | RequestOwner
    | Destroy
    | Revoke
    | RequestStaticData
    | AskToChangeOwnership

fun onInternalMessage(in: InMessage) {
    var storage = lazy PassportItemStorage.load();
    val msg = lazy AllowedMessageToPassportItem.fromSlice(in.body);

    match (msg) {
        // System-mint init (collection-gated). Sets the typed content the collection
        // supplied (may be a zeroed emptyContentForId).
        PassportInit => {
            assert (in.senderAddress == storage.collectionAddress) throw ERROR_NOT_FROM_COLLECTION;
            if (storage.active) {
                throw ERROR_ALREADY_INITIALIZED
            }
            storage.active = true;
            storage.individualContent = msg.individualContent;
            storage.save();
            return;
        }

        // OWNER self-deploy (§3.3): the owner activates their own passport(id) with EMPTY
        // (zeroed-per-id) content. Idempotent on a re-send (already active -> no-op).
        PassportOwnerInit => {
            assert (in.senderAddress == storage.ownerAddress) throw ERROR_NOT_FROM_OWNER;
            if (storage.active) {
                return;
            }
            storage.active = true;
            storage.individualContent = emptyContentForId(storage.index);
            storage.save();
            return;
        }

        // SYSTEM content write — ONLY from the collection. Per-id MERGE: id=0 keeps the
        // owner's nickname; id=1/2 have no owner field (system payload == full content);
        // id>=3 is opaque (stored verbatim).
        SetPassportSystemContent => {
            assert (storage.active == true) throw ERROR_NOT_INITIALIZED;
            assert (in.senderAddress == storage.collectionAddress) throw ERROR_NOT_FROM_COLLECTION;
            storage.individualContent = applySystemContent(storage.index, storage.individualContent, msg.newContent);
            storage.save();
        }

        // OWNER-FIELD write (nickname) — ONLY from the collection authority (the GM->R*
        // pipe; R* already verified the requester is THIS passport's owner). id=0 only
        // (the lone owner-writable field); other ids reject (system-only by default).
        // Merges the nickname, preserving the system reputation.
        SetPassportOwnerContent => {
            assert (storage.active == true) throw ERROR_NOT_INITIALIZED;
            assert (in.senderAddress == storage.collectionAddress) throw ERROR_NOT_FROM_COLLECTION;
            assert (storage.index == PASSPORT_ID_CORE) throw ERROR_FIELD_NOT_OWNER_WRITABLE;
            val core = PassportCoreContent.fromCell(storage.individualContent);
            storage.individualContent = PassportCoreContent {
                reputation: core.reputation,
                nickname: (msg.newContent as Cell<SnakeString>),
            }.toCell();
            storage.save();
        }

        AskToChangeOwnership => {
            throw ERROR_SBTN_TRANSFER_FORBIDDEN
        }

        ProveOwnership => {
            assert (storage.active == true) throw ERROR_NOT_INITIALIZED;
            assert (in.senderAddress == storage.ownerAddress) throw ERROR_NOT_FROM_OWNER;

            var contentCell: cell? = null;
            if (msg.withContent) {
                contentCell = storage.individualContent;
            }
            val proofMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: msg.destination,
                value: 0,
                body: OwnershipProof {
                    queryId: msg.queryId,
                    itemId: storage.index,
                    owner: storage.ownerAddress!,
                    data: msg.forwardPayload,
                    revokedAt: storage.revokedAt,
                    content: contentCell,
                }
            });
            proofMsg.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        RequestOwner => {
            assert (storage.active == true) throw ERROR_NOT_INITIALIZED;

            var contentCell: cell? = null;
            if (msg.withContent) {
                contentCell = storage.individualContent;
            }
            val infoMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: msg.destination,
                value: 0,
                body: OwnerInfo {
                    queryId: msg.queryId,
                    itemId: storage.index,
                    initiator: in.senderAddress,
                    owner: storage.ownerAddress!,
                    data: msg.forwardPayload,
                    revokedAt: storage.revokedAt,
                    content: contentCell,
                }
            });
            infoMsg.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        Destroy => {
            assert (storage.active == true) throw ERROR_NOT_INITIALIZED;
            assert (in.senderAddress == storage.ownerAddress) throw ERROR_NOT_FROM_OWNER;

            storage.active = false;
            storage.save();

            // Retain the storage reserve (SBTN_02 §5.1): reserve EXACTLY
            // MIN_TONS_FOR_STORAGE, then carry-all the remainder.
            reserveToncoinsOnBalance(MIN_TONS_FOR_STORAGE, RESERVE_MODE_EXACT_AMOUNT);
            val excessesMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: Excesses { queryId: msg.queryId }
            });
            excessesMsg.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }

        Revoke => {
            assert (storage.active == true) throw ERROR_NOT_INITIALIZED;
            assert (storage.revokedAt == 0) throw ERROR_ALREADY_REVOKED;
            assert (in.senderAddress == storage.collectionAddress) throw ERROR_NOT_AUTHORITY;

            storage.revokedAt = blockchain.now() as uint64;
            storage.save();
        }

        RequestStaticData => {
            val respondMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: UnsafeBodyNoRef {
                    forceInline: ResponseStaticData {
                        queryId: msg.queryId,
                        itemIndex: storage.index,
                        collectionAddress: storage.collectionAddress,
                    }
                }
            });
            respondMsg.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        else => {
            assert (in.body.isEmpty()) throw ERROR_UNKNOWN_MESSAGE
        }
    }
}

// Per-id SYSTEM content merge: applies the system payload while preserving owner fields.
//   id=0 : payload = {reputation}; keep the stored nickname.
//   id=1 : payload = full PassportActivityContent.
//   id=2 : payload = full PassportAvatarContent.
//   id>=3: opaque — store the payload verbatim.
fun applySystemContent(id: uint256, current: cell, payload: cell): cell {
    if (id == PASSPORT_ID_CORE) {
        val core = PassportCoreContent.fromCell(current);
        val upd = PassportCoreSystemUpdate.fromCell(payload);
        return PassportCoreContent {
            reputation: upd.reputation,
            nickname: core.nickname,
        }.toCell();
    }
    return payload; // id=1/2/>=3: no owner field to preserve
}

struct PassportDataReply {
    isInitialized: bool
    itemIndex: int
    collectionAddress: address
    ownerAddress: address
    content: cell? = null
    authority: address
    revokedAt: uint64 = 0
}

get fun get_nft_data(): PassportDataReply {
    var storage = lazy PassportItemStorage.load();
    return {
        isInitialized: storage.active,
        itemIndex: storage.index as int,
        collectionAddress: storage.collectionAddress,
        ownerAddress: storage.ownerAddress,
        content: storage.individualContent,
        authority: storage.collectionAddress,
        revokedAt: storage.revokedAt,
    }
}

// id=0 typed view — reputation (SYSTEM) + nickname (OWNER). The UBPS filter seam
// reads reputation (§3.7). Only valid for a CORE (id=0) passport that has content.
get fun get_passport_core(): PassportCoreContent {
    var storage = lazy PassportItemStorage.load();
    return PassportCoreContent.fromCell(storage.individualContent);
}

// Convenience: reputation alone (id=0). uap filters reputation > 0.
get fun get_reputation(): int {
    var storage = lazy PassportItemStorage.load();
    return PassportCoreContent.fromCell(storage.individualContent).reputation as int;
}

get fun get_authority_address(): address {
    var storage = lazy PassportItemStorage.load();
    return storage.collectionAddress;
}

get fun get_revoked_time(): int {
    var storage = lazy PassportItemStorage.load();
    return storage.revokedAt as int;
}
