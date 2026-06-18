// SPDX-License-Identifier: UNLICENSED
import "static"

// =============================================================================
// Answer (A) — holds the answer bytes, bound to its Question via questionAddress.
// Deployed inactive by anyone; activated ONLY by the UBPS master (which verified
// sha256(answerBytes) == answerId). IMMUTABLE once activated.
// =============================================================================

type AllowedMessagesToAnswer =
    | ActivateAnswerMsg
    | ReturnExcessesBack
    | LiteralyAnything

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessagesToAnswer.fromSlice(in.body);
    var storage = lazy AnswerStorage.load();

    match (msg) {
        ActivateAnswerMsg => {
            assert (in.senderAddress == storage.ubpsMaster) throw ERR_UBPS_NOT_MASTER;
            assert (!storage.active) throw ERR_UBPS_ALREADY_ACTIVE;
            storage.answerBytes = msg.answerBytes;
            storage.active = true;
            storage.save();
            // terminal (sends nothing): the A keeps the small deploy budget as storage.
        }

        ReturnExcessesBack => {
            // terminal catch-all (sends nothing): the A absorbs the value.
        }
        LiteralyAnything => {
            // terminal catch-all (sends nothing): the A absorbs the value.
        }
        else => {
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}

get fun get_active(): bool {
    val storage = lazy AnswerStorage.load();
    return storage.active;
}

get fun get_answer(): cell? {
    val storage = lazy AnswerStorage.load();
    return storage.answerBytes;
}

get fun get_id(): int {
    val storage = lazy AnswerStorage.load();
    return storage.answerId;
}

get fun get_question_address(): address {
    val storage = lazy AnswerStorage.load();
    return storage.questionAddress;
}

get fun get_master(): address {
    val storage = lazy AnswerStorage.load();
    return storage.ubpsMaster;
}
