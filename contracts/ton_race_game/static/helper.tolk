// SPDX-License-Identifier: UNLICENSED
import "storage"
import "structs"
import "constants"
import "errors"

fun empty_cell() : cell {
    return beginCell().endCell();
}

fun calcDeployedCoordinateCell(
    gameAddress: address,
    coordinate_x: X_TYPE,
    coordinate_y: Y_TYPE,
    coordinateCellCode: cell,
    shipCode: cell,
    ): AutoDeployAddress {
    val xy: XY = XY {x: coordinate_x, y: coordinate_y};
    val initStorage: CoordinateCellStorage = {
        gameAddress,
        xy: xy,
        opened: false,
        ccStorage: null,
        shipCode: shipCode,
    };

    val dataCell: cell = initStorage.toCell();
    val st = ContractState { code: coordinateCellCode, data: dataCell };
    val deployed: AutoDeployAddress = { stateInit: st };
    return deployed;
}

fun calcAddressOfCoordinateCell(
    gameAddress: address,
    coordinate_x: X_TYPE,
    coordinate_y: Y_TYPE,
    coordinateCellCode: cell,
    shipCode: cell,
    ): address {
    val ccDeployed = calcDeployedCoordinateCell(gameAddress, coordinate_x, coordinate_y, coordinateCellCode, shipCode);
    return ccDeployed.calculateAddress();
}



// Ship

fun calcDeployedShip(
    userAddress: address,
    gameAddress: address,
    shipCode: cell,
    coordinateCellCode: cell,
): AutoDeployAddress {
    val initStorage: ShipStorage = {
        userAddress,
        gameAddress,
        max_hp: 0,
        gameFields: null,
        fastTravelInfo: null,
        coordinateCellCode: coordinateCellCode,
        movement_in_process: false,
        // No move in flight, so no pending cashback routing either.
        cashback_to_ship: false,
        pending_mint_amount: 0,
        // No active session on a freshly-deployed ship.
        sessionInfo: null,
    };

    val dataCell: cell = initStorage.toCell();
    val st = ContractState { code: shipCode, data: dataCell };
    val deployed: AutoDeployAddress = { stateInit: st };
    return deployed;  
}

fun calcAddressOfShip(
    userAddress: address,
    gameAddress: address,
    shipCode: cell,
    coordinateCellCode: cell,
    ): address {
    val shipDeployed = calcDeployedShip(userAddress, gameAddress, shipCode, coordinateCellCode);
    return shipDeployed.calculateAddress()
}

fun reserveValue(msgValue: coins, delta: coins = 0) {
    val base = (contract.getOriginalBalance() - msgValue) + BASIC_STORAGE_TAX;
    reserveToncoinsOnBalance(base + delta, RESERVE_MODE_EXACT_AMOUNT);
}


// Convert a raw uint8 (e.g. from a signed external SessionMoveInner) into a MoveMode.
// Tolk has no int->enum cast; callers MUST bound-check v <= MOVE_MODE_EXIT first (this
// maps any value >= 3 to EXIT). Used by the ship's external session move path.
fun moveModeFromUint(v: uint8): MoveMode {
    if (v == 0) { return MoveMode.LEFT; }
    if (v == 1) { return MoveMode.UP; }
    if (v == 2) { return MoveMode.RIGHT; }
    return MoveMode.EXIT;
}

fun coordinate_plus_mode(x: X_TYPE, mode: MoveMode):X_TYPE {
    match (mode) {
        MoveMode.LEFT => {return x-1}
        MoveMode.RIGHT => {return x+1}
        else => { return x },
    }
}

// Helper function to encode TEP-62 NFT Transfer message
// TEP-62 uses MsgAddress format for optional addresses: 2 bits (0b00=null, 0b10=address)
fun encodeNFTTransfer(
    queryId: uint64,
    newOwner: address,
    responseDestination: address?,
    customPayload: cell?,
    forwardAmount: coins,
    forwardPayload: RemainingBitsAndRefs
): cell {
    var builder = beginCell()
        .storeUint(0x5fcc3d14, 32) // NFT Transfer opcode (TEP-62)
        .storeUint(queryId, 64) // query_id
        .storeAddress(newOwner); // new_owner (always present)
    
    // Encode optional response_destination using TEP-62 MsgAddress format
    // 2 bits: 0b00 = null, 0b10 = address (any workchain), 0b11 = address (masterchain)
    if (responseDestination != null) {
        val workchain = responseDestination!.getWorkchain();
        if (workchain == -1) {
            builder = builder.storeUint(3, 2); // 0b11 = masterchain
        } else {
            builder = builder.storeUint(2, 2); // 0b10 = any workchain
        }
        builder = builder.storeAddress(responseDestination!);
    } else {
        builder = builder.storeUint(0, 2); // 0b00 = null
    }
    
    // Encode optional custom_payload: 1 bit (0=null, 1=cell) + cell if present
    if (customPayload != null) {
        builder = builder.storeUint(1, 1).storeRef(customPayload!);
    } else {
        builder = builder.storeUint(0, 1);
    }
    
    // forward_amount (VarUInteger 16)
    builder = builder.storeCoins(forwardAmount);
    
    // forward_payload (RemainingBitsAndRefs) - append remaining bits/refs from the slice
    // RemainingBitsAndRefs is a slice, so we can check and copy remaining data
    // For empty forwardPayload, we just end the cell (no additional bits/refs)
    // If there are remaining bits or refs, they would be appended here
    // In our case, forwardPayload is empty, so we just end the cell
    
    return builder.endCell();
}

fun generateSpecialType(): SpecialType {
    // This should generate random type (4 types: empty, low, high, extra)
    // 0: EMPTY | 5%
    // 1: LOW | 45%
    // 2: HIGH | 45%
    // 3: EXTRA | 5%
    
    val randomValue: uint8 = random.range(100);
    if (randomValue < 5) {
        return SpecialType.EMPTY;
    } else if (randomValue < 50) {
        return SpecialType.LOW;
    } else if (randomValue < 95) {
        return SpecialType.HIGH;
    } else {
        return SpecialType.EXTRA;
    }
}

fun generateSpecialRandomUint(base: HP_TYPE, k: uint16 = 10): HP_TYPE {
    // Generate random type (4 types: empty, low, high, extra)
    // Based on type generate random uint
    // EMPTY: 0
    // LOW: [0, base/2]
    // HIGH: [base/2, base]
    // EXTRA: k*base, where k is random uint between 1 and 10
    assert (base > 0) throw ERR_INVALID_BASE;

    val specialType: SpecialType = generateSpecialType();
    match (specialType) {
        SpecialType.EMPTY => {return 0}
        SpecialType.LOW => {return random.range(base/2)}
        SpecialType.HIGH => {return random.range(base/2) + base/2}
        SpecialType.EXTRA => {return (random.range(k) + 1) * base}
    }

}

fun generateRandomResult(base: HP_TYPE): RandomResult {
    random.initialize();

    val randomResult: RandomResult = {
        hp: generateSpecialRandomUint(base) as HP_TYPE,
        jettonAmount: generateSpecialRandomUint(base) as coins,
    };

    return randomResult;

}

fun buildGameFields(max_hp: HP_TYPE): Cell<GameFields> {
    // X is a signed int64 (X_TYPE); store it as signed to match XY.load's loadInt. Value is 0 here
    // (initial position), so this is bit-identical to the previous storeUint but type-correct.
    val gameFields: Cell<GameFields> = beginCell().storeInt(0, X_TYPE_BITS).storeUint(0, Y_TYPE_BITS).storeUint(max_hp, HP_TYPE_BITS).storeCoins(0).endCell() as Cell<GameFields>;
    return gameFields;
}