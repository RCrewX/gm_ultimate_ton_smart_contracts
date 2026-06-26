// SPDX-License-Identifier: UNLICENSED
import "structs"

const BASIC_STORAGE_TAX = ton("0.01");

const BASIC_SHIP_HP: HP_TYPE = 100;
const MINT_TON_AMOUNT: coins = ton("0.2");

// Gas costs from gas consumption tests (in TON)
// These are maximum expected costs for each operation (updated from test results)
const GAS_COST_REQUEST_SHIP_ADDRESS: coins = ton("0.015"); // From gas consumption test
const GAS_COST_REQUEST_COORDINATE_CELL_ADDRESS: coins = ton("0.015"); // From gas consumption test
const GAS_COST_REQUEST_TO_MOVE: coins = ton("0.06"); // 0.0589864 + buffer
const TODO_TOTAL_GAS_TO_MOVE = GAS_COST_REQUEST_TO_MOVE + GAS_COST_MOVE_SHIP_TO_CC + BASIC_STORAGE_TAX;
// Internal message gas costs (from test results, with buffer)
const GAS_COST_MOVE_SHIP_TO_CC: coins = ton("0.12"); // Ship -> CoordinateCell (MoveShipToCC) - includes storage + gas for Move (estimated from move flow)
const GAS_COST_MOVE: coins = ton("0.12"); // CoordinateCell -> CoordinateCell (Move) - includes storage (if new) + gas for MoveEnd (estimated from move flow)
const GAS_COST_MOVE_END: coins = ton("0.06"); // CoordinateCell -> Ship (MoveEnd) - just gas (estimated)
const GAS_COST_REQUEST_MINT: coins = ton("0.22"); // Ship -> Game (RequestMint) - includes MINT_TON_AMOUNT (0.2) + gas (~0.02)
const GAS_COST_FORWARD_MINT_REQUEST: coins = ton("0.06"); // Game -> GameManager (ForwardMintRequest) - just gas (estimated)
const GAS_COST_JETTON_USED: coins = ton("0.06"); // GameManager -> Game (JettonUsed) - just gas (estimated)
const GAS_COST_SHIP_UPGRADE: coins = ton("0.06"); // Game -> Ship (ShipUpgrade) - just gas (estimated)
const GAS_COST_RESET_SHIP: coins = ton("0.05"); // ResetShip handler gas buffer
const GAS_COST_TRANSFER_NOTIFICATION: coins = ton("0.06"); // JettonWallet -> GameManager (TransferNotificationForRecipient) - just gas (estimated)
const GAS_COST_WITHDRAW_JETTON: coins = ton("0.05"); // Gas for jetton wallet operations during withdrawal
const GAS_COST_WITHDRAW_NFT: coins = ton("0.05"); // Gas for NFT operations during withdrawal
const GAS_COST_WITHDRAW: coins = ton("0.02"); // WithdrawExcessTON handler gas (owner reclaim of ship surplus)

// Floor the ship retains on a WithdrawExcessTON reclaim: one session-move float
// (== SESSION_MOVE_FLOAT) so auto/session moves stay funded after the owner pulls surplus.
// Never reserved below the storage tax (enforced in the handler).
const WITHDRAW_KEEP_AMOUNT: coins = ton("1");

// HardTravel minimum inbound value. Right-sized (2026-06-22, ship-ton-economics-fix) from a
// flat 1 TON floor down to the real per-walk gas need: it must fund the launch hop
// (Ship -> current CC), one HardTravel hop (CC -> CC), the HardTravelMoveEnd reply, plus the
// storage tax. The CLIENT funds the actual N-hop walk via the value it sends (>= this floor);
// unspent fuel is refunded to the owner by HardTravelMoveEnd, so the floor only needs to cover
// the shortest viable single-hop walk. Step-0 measurement (see the result) confirms a hard
// travel at this floor completes and leaves ~0 surplus on the ship.
const HARD_TRAVEL_MIN_VALUE: coins = GAS_COST_MOVE_SHIP_TO_CC + GAS_COST_MOVE + GAS_COST_MOVE_END + BASIC_STORAGE_TAX;

// Native session (external move/exit) ─────────────────────────────────────────
// Upper bound for a session move's moveMode (LEFT=0 UP=1 RIGHT=2 EXIT=3). Must equal
// MoveMode.EXIT; a session key may ONLY trigger move/exit, never any other ship op.
const MOVE_MODE_EXIT: uint8 = 3;
// The external carries NO value; the move is funded from the ship's float. This is the
// effective value handed to runMove: it reserves (balance - SESSION_MOVE_FLOAT + tax) so the
// move carries ~SESSION_MOVE_FLOAT onward. It must cover the FULL downstream chain (cells the
// value flows through retain storage + pay gas at each hop, then the MoveEnd cashback), so it
// is sized like a real internal move — the game's own tests send 1 TON per move and the move
// path is only proven at that level. Excess flows back to userAddress via the MoveEnd cashback
// exactly as the wallet path, so this is round-tripped, not spent; the owner tops the ship
// float up via SetSessionKey value (or a plain transfer) to fund the next batch of moves.
const SESSION_MOVE_FLOAT: coins = ton("1");

// Note: SEND_MODE constants from stdlib:
// SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE = 64 (carry remaining message value)
// SEND_MODE_CARRY_ALL_REMAINING_BALANCE = 128 (carry all remaining balance)
// SEND_MODE_IGNORE_ERRORS = 2
// Use send_mode=128 (CARRY_ALL_REMAINING_BALANCE) where we want to forward all excess balance
const SEND_MODE_CARRY_ALL_REMAINING_BALANCE: uint8 = 128;

// WithdrawTON constants
const WITHDRAW_TON_MIN_BALANCE_MULTIPLIER: uint8 = 10; // minRequiredBalance = BASIC_STORAGE_TAX * 10

// Forward payload marker for jetton transfers
const FORWARD_PAYLOAD_MARKER: uint128 = 1;

const var_mutableVar: int = 10;
const val_immutableVal: int = 20;

enum UniqueResult {
    SAFE_EXIT
    CRASH
    CONTINUE
}

enum MoveMode: uint8 {
    LEFT
    UP
    RIGHT
    EXIT
}

enum SpecialType: uint8 {
    EMPTY
    LOW
    HIGH
    EXTRA
}

enum JettonUsageMode: uint8 {
    SHIP_UPGRADE
    FAST_TRAVEL_UPGRADE
}
