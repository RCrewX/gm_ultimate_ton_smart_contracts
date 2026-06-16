// SPDX-License-Identifier: UNLICENSED
import "constants"

type Y_TYPE = uint64
type X_TYPE = int64
type HP_TYPE = Y_TYPE

const Y_TYPE_BITS: int = 64
const X_TYPE_BITS: int = 64
const HP_TYPE_BITS: int = 64

// Native ship session-key fields (see ShipStorage + the external move path). These
// widths are published in the ABI storageLayout so the dApp can serialise the signed
// SessionMoveInner / SetSessionKey the exact same way the contract parses it.
type SHIP_SESSION_PUBKEY_TYPE = uint256
type SHIP_SESSION_SEQNO_TYPE = uint32
type SHIP_SESSION_VALID_UNTIL_TYPE = uint32
type SHIP_SESSION_MOVES_LEFT_TYPE = uint16

const SHIP_SESSION_PUBKEY_BITS: int = 256
const SHIP_SESSION_SEQNO_BITS: int = 32
const SHIP_SESSION_VALID_UNTIL_BITS: int = 32
const SHIP_SESSION_MOVES_LEFT_BITS: int = 16
const SHIP_SESSION_MOVE_MODE_BITS: int = 8
const SHIP_SESSION_SIGNATURE_BITS: int = 512

// DOES NOT WORK YET, WAIT TOLK 1.3
// 
// Error: fatal: Assertion failed at /Users/inv/ton-wasm/ton/tolk/optimize.cpp:62: p_ > 0 && p_ <= l_ && q_ >= 0 && q_ <= optimize_depth && l_ <= optimize_depth
// 
// Use (x-x) for zero
const x_zero: X_TYPE = 0 as X_TYPE;
const y_zero: Y_TYPE = 0 as Y_TYPE;





struct XY {
    x: X_TYPE
    y: Y_TYPE
}

fun XY.toSlice(self): slice {
    return beginCell().storeInt(self.x, X_TYPE_BITS).storeUint(self.y, Y_TYPE_BITS).toSlice();
}

fun XY.load(slice: slice): XY {
    return XY {
        x: slice.loadInt(X_TYPE_BITS),
        y: slice.loadUint(Y_TYPE_BITS),
    }
}

struct HardTravelInfo {
    mode: MoveMode
    gasLimit: coins // always > 1 TON
    hpLimit: HP_TYPE // always > 0
    maxTurns: uint64 // must be < 100; enforced in Ship on RequestToHardTravel
}

struct FastTravelInfo {
    enrichedFuelAmount: coins
}

// Native session authorisation, kept in its OWN ref cell off ShipStorage (same pattern as
// gameFields/fastTravelInfo) so the root cell never approaches the 1023-bit limit. A null
// sessionInfo ref means "no active session". sessionPublicKey is always non-zero when set.
struct SessionInfo {
    sessionPublicKey: SHIP_SESSION_PUBKEY_TYPE    // Ed25519 browser key authorised for moves
    sessionSeqno: SHIP_SESSION_SEQNO_TYPE         // anti-replay counter
    sessionValidUntil: SHIP_SESSION_VALID_UNTIL_TYPE // unix expiry (session time-box)
    sessionMovesLeft: SHIP_SESSION_MOVES_LEFT_TYPE   // remaining move budget
}

struct GameFields {
    xy: XY
    hp: HP_TYPE
    jettonAmount: coins
}

struct MoveData {
    ship_hp: HP_TYPE
    xy: XY
}

struct RandomResult {
    hp: HP_TYPE
    jettonAmount: coins
}