// SPDX-License-Identifier: UNLICENSED
import "errors"
import "storage"
import "messages"

// =============================================================================
// SBTPrinter (collection) = GM-owned, R*-governed soulbound (sbtn) collection.
//
//   adminAddress == GameManager (the sole on-chain authority). Mints + revokes are
//   driven by the Retranslator over R1→R2→R3→R4: R* validates the recipe (mint =
//   game-or-owner; revoke = owner-only) and tells GM to emit DeploySbtn /
//   RevokeSbtnItem here; since sender == admin == GM, it passes.
//
// SBTPrinter items are NON-TRANSFERABLE (soulbound) and revocable. The item code is
// the proven, gate-fixed tep/sbtn SBTNItem (collection-only sbtn_init + EXACT
// destroy-reserve), supplied as `sbtnItemCode` at deploy time — the printer
// inherits that correct behavior for free.
//
// Surface: DeploySbtn (mint) + RevokeSbtnItem (revoke) + EditSbtItem (admin
// content-edit) + ChangeCollectionAdmin. Owner Destroy stays on the item.
// =============================================================================

// TON forwarded to an item when editing its content (storage already funded).
const EDIT_ITEM_FORWARD_AMOUNT: coins = ton("0.02");

fun deploySbtnItemWithStateInit(ownerAddress: address, index: uint256, sbtnItemCode: cell, attachTonAmount: coins, individualContent: cell) {
    val itemAddr = calcDeployedSbtnItem(index, contract.getAddress(), ownerAddress, sbtnItemCode);
    val deployMsg = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        dest: itemAddr,
        value: attachTonAmount,
        body: SbtnInit {
            queryId: 0,
            individualContent: individualContent,
        },
    });
    deployMsg.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

type AllowedMessageToSbtnPrinterCollection =
    | DeploySbtn
    | ChangeCollectionAdmin
    | RevokeSbtnItem
    | EditSbtItem

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessageToSbtnPrinterCollection.fromSlice(in.body);

    match (msg) {
        DeploySbtn => {
            var storage = lazy SbtnPrinterCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;

            deploySbtnItemWithStateInit(msg.ownerAddress, msg.index, storage.sbtnItemCode, msg.attachTonAmount, msg.individualContent);

            val isLast = msg.index == storage.nextItemIndex;
            if (isLast) {
                storage.nextItemIndex += 1;
                storage.save();
            }
        }

        ChangeCollectionAdmin => {
            var storage = lazy SbtnPrinterCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;
            storage.adminAddress = msg.newAdminAddress;
            storage.save();
        }

        RevokeSbtnItem => {
            var storage = lazy SbtnPrinterCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;
            val revokeMsg = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: msg.itemAddress,
                value: ton("0.01"),
                body: Revoke { queryId: msg.queryId },
            });
            revokeMsg.send(SEND_MODE_PAY_FEES_SEPARATELY);
        }

        // admin (== GM) edits an item's content. R*'s ANVIL section gates this to
        // the owner upstream; here we re-check sender == admin and forward
        // SetSbtContent to the item (the item checks sender == collection).
        EditSbtItem => {
            var storage = lazy SbtnPrinterCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;
            val editMsg = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: msg.itemAddress,
                value: EDIT_ITEM_FORWARD_AMOUNT,
                body: SetSbtContent {
                    queryId: msg.queryId,
                    newContent: msg.newContent,
                },
            });
            editMsg.send(SEND_MODE_PAY_FEES_SEPARATELY);
        }

        else => {
            assert (in.body.isEmpty()) throw ERROR_UNKNOWN_MESSAGE
        }
    }
}

struct SbtnCollectionDataReply {
    nextItemIndex: int
    collectionMetadata: cell
    adminAddress: address
}

get fun get_collection_data(): SbtnCollectionDataReply {
    val storage = lazy SbtnPrinterCollectionStorage.load();
    val content = lazy storage.content.load();

    return {
        nextItemIndex: storage.nextItemIndex as int,
        collectionMetadata: content.collectionMetadata,
        adminAddress: storage.adminAddress,
    }
}

get fun get_sbtn_address(ownerAddress: address, index: int): address {
    val storage = lazy SbtnPrinterCollectionStorage.load();
    val deployed = calcDeployedSbtnItem(index as uint256, contract.getAddress(), ownerAddress, storage.sbtnItemCode);
    return deployed.calculateAddress();
}

get fun get_sbtn_item_code(): cell {
    val storage = lazy SbtnPrinterCollectionStorage.load();
    return storage.sbtnItemCode;
}

get fun get_version(): int {
    val storage = lazy SbtnPrinterCollectionStorage.load();
    return storage.version;
}
