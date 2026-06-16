// SPDX-License-Identifier: UNLICENSED

// these error codes are quite strange, but they are exactly the same as in FunC implementation

const ERR_INVALID_OP = 709
const ERR_NOT_FROM_ADMIN = 73
const ERR_UNAUTHORIZED_BURN = 74
const ERR_NOT_ENOUGH_AMOUNT_TO_RESPOND = 75
const ERR_NOT_FROM_OWNER = 705
const ERR_NOT_ENOUGH_TON_FOR_OPERATION = 710  // Changed from 709 (was duplicate)
const ERR_NOT_ENOUGH_GAS_FOR_OPERATION = 711  // Changed from 707 (was duplicate)
const ERR_INVALID_WALLET_ADDRESS = 712  // Changed from 707 (was duplicate)
const ERR_WRONG_WORKCHAIN = 333
const ERR_NOT_ENOUGH_BALANCE = 706
const ERR_INVALID_PAYLOAD = 708

// Custom

const ERR_UNAUTHORIZED = 901  // Generic unauthorized (kept for backward compatibility)
const ERR_NOT_ENOUGH_VALUE_COINS = 903
const ERR_MESSAGE_VALUE_TOO_LOW = 904  // Message value is too low (less than estimated gas cost)
const ERR_INVALID_SENDER_ADDRESS = 905  // Sender address doesn't match expected address
const ERR_MISSING_REQUIRED_DATA = 906  // Required data (like jettonMinterAddress) is null
const ERR_INSUFFICIENT_BALANCE_FOR_OPERATION = 907  // Contract balance too low for operation

// Ship-specific errors
const ERR_GAME_FIELDS_NOT_INITIALIZED = 908  // Ship gameFields is null when it should be initialized
const ERR_MOVEMENT_NOT_IN_PROCESS = 909  // Movement is not in process when it should be
const ERR_MOVEMENT_ALREADY_IN_PROCESS = 910  // Movement is already in process when it should not be
const ERR_INVALID_COORDINATE_CELL_SENDER = 911  // Sender is not the expected coordinate cell address
const ERR_INVALID_USER_SENDER = 912  // Sender is not the ship's user address
const ERR_INVALID_GAME_SENDER = 913  // Sender is not the ship's game address
const ERR_NO_PENDING_MINT = 936  // Ship has no pending mint amount (RequestShipToMint when pending_mint_amount == 0)

// Game-specific errors
const ERR_INVALID_GAME_MANAGER_SENDER = 914  // Sender is not the game's manager address
const ERR_INVALID_SHIP_SENDER_FOR_MINT = 915  // Sender is not the expected ship address for mint request

// CoordinateCell-specific errors
const ERR_COORDINATE_CELL_STORAGE_NOT_INITIALIZED = 916  // Coordinate cell storage (ccStorage) is null
const ERR_NOT_FIRST_EXPLORER = 917  // Sender is not the first explorer of this coordinate cell
const ERR_INVALID_COORDINATE_CELL_SENDER_FOR_MOVE = 918  // Sender is not the expected coordinate cell for Move message
const ERR_INVALID_SHIP_SENDER_FOR_MOVE = 919  // Sender is not the expected ship for MoveShipToCC message
const ERR_INVALID_BASE = 920  // Base is invalid (must be > 0)
const ERR_WRONG_XY = 921  // Provided coordinates do not satisfy required constraints
const ERR_START_WRONG_XY = 922  // Fast travel allowed only from start (0,0)
const ERR_FAST_TRAVEL_INFO_NOT_INITIALIZED = 923  // Fast travel info not set up yet
const ERR_NOT_ENOUGH_FUEL_FOR_TRAVEL = 924  // Not enough enriched fuel to cover travel cost
const ERR_INVALID_JETTON_USAGE_MODE = 925  // Jetton usage mode is invalid
const ERR_INVALID_DESTINATION = 926  // Destination is invalid
const ERR_FAST_TRAVEL_NOT_ALLOWED_TO_CLOSED_CELLS = 927  // Fast travel not allowed to closed cells
const ERR_FAST_TRAVEL_Y_TOO_LOW = 933  // Fast travel y coordinate must be > 2
const ERR_FAST_TRAVEL_NEGATIVE_X_INVALID = 934  // Fast travel: when x < 0, must have -x <= y
const ERR_FAST_TRAVEL_POSITIVE_X_INVALID = 935  // Fast travel: when x >= 0, must have x <= y
const ERR_HARD_TRAVEL_EXIT_MODE = 937  // HardTravel: EXIT mode not allowed
const ERR_HARD_TRAVEL_MAX_TURNS_INVALID = 938  // HardTravel: maxTurns must be < 100
const ERR_HARD_TRAVEL_VALUE_TOO_LOW = 939  // HardTravel: message value below HARD_TRAVEL_MIN_VALUE
const ERR_UNKNOWN_MESSAGE = 0xFFFF  // Unknown message type (body not empty but doesn't match any known message)

// Native session-key errors (external move/exit path). 950+ range, isolated from the
// game's 901-939. Names reuse the retired ship_session contract's vocabulary.
const ERR_INVALID_SIGNATURE = 950   // external not signed by the stored session public key
const ERR_BAD_SEQNO = 951           // replayed / out-of-order session seqno
const ERR_EXPIRED = 952             // inner.validUntil != stored sessionValidUntil (sig not bound to this session)
const ERR_SESSION_EXPIRED = 953     // now() > sessionValidUntil (session time-box passed)
const ERR_INVALID_MOVE_MODE = 956   // moveMode outside move/exit (LEFT/UP/RIGHT/EXIT)
const ERR_BUDGET_EXHAUSTED = 957    // sessionMovesLeft == 0
const ERR_INSUFFICIENT_FLOAT = 958  // ship float too low to fund the external move
const ERR_NO_SESSION = 960          // no active session (sessionPublicKey == 0)
// Helper-specific errors