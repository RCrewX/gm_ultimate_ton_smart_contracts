// SPDX-License-Identifier: UNLICENSED
import "ssm_common"
import "ssm_slot_static"

// =============================================================================
// SSMSlot — ephemeral, one per reel, owned by its SoullessSlotMachine.
//
// Stateless w.r.t. a roll: storage is only {ssmAddress, reelIndex}. On a RollStep
// it block-seed rolls ONE symbol in its OWN transaction, appends it at its reel
// position, and forwards to the next slot (or returns the result to SSM if it is
// the last reel). reserveValue keeps the 0.01 storage tax; the rest carries on,
// so the value flows down the chain and back to SSM. Slot addresses are stable
// and reused every roll.
//
// Sender gate uses contract.getCode() (this slot's own code) — NOT a code cell
// from the message — so an attacker cannot forge a previous-slot address by
// supplying crafted code.
// =============================================================================

type AllowedMessagesToSlot =
    | RollStep

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessagesToSlot.fromSlice(in.body);
    var storage = lazy SSMSlotStorage.load();

    match (msg) {
        RollStep => {
            // Only the SSM (reel 0) or the immediately preceding slot may drive us.
            var expectedSender: address = storage.ssmAddress;
            if (storage.reelIndex != 0) {
                expectedSender = calcAddressOfSlot(storage.ssmAddress, storage.reelIndex - 1, contract.getCode());
            }
            assert (in.senderAddress == expectedSender) throw ERR_SLOT_INVALID_SENDER;

            reserveValue(in.valueCoins);

            // Block-seed RNG, one symbol in {0,1,2} == {ZERO,SEVEN,X}.
            random.initialize();
            val sym = random.range(3);
            val newSymbols = appendSymbol(msg.symbols, storage.reelIndex, sym);

            if (storage.reelIndex >= SSM_REELS - 1) {
                // Last reel -> return the completed result to SSM.
                val result: RollResult = {
                    ctx: msg.ctx,
                    symbols: newSymbols as uint8,
                };
                val out = createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: storage.ssmAddress,
                    value: 0,
                    body: result,
                });
                out.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
            } else {
                // Forward to the next reel (deploying it if needed).
                val nextStep: RollStep = {
                    ctx: msg.ctx,
                    symbols: newSymbols as uint8,
                };
                val out = createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: calcDeployedSlot(storage.ssmAddress, storage.reelIndex + 1, contract.getCode()),
                    value: 0,
                    body: nextStep,
                });
                out.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
            }
        }

        else => {
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}

get fun get_ssm_address(): address {
    val storage = lazy SSMSlotStorage.load();
    return storage.ssmAddress;
}

get fun get_reel_index(): int {
    val storage = lazy SSMSlotStorage.load();
    return storage.reelIndex;
}
