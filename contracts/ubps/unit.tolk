// SPDX-License-Identifier: UNLICENSED
import "static"

// =============================================================================
// Unit (U) — the user's representation in UBPS. MUTABLE, but only the single Unit
// Pointer (up). The owning user freely re-points it at a BS/B, at another Unit
// (follow chain), or clears it to null. There is NO on-chain check that the target
// is a valid UBPS contract (concept decision #6) — correctness of the target is a
// frontend/backend concern. Follow-cycle detection is also off-chain (decision #4).
// =============================================================================

type AllowedMessagesToUnit =
    | SetPointer
    | InitUnitPointer
    | TraverseUp
    | ReturnExcessesBack
    | LiteralyAnything

// A forwarded TraverseUp can bounce back (the next hop ran out of gas and asserted, or
// the pointer target rejected it). Absorb it: the bounced value is already credited to
// our balance and TraverseUp edits no storage, so there is nothing to undo — just keep
// the funds here (the chain has terminated; nothing more to forward).
fun onBouncedMessage(in: InMessageBounced) {}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessagesToUnit.fromSlice(in.body);
    var storage = lazy UnitStorage.load();

    match (msg) {
        SetPointer => {
            assert (in.senderAddress == storage.userAddress) throw ERR_UBPS_INVALID_OWNER_SENDER;
            storage.up = msg.up;          // any address, or null to clear
            storage.save();
            // terminal (sends nothing): no reserve needed — the Unit keeps its balance.
        }

        // master-only INITIAL pointer (sent right after a CreateUnit deploy). Accepted
        // ONLY from the master AND ONLY while the pointer is still null — so it sets the
        // user-requested starting pointer but can NEVER override one the user has set.
        // Idempotent: a no-op (no throw) if the pointer is already set, so re-running a
        // CreateUnit on an existing Unit is safe and never clobbers the user's pointer.
        InitUnitPointer => {
            assert (in.senderAddress == storage.ubpsMaster) throw ERR_UBPS_NOT_MASTER;
            if (storage.up == null) {
                storage.up = msg.up;      // initial set (may itself be null = empty)
                storage.save();
            }
            // terminal (sends nothing): the Unit keeps the small deploy budget as storage.
        }

        // UP traversal: forward-or-refund. Storage is NEVER edited. `origOwner` is the
        // wallet to refund at the chain's terminal; it is body-supplied and SAFE here
        // (the initiator pays their own gas, so spoofing it only redirects the spoofer's
        // own leftover — NOT the in.senderAddress-gated create-op cashback).
        TraverseUp => {
            if (storage.up != null) {
                // Forward one more hop — but only if there is enough gas to fund it.
                // Each hop burns gas + re-asserts this floor, so a follow cycle
                // (Unit->Unit->Unit, allowed off-chain) is bounded by gas and simply
                // asserts-and-stops; there is NO on-chain cycle check and NO infinite loop.
                assert (in.valueCoins >= UBPS_UP_HOP_VALUE) throw ERR_UBPS_UP_VALUE_TOO_LOW;
                reserveValue(in.valueCoins);   // keep prior balance + storage tax
                val fwd = createMessage({
                    bounce: BounceMode.Only256BitsOfBody,
                    dest: storage.up!,
                    value: 0,
                    body: TraverseUp { origOwner: msg.origOwner },
                });
                fwd.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);  // forward all remaining gas
            } else {
                // Empty pointer: terminal — there is no BS to reach, so refund origOwner
                // with the leftover (keep our own prior balance + storage tax).
                reserveValue(in.valueCoins);
                val refund = createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: msg.origOwner,
                    value: 0,
                    body: ReturnExcessesBack { queryId: 0 },
                });
                refund.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
            }
        }

        ReturnExcessesBack => {
            // terminal catch-all (sends nothing): the Unit absorbs the value.
        }
        LiteralyAnything => {
            // terminal catch-all (sends nothing): the Unit absorbs the value.
        }
        else => {
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}

get fun get_pointer(): address? {
    val storage = lazy UnitStorage.load();
    return storage.up;
}

get fun get_user(): address {
    val storage = lazy UnitStorage.load();
    return storage.userAddress;
}

get fun get_master(): address {
    val storage = lazy UnitStorage.load();
    return storage.ubpsMaster;
}
