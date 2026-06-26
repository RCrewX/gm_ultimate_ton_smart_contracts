// SPDX-License-Identifier: UNLICENSED
import "static/messages"
import "static/storage"
import "static/helper"
import "static/errors"
import "static/structs"
import "static/constants"
import "@stdlib/gas-payments"   // acceptExternalMessage (the rest of the crypto/reserve primitives live in @stdlib/common)

type AllowedMessagesToShip =
    | MoveEnd
    | HardTravelMoveEnd
    | RequestToMove
    | RequestToHardTravel
    | ShipUpgrade
    | RequestToFastTravel
    | RequestShipToMint
    | SetSessionKey
    | WithdrawExcessTON
    | AnyMessage
    | ResetShip
    | FastTravelUpgrade

// Shared move pipeline used by BOTH the internal wallet-signed RequestToMove and the
// external session-key-signed move/exit. `effValue` is the value semantics handed to the
// EXACT-amount reserve: the move carries (effValue - storage tax) to the coordinate cell.
//  - internal: effValue = in.valueCoins  (forwards the gas the wallet sent — unchanged)
//  - external: effValue = SESSION_MOVE_FLOAT (funds the move from the ship's own float)
// On-chain effect (movement lock, MoveShipToCC, async MoveEnd) is identical for both.
// `isSessionMove` records the origin so the async MoveEnd can route the cashback: an
// auto-mode (session) move keeps its leftover float on the ship; a wallet move refunds owner.
fun runMove(moveMode: MoveMode, effValue: coins, isSessionMove: bool) {
    var storage = lazy ShipStorage.load();
    assert (!storage.movement_in_process) throw ERR_MOVEMENT_ALREADY_IN_PROCESS;
    // Check we have enough balance for the operation: gas cost + coordinate cell gas
    assert (contract.getOriginalBalance() >= GAS_COST_REQUEST_TO_MOVE + GAS_COST_MOVE_SHIP_TO_CC) throw ERR_INSUFFICIENT_BALANCE_FOR_OPERATION;

    if (storage.gameFields == null) {
        var gameFields = buildGameFields(BASIC_SHIP_HP);
        storage.gameFields = gameFields;
        storage.max_hp = BASIC_SHIP_HP;
        storage.save();
    }
    // Lock the ship to THIS move (the lock itself doesn't care how it started), and record
    // whether the move is an auto (session) move so MoveEnd can keep its cashback on the ship.
    storage.movement_in_process = true;
    storage.cashback_to_ship = isSessionMove;
    storage.save();
    var gameFields: GameFields = lazy storage.gameFields!.load();
    reserveValue(effValue);
    // Send enough TON for coordinate cell operations (storage + Move message)
    val coordinateCellGas = GAS_COST_MOVE_SHIP_TO_CC;
    val moveMsg = createMessage({
        bounce: BounceMode.NoBounce,
        dest: calcDeployedCoordinateCell(storage.gameAddress, gameFields.xy.x, gameFields.xy.y, storage.coordinateCellCode, contract.getCode()),
        value: coordinateCellGas,
        body: MoveShipToCC {
            user: storage.userAddress,
            mode: moveMode,
            ship_hp: gameFields.hp,
        }
    });
    // Use send_mode=128 to carry all remaining balance (excesses)
    moveMsg.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
}

get fun currentGameData(): GameFields? {
    var storage: ShipStorage = lazy ShipStorage.load();
    if (storage.gameFields == null) {
        return null;
    }
    var gameFields: GameFields = lazy storage.gameFields!.load();
    return gameFields;
}
get fun tonBalance(): coins {
    return contract.getOriginalBalance();
}
get fun get_movement_in_process(): bool {
    var storage: ShipStorage = lazy ShipStorage.load();
    return storage.movement_in_process;
}
get fun get_max_hp(): HP_TYPE {
    var storage: ShipStorage = lazy ShipStorage.load();
    return storage.max_hp;
}
get fun get_pending_mint_amount(): coins {
    var storage: ShipStorage = lazy ShipStorage.load();
    return storage.pending_mint_amount;
}
fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessagesToShip.fromSlice(in.body);

    match (msg) {
        MoveEnd => {
            var storage: ShipStorage = lazy ShipStorage.load();
            assert (storage.gameFields != null) throw ERR_GAME_FIELDS_NOT_INITIALIZED;
            assert (storage.movement_in_process) throw ERR_MOVEMENT_NOT_IN_PROCESS;
            var gameFields: GameFields = lazy storage.gameFields!.load();
            var msgGameFields: GameFields = msg.gameFields;

            assert (in.senderAddress == calcAddressOfCoordinateCell(storage.gameAddress, msgGameFields.xy.x, msgGameFields.xy.y, storage.coordinateCellCode, contract.getCode())) throw ERR_INVALID_COORDINATE_CELL_SENDER;
            var totalReward: coins = 0;
            if (msg.result == UniqueResult.SAFE_EXIT) {
                gameFields.xy.x = 0;
                gameFields.xy.y = 0;
                gameFields.hp = storage.max_hp;
                gameFields.jettonAmount += msgGameFields.jettonAmount;
                totalReward = gameFields.jettonAmount;
                gameFields.jettonAmount = 0;
            }

            if (msg.result == UniqueResult.CRASH) {
                gameFields.xy.x = 0;
                gameFields.xy.y = 0;
                gameFields.hp = storage.max_hp;
                totalReward = gameFields.jettonAmount / 10;
                gameFields.jettonAmount = 0;
            }
            
            if (msg.result == UniqueResult.CONTINUE) {
                gameFields.xy.x = msgGameFields.xy.x;
                gameFields.xy.y = msgGameFields.xy.y;
                gameFields.hp = msgGameFields.hp;
                gameFields.jettonAmount += msgGameFields.jettonAmount;
            }
            // Capture the cashback routing before we clear the in-flight flags.
            val keepCashbackOnShip = storage.cashback_to_ship;
            storage.gameFields = gameFields.toCell();
            storage.movement_in_process = false;
            storage.cashback_to_ship = false;
            if (totalReward > 0) {
                storage.pending_mint_amount += totalReward;
            }
            storage.save();

            if (!keepCashbackOnShip) {
                // Wallet (internal) move: refund the leftover gas to the owner as before.
                reserveValue(in.valueCoins);
                val cashbackMsg = createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: storage.userAddress,
                    value: 0,
                    body: ReturnExcessesBack {queryId:0},
                });
                // Use send_mode=128 to carry all remaining balance (excesses)
                cashbackMsg.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
            }
            // Auto mode (session move): send NO cashback — the leftover float stays on the
            // ship so the next session move is already funded (no owner top-up between moves).
        }
        HardTravelMoveEnd => {
            var storage: ShipStorage = lazy ShipStorage.load();
            assert (storage.gameFields != null) throw ERR_GAME_FIELDS_NOT_INITIALIZED;
            assert (storage.movement_in_process) throw ERR_MOVEMENT_NOT_IN_PROCESS;
            var gameFields: GameFields = lazy storage.gameFields!.load();
            var msgGameFields: GameFields = msg.gameFields;
            assert (in.senderAddress == calcAddressOfCoordinateCell(storage.gameAddress, msgGameFields.xy.x, msgGameFields.xy.y, storage.coordinateCellCode, contract.getCode())) throw ERR_INVALID_COORDINATE_CELL_SENDER;
            var totalReward: coins = 0;
            if (msg.result == UniqueResult.CRASH) {
                gameFields.xy.x = 0;
                gameFields.xy.y = 0;
                gameFields.hp = storage.max_hp;
                totalReward = msgGameFields.jettonAmount / 10;
                gameFields.jettonAmount = 0;
            }
            if (msg.result == UniqueResult.CONTINUE) {
                gameFields.xy.x = msgGameFields.xy.x;
                gameFields.xy.y = msgGameFields.xy.y;
                gameFields.hp = msgGameFields.hp;
                gameFields.jettonAmount += msgGameFields.jettonAmount;
            }
            storage.gameFields = gameFields.toCell();
            storage.movement_in_process = false;
            if (totalReward > 0) {
                storage.pending_mint_amount += totalReward;
            }
            storage.save();
            reserveValue(in.valueCoins);
            val cashbackMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: storage.userAddress,
                value: 0,
                body: ReturnExcessesBack {queryId:0},
            });
            cashbackMsg.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }
        RequestToMove => {
            // Wallet-signed (internal) move. Auth + value checks here; the move itself
            // (balance check, gameFields init, movement lock, MoveShipToCC) runs in the
            // shared runMove — identical on-chain effect as the external session path.
            var storage = lazy ShipStorage.load();
            assert (in.senderAddress == storage.userAddress) throw ERR_INVALID_USER_SENDER;
            assert (!storage.movement_in_process) throw ERR_MOVEMENT_ALREADY_IN_PROCESS;
            assert (in.valueCoins >= TODO_TOTAL_GAS_TO_MOVE) throw ERR_MESSAGE_VALUE_TOO_LOW;
            runMove(msg.mode, in.valueCoins, false);
        }
        RequestToFastTravel => {

            var storage = lazy ShipStorage.load();
            assert (in.senderAddress == storage.userAddress) throw ERR_INVALID_USER_SENDER;
            assert (!storage.movement_in_process) throw ERR_MOVEMENT_ALREADY_IN_PROCESS;
            assert (in.valueCoins >= TODO_TOTAL_GAS_TO_MOVE) throw ERR_MESSAGE_VALUE_TOO_LOW;
            // Check we have enough balance for the operation: gas cost + coordinate cell gas
            assert (contract.getOriginalBalance() >= GAS_COST_REQUEST_TO_MOVE + GAS_COST_MOVE_SHIP_TO_CC) throw ERR_INSUFFICIENT_BALANCE_FOR_OPERATION;

            assert (msg.xy.y > 2) throw ERR_FAST_TRAVEL_Y_TOO_LOW;
            
            if (msg.xy.x < x_zero) {
                assert (-msg.xy.x <= msg.xy.y) throw ERR_FAST_TRAVEL_NEGATIVE_X_INVALID;
            } else {
                assert (msg.xy.x <= msg.xy.y) throw ERR_FAST_TRAVEL_POSITIVE_X_INVALID;
            }
            
            assert (storage.gameFields != null) throw ERR_GAME_FIELDS_NOT_INITIALIZED;
            var gameFields: GameFields = lazy storage.gameFields!.load();

            assert (gameFields.xy.x == x_zero && gameFields.xy.y == y_zero) throw ERR_START_WRONG_XY;

            assert (storage.fastTravelInfo != null) throw ERR_FAST_TRAVEL_INFO_NOT_INITIALIZED;
            var fastTravelInfo: FastTravelInfo = lazy storage.fastTravelInfo!.load();
            
            // TODO: Calculate travel cost correctly (make it more effective than move?)
            // Note: x can be negative (already validated above), but y must be >= 0 (already validated as y > 2)
            assert (msg.xy.y >= y_zero) throw ERR_WRONG_XY;
            var travelCost = msg.xy.y * (msg.xy.y - 1) / 2 as coins;

            assert (fastTravelInfo.enrichedFuelAmount >= travelCost) throw ERR_NOT_ENOUGH_FUEL_FOR_TRAVEL;
            fastTravelInfo.enrichedFuelAmount -= travelCost;

            
            storage.fastTravelInfo = fastTravelInfo.toCell();
            storage.movement_in_process = true;
            storage.save();
            
            reserveValue(in.valueCoins);

            val xy = msg.xy;
            val bodyCell = TravelToCC {
                user: in.senderAddress,
                moveData: MoveData {
                    ship_hp: gameFields.hp,
                    xy: xy,
                },
            }.toCell();


            // The dirtiest hack you ever seen
            // It works because of the way the compiler optimizes the code
            // DO NOT REMOVE THIS HACK
            val x_z = msg.xy.x - msg.xy.x;
            val y_z = msg.xy.y - msg.xy.y;

            val calcDest = calcDeployedCoordinateCell(
                storage.gameAddress,
                (x_z),
                (y_z),
                storage.coordinateCellCode,
                contract.getCode(),
            );
            val travelMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: calcDest,
                value: 0,
                body: bodyCell,
            });
            travelMsg.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }
        ShipUpgrade => {
            // Using lazy for partial update - compiler handles efficient write-back via toCell()
            var storage = lazy ShipStorage.load();
            // Only Game can upgrade ships
            assert (in.senderAddress == storage.gameAddress) throw ERR_INVALID_GAME_SENDER;
            assert (storage.movement_in_process == false) throw ERR_MOVEMENT_ALREADY_IN_PROCESS;
            assert (storage.gameFields != null) throw ERR_GAME_FIELDS_NOT_INITIALIZED;

            
            var gameFields: GameFields = lazy storage.gameFields!.load();
            gameFields.hp += msg.hpIncrease;
            storage.max_hp += msg.hpIncrease;
            storage.gameFields = gameFields.toCell();
            storage.save();
            reserveValue(in.valueCoins);
        }
        FastTravelUpgrade => {
            var storage = lazy ShipStorage.load();
            assert (in.senderAddress == storage.gameAddress) throw ERR_INVALID_GAME_SENDER;
            assert (storage.movement_in_process == false) throw ERR_MOVEMENT_ALREADY_IN_PROCESS;
            assert (storage.gameFields != null) throw ERR_GAME_FIELDS_NOT_INITIALIZED;

            if (storage.fastTravelInfo == null) {
                var fastTravelInfo = FastTravelInfo {
                    enrichedFuelAmount: msg.jettonAmount,
                };
                storage.fastTravelInfo = fastTravelInfo.toCell();
            } else {
                var fastTravelInfo: FastTravelInfo = lazy storage.fastTravelInfo!.load();
                fastTravelInfo.enrichedFuelAmount += msg.jettonAmount;
                storage.fastTravelInfo = fastTravelInfo.toCell();
            }
            storage.save();

        },
        ResetShip => {
            var storage = lazy ShipStorage.load();
            assert (in.senderAddress == storage.userAddress) throw ERR_INVALID_USER_SENDER;
            assert (in.valueCoins >= GAS_COST_RESET_SHIP) throw ERR_MESSAGE_VALUE_TOO_LOW;
            var fastTravelInfo = FastTravelInfo {
                enrichedFuelAmount: 0,
            };

            // Note: gameFields (position/HP/rewards) are intentionally preserved.
            // ResetShip only unblocks a ship stuck after a failed fast travel
            // (clears movement_in_process + fast-travel fuel + pending mint).
            storage.fastTravelInfo = fastTravelInfo.toCell();
            storage.pending_mint_amount = 0;
            storage.movement_in_process = false;
            storage.save();
        },
        RequestShipToMint => {
            var storage = lazy ShipStorage.load();
            assert (in.senderAddress == storage.userAddress) throw ERR_INVALID_USER_SENDER;
            assert (storage.pending_mint_amount > 0) throw ERR_NO_PENDING_MINT;
            assert (in.valueCoins >= GAS_COST_REQUEST_MINT) throw ERR_MESSAGE_VALUE_TOO_LOW;
            val amountToMint: coins = storage.pending_mint_amount;
            storage.pending_mint_amount = 0;
            storage.save();
            reserveValue(in.valueCoins);
            val requestMintMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: storage.gameAddress,
                value: MINT_TON_AMOUNT,
                body: RequestMint {
                    receiver: storage.userAddress,
                    amount: amountToMint,
                }
            });
            requestMintMsg.send(0);
            val cashbackMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: storage.userAddress,
                value: 0,
                body: ReturnExcessesBack {queryId:0},
            });
            cashbackMsg.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        },
        // Owner reclaim of the ship's surplus TON. Owner-WALLET only — NEVER a session key
        // (same rule as every other internal op: a session key can ONLY move/exit, see the
        // external path). Keeps WITHDRAW_KEEP_AMOUNT on the ship (so auto/session moves stay
        // funded) and sends everything above it back to userAddress. Touches NO game state.
        WithdrawExcessTON => {
            var storage = lazy ShipStorage.load();
            assert (in.senderAddress == storage.userAddress) throw ERR_INVALID_USER_SENDER;
            assert (in.valueCoins >= GAS_COST_WITHDRAW) throw ERR_MESSAGE_VALUE_TOO_LOW;

            // Floor the ship retains. Never below the storage tax (defensive; the const is 1 TON).
            var keep: coins = WITHDRAW_KEEP_AMOUNT;
            if (keep < BASIC_STORAGE_TAX) {
                keep = BASIC_STORAGE_TAX;
            }
            // Standing balance BEFORE this message credited — so the incoming gas is not counted
            // as withdrawable surplus. Require a real surplus, else there is nothing to reclaim.
            val balanceBeforeMsg = contract.getOriginalBalance() - in.valueCoins;
            assert (balanceBeforeMsg > keep) throw ERR_NOT_ENOUGH_BALANCE;

            // Reserve EXACTLY the keep floor, then carry-all the rest (surplus + this message's
            // unspent gas) to the owner. The ship is left holding precisely `keep`.
            reserveToncoinsOnBalance(keep, RESERVE_MODE_EXACT_AMOUNT);
            val withdrawMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: storage.userAddress,
                value: 0,
                body: ReturnExcessesBack { queryId: msg.queryId },
            });
            withdrawMsg.send(SEND_MODE_IGNORE_ERRORS + SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        },
        SetSessionKey => {
            // One-time authorise / rotate / revoke. Wallet-only, gated EXACTLY like every
            // other user op. sessionPublicKey=0 ⇒ revoke; a new key ⇒ rotate (seqno reset).
            // Any TON carried with this message stays on the ship as the float that funds
            // external moves (no explicit refund — that is the intended top-up path).
            var storage = lazy ShipStorage.load();
            assert (in.senderAddress == storage.userAddress) throw ERR_INVALID_USER_SENDER;
            if (msg.sessionPublicKey == 0) {
                storage.sessionInfo = null;                 // revoke
            } else {
                storage.sessionInfo = SessionInfo {         // authorise / rotate (fresh seqno)
                    sessionPublicKey: msg.sessionPublicKey,
                    sessionSeqno: 0,
                    sessionValidUntil: msg.validUntil,
                    sessionMovesLeft: msg.movesLeft,
                }.toCell();
            }
            storage.save();
        },
        RequestToHardTravel => {
            var storage = lazy ShipStorage.load();
            assert (in.senderAddress == storage.userAddress) throw ERR_INVALID_USER_SENDER;
            assert (!storage.movement_in_process) throw ERR_MOVEMENT_ALREADY_IN_PROCESS;
            assert (msg.info.mode != MoveMode.EXIT) throw ERR_HARD_TRAVEL_EXIT_MODE;
            assert (msg.info.maxTurns < 100) throw ERR_HARD_TRAVEL_MAX_TURNS_INVALID;
            assert (in.valueCoins >= HARD_TRAVEL_MIN_VALUE) throw ERR_HARD_TRAVEL_VALUE_TOO_LOW;
            assert (contract.getOriginalBalance() >= GAS_COST_MOVE_SHIP_TO_CC) throw ERR_INSUFFICIENT_BALANCE_FOR_OPERATION;

            if (storage.gameFields == null) {
                var gameFields = buildGameFields(BASIC_SHIP_HP);
                storage.gameFields = gameFields;
                storage.max_hp = BASIC_SHIP_HP;
                storage.movement_in_process = false;
                storage.save();
            }
            storage.movement_in_process = true;
            storage.save();
            var gameFields: GameFields = lazy storage.gameFields!.load();
            reserveValue(in.valueCoins);
            val launchMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: calcDeployedCoordinateCell(storage.gameAddress, gameFields.xy.x, gameFields.xy.y, storage.coordinateCellCode, contract.getCode()),
                value: GAS_COST_MOVE_SHIP_TO_CC,
                body: LaunchHardTravel {
                    user: in.senderAddress,
                    ship_hp: gameFields.hp,
                    info: msg.info,
                }
            });
            launchMsg.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }
        ReturnExcessesBack => {}
        LiteralyAnything => {}
        else => {
            assert (in.body.isEmpty()) throw ERR_UNKNOWN_MESSAGE
        }
    }
}

// External session-key-signed entrypoint — the per-move path that needs NO wallet popup.
// The session key (authorised once via SetSessionKey) signs a SessionMoveInner; the ship
// verifies it against the stored session key + bounds (expiry, budget, seqno, move/exit
// only) and runs the SAME move pipeline as the wallet path. Mirrors the safe ordering of
// contracts/subcontract/subcontract.tolk: every check happens BEFORE acceptExternalMessage,
// so an unsigned / forged / out-of-bounds external is dropped within the gas credit and the
// ship pays nothing (anti gas-drain).
fun onExternalMessage(inMsg: slice) {
    // Cheap parse first — no acceptExternalMessage() until everything checks out.
    val env = ShipExternalEnvelope.fromSlice(inMsg);
    val innerCell = env.inner;
    val signature = env.signature;

    var storage = lazy ShipStorage.load();

    // 0) There must be an active session at all.
    assert (storage.sessionInfo != null) throw ERR_NO_SESSION;
    var session: SessionInfo = lazy storage.sessionInfo!.load();

    // 1) Signature must be from the stored session public key — BEFORE accept (anti gas-drain).
    val hash = innerCell.hash();
    val signatureSlice = signature as slice;
    val ok = isSignatureValid(hash, signatureSlice, session.sessionPublicKey);
    if (!ok) {
        throw ERR_INVALID_SIGNATURE;
    }

    val inner = SessionMoveInner.fromCell(innerCell);

    // 2) Replay protection.
    assert (inner.seqno == session.sessionSeqno) throw ERR_BAD_SEQNO;
    // 3) Whole-session time-box.
    assert (blockchain.now() <= session.sessionValidUntil) throw ERR_SESSION_EXPIRED;
    // 4) Bind the signature to THIS session (validUntil rotates with every SetSessionKey).
    assert (inner.validUntil == session.sessionValidUntil) throw ERR_EXPIRED;
    // 5) Move budget.
    assert (session.sessionMovesLeft > 0) throw ERR_BUDGET_EXHAUSTED;
    // 6) Move-mode bound — only LEFT/UP/RIGHT/EXIT; a session key can NEVER trigger
    //    upgrade / withdraw / claim / reset (those stay internal == userAddress).
    assert (inner.moveMode <= MOVE_MODE_EXIT) throw ERR_INVALID_MOVE_MODE;
    // 7) Don't burn a budget unit while a move is already pending.
    assert (!storage.movement_in_process) throw ERR_MOVEMENT_ALREADY_IN_PROCESS;
    // 8) Enough float to actually fund the move from the ship's own balance. The external
    //    carries no value, so the float must cover the whole SESSION_MOVE_FLOAT the move sends
    //    onward (plus the storage floor) — otherwise the reserve would underflow.
    assert (contract.getOriginalBalance() >= SESSION_MOVE_FLOAT + BASIC_STORAGE_TAX) throw ERR_INSUFFICIENT_FLOAT;

    // All checks passed — only now does the ship pay gas.
    acceptExternalMessage();

    // Bump seqno + consume one budget unit FIRST and commit (wallet pattern): replay is
    // impossible even if the move pipeline below were to throw.
    session.sessionSeqno += 1;
    session.sessionMovesLeft -= 1;
    storage.sessionInfo = session.toCell();
    storage.save();
    commitContractDataAndActions();

    runMove(moveModeFromUint(inner.moveMode), SESSION_MOVE_FLOAT, true);
}

get fun get_session_public_key(): SHIP_SESSION_PUBKEY_TYPE {
    var storage: ShipStorage = lazy ShipStorage.load();
    if (storage.sessionInfo == null) { return 0; }
    var session: SessionInfo = lazy storage.sessionInfo!.load();
    return session.sessionPublicKey;
}
get fun get_session_seqno(): SHIP_SESSION_SEQNO_TYPE {
    var storage: ShipStorage = lazy ShipStorage.load();
    if (storage.sessionInfo == null) { return 0; }
    var session: SessionInfo = lazy storage.sessionInfo!.load();
    return session.sessionSeqno;
}
get fun get_session_valid_until(): SHIP_SESSION_VALID_UNTIL_TYPE {
    var storage: ShipStorage = lazy ShipStorage.load();
    if (storage.sessionInfo == null) { return 0; }
    var session: SessionInfo = lazy storage.sessionInfo!.load();
    return session.sessionValidUntil;
}
get fun get_session_moves_left(): SHIP_SESSION_MOVES_LEFT_TYPE {
    var storage: ShipStorage = lazy ShipStorage.load();
    if (storage.sessionInfo == null) { return 0; }
    var session: SessionInfo = lazy storage.sessionInfo!.load();
    return session.sessionMovesLeft;
}
