// SPDX-License-Identifier: UNLICENSED
import "@stdlib/gas-payments"
import "errors"
import "jetton-utils"
import "messages"
import "storage"
import "fees-management"


fun _assertFitsVarUint32(x: uint256) {
    // varuint32 => len is 5 bits => 0..31 bytes => max 248 bits
    var len = 0;
    var t = x;
    while (t > 0) {
        len += 1;
        t = t / 256;
    }
    // If x==0 => len==0 is representable by TL-B, but for multiplier we disallow 0 outside.
    assert (len <= 31) throw ERR_INVALID_OP;
}

fun emitDisplayMultiplierChanged(numerator: uint256, denominator: uint256, comment: cell?) {
    // TEP-526 display multiplier must be positive for display purposes
    assert (numerator > 0) throw ERR_INVALID_OP;
    assert (denominator > 0) throw ERR_INVALID_OP;

    _assertFitsVarUint32(numerator);
    _assertFitsVarUint32(denominator);

    val body = DisplayMultiplierChanged{
        numerator: numerator as varuint32,
        denominator: denominator as varuint32,
        comment: comment,
    };

    // external-out event (dest = addr_none)
    val msg = createExternalLogMessage({
        dest: createAddressNone(),
        body: body,
    });

    // ignore errors so logging can't break main logic
    msg.send(SEND_MODE_IGNORE_ERRORS);
}


type AllowedMessageToMinter =
    | MintNewJettons
    | BurnNotificationForMinter
    | RequestWalletAddress
    | ChangeMinterAdmin
    | ChangeMinterContent
    | ChangeDisplayMultiplier

fun onInternalMessage(in: InMessage) {
    // Check if this is initialization (first message with empty body)
    // TEP-526 requires emitting display_multiplier_changed on initialization
    if (in.body.isEmpty()) {
        var storage = lazy MinterStorage.load();
        // Emit display_multiplier_changed external-out message on init (TEP-526)
        emitDisplayMultiplierChanged(storage.displayNumerator, storage.displayDenominator, null);
    }
    
    val msg = lazy AllowedMessageToMinter.fromSlice(in.body);

    match (msg) {
        BurnNotificationForMinter => {
            // Using lazy for partial update - compiler handles efficient write-back via toCell()
            var storage = lazy MinterStorage.load();
            assert (in.senderAddress == calcAddressOfJettonWallet(msg.burnInitiator, contract.getAddress(), storage.jettonWalletCode)) throw ERR_UNAUTHORIZED_BURN;

            storage.totalSupply -= msg.jettonAmount;
            storage.save();

            if (msg.sendExcessesTo == null) {
                return;
            }

            val excessesMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: msg.sendExcessesTo,
                value: 0,
                body: ReturnExcessesBack {
                    queryId: msg.queryId
                }
            });
            excessesMsg.send(SEND_MODE_IGNORE_ERRORS + SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        RequestWalletAddress => {
            assert (in.valueCoins > in.originalForwardFee + MINIMAL_MESSAGE_VALUE_BOUND) throw ERR_NOT_ENOUGH_AMOUNT_TO_RESPOND;

            var respondOwnerAddress: Cell<address>? = msg.includeOwnerAddress
                ? msg.ownerAddress.toCell()
                : null;

            var walletAddress: address? = null;
            if (msg.ownerAddress.getWorkchain() == BASECHAIN) {
                var storage = lazy MinterStorage.load();
                walletAddress = calcAddressOfJettonWallet(msg.ownerAddress, contract.getAddress(), storage.jettonWalletCode);
            }

            val respondMsg = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: in.senderAddress,
                value: 0,
                body: ResponseWalletAddress {
                    queryId: msg.queryId,
                    jettonWalletAddress: walletAddress,
                    ownerAddress: respondOwnerAddress,
                }
            });
            respondMsg.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        MintNewJettons => {
            // Using lazy for partial update - compiler handles efficient write-back via toCell()
            var storage = lazy MinterStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERR_NOT_FROM_ADMIN;

            var internalTransferMsg = lazy msg.internalTransferMsg.load();
            storage.totalSupply += internalTransferMsg.jettonAmount;
            storage.save();

            val deployMsg = createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                dest: calcDeployedJettonWallet(msg.mintRecipient, contract.getAddress(), storage.jettonWalletCode),
                value: msg.tonAmount,
                body: msg.internalTransferMsg,  // a newly-deployed wallet contract will immediately handle it
            });
            deployMsg.send(SEND_MODE_PAY_FEES_SEPARATELY);
        }

        ChangeMinterAdmin => {
            // Using lazy for partial update - compiler handles efficient write-back via toCell()
            var storage = lazy MinterStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERR_NOT_FROM_ADMIN;
            storage.adminAddress = msg.newAdminAddress;
            storage.save();
        }

        ChangeMinterContent => {
            // Using lazy for partial update - compiler handles efficient write-back via toCell()
            var storage = lazy MinterStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERR_NOT_FROM_ADMIN;
            storage.content = msg.newContent;
            storage.save();
        }

        ChangeDisplayMultiplier => {
            // Using lazy for partial update - compiler handles efficient write-back via toCell()
            var storage = lazy MinterStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERR_NOT_FROM_ADMIN;
            // Validate positive values (required for display multiplier and VarUInteger encoding)
            assert (msg.numerator > 0) throw ERR_INVALID_OP;
            assert (msg.denominator > 0) throw ERR_INVALID_OP;
            
            storage.displayNumerator = msg.numerator;
            storage.displayDenominator = msg.denominator;
            storage.save();
            
            // Send display_multiplier_changed external-out message (TEP-526)
            // TEP-526: display_multiplier_changed#ac392598 numerator:(VarUInteger 32) denominator:(VarUInteger 32) comment:(Maybe SnakeString)
            // msg.comment is already a cell? (SnakeString format), use it directly
            emitDisplayMultiplierChanged(msg.numerator, msg.denominator, msg.comment);
        }

        else => {
            // ignore empty messages, "wrong opcode" for others
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}



struct JettonDataReply {
    totalSupply: int
    mintable: bool
    adminAddress: address
    jettonContent: cell
    jettonWalletCode: cell
}

get fun get_jetton_data(): JettonDataReply {
    val storage = lazy MinterStorage.load();

    return {
        totalSupply: storage.totalSupply,
        mintable: true,
        adminAddress: storage.adminAddress,
        jettonContent: storage.content,
        jettonWalletCode: storage.jettonWalletCode,
    }
}

get fun get_wallet_address(ownerAddress: address): address {
    val storage = lazy MinterStorage.load();
    return calcAddressOfJettonWallet(ownerAddress, contract.getAddress(), storage.jettonWalletCode);
}

struct DisplayMultiplierReply {
    numerator: uint256
    denominator: uint256
}

get fun get_display_multiplier(): DisplayMultiplierReply {
    val storage = lazy MinterStorage.load();
    return {
        numerator: storage.displayNumerator,
        denominator: storage.displayDenominator,
    }
}
