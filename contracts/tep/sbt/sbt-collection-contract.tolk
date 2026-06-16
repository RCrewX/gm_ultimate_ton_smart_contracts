// SPDX-License-Identifier: UNLICENSED
import "errors"
import "storage"
import "messages"

fun deploySbtItem(itemIndex: int, sbtItemCode: cell, attachTonAmount: coins, initParams: Cell<SbtItemInitAtDeployment>) {
    val deployMsg = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        dest: calcDeployedSbtItem(itemIndex, contract.getAddress(), sbtItemCode),
        value: attachTonAmount,
        body: initParams,
    });
    deployMsg.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

type AllowedMessageToSbtCollection =
    | DeploySbt
    | BatchDeploySbt
    | ChangeCollectionAdmin

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessageToSbtCollection.fromSlice(in.body);

    match (msg) {
        DeploySbt => {
            var storage = lazy SbtCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;
            assert (msg.itemIndex <= storage.nextItemIndex) throw ERROR_INVALID_ITEM_INDEX;

            val isLast = msg.itemIndex == storage.nextItemIndex;
            deploySbtItem(msg.itemIndex, storage.sbtItemCode, msg.attachTonAmount, msg.initParams);
            if (isLast) {
                storage.nextItemIndex += 1;
                storage.save();
            }
        }

        BatchDeploySbt => {
            var storage = lazy SbtCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;

            var counter = 0;
            var r = msg.deployList.findFirst();
            while (r.isFound) {
                counter += 1;
                assert (counter < 250) throw ERROR_BATCH_LIMIT_EXCEEDED;

                val itemIndex = r.getKey();
                assert (itemIndex <= storage.nextItemIndex) throw ERROR_NOT_FROM_ADMIN + counter;

                val dictItem = r.loadValue();
                deploySbtItem(itemIndex, storage.sbtItemCode, dictItem.attachTonAmount, dictItem.initParams);
                if (itemIndex == storage.nextItemIndex) {
                    storage.nextItemIndex += 1;
                }

                r = msg.deployList.iterateNext(r);
            }
            storage.save();
        }

        ChangeCollectionAdmin => {
            var storage = lazy SbtCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_NOT_FROM_ADMIN;
            storage.adminAddress = msg.newAdminAddress;
            storage.save();
        }

        else => {
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}

struct SbtCollectionDataReply {
    nextItemIndex: int
    collectionMetadata: cell
    adminAddress: address
}

get fun get_collection_data(): SbtCollectionDataReply {
    val storage = lazy SbtCollectionStorage.load();
    val content = lazy storage.content.load();

    return {
        nextItemIndex: storage.nextItemIndex,
        collectionMetadata: content.collectionMetadata,
        adminAddress: storage.adminAddress,
    }
}

get fun get_sbt_address_by_index(itemIndex: int): address {
    val storage = lazy SbtCollectionStorage.load();
    val deployed = calcDeployedSbtItem(itemIndex, contract.getAddress(), storage.sbtItemCode);
    return deployed.calculateAddress();
}
