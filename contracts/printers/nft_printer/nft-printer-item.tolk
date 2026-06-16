// SPDX-License-Identifier: UNLICENSED
import "@stdlib/gas-payments"
import "errors"
import "storage"
import "messages"
import "fees-management"

// =============================================================================
// NFTPrinter ITEM = the tep/nft NFTItem (TEP-62 transferable) PLUS one extra,
// collection-gated message: SetNftContent (admin content-edit, driven by R*'s
// ANVIL section through the collection). Storage WIRE layout is identical to
// tep/nft (itemIndex, collection, owner, content-ref) so the collection's
// address derivation (calcDeployedNftItem) is unchanged — only the content ref
// is now a structured Cell<NFTContent> instead of a Cell<SnakeString>.
// tep/nft itself is left untouched.
// =============================================================================

// EXACT-reserve for an ANVIL hop: keep the item's prior balance (>= storage min),
// forward only the incoming value down the chain (carry-all).
fun reserveAnvil(msgValue: coins) {
    var keep = contract.getOriginalBalance() - msgValue;
    if (keep < MIN_TONS_FOR_STORAGE) {
        keep = MIN_TONS_FOR_STORAGE;
    }
    reserveToncoinsOnBalance(keep, RESERVE_MODE_EXACT_AMOUNT);
}

type AllowedMessageToNftItem =
    | AskToChangeOwnership
    | RequestStaticData
    | SetNftContent
    | AnvilInit                 // ⚒ user starts a recipe on this (surviving) item
    | AnvilHop                  // ⚒ item1 -> item2 (two-item)
    | SetNftContentAndDestroy   // ⚒ collection -> item1 (combine: update + destroy item2)
    | AnvilDestroyFromSibling   // ⚒ item1 -> item2 (combine: destroy sacrificed item)
    | AnvilDestroy              // ⚒ collection -> item1 (melt: destroy item1)

fun onInternalMessage(in: InMessage) {
    var loadingStorage = startLoadingNftItemStorage();
    if (!loadingStorage.isInitialized()) {
        val uninitedSt = loadingStorage.parseNotInitialized();
        assert (in.senderAddress == uninitedSt.collectionAddress) throw ERROR_NOT_FROM_COLLECTION;

        // using a message from collection, convert "uninitialized" to "initialized" state
        val initParams = NftItemInitAtDeployment.fromSlice(in.body);
        val storage: NftItemStorage = {
            itemIndex: uninitedSt.itemIndex,
            collectionAddress: uninitedSt.collectionAddress,
            ownerAddress: initParams.ownerAddress,
            content: initParams.content,
        };
        storage.save();
        return;
    }

    var storage = loadingStorage.parseInitialized();

    val msg = lazy AllowedMessageToNftItem.fromSlice(in.body);

    match (msg) {
        // Content-edit: ONLY the collection (== printer; admin == GM) may overwrite
        // the structured content. The recipe authority (owner/GM, later finer-grained)
        // is enforced upstream in R*'s ANVIL section; the item just trusts its collection.
        SetNftContent => {
            assert (in.senderAddress == storage.collectionAddress) throw ERROR_NOT_FROM_COLLECTION;
            storage.content = msg.newContent;
            storage.save();
        }

        // ⚒ ANVIL: user initiates a recipe on THIS item (the surviving/updated one).
        AnvilInit => {
            assert (in.senderAddress == storage.ownerAddress) throw ERROR_NOT_FROM_OWNER;
            val c = storage.content.load();
            val myAttrs: AnvilItemAttrs = {
                index: storage.itemIndex, origin: c.origin, itemType: c.itemType, tier: c.tier, seen: c.seen,
            };
            reserveAnvil(in.valueCoins);
            if (msg.hasSecond) {
                // Two-item: hop to item2 carrying our reported attrs.
                val item2Addr = calcDeployedNftItem(msg.item2Index, storage.collectionAddress, contract.getCode());
                val hop = AnvilHop {
                    queryId: msg.queryId, recipe: msg.recipe,
                    owner: storage.ownerAddress, item1: myAttrs.toCell(),
                };
                val out = createMessage({ bounce: BounceMode.NoBounce, dest: item2Addr.calculateAddress(), value: 0, body: hop });
                out.send(ANVIL_SEND_CARRY_ALL);
            } else {
                // Single-item: report straight to the collection.
                val report = AnvilReportToCollection {
                    queryId: msg.queryId, recipe: msg.recipe, owner: storage.ownerAddress,
                    isDouble: false, item1: myAttrs.toCell(), item2: null,
                };
                val out = createMessage({ bounce: BounceMode.NoBounce, dest: storage.collectionAddress, value: 0, body: report });
                out.send(ANVIL_SEND_CARRY_ALL);
            }
        }

        // ⚒ ANVIL: item1 -> item2. Verify the sender is the REAL item1 (by index in
        // this collection) and that the same user owns us; report both attrs onward.
        AnvilHop => {
            val i1 = msg.item1.load();
            val expectedItem1 = calcDeployedNftItem(i1.index, storage.collectionAddress, contract.getCode());
            assert (in.senderAddress == expectedItem1.calculateAddress()) throw ERROR_NOT_FROM_PREV;
            assert (storage.ownerAddress == msg.owner) throw ERROR_ANVIL_OWNER_MISMATCH;
            val c = storage.content.load();
            val myAttrs: AnvilItemAttrs = {
                index: storage.itemIndex, origin: c.origin, itemType: c.itemType, tier: c.tier, seen: c.seen,
            };
            reserveAnvil(in.valueCoins);
            val report = AnvilReportToCollection {
                queryId: msg.queryId, recipe: msg.recipe, owner: msg.owner,
                isDouble: true, item1: msg.item1, item2: myAttrs.toCell(),
            };
            val out = createMessage({ bounce: BounceMode.NoBounce, dest: storage.collectionAddress, value: 0, body: report });
            out.send(ANVIL_SEND_CARRY_ALL);
        }

        // ⚒ ANVIL combine return: collection tells item1 to take the new content and
        // then destroy the sacrificed item2.
        SetNftContentAndDestroy => {
            assert (in.senderAddress == storage.collectionAddress) throw ERROR_NOT_FROM_COLLECTION;
            storage.content = msg.newContent;
            storage.save();
            reserveAnvil(in.valueCoins);
            val item2Addr = calcDeployedNftItem(msg.item2Index, storage.collectionAddress, contract.getCode());
            val destroy = AnvilDestroyFromSibling {
                queryId: msg.queryId, item1Index: storage.itemIndex, cashbackTo: msg.cashbackTo,
            };
            val out = createMessage({ bounce: BounceMode.NoBounce, dest: item2Addr.calculateAddress(), value: 0, body: destroy });
            out.send(ANVIL_SEND_CARRY_ALL);
        }

        // ⚒ ANVIL combine: item2 destroys itself (sender must be the real item1) and
        // sends the remaining balance to the user as cashback.
        AnvilDestroyFromSibling => {
            val expectedItem1 = calcDeployedNftItem(msg.item1Index, storage.collectionAddress, contract.getCode());
            assert (in.senderAddress == expectedItem1.calculateAddress()) throw ERROR_NOT_FROM_PREV;
            val out = createMessage({ bounce: BounceMode.NoBounce, dest: msg.cashbackTo, value: 0, body: beginCell().endCell() });
            out.send(ANVIL_SEND_CARRY_ALL + ANVIL_SEND_DESTROY_IF_ZERO);
        }

        // ⚒ ANVIL melt: collection tells item1 to self-destruct + cashback (the RUDA
        // payout is minted separately by R* via the jetton minter).
        AnvilDestroy => {
            assert (in.senderAddress == storage.collectionAddress) throw ERROR_NOT_FROM_COLLECTION;
            val out = createMessage({ bounce: BounceMode.NoBounce, dest: msg.cashbackTo, value: 0, body: beginCell().endCell() });
            out.send(ANVIL_SEND_CARRY_ALL + ANVIL_SEND_DESTROY_IF_ZERO);
        }

        AskToChangeOwnership => {
            assert (in.senderAddress == storage.ownerAddress) throw ERROR_NOT_FROM_OWNER;

            assert (msg.forwardPayload.remainingBitsCount()) throw ERROR_INCORRECT_FORWARD_PAYLOAD;
            assert (msg.newOwnerAddress.getWorkchain() == BASECHAIN) throw ERROR_INVALID_WORKCHAIN;

            val fwdFee = in.originalForwardFee;
            var restAmount = contract.getOriginalBalance() - MIN_TONS_FOR_STORAGE;
            if (msg.forwardTonAmount) {
                restAmount -= (msg.forwardTonAmount + fwdFee);
            }
            if (msg.sendExcessesTo != null) {
                assert (msg.sendExcessesTo.getWorkchain() == BASECHAIN) throw ERROR_INVALID_WORKCHAIN;
                restAmount -= fwdFee;
            }

            assert (restAmount >= 0) throw ERROR_TOO_SMALL_REST_AMOUNT;

            if (msg.forwardTonAmount) {
                val ownershipMsg = createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: msg.newOwnerAddress,
                    value: msg.forwardTonAmount,
                    body: NotificationForNewOwner {
                        queryId: msg.queryId,
                        oldOwnerAddress: storage.ownerAddress,
                        payload: msg.forwardPayload,
                    }
                });
                ownershipMsg.send(SEND_MODE_PAY_FEES_SEPARATELY);
            }
            if (msg.sendExcessesTo != null) {
                val excessesMsg = createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: msg.sendExcessesTo,
                    value: restAmount,
                    body: ReturnExcessesBack {
                        queryId: msg.queryId,
                    }
                });
                excessesMsg.send(SEND_MODE_PAY_FEES_SEPARATELY);
            }

            storage.ownerAddress = msg.newOwnerAddress;
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
            // ignore empty messages, "wrong opcode" for others
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}


struct NftDataReply {
    isInitialized: bool
    itemIndex: int
    collectionAddress: address
    ownerAddress: address? = null
    content: Cell<NFTContent>? = null
}

get fun get_nft_data(): NftDataReply {
    var loadingStorage = startLoadingNftItemStorage();
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
    }
}

// Typed view of the structured content: returns origin, type, tier.
get fun get_nft_content_fields(): NFTContent {
    val storage = NftItemStorage.fromCell(contract.getData());
    return storage.content.load();
}
