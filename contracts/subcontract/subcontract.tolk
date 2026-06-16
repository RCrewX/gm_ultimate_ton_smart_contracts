// SPDX-License-Identifier: UNLICENSED
import "static"
import "@stdlib/gas-payments"

type AllowedMessagesToSubcontract = 
    | ManualDeploy
    | Forward
    | ForwardWithInit
    | Withdraw
    | TransferNotificationForRecipient
    | ReturnExcessesBack
    | SetRedirectExcess
    | SetExcessThreshold

fun onInternalMessage(in: InMessage) {
    
    val msg = lazy AllowedMessagesToSubcontract.fromSlice(in.body);
    match (msg) {
        ManualDeploy => {

            // Owner-only: ManualDeploy must come from the stored owner address. Checked FIRST so a
            // non-owner gets ERR_INVALID_OWNER_SENDER instead of a misleading gas/balance error.
            var storage = lazy SubcontractStorage.load();
            assert (in.senderAddress == storage.ownerAddress) throw ERR_INVALID_OWNER_SENDER;

            // assert gas>const_min_to_deploy-fee
            assert (in.valueCoins >= GAS_COST_MANUAL_DEPLOY - BASIC_STORAGE_TAX) throw ERR_MESSAGE_VALUE_TOO_LOW;
            assert (contract.getOriginalBalance() > (2 * GAS_COST_MANUAL_DEPLOY) - BASIC_STORAGE_TAX) throw ERR_NOT_ENOUGH_BALANCE;

            val cashbackMessage = createMessage({
                bounce: BounceMode.NoBounce,
                dest: in.senderAddress,
                value: GAS_COST_MANUAL_DEPLOY + BASIC_STORAGE_TAX,
                body: beginCell().endCell() // Empty body for simple transfer
            });
            cashbackMessage.send(SEND_MODE_IGNORE_ERRORS + SEND_MODE_PAY_FEES_SEPARATELY);
            
        }
        ReturnExcessesBack => {
            // Handle excess message
            // Load storage fresh to get current redirectExcess and excessThreshold values
            var storage = lazy SubcontractStorage.load();
            // If redirect excess is enabled and message value is greater than or equal to threshold, resend to owner
            if (storage.redirectExcess && in.valueCoins >= storage.excessThreshold) {
                // Reserve value first (before sending forward message)
                // This ensures we have enough balance for the forward
                reserveValue(in.valueCoins);
                // Use value 0 with CARRY_ALL_REMAINING_MESSAGE_VALUE to forward all excess after gas
                val out = createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: storage.ownerAddress,
                    value: 0,
                    body: ReturnExcessesBack {
                        queryId: msg.queryId
                    }
                });
                out.send(SEND_MODE_IGNORE_ERRORS + SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
            } else {
                reserveValue(in.valueCoins);
            }
        }
        Forward => {
            // Auth check - using lazy since we only read ownerAddress (read-only access)
            var storage = lazy SubcontractStorage.load();
            assert (in.senderAddress == storage.ownerAddress) throw ERR_INVALID_OWNER_SENDER;
            // Value check: must cover gas cost + forward amount
            assert (in.valueCoins >= GAS_COST_FORWARD + msg.forwardTonAmount) throw ERR_MESSAGE_VALUE_TOO_LOW;
            // Reserve value, but leave enough for gas + forwardAmount when sending the message
            // When sending a message, we need: forwardAmount (message value) + gas (transaction cost)
            // We reduce reserve by (GAS_COST_FORWARD + msg.forwardTonAmount) to ensure we have enough
            reserveValue(in.valueCoins, -(GAS_COST_FORWARD + msg.forwardTonAmount));
            // Build outgoing message with bounce from command
            // Tolk BounceMode enum: NoBounce (0), Only256BitsOfBody (2)
            // For bounce=true, we use Only256BitsOfBody as it's the only bounce option available
            // For bounce=false, we use NoBounce
            var bounceMode: BounceMode;
            if (msg.bounce) {
                bounceMode = BounceMode.Only256BitsOfBody;
            } else {
                bounceMode = BounceMode.NoBounce;
            }
            val out = createMessage({
                bounce: bounceMode,
                dest: msg.destination,
                value: msg.forwardTonAmount,
                body: msg.messageBody
            });
            // Send with sendMode from command (no hardcoded 128)
            out.send(msg.sendMode);
        }
        ForwardWithInit => {
            // Auth check - using lazy since we only read ownerAddress (read-only access)
            var storage = lazy SubcontractStorage.load();
            assert (in.senderAddress == storage.ownerAddress) throw ERR_INVALID_OWNER_SENDER;
            // Value check: must cover gas cost + forward amount
            assert (in.valueCoins >= GAS_COST_FORWARD_WITH_INIT + msg.forwardTonAmount) throw ERR_MESSAGE_VALUE_TOO_LOW;
            // Reserve value, but leave enough for gas + forwardAmount when sending the message
            // When sending a message, we need: forwardAmount (message value) + gas (transaction cost)
            // We reduce reserve by (GAS_COST_FORWARD_WITH_INIT + msg.forwardTonAmount) to ensure we have enough
            reserveValue(in.valueCoins, -(GAS_COST_FORWARD_WITH_INIT + msg.forwardTonAmount));
            // Build outgoing message with stateInit
            // Deploy rule: stateInit present, enforce NoBounce (forced, not checked)
            // In Tolk, stateInit is included when using AutoDeployAddress as dest
            // Parse stateInit cell: stateInit$00 code:^Cell data:^Cell
            var stateInitSlice = msg.stateInit.beginParse();
            val _splitDepth = stateInitSlice.loadUint(1); // Skip split_depth (1 bit)
            val _special = stateInitSlice.loadUint(1); // Skip special (1 bit)
            val code = stateInitSlice.loadRef(); // Load code cell
            val data = stateInitSlice.loadRef(); // Load data cell
            // Create AutoDeployAddress with the parsed stateInit
            val deployAddress: AutoDeployAddress = {
                stateInit: {
                    code: code,
                    data: data
                }
            };
            val out = createMessage({
                bounce: BounceMode.NoBounce,  // Enforced for deploy
                dest: deployAddress,
                value: msg.forwardTonAmount,
                body: msg.messageBody
            });
            // Send with sendMode from command
            out.send(msg.sendMode);
        }
        Withdraw => {
            // Auth check - using lazy since we only read ownerAddress (read-only access)
            var storage = lazy SubcontractStorage.load();
            assert (in.senderAddress == storage.ownerAddress) throw ERR_INVALID_OWNER_SENDER;
            // Calculate available balance: current balance - BASIC_STORAGE_TAX (for gas safety)
            // getOriginalBalance() returns balance before processing the current message
            // We need to account for the incoming message value
            val balanceBeforeMsg = contract.getOriginalBalance() - in.valueCoins;
            val maxWithdrawable = balanceBeforeMsg - BASIC_STORAGE_TAX;
            // Validate amount: must be more than BASIC_STORAGE_TAX and less than or equal to maxWithdrawable
            assert (msg.amount > BASIC_STORAGE_TAX) throw ERR_WITHDRAW_AMOUNT_TOO_LOW;
            assert (msg.amount <= maxWithdrawable) throw ERR_WITHDRAW_AMOUNT_TOO_HIGH;
            // Withdraw the specified amount to msg.receiver
            val out = createMessage({
                bounce: BounceMode.NoBounce,
                dest: msg.receiver,
                value: msg.amount,
                body: beginCell().endCell() // Empty body for simple transfer
            });
            out.send(SEND_MODE_IGNORE_ERRORS + SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }
        SetRedirectExcess => {
            // Using lazy for partial update - compiler handles efficient write-back via toCell()
            var storage = lazy SubcontractStorage.load();
            assert (in.senderAddress == storage.ownerAddress) throw ERR_INVALID_OWNER_SENDER;
            // Update redirect excess flag - lazy allows partial updates via toCell()
            storage.redirectExcess = msg.redirectExcess;
            storage.save();
            reserveValue(in.valueCoins);
            val cashbackMessage = createMessage({
                bounce: BounceMode.NoBounce,
                dest: storage.ownerAddress,
                value: 0,
                body: beginCell().endCell() // Empty body for simple transfer
            });
            cashbackMessage.send(SEND_MODE_IGNORE_ERRORS + SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }
        SetExcessThreshold => {
            // Using lazy for partial update - compiler handles efficient write-back via toCell()
            var storage = lazy SubcontractStorage.load();
            assert (in.senderAddress == storage.ownerAddress) throw ERR_INVALID_OWNER_SENDER;
            // Validate threshold: must be at least MIN_EXCESS_THRESHOLD
            assert (msg.excessThreshold >= MIN_EXCESS_THRESHOLD) throw ERR_EXCESS_THRESHOLD_TOO_LOW;
            // Update excess threshold - lazy allows partial updates via toCell()
            storage.excessThreshold = msg.excessThreshold;
            storage.save();
            reserveValue(in.valueCoins);
            val cashbackMessage = createMessage({
                bounce: BounceMode.NoBounce,
                dest: storage.ownerAddress,
                value: 0,
                body: beginCell().endCell() // Empty body for simple transfer
            });
            cashbackMessage.send(SEND_MODE_IGNORE_ERRORS + SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }
        TransferNotificationForRecipient => {
            // Accept jetton transfer notifications (from jetton wallet)
            // Just reserve value and do nothing - subcontract can receive these messages
            // No auth check needed - anyone can send transfer notifications
            reserveValue(in.valueCoins);
        }
        else => {
            reserveValue(in.valueCoins);
        }
    }
}

get fun get_owner_address(): address {
    var storage = lazy SubcontractStorage.load();
    return storage.ownerAddress;
}

get fun get_id(): uint256 {
    var storage = lazy SubcontractStorage.load();
    return storage.id;
}

get fun get_subcontract_address(id: uint256): address {
    // For address calculation, we need ownerPublicKey from storage
    // Note: This calculates address assuming same ownerPublicKey as current contract
    var storage = lazy SubcontractStorage.load();
    return calcAddressOfSubcontract(contract.getAddress(), id, storage.ownerPublicKey, contract.getCode());
}

get fun get_subcontract_by_id_address(ownerAddress: address, id: uint256): address {
    // For address calculation, we need ownerPublicKey
    // Since we don't have it, we use 0 as default (address calculation only)
    // WARNING: Actual initialization must use the correct ownerPublicKey, or address will differ
    return calcAddressOfSubcontract(ownerAddress, id, 0, contract.getCode());
}

get fun get_redirect_excess(): bool {
    var storage = lazy SubcontractStorage.load();
    return storage.redirectExcess;
}

get fun get_excess_threshold(): coins {
    var storage = lazy SubcontractStorage.load();
    return storage.excessThreshold;
}

get fun tonBalance(): coins {
    return contract.getOriginalBalance();
}

get fun get_owner_public_key(): uint256 {
    var storage = lazy SubcontractStorage.load();
    return storage.ownerPublicKey;
}

get fun get_ext_seqno(): uint32 {
    var storage = lazy SubcontractStorage.load();
    return storage.extSeqno;
}

// External message handler for owner-signed messages
fun onExternalMessage(inMsg: slice) {
    // Parse envelope (cheap parsing, no accept yet)
    val env = ExternalEnvelope.fromSlice(inMsg);
    val innerCell = env.inner;
    val signature = env.signature;
    
    // Load storage
    var storage = lazy SubcontractStorage.load();
    
    // Verify signature (still no acceptExternalMessage() yet)
    // Hash the inner cell (fast - cell hash is precomputed)
    val hash = innerCell.hash();
    // Convert bits512 to slice for isSignatureValid (UNSAFE cast, but safe here since bits512 is 512 bits)
    val signatureSlice = signature as slice;
    val ok = isSignatureValid(hash, signatureSlice, storage.ownerPublicKey);
    if (!ok) {
        throw ERR_INVALID_SIGNATURE;
    }
    
    // Parse signed inner
    val inner = ExternalInner.fromCell(innerCell);
    
    // Replay + time checks
    assert(inner.seqno == storage.extSeqno) throw ERR_BAD_SEQNO;
    assert(blockchain.now() < inner.validUntil) throw ERR_EXPIRED;
    
    // Now accept external message
    acceptExternalMessage();
    
    // Update seqno FIRST (wallet pattern - prevents replay even if later logic throws)
    storage.extSeqno += 1;
    storage.save();
    
    // Optionally commit state before sending actions (wallet-style)
    commitContractDataAndActions();
    
    // Execute forwarding based on inner.command
    // Bind command to a variable for access in match branches
    val cmd = inner.command;
    match(cmd) {
        Forward => {
            // Balance check: ensure we have enough for forward + gas + reserve
            val balance = contract.getOriginalBalance();
            val requiredBalance = BASIC_STORAGE_TAX + cmd.forwardTonAmount + GAS_MARGIN;
            assert(balance >= requiredBalance) throw ERR_MESSAGE_VALUE_TOO_LOW;
            
            // Build outgoing message with bounce from command
            var bounceMode: BounceMode;
            if (cmd.bounce) {
                bounceMode = BounceMode.Only256BitsOfBody;
            } else {
                bounceMode = BounceMode.NoBounce;
            }
            val out = createMessage({
                bounce: bounceMode,
                dest: cmd.destination,
                value: cmd.forwardTonAmount,
                body: cmd.messageBody
            });
            // Send with sendMode from command
            out.send(cmd.sendMode);
        }
        ForwardWithInit => {
            // Balance check: ensure we have enough for forward + gas + reserve
            val balance = contract.getOriginalBalance();
            val requiredBalance = BASIC_STORAGE_TAX + cmd.forwardTonAmount + GAS_MARGIN;
            assert(balance >= requiredBalance) throw ERR_MESSAGE_VALUE_TOO_LOW;
            
            // Build outgoing message with stateInit
            // Parse stateInit cell: stateInit$00 code:^Cell data:^Cell
            var stateInitSlice = cmd.stateInit.beginParse();
            val _splitDepth = stateInitSlice.loadUint(1); // Skip split_depth (1 bit)
            val _special = stateInitSlice.loadUint(1); // Skip special (1 bit)
            val code = stateInitSlice.loadRef(); // Load code cell
            val data = stateInitSlice.loadRef(); // Load data cell
            // Create AutoDeployAddress with the parsed stateInit
            val deployAddress: AutoDeployAddress = {
                stateInit: {
                    code: code,
                    data: data
                }
            };
            val out = createMessage({
                bounce: BounceMode.NoBounce,  // Enforced for deploy
                dest: deployAddress,
                value: cmd.forwardTonAmount,
                body: cmd.messageBody
            });
            // Send with sendMode from command
            out.send(cmd.sendMode);
        }
    }
}

