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
    | ReturnExcessesBack
    | LiteralyAnything

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessagesToUnit.fromSlice(in.body);
    var storage = lazy UnitStorage.load();

    match (msg) {
        SetPointer => {
            assert (in.senderAddress == storage.userAddress) throw ERR_UBPS_INVALID_OWNER_SENDER;
            storage.up = msg.up;          // any address, or null to clear
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
