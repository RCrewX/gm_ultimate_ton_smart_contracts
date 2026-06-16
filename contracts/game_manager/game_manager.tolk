// SPDX-License-Identifier: UNLICENSED
import "static"

// =============================================================================
// GameManager (GM) = stable PIPE + sole on-chain AUTHORITY.
// It stores NO minter/games/printer addresses. It only:
//   - forwards inbound requests (R1 / jetton notifications) into the Retranslator
//     as R2 (attesting the initiator),
//   - emits whatever the Retranslator tells it to (R3 -> R4 send),
//   - owner-only config relay (RedirectMessage) and retranslator swap.
// GM never parses R*-private payloads.
// =============================================================================

type AllowedMessagesToGameManager =
    | SetRetranslator
    | R1
    | R3
    | TransferNotificationForRecipient
    | RedirectMessage
    | ReturnExcessesBack
    | LiteralyAnything


fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessagesToGameManager.fromSlice(in.body);
    var storage = lazy GameManagerStorage.load();
    match (msg) {

        // Owner swaps the brain. The whole point of the split: R* can be
        // redeployed/upgraded and pointed at here without touching GM.
        SetRetranslator => {
            assert (in.senderAddress == storage.ownerAddress) throw ERR_INVALID_OWNER_SENDER;
            assert (in.valueCoins >= GAS_COST_SET_RETRANSLATOR) throw ERR_MESSAGE_VALUE_TOO_LOW;
            storage.retranslatorAddress = msg.retranslatorAddress;
            storage.save();
            reserveValue(in.valueCoins);
            val responseMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: beginCell().endCell()
            });
            responseMsg.send(SEND_MODE_IGNORE_ERRORS + SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }

        // anyone -R1-> GM -R2-> R*. GM does NOT inspect R1.data.
        R1 => {
            reserveValue(in.valueCoins);
            val r2 = createMessage({
                bounce: BounceMode.NoBounce,
                dest: storage.retranslatorAddress,
                value: 0,
                body: R2 {
                    initiator: in.senderAddress,
                    data: msg.data,
                }
            });
            r2.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }

        // A jetton wallet notified GM. GM does NOT verify or parse it — it wraps
        // the raw body into an R2 and lets R* verify the wallet/initiator.
        TransferNotificationForRecipient => {
            reserveValue(in.valueCoins);
            val rawBody = beginCell().storeSlice(in.body).endCell();
            val r2 = createMessage({
                bounce: BounceMode.NoBounce,
                dest: storage.retranslatorAddress,
                value: 0,
                body: R2 {
                    initiator: in.senderAddress,
                    data: rawBody,
                }
            });
            r2.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }

        // R* -R3-> GM -R4-> recipient. GM emits R3.data to R3.recipient verbatim.
        R3 => {
            assert (in.senderAddress == storage.retranslatorAddress) throw ERR_INVALID_RETRANSLATOR_SENDER;
            reserveValue(in.valueCoins);
            val r4 = createMessage({
                bounce: BounceMode.NoBounce,
                dest: msg.recipient,
                value: 0,
                body: msg.data
            });
            r4.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }

        // Owner-gated config relay channel to R* (and any other destination).
        RedirectMessage => {
            assert (in.senderAddress == storage.ownerAddress) throw ERR_INVALID_OWNER_SENDER;
            assert (in.valueCoins >= GAS_COST_REDIRECT_MESSAGE) throw ERR_MESSAGE_VALUE_TOO_LOW;
            reserveValue(in.valueCoins);
            val redirectMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: msg.destination,
                value: msg.forwardTonAmount,
                body: msg.messageBody
            });
            redirectMsg.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }

        ReturnExcessesBack => {
            reserveValue(in.valueCoins);
            val cashbackMessage = createMessage({
                bounce: BounceMode.NoBounce,
                dest: storage.ownerAddress,
                value: 0,
                body: beginCell().endCell() // Empty body for simple transfer
            });
            cashbackMessage.send(SEND_MODE_IGNORE_ERRORS + SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }
        LiteralyAnything => {
            reserveValue(in.valueCoins);
        }
        else => {
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}

get fun get_owner_address(): address {
    var storage = lazy GameManagerStorage.load();
    return storage.ownerAddress;
}

get fun get_retranslator_address(): address {
    var storage = lazy GameManagerStorage.load();
    return storage.retranslatorAddress;
}
