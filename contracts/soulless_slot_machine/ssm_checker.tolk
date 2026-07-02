// SPDX-License-Identifier: UNLICENSED
import "ssm_common"
import "ssm_checker_static"

// =============================================================================
// SSMChecker — ephemeral, one per pending custom-roll verification, owned by its
// SoullessSlotMachine. Deployed at f(ssmAddress, player, master); performs the
// TEP-89 wallet-address handshake with the claimed master, then hands SSM a
// VerifiedRoll (match) or RefundEscrow (mismatch/timeout) and self-destructs.
//
//   StartVerify (from SSM) : record the escrow; ask the master for its wallet-for-SSM.
//                            A StartVerify for a BUSY checker refunds THAT intake to
//                            SSM (one-in-flight-per-key rule) without disturbing the
//                            live verification.
//   ResponseWalletAddress  : (from the queried master only) match W -> VerifiedRoll,
//     (Phase 2)              else -> RefundEscrow; either way self-destruct to SSM.
//   Reclaim                : (player or SSM, after the deadline) -> RefundEscrow + destroy.
//
// Sender auth is by ADDRESS identity: StartVerify must come from storage.ssmAddress,
// the TEP-89 answer must come from storage.master. The checker never trusts a field
// to decide who it is talking to — the key is baked into its own address.
// =============================================================================

type AllowedMessagesToChecker =
    | StartVerify
    | ResponseWalletAddress
    | Reclaim

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessagesToChecker.fromSlice(in.body);
    var storage = lazy SSMCheckerStorage.load();

    match (msg) {

        // ---- Phase 1: SSM asks us to verify an escrow ----
        StartVerify => {
            assert (in.senderAddress == storage.ssmAddress) throw ERR_CHECKER_INVALID_SSM_SENDER;
            val vol = storage.volatiles.load();

            if (vol.phase == 0) {
                // Fresh: record the volatiles and query the claimed master via TEP-89.
                val newVol: SSMCheckerVolatiles = {
                    phase: 1,
                    escrowWallet: msg.escrowWallet,
                    stake: msg.stake,
                    queryId: msg.queryId,
                    deadline: msg.deadline,
                };
                storage.volatiles = newVol.toCell();
                storage.save();

                reserveValue(in.valueCoins);
                val req = createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: storage.master,
                    value: 0,
                    body: RequestWalletAddress {
                        queryId: msg.queryId,
                        ownerAddress: storage.ssmAddress,
                        includeOwnerAddress: true,
                    },
                });
                req.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
            } else {
                // Busy (a live verification for this same (player, master) is in flight):
                // do NOT touch state; refund THIS second intake back to SSM. Same player &
                // master (they define our address), so SSM refunds it to the right player.
                reserveValue(in.valueCoins);
                val refund = createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: storage.ssmAddress,
                    value: 0,
                    body: RefundEscrow {
                        player: storage.player,
                        master: storage.master,
                        escrowWallet: msg.escrowWallet,
                        stake: msg.stake,
                        queryId: msg.queryId,
                    },
                });
                refund.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
            }
        }

        // ---- Phase 2: the claimed master answered TEP-89 ----
        ResponseWalletAddress => {
            val vol = storage.volatiles.load();
            assert (vol.phase == 1) throw ERR_CHECKER_BAD_PHASE;
            // Only the master we actually queried may vouch, and if it echoed the owner it
            // must be our SSM. (We asked for the master's wallet for owner=SSM.)
            assert (in.senderAddress == storage.master) throw ERR_CHECKER_NOT_MASTER;
            if (msg.ownerAddress != null) {
                assert (msg.ownerAddress!.load() == storage.ssmAddress) throw ERR_CHECKER_NOT_MASTER;
            }

            // Match iff the master vouches for EXACTLY the wallet that escrowed to SSM.
            // phase==1 guarantees escrowWallet was recorded (non-null).
            val matches = msg.jettonWalletAddress != null && msg.jettonWalletAddress! == vol.escrowWallet!;
            settleToSsm(storage, vol, matches);
        }

        // ---- Timeout: the master never answered; refund the escrow ----
        Reclaim => {
            val vol = storage.volatiles.load();
            assert (vol.phase == 1) throw ERR_CHECKER_BAD_PHASE;
            assert (blockchain.now() > vol.deadline as int) throw ERR_CHECKER_NOT_EXPIRED;
            assert (in.senderAddress == storage.player || in.senderAddress == storage.ssmAddress)
                throw ERR_CHECKER_RECLAIM_NOT_AUTH;
            settleToSsm(storage, vol, false);
        }

        else => {
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}

// Settle the verification: hand SSM a VerifiedRoll (verified==true) or a RefundEscrow,
// then self-destruct, carrying the WHOLE remaining balance back to SSM (mode 128 + 32)
// to fund the roll / the refund send. Both bodies echo the key + escrow so SSM can
// recompute our address and drive the outcome.
fun settleToSsm(storage: SSMCheckerStorage, vol: SSMCheckerVolatiles, verified: bool) {
    if (verified) {
        val m = createMessage({
            bounce: BounceMode.NoBounce,
            dest: storage.ssmAddress,
            value: 0,
            body: VerifiedRoll {
                player: storage.player,
                master: storage.master,
                escrowWallet: vol.escrowWallet!,
                stake: vol.stake,
                queryId: vol.queryId,
            },
        });
        m.send(SEND_MODE_CARRY_ALL_AND_DESTROY);
    } else {
        val m = createMessage({
            bounce: BounceMode.NoBounce,
            dest: storage.ssmAddress,
            value: 0,
            body: RefundEscrow {
                player: storage.player,
                master: storage.master,
                escrowWallet: vol.escrowWallet!,
                stake: vol.stake,
                queryId: vol.queryId,
            },
        });
        m.send(SEND_MODE_CARRY_ALL_AND_DESTROY);
    }
}

// =============================================================================
//  Get-methods — let tests observe the pending verification without driving the
//  whole handshake. Returns (phase, player, master, escrowWallet, stake, deadline).
//  A fresh (just-deployed) checker reports phase 0; after settle the account is
//  destroyed, so this method no longer resolves.
// =============================================================================
get fun get_checker_state(): (int, address, address, address?, coins, int) {
    val storage = lazy SSMCheckerStorage.load();
    val vol = storage.volatiles.load();
    return (vol.phase as int, storage.player, storage.master, vol.escrowWallet, vol.stake, vol.deadline as int);
}
