// SPDX-License-Identifier: UNLICENSED
import "static/messages"
import "static/helper"
import "static/storage"
import "static/structs"
import "static/constants"
import "static/errors"

type AllowedMessagesToGame = 
    | RequestMint 
    | RequestShipAddress 
    | RequestCoordinateCellAddress 
    | JettonUsed
    | AnyMessage

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessagesToGame.fromSlice(in.body);
    var storage = lazy GameV1Storage.load();
    match (msg) {
        RequestShipAddress => {
            assert (in.valueCoins >= GAS_COST_REQUEST_SHIP_ADDRESS) throw ERR_MESSAGE_VALUE_TOO_LOW;
            reserveValue(in.valueCoins);
            val responseMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: ResponseAddress {
                    requestedAddress: calcAddressOfShip(msg.userAddress, contract.getAddress(), storage.shipCode, storage.coordinateCellCode),
                }
            });
            // Use SEND_MODE_IGNORE_ERRORS + 128 for response messages (ignore errors + carry all remaining balance)
            responseMsg.send(SEND_MODE_IGNORE_ERRORS + 128);
        }
        RequestCoordinateCellAddress => {
            assert (in.valueCoins >= GAS_COST_REQUEST_COORDINATE_CELL_ADDRESS) throw ERR_MESSAGE_VALUE_TOO_LOW;
            reserveValue(in.valueCoins);
            val responseMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: ResponseAddress {
                    requestedAddress: calcAddressOfCoordinateCell(contract.getAddress(), msg.xy.x, msg.xy.y,  storage.coordinateCellCode, storage.shipCode),
                }
            });
            // Use SEND_MODE_IGNORE_ERRORS + 128 for response messages (ignore errors + carry all remaining balance)
            responseMsg.send(SEND_MODE_IGNORE_ERRORS + 128);
        }
        RequestMint => {

            assert (in.valueCoins > BASIC_STORAGE_TAX) throw ERR_NOT_ENOUGH_VALUE_COINS;
            assert (in.senderAddress == calcAddressOfShip(msg.receiver, contract.getAddress(),  storage.shipCode, storage.coordinateCellCode)) throw ERR_INVALID_SHIP_SENDER_FOR_MINT;

            reserveValue(in.valueCoins);

            // New architecture: GM is a dumb pipe. Wrap ForwardMintRequest in R1
            // so GM forwards it (as R2, attesting this game) to the Retranslator,
            // which verifies the game and orders the mint.
            val mintRequestBody = ForwardMintRequest {
                receiver: msg.receiver,
                amount: msg.amount,
            }.toCell();
            val forwardMsg = createMessage({
                bounce: BounceMode.NoBounce,
                dest: storage.managerAddress,
                value: 0,
                body: R1 {
                    data: mintRequestBody,
                }
            });
            // Use send_mode=128 to carry all remaining balance (excesses)
            forwardMsg.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }
        JettonUsed => {
            // Only GameManager can request ship upgrades
            assert (in.senderAddress == storage.managerAddress) throw ERR_INVALID_GAME_MANAGER_SENDER;
            
            var dataSlice = msg.data.beginParse();
            val jettonUsageModeRaw = dataSlice.loadUint(8);
            val shipAddress = dataSlice.loadAddress();
            reserveValue(in.valueCoins);


            if (jettonUsageModeRaw == (JettonUsageMode.SHIP_UPGRADE as uint8)) {
                    random.initialize();
                    var hpIncrease = generateSpecialRandomUint(msg.jettonAmount as HP_TYPE, 3);
                    
                    // Minimum HP increase is 1 (Minimum jetton amount is MIN_JETTON_USAGE_AMOUNT)
                    if (hpIncrease < 1) {
                        hpIncrease = 1;
                    }
                    // Send upgrade message to Ship
                    val upgradeMsg = createMessage({
                        bounce: BounceMode.NoBounce,
                        dest: shipAddress,
                        value: 0,
                        body: ShipUpgrade {
                            hpIncrease: hpIncrease,
                        }
                    });
                    // Use send_mode=128 to carry all remaining balance (excesses)
                    upgradeMsg.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
            } else if (jettonUsageModeRaw == (JettonUsageMode.FAST_TRAVEL_UPGRADE as uint8)) {
                    // Send fast travel message to Ship
                    val fastTravelMsg = createMessage({
                        bounce: BounceMode.NoBounce,
                        dest: shipAddress,
                        value: 0,
                        body: FastTravelUpgrade {
                            jettonAmount: msg.jettonAmount,
                        }
                    });
                    fastTravelMsg.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
            } else {
                assert (false) throw ERR_INVALID_JETTON_USAGE_MODE;
            }
        }
        ReturnExcessesBack => {}
        LiteralyAnything => {}
        else => {
            assert (in.body.isEmpty()) throw ERR_UNKNOWN_MESSAGE
        }
    }
}