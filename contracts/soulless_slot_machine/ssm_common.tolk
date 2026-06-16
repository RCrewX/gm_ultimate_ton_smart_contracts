// SPDX-License-Identifier: UNLICENSED
// =============================================================================
// ssm_common.tolk — roll protocol SHARED between SoullessSlotMachine (SSM) and
// SSMSlot. This is intra-feature sharing (SSM <-> its own slots); it has NOTHING
// to do with the GM<->R* decoupling invariant (that one only constrains
// game_manager/static.tolk). Both the SSM and the slot import this file.
// =============================================================================

const BASIC_STORAGE_TAX = ton("0.01");

// Reel count is a single constant ("customizable" per the brief). The reward
// tables assume 3; change here + extend the reward function if you ever grow it.
// The generative reward rule (static.tolk computeOutcome) reads this constant and
// does NOT hardcode "3", so the count is the only thing to touch to grow reels.
const SSM_REELS: int = 3;

// Symbol alphabet rolled by each slot. random.range(3) yields exactly these.
//   ZERO  = "0" (nothing)   SEVEN = "7"            X = "X" (NFT tier driver)
const SYM_ZERO: int = 0;
const SYM_SEVEN: int = 1;
const SYM_X: int = 2;

const SEND_MODE_CARRY_ALL_REMAINING_BALANCE: uint8 = 128;

// =============================================================================
//  Slot storage — DELIBERATELY minimal and STATELESS w.r.t. a roll.
//  A slot holds only {ssmAddress, reelIndex}; the per-roll context travels in
//  the message, never in slot storage. Consequence: slot addresses are STABLE
//  (one set of 3 per SSM, reused every roll), and concurrent rolls cannot
//  corrupt each other (a slot mutates no per-roll state).
// =============================================================================
struct SSMSlotStorage {
    ssmAddress: address
    reelIndex: uint8
}

fun SSMSlotStorage.load() {
    return SSMSlotStorage.fromCell(contract.getData())
}

fun SSMSlotStorage.save(self) {
    contract.setData(self.toCell())
}

// =============================================================================
//  Roll context — opaque cell carried SSM -> slot0 -> ... -> slotLast -> SSM.
//  Everything SSM needs to settle a returning result lives here, so SSM keeps
//  NO per-roll bookkeeping in its own storage.
// =============================================================================
struct RollContext {
    player: address          // who receives rewards / cashback
    stake: coins             // jettons staked this roll (RUDA raw, or custom raw)
    isNative: bool           // true = native RUDA path, false = custom-jetton path
    origin: address          // NFT origin: RUDA master (native) or custom master (custom)
    escrowWallet: address    // custom path: SSM's own jetton wallet holding the escrow
                             // native path: unused (set to SSM's own address)
    queryId: uint64
}

// SSM -> slot0, and slot_i -> slot_{i+1}. `symbols` is the accumulating result,
// packed 2 bits per reel (reel i at bits [2i, 2i+1]).
struct (0x55310001) RollStep {
    ctx: Cell<RollContext>
    symbols: uint8
}

// slot_{SSM_REELS-1} -> SSM: the completed 3-symbol result.
struct (0x55320002) RollResult {
    ctx: Cell<RollContext>
    symbols: uint8
}

// EXACT-reserve: keep (priorBalance + storage tax), forward only the rest. Same
// pattern as the rest of the codebase; never drops below the 0.01 storage tax.
fun reserveValue(msgValue: coins, delta: coins = 0) {
    val base = (contract.getOriginalBalance() - msgValue) + BASIC_STORAGE_TAX;
    val reserveAmount = base + delta;
    var finalReserve: coins = reserveAmount;
    if (reserveAmount < BASIC_STORAGE_TAX) {
        finalReserve = BASIC_STORAGE_TAX;
    }
    reserveToncoinsOnBalance(finalReserve, RESERVE_MODE_EXACT_AMOUNT);
}

// Deterministic slot address from (ssm, reelIndex, slotCode). Slot code is the
// SAME for every reel; reelIndex (in storage) makes each address distinct.
fun calcDeployedSlot(ssmAddress: address, reelIndex: int, slotCode: cell): AutoDeployAddress {
    val initStorage: SSMSlotStorage = {
        ssmAddress,
        reelIndex: reelIndex as uint8,
    };
    return {
        stateInit: {
            code: slotCode,
            data: initStorage.toCell()
        }
    }
}

fun calcAddressOfSlot(ssmAddress: address, reelIndex: int, slotCode: cell): address {
    return calcDeployedSlot(ssmAddress, reelIndex, slotCode).calculateAddress();
}

// Symbol packing helpers (2 bits per reel).
fun appendSymbol(symbols: int, reelIndex: int, sym: int): int {
    return symbols | (sym << (2 * reelIndex));
}

fun symbolAt(symbols: int, reelIndex: int): int {
    return (symbols >> (2 * reelIndex)) & 3;
}
