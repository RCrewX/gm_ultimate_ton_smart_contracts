// SPDX-License-Identifier: UNLICENSED

import "structs"

struct GameV1Storage {
    managerAddress: address
    shipCode: cell // library cell will be perfect
    coordinateCellCode: cell // library cell will be perfect
}

struct CCStorage {
    hp: HP_TYPE
    jettonAmount: coins
    firstExplorer: address?
}

struct CoordinateCellStorage {
    gameAddress: address
    xy: XY
    opened: bool
    ccStorage: Cell<CCStorage>?
    shipCode: cell
}

struct ShipStorage {
    userAddress: address
    gameAddress: address
    max_hp: HP_TYPE
    gameFields: Cell<GameFields>?
    fastTravelInfo: Cell<FastTravelInfo>?
    coordinateCellCode: cell
    // The lock: true iff a move (of ANY kind — wallet or auto) is in flight. A new move,
    // internal or external, is accepted only when this is false. It does NOT encode how the
    // move started.
    movement_in_process: bool
    // Cashback routing for the move currently in flight: true iff that move is an auto
    // (session-key) move, whose leftover float MoveEnd keeps ON the ship instead of refunding
    // the owner. Set when a move starts, read + cleared in MoveEnd. Meaningless while no move
    // is in flight (always false then). Separate from the lock on purpose — it answers "where
    // does the cashback go", not "is a move happening".
    cashback_to_ship: bool
    pending_mint_amount: coins
    // Native session-key authorisation, in its OWN ref cell (appended at the END). A
    // one-time internal SetSessionKey (from userAddress) authorises an Ed25519 browser
    // key to sign external move/exit messages, bounded by expiry + a move budget. null
    // ref = no active session (the default on a fresh ship).
    sessionInfo: Cell<SessionInfo>?
}


fun GameV1Storage.load() {
    return GameV1Storage.fromCell(contract.getData())
}

fun GameV1Storage.save(self) {
    contract.setData(self.toCell())
}


fun CoordinateCellStorage.load() {
    return CoordinateCellStorage.fromCell(contract.getData())
}

fun CoordinateCellStorage.save(self) {
    contract.setData(self.toCell())
}


fun ShipStorage.load() {
    return ShipStorage.fromCell(contract.getData())
}

fun ShipStorage.save(self) {
    contract.setData(self.toCell())
}

