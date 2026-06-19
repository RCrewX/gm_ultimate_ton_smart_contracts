// SPDX-License-Identifier: UNLICENSED
import "errors"
import "storage"
import "messages"

// =============================================================================
// UniversalBlockchainPassportPrinter (collection) = GM-owned, R*-governed soulbound
// passport collection (compile target: UniversalBlockchainPassportPrinter).
//
//   adminAddress == GameManager (the sole on-chain authority). EVERY content write runs
//   over R1->R2->R3->R4: R* validates the request and tells GM to emit PassportDeploy /
//   RevokePassportItem / EditPassportItem / EditPassportOwnerContent here; since sender
//   == admin == GM, it passes. Owners may SELF-DEPLOY their passport(id) (see the item
//   PassportOwnerInit), but EVERY content write — including the owner's own nickname —
//   is routed through this collection; the item has no direct owner op.
//
// Passport items are NON-TRANSFERABLE (soulbound) and revocable. Address derivation
// (calcDeployedPassportItem) is owner-bound (owner,id,collection,code) and content-free.
//
// Surface: PassportDeploy (system mint) + RevokePassportItem (revoke) + EditPassportItem
// (system content-edit) + EditPassportOwnerContent (owner-field/nickname edit) +
// ChangeCollectionAdmin.
// =============================================================================

// TON forwarded to an item when editing its content (storage already funded).
const EDIT_ITEM_FORWARD_AMOUNT: coins = ton("0.02");

fun deployPassportItemWithStateInit(ownerAddress: address, index: uint256, passportItemCode: cell, attachTonAmount: coins, individualContent: cell) {
    val itemAddr = calcDeployedPassportItem(index, contract.getAddress(), ownerAddress, passportItemCode);
    val deployMsg = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        dest: itemAddr,
        value: attachTonAmount,
        body: PassportInit {
            queryId: 0,
            individualContent: individualContent,
        },
    });
    deployMsg.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

type AllowedMessageToPassportPrinterCollection =
    | PassportDeploy
    | ChangeCollectionAdmin
    | RevokePassportItem
    | EditPassportItem
    | EditPassportOwnerContent

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessageToPassportPrinterCollection.fromSlice(in.body);

    match (msg) {
        PassportDeploy => {
            var storage = lazy PassportPrinterCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;

            deployPassportItemWithStateInit(msg.ownerAddress, msg.index, storage.passportItemCode, msg.attachTonAmount, msg.individualContent);

            val isLast = msg.index == storage.nextItemIndex;
            if (isLast) {
                storage.nextItemIndex += 1;
                storage.save();
            }
        }

        ChangeCollectionAdmin => {
            var storage = lazy PassportPrinterCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;
            storage.adminAddress = msg.newAdminAddress;
            storage.save();
        }

        RevokePassportItem => {
            var storage = lazy PassportPrinterCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;
            val revokeMsg = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: msg.itemAddress,
                value: ton("0.01"),
                body: Revoke { queryId: msg.queryId },
            });
            revokeMsg.send(SEND_MODE_PAY_FEES_SEPARATELY);
        }

        // admin (== GM) drives a SYSTEM content edit. R*'s ANVIL section gates the
        // recipe upstream; here we re-check sender == admin and forward
        // SetPassportSystemContent to the item (the item checks sender == collection
        // and MERGES the per-id system payload, preserving owner fields).
        EditPassportItem => {
            var storage = lazy PassportPrinterCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;
            val editMsg = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: msg.itemAddress,
                value: EDIT_ITEM_FORWARD_AMOUNT,
                body: SetPassportSystemContent {
                    queryId: msg.queryId,
                    newContent: msg.newContent,
                },
            });
            editMsg.send(SEND_MODE_PAY_FEES_SEPARATELY);
        }

        // admin (== GM, driven by R*) drives an OWNER-FIELD (nickname) edit. The owner
        // cannot pass a target item address: R* bound `ownerAddress` to the GM-attested
        // initiator, and we DERIVE the item address from (ownerAddress, index) — so an
        // owner can only ever reach THEIR OWN passport. Forward SetPassportOwnerContent
        // (the item checks sender == collection, asserts id=0, merges nickname).
        EditPassportOwnerContent => {
            var storage = lazy PassportPrinterCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;
            val itemAddr = calcDeployedPassportItem(msg.index, contract.getAddress(), msg.ownerAddress, storage.passportItemCode).calculateAddress();
            val ownerEditMsg = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: itemAddr,
                value: EDIT_ITEM_FORWARD_AMOUNT,
                body: SetPassportOwnerContent {
                    queryId: msg.queryId,
                    newContent: msg.newContent,
                },
            });
            ownerEditMsg.send(SEND_MODE_PAY_FEES_SEPARATELY);
        }

        else => {
            assert (in.body.isEmpty()) throw ERROR_UNKNOWN_MESSAGE
        }
    }
}

struct PassportCollectionDataReply {
    nextItemIndex: int
    collectionMetadata: cell
    adminAddress: address
}

get fun get_collection_data(): PassportCollectionDataReply {
    val storage = lazy PassportPrinterCollectionStorage.load();
    val content = lazy storage.content.load();

    return {
        nextItemIndex: storage.nextItemIndex as int,
        collectionMetadata: content.collectionMetadata,
        adminAddress: storage.adminAddress,
    }
}

get fun get_passport_address(ownerAddress: address, index: int): address {
    val storage = lazy PassportPrinterCollectionStorage.load();
    val deployed = calcDeployedPassportItem(index as uint256, contract.getAddress(), ownerAddress, storage.passportItemCode);
    return deployed.calculateAddress();
}

get fun get_passport_item_code(): cell {
    val storage = lazy PassportPrinterCollectionStorage.load();
    return storage.passportItemCode;
}

get fun get_version(): int {
    val storage = lazy PassportPrinterCollectionStorage.load();
    return storage.version;
}
