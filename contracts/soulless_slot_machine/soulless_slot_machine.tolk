// SPDX-License-Identifier: UNLICENSED
import "ssm_common"
import "static"

// =============================================================================
// SoullessSlotMachine (SSM) — a real slot machine.
//
//   * Native RUDA roll  : the staked RUDA (sitting in GM's RUDA wallet) is BURNED
//     on EVERY native roll via R1{SsmBurnStake}; rewards are MINTED fresh
//     (honest burn-and-mint, symmetric). Intake = JettonUsed routed by R* to SSM.
//     Reward token wins -> ForwardMintRequest; NFT wins -> MintNft; loss -> burn +
//     cashback only.
//   * Custom jetton roll: ESCROW-and-RETURN on a fully separate code path. Intake
//     = a TEP-74 transfer-notification DIRECTLY from SSM's own custom wallet.
//     "tokens back" -> AskToTransfer the escrow back; NFT wins -> MintNft with
//     the custom master as origin; loss -> house keeps the escrow.
//
// Per roll, SSM deploys ephemeral SSMSlot contracts (one per reel). The roll
// context rides the message the whole way, so SSM keeps NO per-roll state.
// =============================================================================

type AllowedMessagesToSSM =
    | JettonUsed                       // native intake (from GM)
    | TransferNotificationForRecipient // custom intake phase 1: escrow notification from SSM's custom wallet
    | ResponseWalletAddress            // custom intake phase 2: the claimed master's TEP-89 answer
    | ReclaimExpiredEscrow             // custom timeout: refund an escrow whose master never answered
    | RollResult                       // from the last slot
    | SetSsmConfig                     // owner (GM) config
    | ReturnExcessesBack
    | LiteralyAnything

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessagesToSSM.fromSlice(in.body);
    var storage = lazy SSMStorage.load();

    match (msg) {

        // ---- NATIVE intake: GM delivered the R*-routed RUDA transfer-notification ----
        JettonUsed => {
            assert (in.senderAddress == storage.ownerAddress) throw ERR_INVALID_OWNER_SENDER;
            assert (isAllowedRudaAmount(msg.jettonAmount)) throw ERR_INVALID_RUDA_AMOUNT;
            assert (in.valueCoins >= MIN_ROLL_VALUE) throw ERR_INSUFFICIENT_ROLL_VALUE;

            val intake = RollIntakeData.fromCell(msg.data);
            val ctx: RollContext = {
                player: intake.player,
                stake: msg.jettonAmount,
                isNative: true,
                origin: storage.rudaMasterAddress,
                escrowWallet: contract.getAddress(), // unused on native path
                queryId: intake.queryId,
            };
            startRoll(storage, ctx, in.valueCoins);
        }

        // ---- CUSTOM intake PHASE 1: escrow notification straight from a custom wallet ----
        // The escrow is real (tokens are now in the notifying wallet W == in.senderAddress),
        // but the claimed `master` is UNPROVEN. We do NOT roll here. Instead we record a
        // pending roll keyed by W and ask the claimed master (via TEP-89) for its wallet for
        // owner=SSM. Only if the master answers with exactly W (Phase 2) do we roll with that
        // master as the NFT origin — closing the "mint an NFT with an arbitrary origin without
        // holding that master's tokens" vector (GM-B-001).
        TransferNotificationForRecipient => {
            assert (msg.jettonAmount == CUSTOM_ALLOWED_AMOUNT) throw ERR_INVALID_CUSTOM_AMOUNT;
            assert (in.valueCoins >= MIN_ROLL_VALUE) throw ERR_INSUFFICIENT_ROLL_VALUE;

            var fp: slice = msg.forwardPayload;
            assert (fp.remainingRefsCount() >= 1) throw ERR_BAD_FORWARD_PAYLOAD;
            val payload = CustomRollPayload.fromCell(fp.loadRef());

            // Hard rule: the native RUDA master can NEVER be a custom origin (a native NFT must
            // only ever come from the native burn-and-mint path). Reject at intake.
            assert (payload.master != storage.rudaMasterAddress) throw ERR_CUSTOM_ORIGIN_IS_NATIVE;

            val escrowWallet = in.senderAddress; // W: the wallet holding the escrow
            val pending: PendingRoll = {
                player: payload.player,
                stake: msg.jettonAmount,
                master: payload.master,
                queryId: payload.queryId,
                deadline: (blockchain.now() + CUSTOM_VERIFY_TTL) as uint32,
            };
            storage.pendingRolls.set(escrowWallet, pending);
            storage.save();

            // Reserve prior balance + tax; forward the rest to the claimed master as a TEP-89
            // wallet-address request. Its response (Phase 2) carries the value back to fund the
            // roll. NoBounce: a non-TEP-89 master simply never answers -> timeout reclaim.
            reserveValue(in.valueCoins);
            val req = createMessage({
                bounce: BounceMode.NoBounce,
                dest: payload.master,
                value: 0,
                body: RequestWalletAddress {
                    queryId: payload.queryId,
                    ownerAddress: contract.getAddress(),
                    includeOwnerAddress: true,
                },
            });
            req.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }

        // ---- CUSTOM intake PHASE 2: the claimed master answered TEP-89 ----
        // Match the reply against a pending escrow. The record is keyed by the escrow wallet W,
        // so a genuine master (queried in Phase 1) returns exactly that W. A forged notification
        // (from a wallet the claimed master does NOT own) makes the master return a DIFFERENT
        // wallet, which matches no pending record -> rejected (that forged escrow is reclaimed on
        // timeout). We also require the responder to BE the queried master.
        ResponseWalletAddress => {
            assert (msg.jettonWalletAddress != null) throw ERR_NO_PENDING_ROLL;
            val escrowWallet = msg.jettonWalletAddress!;
            val found = storage.pendingRolls.get(escrowWallet);
            assert (found.isFound) throw ERR_NO_PENDING_ROLL;
            val pending = found.loadValue();

            // Only the master we actually queried may vouch, and if it echoed the owner it must
            // be us. (Do NOT delete/refund on mismatch: a forged reply must not cancel a genuine
            // pending record — that record is settled by its own real reply or by timeout.)
            assert (in.senderAddress == pending.master) throw ERR_VERIFY_SENDER_MISMATCH;
            if (msg.ownerAddress != null) {
                assert (msg.ownerAddress!.load() == contract.getAddress()) throw ERR_VERIFY_SENDER_MISMATCH;
            }

            // Verified: the notifier IS the master's wallet for owner=SSM. Drop the record and
            // run the roll with the proven origin, escrow returnable to W.
            storage.pendingRolls.delete(escrowWallet);
            storage.save();

            val ctx: RollContext = {
                player: pending.player,
                stake: pending.stake,
                isNative: false,
                origin: pending.master,
                escrowWallet: escrowWallet,
                queryId: pending.queryId,
            };
            startRoll(storage, ctx, in.valueCoins);
        }

        // ---- CUSTOM timeout: reclaim an escrow whose master never answered TEP-89 ----
        // Callable by the escrow's player or the owner (GM). After the verify TTL, refund the
        // escrow to the player and drop the record. Idempotent-safe: a missing record throws.
        ReclaimExpiredEscrow => {
            val found = storage.pendingRolls.get(msg.wallet);
            assert (found.isFound) throw ERR_NO_PENDING_ROLL;
            val pending = found.loadValue();
            assert (in.senderAddress == storage.ownerAddress || in.senderAddress == pending.player) throw ERR_RECLAIM_NOT_AUTHORIZED;
            assert (blockchain.now() > pending.deadline as int) throw ERR_ESCROW_NOT_EXPIRED;

            storage.pendingRolls.delete(msg.wallet);
            storage.save();

            reserveValue(in.valueCoins);
            val refund: AskToTransfer = {
                queryId: pending.queryId,
                jettonAmount: pending.stake,
                transferRecipient: pending.player,
                sendExcessesTo: pending.player,
                customPayload: null,
                forwardTonAmount: 0,
                forwardPayload: beginCell().toSlice(),
            };
            val m = createMessage({
                bounce: BounceMode.NoBounce,
                dest: msg.wallet, // the escrow wallet W
                value: ESCROW_RETURN_BUDGET,
                body: refund,
            });
            m.send(SEND_MODE_PAY_FEES_SEPARATELY);
        }

        // ---- Roll completed: the last slot returned the 3-symbol result ----
        RollResult => {
            val lastSlot = calcAddressOfSlot(contract.getAddress(), SSM_REELS - 1, storage.ssmSlotCode);
            assert (in.senderAddress == lastSlot) throw ERR_INVALID_SLOT_RESULT_SENDER;

            val ctx = msg.ctx.load();
            reserveValue(in.valueCoins);
            settleReward(storage, ctx, msg.symbols);
        }

        // ---- Owner (GM) config ----
        SetSsmConfig => {
            assert (in.senderAddress == storage.ownerAddress) throw ERR_INVALID_OWNER_SENDER;
            assert (in.valueCoins >= GAS_COST_SET_CONFIG) throw ERR_MESSAGE_VALUE_TOO_LOW;
            storage.ssmSlotCode = msg.ssmSlotCode;
            storage.rudaMasterAddress = msg.rudaMasterAddress;
            storage.save();
            reserveValue(in.valueCoins);
            val back = createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: 0,
                body: ReturnExcessesBack { queryId: 0 }
            });
            back.send(SEND_MODE_IGNORE_ERRORS + SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }

        ReturnExcessesBack => {
            reserveValue(in.valueCoins);
        }
        LiteralyAnything => {
            reserveValue(in.valueCoins);
        }
        else => {
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}

// Reserve storage, then deploy reel 0 carrying the whole remaining value into the
// chain. The value travels SSM -> slot0 -> slot1 -> slot2 -> SSM (RollResult).
fun startRoll(storage: SSMStorage, ctx: RollContext, msgValue: coins) {
    reserveValue(msgValue);
    val step: RollStep = {
        ctx: ctx.toCell(),
        symbols: 0,
    };
    val deployMsg = createMessage({
        bounce: BounceMode.NoBounce,
        dest: calcDeployedSlot(contract.getAddress(), 0, storage.ssmSlotCode),
        value: 0,
        body: step,
    });
    deployMsg.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
}

// Map symbols -> outcome and emit the reward (bounded value) + cashback (the
// carry-all remainder) to the player. reserveValue() was already called by the
// RollResult arm before this runs.
fun settleReward(storage: SSMStorage, ctx: RollContext, symbols: int) {
    val outcome = computeOutcome(symbols, ctx.isNative, ctx.stake);

    // (a0) NATIVE stake burn — EVERY native roll burns the staked RUDA (honest
    //      burn-and-mint, regardless of outcome incl. a loss). SSM is a registered
    //      game, so R* authorizes this like a mint and routes AskToBurn to GM's
    //      RUDA wallet. Custom rolls never burn (escrow-and-return; house can't mint
    //      custom). Symmetry: native stake in == burned; any payout out == minted.
    if (ctx.isNative) {
        val burn: SsmBurnStake = { queryId: ctx.queryId, amount: ctx.stake };
        val r1: R1 = { data: burn.toCell() };
        val m = createMessage({
            bounce: BounceMode.NoBounce,
            dest: storage.ownerAddress,
            value: NATIVE_BURN_BUDGET,
            body: r1,
        });
        m.send(SEND_MODE_PAY_FEES_SEPARATELY);
    }

    // (a) custom escrow return — send the staked custom jetton back to the player
    //     via SSM's own custom wallet.
    if (outcome.returnEscrow) {
        val transfer: AskToTransfer = {
            queryId: ctx.queryId,
            jettonAmount: ctx.stake,
            transferRecipient: ctx.player,
            sendExcessesTo: ctx.player,
            customPayload: null,
            forwardTonAmount: 0,
            forwardPayload: beginCell().toSlice(),
        };
        val m = createMessage({
            bounce: BounceMode.NoBounce,
            dest: ctx.escrowWallet,
            value: ESCROW_RETURN_BUDGET,
            body: transfer,
        });
        m.send(SEND_MODE_PAY_FEES_SEPARATELY);
    }

    // (b) RUDA mint — native token wins, and the +1 RUDA on custom 077. Routed
    //     through GM as a normal game reward (R1{ForwardMintRequest}).
    if (outcome.mintRudaAmount > 0) {
        val fmr: ForwardMintRequest = {
            receiver: ctx.player,
            amount: outcome.mintRudaAmount,
        };
        val r1: R1 = { data: fmr.toCell() };
        val m = createMessage({
            bounce: BounceMode.NoBounce,
            dest: storage.ownerAddress,
            value: RUDA_MINT_BUDGET,
            body: r1,
        });
        m.send(SEND_MODE_PAY_FEES_SEPARATELY);
    }

    // (c) NFT mint — origin distinguishes native vs custom; one shared collection.
    if (outcome.kind == OUT_NFT) {
        val content: NFTContent = {
            origin: ctx.origin,
            itemType: outcome.nftType,
            tier: outcome.nftTier,
            seen: null, // SSM never mints a multisplav item; empty provenance slot
        };
        val mint: MintNft = {
            receiver: ctx.player,
            content: content.toCell(),
        };
        val r1: R1 = { data: mint.toCell() };
        val m = createMessage({
            bounce: BounceMode.NoBounce,
            dest: storage.ownerAddress,
            value: NFT_REWARD_BUDGET,
            body: r1,
        });
        m.send(SEND_MODE_PAY_FEES_SEPARATELY);
    }

    // (d) cashback — THE single clean rule (no asymmetric quirk): refund whatever
    //     TON is left after the bounded reward/burn budgets are paid out, on BOTH
    //     win and loss paths. reserveValue() (called in the RollResult arm) already
    //     kept the contract's prior balance + the BASIC_STORAGE_TAX (0.01) floor, so
    //     the carry-all remainder here is exactly the player's excess. IGNORE_ERRORS
    //     is the dust floor: if the remainder is below the message fee it stays put
    //     rather than failing the settle.
    val cashback = createMessage({
        bounce: BounceMode.NoBounce,
        dest: ctx.player,
        value: 0,
        body: ReturnExcessesBack { queryId: ctx.queryId },
    });
    cashback.send(SEND_MODE_IGNORE_ERRORS + SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
}

// =============================================================================
//  Get-methods
// =============================================================================

get fun get_owner_address(): address {
    val storage = lazy SSMStorage.load();
    return storage.ownerAddress;
}

get fun get_ruda_master(): address {
    val storage = lazy SSMStorage.load();
    return storage.rudaMasterAddress;
}

get fun get_slot_code(): cell {
    val storage = lazy SSMStorage.load();
    return storage.ssmSlotCode;
}

get fun get_slot_address(reelIndex: int): address {
    val storage = lazy SSMStorage.load();
    return calcAddressOfSlot(contract.getAddress(), reelIndex, storage.ssmSlotCode);
}

// Pending custom-roll escrow keyed by wallet W: (isFound, player, stake, master, queryId,
// deadline). For an absent key returns (false, W, 0, W, 0, 0). Lets tests observe the
// two-phase verification state without driving the whole handshake.
get fun get_pending_roll(wallet: address): (bool, address, coins, address, int, int) {
    val storage = lazy SSMStorage.load();
    val found = storage.pendingRolls.get(wallet);
    if (!found.isFound) {
        return (false, wallet, 0, wallet, 0, 0);
    }
    val p = found.loadValue();
    return (true, p.player, p.stake, p.master, p.queryId, p.deadline as int);
}

// Pure reward mapping exposed for exhaustive unit testing of every table row.
// Returns (kind, nftType, nftTier, mintRudaAmount, returnEscrow).
get fun get_reward(symbols: int, isNative: bool, stake: coins): (int, int, int, coins, bool) {
    val outcome = computeOutcome(symbols, isNative, stake);
    return (outcome.kind, outcome.nftType as int, outcome.nftTier as int, outcome.mintRudaAmount, outcome.returnEscrow);
}
