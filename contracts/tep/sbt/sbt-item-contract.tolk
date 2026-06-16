// SPDX-License-Identifier: UNLICENSED
import "@stdlib/gas-payments"
import "errors"
import "storage"
import "messages"
import "fees-management"

type AllowedMessageToSbtItem =
    | ProveOwnership
    | RequestOwner
    | Destroy
    | Revoke
    | RequestStaticData
    | AskToChangeOwnership

fun onInternalMessage(in: InMessage) {
    var loadingStorage = startLoadingSbtItemStorage();
    if (!loadingStorage.isInitialized()) {
        val uninitedSt = loadingStorage.parseNotInitialized();
        assert (in.senderAddress == uninitedSt.collectionAddress) throw ERROR_NOT_FROM_COLLECTION;

        val initParams = SbtItemInitAtDeployment.fromSlice(in.body);
        val storage: SbtItemStorage = {
            itemIndex: uninitedSt.itemIndex,
            collectionAddress: uninitedSt.collectionAddress,
            ownerAddress: initParams.ownerAddress,
            content: initParams.content,
            authority: initParams.authority,
            revokedAt: 0,
        };
        storage.save();
        return;
    }

    var storage = loadingStorage.parseInitialized();
    val msg = lazy AllowedMessageToSbtItem.fromSlice(in.body);

    match (msg) {
        AskToChangeOwnership => {
            throw ERROR_SBT_TRANSFER_FORBIDDEN
        }

        ProveOwnership => {
            assert (storage.ownerAddress != null) throw ERROR_NOT_FROM_OWNER;
            assert (in.senderAddress == storage.ownerAddress) throw ERROR_NOT_FROM_OWNER;

            var contentCell: cell? = null;
            if (msg.withContent) {
                contentCell = storage.content.toCell();
            }
            val proofMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: msg.destination,
                value: 0,
                body: OwnershipProof {
                    queryId: msg.queryId,
                    itemId: storage.itemIndex as uint256,
                    owner: storage.ownerAddress!,
                    data: msg.forwardPayload,
                    revokedAt: storage.revokedAt,
                    content: contentCell,
                }
            });
            proofMsg.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        RequestOwner => {
            var contentCell: cell? = null;
            if (msg.withContent) {
                contentCell = storage.content.toCell();
            }
            if (storage.ownerAddress != null) {
                val infoMsg = createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: msg.destination,
                    value: 0,
                    body: OwnerInfo {
                        queryId: msg.queryId,
                        itemId: storage.itemIndex as uint256,
                        initiator: in.senderAddress,
                        owner: storage.ownerAddress!,
                        data: msg.forwardPayload,
                        revokedAt: storage.revokedAt,
                        content: contentCell,
                    }
                });
                infoMsg.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
            } else {
                // Destroyed SBT: send owner_info with owner = addr_none (TEP-85)
                var bodyBuilder = beginCell()
                    .storeUint(0x0dd607e3, 32)
                    .storeUint(msg.queryId, 64)
                    .storeUint(storage.itemIndex, 256)
                    .storeAddress(in.senderAddress)
                    .storeUint(0, 2)
                    .storeRef(msg.forwardPayload)
                    .storeUint(storage.revokedAt, 64);
                if (contentCell != null) {
                    bodyBuilder = bodyBuilder.storeUint(1, 1).storeRef(contentCell!);
                } else {
                    bodyBuilder = bodyBuilder.storeUint(0, 1);
                }
                val infoMsg = createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: msg.destination,
                    value: 0,
                    body: bodyBuilder.endCell(),
                });
                infoMsg.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
            }
        }

        Destroy => {
            assert (storage.ownerAddress != null) throw ERROR_NOT_FROM_OWNER;
            assert (in.senderAddress == storage.ownerAddress) throw ERROR_NOT_FROM_OWNER;

            storage.ownerAddress = null;
            storage.authority = null;
            storage.save();

            // Retain the storage reserve: reserve EXACTLY MIN_TONS_FOR_STORAGE, then carry-all
            // the remainder. A bare mode-128 send ignores `value` and would drain the account
            // below the storage tax (mirrors the sbtn Destroy fix).
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
            assert (storage.authority != null) throw ERROR_NOT_AUTHORITY;
            assert (in.senderAddress == storage.authority) throw ERROR_NOT_AUTHORITY;
            assert (storage.revokedAt == 0) throw ERROR_ALREADY_REVOKED;

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
                        itemIndex: storage.itemIndex as uint256,
                        collectionAddress: storage.collectionAddress,
                    }
                }
            });
            respondMsg.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        else => {
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}

struct SbtDataReply {
    isInitialized: bool
    itemIndex: int
    collectionAddress: address
    ownerAddress: address? = null
    content: Cell<SnakeString>? = null
    authority: address? = null
    revokedAt: uint64 = 0
}

get fun get_nft_data(): SbtDataReply {
    var loadingStorage = startLoadingSbtItemStorage();
    if (!loadingStorage.isInitialized()) {
        val uninitedSt = loadingStorage.parseNotInitialized();
        return {
            isInitialized: false,
            itemIndex: uninitedSt.itemIndex,
            collectionAddress: uninitedSt.collectionAddress,
        }
    }

    val storage = loadingStorage.parseInitialized();
    return {
        isInitialized: true,
        itemIndex: storage.itemIndex,
        collectionAddress: storage.collectionAddress,
        ownerAddress: storage.ownerAddress,
        content: storage.content,
        authority: storage.authority,
        revokedAt: storage.revokedAt,
    }
}

get fun get_authority_address(): slice {
    var loadingStorage = startLoadingSbtItemStorage();
    if (!loadingStorage.isInitialized()) {
        return beginCell().storeUint(0, 2).endCell().beginParse();
    }
    val storage = loadingStorage.parseInitialized();
    if (storage.authority == null) {
        return beginCell().storeUint(0, 2).endCell().beginParse();
    }
    return beginCell().storeAddress(storage.authority).endCell().beginParse();
}

get fun get_revoked_time(): int {
    var loadingStorage = startLoadingSbtItemStorage();
    if (!loadingStorage.isInitialized()) {
        return 0;
    }
    val storage = loadingStorage.parseInitialized();
    return storage.revokedAt as int;
}
