// SPDX-License-Identifier: UNLICENSED
import "@stdlib/gas-payments"
import "errors"
import "storage"
import "messages"
import "fees-management"

// =============================================================================
// SBTPrinter ITEM = the gate-fixed tep/sbtn SBTNItem (collection-only sbtn_init,
// EXACT destroy-reserve, soulbound) PLUS one extra, collection-gated message:
// SetSbtContent (admin content-edit, driven by R*'s ANVIL section through the
// collection). Storage WIRE layout is identical to tep/sbtn (index, collection,
// owner, active, revokedAt, individualContent) so the collection's address
// derivation (calcDeployedSbtnItem) is unchanged. tep/sbtn is left untouched.
// individualContent stays an opaque cell (the agreed Cell<SBTContent> schema).
// =============================================================================

type AllowedMessageToSbtnItem =
    | SbtnInit
    | SetSbtContent
    | ProveOwnership
    | RequestOwner
    | Destroy
    | Revoke
    | RequestStaticData
    | AskToChangeOwnership

fun onInternalMessage(in: InMessage) {
    var storage = lazy SbtnItemStorage.load();
    val msg = lazy AllowedMessageToSbtnItem.fromSlice(in.body);

    match (msg) {
        SbtnInit => {
            assert (in.senderAddress == storage.collectionAddress) throw ERROR_NOT_FROM_COLLECTION;
            if (storage.active) {
                throw ERROR_ALREADY_INITIALIZED
            }
            storage.active = true;
            storage.individualContent = msg.individualContent;
            storage.save();
            return;
        }

        // Content-edit: ONLY the collection (== printer; admin == GM) may overwrite
        // the individualContent. The recipe authority (owner/GM, later finer-grained)
        // is enforced upstream in R*'s ANVIL section; the item trusts its collection.
        SetSbtContent => {
            assert (storage.active == true) throw ERROR_NOT_INITIALIZED;
            assert (in.senderAddress == storage.collectionAddress) throw ERROR_NOT_FROM_COLLECTION;
            storage.individualContent = msg.newContent;
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

struct SbtnDataReply {
    isInitialized: bool
    itemIndex: int
    collectionAddress: address
    ownerAddress: address
    content: cell? = null
    authority: address
    revokedAt: uint64 = 0
}

get fun get_nft_data(): SbtnDataReply {
    var storage = lazy SbtnItemStorage.load();
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

// Typed view of the structured content: parses individualContent as SBTContent.
get fun get_sbt_content_fields(): SBTContent {
    var storage = lazy SbtnItemStorage.load();
    return SBTContent.fromCell(storage.individualContent);
}

get fun get_authority_address(): address {
    var storage = lazy SbtnItemStorage.load();
    return storage.collectionAddress;
}

get fun get_revoked_time(): int {
    var storage = lazy SbtnItemStorage.load();
    return storage.revokedAt as int;
}
