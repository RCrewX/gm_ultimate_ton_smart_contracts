// SPDX-License-Identifier: UNLICENSED
import "errors"
import "storage"
import "messages"

// =============================================================================
// NFTPrinter (collection) = GM-owned, R*-governed TEP-62 collection.
//
//   adminAddress == GameManager (the sole on-chain authority). Mints are driven
//   by the Retranslator over R1→R2→R3→R4: R* validates the recipe (game-or-owner)
//   and tells GM to emit DeployNft here; since sender == admin == GM, it passes.
//
// NFTPrinter items are TEP-62 TRANSFERABLE (game NFTs are tradeable). The item
// code is the proven tep/nft NFTItem, supplied as `nftItemCode` at deploy time.
//
// Surface: DeployNft (mint) + EditNftItem (admin content-edit) +
// ChangeCollectionAdmin + RequestRoyaltyParams.
// =============================================================================

// TON forwarded to an item when editing its content (item storage is already
// funded; this just covers the receive + setData gas).
const EDIT_ITEM_FORWARD_AMOUNT: coins = ton("0.02");

fun deployNftItem(itemIndex: int, nftItemCode: cell, attachTonAmount: coins, initParams: Cell<NftItemInitAtDeployment>) {
    val deployMsg = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        dest: calcDeployedNftItem(itemIndex, contract.getAddress(), nftItemCode),
        value: attachTonAmount,
        body: initParams,
    });
    deployMsg.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

// EXACT-reserve for an ANVIL hop: keep the collection's prior balance, forward
// only the incoming value (carry-all) down the chain.
fun reserveAnvilCollection(msgValue: coins) {
    val keep = contract.getOriginalBalance() - msgValue;
    reserveToncoinsOnBalance(keep, RESERVE_MODE_EXACT_AMOUNT);
}

type AllowedMessageToNftPrinterCollection =
    | RequestRoyaltyParams
    | DeployNft
    | EditNftItem
    | ChangeCollectionAdmin
    | AnvilReportToCollection   // ⚒ item -> collection: verified recipe request
    | PrinterAnvilApply         // ⚒ GM -> collection: apply R*'s computed outcome

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessageToNftPrinterCollection.fromSlice(in.body);

    match (msg) {
        DeployNft => {
            var storage = lazy NftPrinterCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;
            assert (msg.itemIndex <= storage.nextItemIndex) throw ERROR_INVALID_ITEM_INDEX;

            val isLast = msg.itemIndex == storage.nextItemIndex;
            deployNftItem(msg.itemIndex, storage.nftItemCode, msg.attachTonAmount, msg.initParams);
            if (isLast) {
                storage.nextItemIndex += 1;
                storage.save();
            }
        }

        // admin (== GM) edits an item's content. R*'s ANVIL section gates this to
        // the owner upstream; here we only re-check sender == admin and forward
        // SetNftContent to the target item (the item checks sender == collection).
        EditNftItem => {
            val storage = lazy NftPrinterCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;
            val editMsg = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: msg.itemAddress,
                value: EDIT_ITEM_FORWARD_AMOUNT,
                body: SetNftContent {
                    queryId: msg.queryId,
                    newContent: msg.newContent,
                },
            });
            editMsg.send(SEND_MODE_PAY_FEES_SEPARATELY);
        }

        RequestRoyaltyParams => {
            val storage = lazy NftPrinterCollectionStorage.load();
            val respondMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: ResponseRoyaltyParams {
                    queryId: msg.queryId,
                    royaltyParams: storage.royaltyParams.load(),
                }
            });
            respondMsg.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        ChangeCollectionAdmin => {
            var storage = lazy NftPrinterCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;
            storage.adminAddress = msg.newAdminAddress;
            storage.save();
        }

        // ⚒ ANVIL: a verified item reports the recipe + attributes. The reporting
        // item (item2 if two-item, else item1) MUST be the real item at its index
        // in THIS collection — that closes the trust chain (item1 was already
        // verified by item2's prev-address gate). We then wrap the request into an
        // R1 to GM, which forwards it to R* for validation + content computation.
        AnvilReportToCollection => {
            val storage = lazy NftPrinterCollectionStorage.load();
            var reporterIndex: uint64 = 0;
            if (msg.isDouble) {
                val i2 = msg.item2!.load();
                reporterIndex = i2.index;
            } else {
                val i1 = msg.item1.load();
                reporterIndex = i1.index;
            }
            val expectedReporter = calcDeployedNftItem(reporterIndex, contract.getAddress(), storage.nftItemCode);
            assert (in.senderAddress == expectedReporter.calculateAddress()) throw ERROR_NOT_FROM_PREV;

            reserveAnvilCollection(in.valueCoins);

            var requestBody: cell;
            if (msg.isDouble) {
                // COMBINE / MULTISPLAV
                val anvil = AnvilCombine {
                    recipe: msg.recipe, owner: msg.owner, item1: msg.item1, item2: msg.item2!,
                };
                requestBody = anvil.toCell();
            } else if (msg.recipe == ANVIL_RECIPE_MELT) {
                val anvil = AnvilMelt { owner: msg.owner, item1: msg.item1 };
                requestBody = anvil.toCell();
            } else {
                // ZERO_TYPE / ZERO_TIER
                val anvil = AnvilTransform { recipe: msg.recipe, owner: msg.owner, item1: msg.item1 };
                requestBody = anvil.toCell();
            }

            val r1 = R1 { data: requestBody };
            val out = createMessage({
                bounce: BounceMode.NoBounce, dest: storage.adminAddress, value: 0, body: r1,
            });
            out.send(ANVIL_SEND_CARRY_ALL);
        }

        // ⚒ ANVIL: GM delivers R*'s computed outcome. Apply it to the item(s).
        PrinterAnvilApply => {
            val storage = lazy NftPrinterCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;
            reserveAnvilCollection(in.valueCoins);

            val item1Addr = calcDeployedNftItem(msg.item1Index, contract.getAddress(), storage.nftItemCode).calculateAddress();

            if (msg.kind == ANVIL_OUT_UPDATE) {
                val set = SetNftContent { queryId: msg.queryId, newContent: msg.newContent };
                val out = createMessage({ bounce: BounceMode.NoBounce, dest: item1Addr, value: 0, body: set });
                out.send(ANVIL_SEND_CARRY_ALL);
            } else if (msg.kind == ANVIL_OUT_UPDATE_DESTROY) {
                val setd = SetNftContentAndDestroy {
                    queryId: msg.queryId, newContent: msg.newContent,
                    item2Index: msg.item2Index, cashbackTo: msg.owner,
                };
                val out = createMessage({ bounce: BounceMode.NoBounce, dest: item1Addr, value: 0, body: setd });
                out.send(ANVIL_SEND_CARRY_ALL);
            } else {
                // ANVIL_OUT_MELT: destroy item1 (RUDA minted by R* via the minter).
                val destroy = AnvilDestroy { queryId: msg.queryId, cashbackTo: msg.owner };
                val out = createMessage({ bounce: BounceMode.NoBounce, dest: item1Addr, value: 0, body: destroy });
                out.send(ANVIL_SEND_CARRY_ALL);
            }
        }

        else => {
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}


struct CollectionDataReply {
    nextItemIndex: int
    collectionMetadata: cell
    adminAddress: address
}

struct (0x01) OffchainMetadataReply {
    string: SnakeString
}

get fun get_collection_data(): CollectionDataReply {
    val storage = lazy NftPrinterCollectionStorage.load();
    val content = lazy storage.content.load();

    return {
        nextItemIndex: storage.nextItemIndex,
        collectionMetadata: content.collectionMetadata,
        adminAddress: storage.adminAddress,
    }
}

get fun get_nft_address_by_index(itemIndex: int): address {
    val storage = lazy NftPrinterCollectionStorage.load();
    val nftDeployed = calcDeployedNftItem(itemIndex, contract.getAddress(), storage.nftItemCode);
    return nftDeployed.calculateAddress();
}

get fun royalty_params(): RoyaltyParams {
    val storage = lazy NftPrinterCollectionStorage.load();
    return storage.royaltyParams.load();
}

get fun get_nft_content(itemIndex: int, individualNftContent: Cell<NFTContent>): Cell<OffchainMetadataReply> {
    val storage = lazy NftPrinterCollectionStorage.load();
    val content = lazy storage.content.load();

    return OffchainMetadataReply {
        string: beginCell()
            .storeSlice(content.commonContent.load())
            .storeRef(individualNftContent)
            .endCell().beginParse()
    }.toCell()
}

get fun get_version(): int {
    val storage = lazy NftPrinterCollectionStorage.load();
    return storage.version;
}
