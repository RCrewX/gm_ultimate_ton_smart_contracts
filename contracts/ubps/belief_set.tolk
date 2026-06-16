// SPDX-License-Identifier: UNLICENSED
import "static"

// =============================================================================
// BeliefSet (BS) — a set of atomic beliefs (A addresses) plus nested sets (BS
// addresses, recursion). B (final public profile) is just a BS with root=true.
// Created ONCE by the UBPS master at a monotonic index with its full content, then
// IMMUTABLE (no setters). Size caps MAX_A / MAX_BS are checked at creation; NO
// on-chain dedup / belief-validity (concept decision #2 — that is off-chain).
// =============================================================================

type AllowedMessagesToBeliefSet =
    | PopulateBeliefSet
    | ReturnExcessesBack
    | LiteralyAnything

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessagesToBeliefSet.fromSlice(in.body);
    var storage = lazy BeliefSetStorage.load();

    match (msg) {
        PopulateBeliefSet => {
            assert (in.senderAddress == storage.ubpsMaster) throw ERR_UBPS_NOT_MASTER;
            assert (!storage.created) throw ERR_UBPS_ALREADY_CREATED;
            assert (msg.aCount <= MAX_A) throw ERR_UBPS_TOO_MANY_A;
            assert (msg.bsCount <= MAX_BS) throw ERR_UBPS_TOO_MANY_BS;
            storage.created = true;
            storage.root = msg.root;
            storage.aCount = msg.aCount;
            storage.bsCount = msg.bsCount;
            storage.aSet = msg.aSet;
            storage.bsSet = msg.bsSet;
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

get fun get_created(): bool {
    val storage = lazy BeliefSetStorage.load();
    return storage.created;
}

get fun get_root(): bool {
    val storage = lazy BeliefSetStorage.load();
    return storage.root;
}

get fun get_index(): int {
    val storage = lazy BeliefSetStorage.load();
    return storage.bsIndex;
}

// Returns (aCount, bsCount, aSet, bsSet).
get fun get_sets(): (int, int, cell, cell) {
    val storage = lazy BeliefSetStorage.load();
    return (storage.aCount, storage.bsCount, storage.aSet, storage.bsSet);
}

get fun get_master(): address {
    val storage = lazy BeliefSetStorage.load();
    return storage.ubpsMaster;
}
