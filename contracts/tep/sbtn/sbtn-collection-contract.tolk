// SPDX-License-Identifier: UNLICENSED
import "errors"
import "storage"
import "messages"

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

type AllowedMessageToSbtnCollection =
    | DeploySbtn
    | ChangeCollectionAdmin
    | RevokeSbtnItem

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessageToSbtnCollection.fromSlice(in.body);

    match (msg) {
        DeploySbtn => {
            var storage = lazy SbtnCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;
            // assert (msg.index <= storage.nextItemIndex) throw ERROR_INVALID_ITEM_INDEX;

            deploySbtnItemWithStateInit(msg.ownerAddress, msg.index, storage.sbtnItemCode, msg.attachTonAmount, msg.individualContent);

            val isLast = msg.index == storage.nextItemIndex;
            if (isLast) {
                storage.nextItemIndex += 1;
                storage.save();
            }
        }

        ChangeCollectionAdmin => {
            var storage = lazy SbtnCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;
            storage.adminAddress = msg.newAdminAddress;
            storage.save();
        }

        RevokeSbtnItem => {
            var storage = lazy SbtnCollectionStorage.load();
            
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;
            val revokeMsg = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: msg.itemAddress,
                value: ton("0.01"),
                body: Revoke { queryId: msg.queryId },
            });
            revokeMsg.send(SEND_MODE_PAY_FEES_SEPARATELY);
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
    val storage = lazy SbtnCollectionStorage.load();
    val content = lazy storage.content.load();

    return {
        nextItemIndex: storage.nextItemIndex as int,
        collectionMetadata: content.collectionMetadata,
        adminAddress: storage.adminAddress,
    }
}

get fun get_sbtn_address(ownerAddress: address, index: int): address {
    val storage = lazy SbtnCollectionStorage.load();
    val deployed = calcDeployedSbtnItem(index as uint256, contract.getAddress(), ownerAddress, storage.sbtnItemCode);
    return deployed.calculateAddress();
}

get fun get_sbtn_item_code(): cell {
    val storage = lazy SbtnCollectionStorage.load();
    return storage.sbtnItemCode;
}
