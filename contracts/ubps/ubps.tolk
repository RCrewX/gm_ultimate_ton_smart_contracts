// SPDX-License-Identifier: UNLICENSED
import "static"

// =============================================================================
// UBPS — master / root authority of the Universal Belief & Political System.
//
// Everything that must be tracked off-chain passes THROUGH the master:
//   * Q/A activation — the master verifies sha256(string) == id and deploys+
//     activates the deterministic Question/Answer contract.
//   * BS/B creation   — the master assigns the next monotonic index and deploys
//     the (immutable) BeliefSet with its full content.
// The master holds NO RUDA/jetton logic and never touches the GM/R* pipe — its
// only job is to be the single funnel so the backend can watch the right addresses.
// =============================================================================

type AllowedMessagesToUBPS =
    | ActivateQuestion
    | ActivateAnswer
    | CreateBeliefSet
    | ReturnExcessesBack
    | LiteralyAnything

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessagesToUBPS.fromSlice(in.body);
    var storage = lazy UBPSStorage.load();

    match (msg) {

        // ---- Activate a Question: verify the hash, then deploy+activate the Q ----
        ActivateQuestion => {
            assert (in.valueCoins >= UBPS_MIN_OP_VALUE) throw ERR_UBPS_VALUE_TOO_LOW;
            val computedId = msg.questionBytes.beginParse().bitsHash();
            assert (computedId == msg.questionId) throw ERR_UBPS_HASH_MISMATCH;

            reserveValue(in.valueCoins);
            val activate: ActivateQuestionMsg = { questionBytes: msg.questionBytes };
            val out = createMessage({
                bounce: BounceMode.NoBounce,
                dest: calcQuestionDeploy(contract.getAddress(), msg.questionId, storage.questionCode),
                value: 0,
                body: activate,
            });
            out.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }

        // ---- Activate an Answer bound to a Question ----
        ActivateAnswer => {
            assert (in.valueCoins >= UBPS_MIN_OP_VALUE) throw ERR_UBPS_VALUE_TOO_LOW;
            val computedId = msg.answerBytes.beginParse().bitsHash();
            assert (computedId == msg.answerId) throw ERR_UBPS_HASH_MISMATCH;

            reserveValue(in.valueCoins);
            val activate: ActivateAnswerMsg = { answerBytes: msg.answerBytes };
            val out = createMessage({
                bounce: BounceMode.NoBounce,
                dest: calcAnswerDeploy(contract.getAddress(), msg.questionAddress, msg.answerId, storage.answerCode),
                value: 0,
                body: activate,
            });
            out.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }

        // ---- Create a BeliefSet (root=false) or final B (root=true) ----
        CreateBeliefSet => {
            assert (in.valueCoins >= UBPS_MIN_OP_VALUE) throw ERR_UBPS_VALUE_TOO_LOW;
            assert (msg.aCount <= MAX_A) throw ERR_UBPS_TOO_MANY_A;
            assert (msg.bsCount <= MAX_BS) throw ERR_UBPS_TOO_MANY_BS;

            val index = storage.nextBsIndex;
            val populate: PopulateBeliefSet = {
                root: msg.root,
                aCount: msg.aCount,
                bsCount: msg.bsCount,
                aSet: msg.aSet,
                bsSet: msg.bsSet,
            };
            storage.nextBsIndex = index + 1;
            storage.save();
            reserveValue(in.valueCoins);
            val out = createMessage({
                bounce: BounceMode.NoBounce,
                dest: calcBeliefSetDeploy(contract.getAddress(), index, storage.beliefSetCode),
                value: 0,
                body: populate,
            });
            out.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
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

// =============================================================================
//  Get-methods
// =============================================================================
get fun get_owner(): address {
    val storage = lazy UBPSStorage.load();
    return storage.ownerAddress;
}

get fun get_next_bs_index(): int {
    val storage = lazy UBPSStorage.load();
    return storage.nextBsIndex;
}

// Child codes (unit, question, answer, beliefSet) for off-chain address calc.
get fun get_codes(): (cell, cell, cell, cell) {
    val storage = lazy UBPSStorage.load();
    return (storage.unitCode, storage.questionCode, storage.answerCode, storage.beliefSetCode);
}

get fun get_unit_address(userAddress: address): address {
    val storage = lazy UBPSStorage.load();
    return calcUnitAddress(contract.getAddress(), userAddress, storage.unitCode);
}

get fun get_question_address(questionId: uint256): address {
    val storage = lazy UBPSStorage.load();
    return calcQuestionAddress(contract.getAddress(), questionId, storage.questionCode);
}

get fun get_answer_address(questionAddress: address, answerId: uint256): address {
    val storage = lazy UBPSStorage.load();
    return calcAnswerAddress(contract.getAddress(), questionAddress, answerId, storage.answerCode);
}

get fun get_belief_set_address(bsIndex: int): address {
    val storage = lazy UBPSStorage.load();
    return calcBeliefSetAddress(contract.getAddress(), bsIndex as uint64, storage.beliefSetCode);
}
