// SPDX-License-Identifier: UNLICENSED
import "static"

// =============================================================================
// Question (Q) — holds the question bytes. Deployed inactive by anyone; becomes
// active ONLY on the activation message from the UBPS master (which has already
// verified sha256(questionBytes) == questionId). IMMUTABLE once activated.
// =============================================================================

type AllowedMessagesToQuestion =
    | ActivateQuestionMsg
    | ReturnExcessesBack
    | LiteralyAnything

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessagesToQuestion.fromSlice(in.body);
    var storage = lazy QuestionStorage.load();

    match (msg) {
        ActivateQuestionMsg => {
            assert (in.senderAddress == storage.ubpsMaster) throw ERR_UBPS_NOT_MASTER;
            assert (!storage.active) throw ERR_UBPS_ALREADY_ACTIVE;
            storage.questionBytes = msg.questionBytes;
            storage.active = true;
            storage.save();
            reserveValue(in.valueCoins);
        }

        ReturnExcessesBack => {
            reserveValue(in.valueCoins);
        }
        LiteralyAnything => {
            reserveValue(in.valueCoins);
        }
        else => {
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}

get fun get_active(): bool {
    val storage = lazy QuestionStorage.load();
    return storage.active;
}

get fun get_question(): cell? {
    val storage = lazy QuestionStorage.load();
    return storage.questionBytes;
}

get fun get_id(): int {
    val storage = lazy QuestionStorage.load();
    return storage.questionId;
}

get fun get_master(): address {
    val storage = lazy QuestionStorage.load();
    return storage.ubpsMaster;
}
