// SPDX-License-Identifier: UNLICENSED
// =============================================================================
// ssm_checker_static.tolk — SSMChecker storage, errors, and message surface.
//
// SSMChecker is an EPHEMERAL child of a SoullessSlotMachine, deployed at a
// deterministic address derived from the uniqueness key (ssmAddress, player,
// master). It owns ONE pending custom-roll verification: it performs the TEP-89
// wallet-address handshake with the claimed jetton master itself, hands SSM a
// VerifiedRoll or a RefundEscrow, then self-destructs. This keeps SSM at O(1)
// storage / O(1) per-message gas no matter how many verifications are in flight
// (see the design analysis: replaces SSMStorage.pendingRolls).
//
// Mirrors the SSMSlot child pattern: the ADDRESS-DEFINING init storage holds only
// the key; the per-verification VOLATILE fields (phase/escrow/stake/queryId/
// deadline) live in a ref cell that is zeroed at deploy and written by StartVerify.
// SSM recomputes the address from just the key (volatiles zeroed), so a callback
// is authenticated by address identity — never by a trusted field.
// =============================================================================

import "ssm_common"

// Carry-all + destroy-if-zero: settle a verification by forwarding the WHOLE
// remaining balance back to SSM and self-destructing the checker (mode 128 + 32).
const SEND_MODE_CARRY_ALL_AND_DESTROY: uint8 = 160;

// Errors — SSMChecker's own range (960..969). Codes are per-contract: they only
// ever surface on a checker transaction, so the numeric overlap with the printers'
// 960s (a different contract) is harmless.
const ERR_CHECKER_INVALID_SSM_SENDER = 960; // StartVerify not from the owning SSM
const ERR_CHECKER_NOT_MASTER = 961;         // ResponseWalletAddress not from the queried master (or wrong owner echo)
const ERR_CHECKER_BAD_PHASE = 962;          // response/reclaim while not awaiting an answer (phase != 1)
const ERR_CHECKER_NOT_EXPIRED = 963;        // Reclaim attempted before the verify deadline
const ERR_CHECKER_RECLAIM_NOT_AUTH = 964;   // Reclaim not from the escrow's player or the owning SSM

// =============================================================================
//  Storage — key (address-defining) + a volatile ref written after deploy.
// =============================================================================

// Per-verification state, written by StartVerify. Held in a REF (not inline) so the
// root storage stays under the 1023-bit cell limit: the three key addresses already
// occupy ~801 bits, and a fourth address (escrowWallet) plus the scalars would overflow.
struct SSMCheckerVolatiles {
    phase: uint8            // 0 = fresh (just deployed), 1 = awaiting the master's TEP-89 answer
    escrowWallet: address?  // W = the notifying jetton wallet; null (addr_none) until StartVerify sets it
    stake: coins            // escrowed custom jetton amount
    queryId: uint64
    deadline: uint32        // blockchain.now() + CUSTOM_VERIFY_TTL; after this the escrow is reclaimable
}

struct SSMCheckerStorage {
    // --- address-defining key (SSM recomputes the address from these three) ---
    ssmAddress: address     // the owning SoullessSlotMachine
    player: address         // reward recipient / refund target (the "user" component of the key)
    master: address         // claimed jetton master == NFT origin; also the queried TEP-89 responder
    // --- volatile (zeroed at deploy; set by StartVerify) ---
    volatiles: Cell<SSMCheckerVolatiles>
}

fun SSMCheckerStorage.load() {
    return SSMCheckerStorage.fromCell(contract.getData())
}

fun SSMCheckerStorage.save(self) {
    contract.setData(self.toCell())
}

// =============================================================================
//  Inbound message bodies
// =============================================================================

// SSM -> checker (Phase 1): begin verifying an escrow. player/master are NOT re-sent
// — they are the checker's address-defining key (SSM deployed us at f(ssm,player,master)).
struct (0x5535e703) StartVerify {
    escrowWallet: address    // W: the wallet that notified SSM with the escrow
    stake: coins
    queryId: uint64
    deadline: uint32
}

// TEP-89 discoverable-wallet exchange (opcodes byte-identical to tep/jetton/messages.tolk).
// Phase 1 out: the checker asks the claimed master "what is your wallet for owner=SSM?".
struct (0x2c76b973) RequestWalletAddress {
    queryId: uint64
    ownerAddress: address
    includeOwnerAddress: bool
}

// Phase 2 in: the master answers. The checker matches jettonWalletAddress against the
// escrow wallet W it recorded; only an exact match (from the queried master) verifies.
struct (0xd1735400) ResponseWalletAddress {
    queryId: uint64
    jettonWalletAddress: address?
    ownerAddress: Cell<address>?
}

// player-or-SSM reclaim after the verify deadline (a master that never spoke TEP-89):
// refund the escrow to the player and self-destruct.
struct (0x5535e706) Reclaim {
    queryId: uint64
}

// =============================================================================
//  Outbound message bodies (checker -> SSM)
// =============================================================================
// SSM authenticates BOTH of these by recomputing calcAddressOfChecker(SSM, player,
// master) and comparing to the sender — never by trusting the carried fields. The
// fields are echoed so SSM can recompute the address and drive the roll/refund.

// Verified: the notifier IS the master's wallet for owner=SSM. SSM runs the roll
// with `master` as the proven NFT origin, escrow returnable to `escrowWallet`.
struct (0x5535e704) VerifiedRoll {
    player: address
    master: address
    escrowWallet: address
    stake: coins
    queryId: uint64
}

// Not verified (mismatch / busy-collision / timeout): SSM returns the escrow to the
// player via `escrowWallet` (AskToTransfer). Inert-safe if W was a forged non-wallet.
struct (0x5535e705) RefundEscrow {
    player: address
    master: address
    escrowWallet: address
    stake: coins
    queryId: uint64
}

// =============================================================================
//  Deterministic address — from the key alone (volatiles zeroed), so SSM and the
//  checker agree on the init cell. Mirrors ssm_common.calcDeployedSlot.
// =============================================================================
fun calcDeployedChecker(
    ssmAddress: address,
    player: address,
    master: address,
    checkerCode: cell,
): AutoDeployAddress {
    val zeroVolatiles: SSMCheckerVolatiles = {
        phase: 0,
        escrowWallet: null, // addr_none until StartVerify records W
        stake: 0,
        queryId: 0,
        deadline: 0,
    };
    val initStorage: SSMCheckerStorage = {
        ssmAddress,
        player,
        master,
        volatiles: zeroVolatiles.toCell(),
    };
    return {
        stateInit: {
            code: checkerCode,
            data: initStorage.toCell()
        }
    };
}

fun calcAddressOfChecker(ssmAddress: address, player: address, master: address, checkerCode: cell): address {
    return calcDeployedChecker(ssmAddress, player, master, checkerCode).calculateAddress();
}
