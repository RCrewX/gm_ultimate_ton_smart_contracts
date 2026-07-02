// SPDX-License-Identifier: UNLICENSED
import "ssm_common"
import "ssm_checker_static"
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
    | VerifiedRoll                     // custom intake phase 2: the SSMChecker proved the origin -> roll
    | RefundEscrow                     // custom intake failed (mismatch/collision/timeout) -> return escrow
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
        // but the claimed `master` is UNPROVEN. We do NOT roll here, and we write NOTHING to our
        // own storage (SSM stays O(1)). Instead we deploy an ephemeral SSMChecker child keyed by
        // (SSM, player, master) and hand it the escrow to verify via TEP-89. Only if the master
        // vouches that W is its wallet for owner=SSM does the checker send us VerifiedRoll —
        // closing the "mint an NFT with an arbitrary origin without holding that master's tokens"
        // vector (GM-B-001). A busy checker (a live verification for the same key) refunds this
        // second intake; a master that never answers is reclaimed after the TTL.
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
            // Reserve prior balance + tax; forward the rest into the checker deploy. The checker
            // funds the TEP-89 round-trip and carries the value back inside VerifiedRoll/RefundEscrow.
            reserveValue(in.valueCoins);
            val startVerify = createMessage({
                bounce: BounceMode.NoBounce,
                dest: calcDeployedChecker(contract.getAddress(), payload.player, payload.master, storage.ssmCheckerCode),
                value: 0,
                body: StartVerify {
                    escrowWallet: escrowWallet,
                    stake: msg.jettonAmount,
                    queryId: payload.queryId,
                    deadline: (blockchain.now() + CUSTOM_VERIFY_TTL) as uint32,
                },
            });
            startVerify.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }

        // ---- CUSTOM intake PHASE 2: the SSMChecker verified the origin -> roll ----
        // Authenticate by RECOMPUTING the checker address from (player, master) — never trust the
        // carried fields. Belt-and-braces: re-reject the native master as a custom origin. Then run
        // the roll exactly as before, with the proven master as origin and escrow returnable to W.
        VerifiedRoll => {
            assert (in.senderAddress == calcAddressOfChecker(contract.getAddress(), msg.player, msg.master, storage.ssmCheckerCode))
                throw ERR_INVALID_CHECKER_SENDER;
            assert (msg.master != storage.rudaMasterAddress) throw ERR_CUSTOM_ORIGIN_IS_NATIVE;
            // A "vouches-but-eats-the-value" master would underfund the roll: fail cleanly here
            // rather than strand a half-funded slot chain.
            assert (in.valueCoins >= MIN_VERIFIED_ROLL_VALUE) throw ERR_INSUFFICIENT_VERIFIED_VALUE;

            val ctx: RollContext = {
                player: msg.player,
                stake: msg.stake,
                isNative: false,
                origin: msg.master,
                escrowWallet: msg.escrowWallet,
                queryId: msg.queryId,
            };
            startRoll(storage, ctx, in.valueCoins);
        }

        // ---- CUSTOM intake failed: the checker asked us to return the escrow ----
        // Same address authentication. Return the staked custom jetton to the player via W. Inert-
        // safe: if W was a forged non-wallet, the AskToTransfer is ignored (a wallet obeys only its
        // owner, and SSM owns only its real wallets), so a forged escrow simply never moves.
        RefundEscrow => {
            assert (in.senderAddress == calcAddressOfChecker(contract.getAddress(), msg.player, msg.master, storage.ssmCheckerCode))
                throw ERR_INVALID_CHECKER_SENDER;

            reserveValue(in.valueCoins);
            val refund: AskToTransfer = {
                queryId: msg.queryId,
                jettonAmount: msg.stake,
                transferRecipient: msg.player,
                sendExcessesTo: msg.player,
                customPayload: null,
                forwardTonAmount: 0,
                forwardPayload: beginCell().toSlice(),
            };
            val m = createMessage({
                bounce: BounceMode.NoBounce,
                dest: msg.escrowWallet, // the escrow wallet W
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
            storage.ssmCheckerCode = msg.ssmCheckerCode;
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

get fun get_checker_code(): cell {
    val storage = lazy SSMStorage.load();
    return storage.ssmCheckerCode;
}

// Deterministic address of the ephemeral SSMChecker for a (player, master) verification.
// Lets tests/consumers find the child to observe its state or drive a timeout Reclaim.
get fun get_checker_address(player: address, master: address): address {
    val storage = lazy SSMStorage.load();
    return calcAddressOfChecker(contract.getAddress(), player, master, storage.ssmCheckerCode);
}

// Pure reward mapping exposed for exhaustive unit testing of every table row.
// Returns (kind, nftType, nftTier, mintRudaAmount, returnEscrow).
get fun get_reward(symbols: int, isNative: bool, stake: coins): (int, int, int, coins, bool) {
    val outcome = computeOutcome(symbols, isNative, stake);
    return (outcome.kind, outcome.nftType as int, outcome.nftTier as int, outcome.mintRudaAmount, outcome.returnEscrow);
}
