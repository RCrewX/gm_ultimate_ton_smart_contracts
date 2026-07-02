// SPDX-License-Identifier: UNLICENSED
import { Address, beginCell, Cell, toNano } from '@ton/core';

// =============================================================================
// Constants & encoders for the SoullessSlotMachine (SSM) + SSMSlot.
// Must stay in sync with:
//   contracts/soulless_slot_machine/ssm_common.tolk
//   contracts/soulless_slot_machine/static.tolk
// =============================================================================

export const BASIC_STORAGE_TAX = toNano('0.01');

// Reel count & symbol alphabet (ssm_common.tolk).
export const SSM_REELS = 3;
export const SYM_ZERO = 0;
export const SYM_SEVEN = 1;
export const SYM_X = 2;

// Allowed stakes (static.tolk). RUDA is 0-decimal / 1:1 => whole RUDA == raw unit.
export const ONE_RUDA = 1n;
export const RUDA_AMOUNT_10 = 10n;
export const RUDA_AMOUNT_100 = 100n;
export const RUDA_AMOUNT_1000 = 1000n;
export const CUSTOM_ALLOWED_AMOUNT = 1000000n; // exact raw, per brief

export const MIN_ROLL_VALUE = toNano('1.0');
export const NFT_REWARD_BUDGET = toNano('0.3');
export const RUDA_MINT_BUDGET = toNano('0.25');
export const ESCROW_RETURN_BUDGET = toNano('0.06');
export const NATIVE_BURN_BUDGET = toNano('0.25');

// Outcome kinds (static.tolk).
export const OUT_NOTHING = 0;
export const OUT_NFT = 1;
export const OUT_MINT_RUDA = 2;
export const OUT_RETURN_ESCROW = 3;

export const Opcodes = {
    OP_JETTON_USED: 0xd7610922,
    OP_TRANSFER_NOTIFICATION: 0x7362d09c,
    OP_ROLL_STEP: 0x55310001,
    OP_ROLL_RESULT: 0x55320002,
    OP_R1: 0x52310001,
    OP_MINT_NFT: 0x4d6e6674,
    OP_FORWARD_MINT_REQUEST: 0xf62ed009,
    OP_ASK_TO_TRANSFER: 0x0f8a7ea5,
    OP_RETURN_EXCESSES_BACK: 0xd53276db,
    OP_SET_SSM_CONFIG: 0x5535e701,
    OP_SSM_BURN_STAKE: 0x5362726e, // "Sbrn" — native-stake burn (R1-wrapped)
    // Custom-intake TEP-89 two-phase verification (GM-B-001).
    OP_REQUEST_WALLET_ADDRESS: 0x2c76b973, // provide_wallet_address (SSM -> claimed master)
    OP_RESPONSE_WALLET_ADDRESS: 0xd1735400, // take_wallet_address (master -> SSM)
    OP_RECLAIM_EXPIRED_ESCROW: 0x5535e702, // player/owner reclaim of an expired escrow
} as const;

// SSM error codes (contracts/soulless_slot_machine/static.tolk).
export const SsmErrors = {
    ERR_INVALID_CUSTOM_AMOUNT: 944,
    ERR_INSUFFICIENT_ROLL_VALUE: 945,
    ERR_BAD_FORWARD_PAYLOAD: 947,
    ERR_CUSTOM_ORIGIN_IS_NATIVE: 948,
    ERR_NO_PENDING_ROLL: 949,
    ERR_VERIFY_SENDER_MISMATCH: 950,
    ERR_ESCROW_NOT_EXPIRED: 951,
    ERR_RECLAIM_NOT_AUTHORIZED: 952,
} as const;

// Custom-intake TEP-89 verification TTL (seconds) — mirror of CUSTOM_VERIFY_TTL.
export const CUSTOM_VERIFY_TTL = 3600;

// ----- Symbol packing (2 bits per reel) -----
export function packSymbols(reels: number[]): number {
    let s = 0;
    for (let i = 0; i < reels.length; i++) {
        s |= (reels[i] & 3) << (2 * i);
    }
    return s;
}

export function unpackSymbols(symbols: number, reels = SSM_REELS): number[] {
    const out: number[] = [];
    for (let i = 0; i < reels; i++) {
        out.push((symbols >> (2 * i)) & 3);
    }
    return out;
}

// ----- TS mirror of the Tolk computeOutcome (for generating expectations) -----
export type RewardOutcome = {
    kind: number;
    nftType: bigint;
    nftTier: bigint;
    mintRudaAmount: bigint;
    returnEscrow: boolean;
};

export function expectedOutcome(symbols: number, isNative: boolean, stake: bigint): RewardOutcome {
    const reels = unpackSymbols(symbols);
    let nX = 0;
    let n7 = 0;
    for (const s of reels) {
        if (s === SYM_X) nX++;
        else if (s === SYM_SEVEN) n7++;
    }
    if (nX >= 1) {
        return {
            kind: OUT_NFT,
            nftType: n7 >= 1 ? 1n : 0n,
            nftTier: BigInt(nX),
            mintRudaAmount: 0n,
            returnEscrow: false,
        };
    }
    if (isNative) {
        if (n7 === 0) return { kind: OUT_NOTHING, nftType: 0n, nftTier: 0n, mintRudaAmount: 0n, returnEscrow: false };
        if (n7 === 1) return { kind: OUT_MINT_RUDA, nftType: 0n, nftTier: 0n, mintRudaAmount: stake, returnEscrow: false };
        if (n7 === 2) return { kind: OUT_MINT_RUDA, nftType: 0n, nftTier: 0n, mintRudaAmount: stake + ONE_RUDA, returnEscrow: false };
        return { kind: OUT_MINT_RUDA, nftType: 0n, nftTier: 0n, mintRudaAmount: stake * 10n, returnEscrow: false };
    }
    if (n7 === 0) return { kind: OUT_NOTHING, nftType: 0n, nftTier: 0n, mintRudaAmount: 0n, returnEscrow: false };
    if (n7 === 1) return { kind: OUT_RETURN_ESCROW, nftType: 0n, nftTier: 0n, mintRudaAmount: 0n, returnEscrow: true };
    if (n7 === 2) return { kind: OUT_RETURN_ESCROW, nftType: 0n, nftTier: 0n, mintRudaAmount: ONE_RUDA, returnEscrow: true };
    return { kind: OUT_NFT, nftType: 5n, nftTier: 0n, mintRudaAmount: 0n, returnEscrow: false };
}

// ----- Intake payload builders -----

// Native: data cell embedded by the depositor (RollIntakeData {player, queryId}).
export function encodeRollIntakeData(player: Address, queryId: bigint | number = 0): Cell {
    return beginCell().storeAddress(player).storeUint(queryId, 64).endCell();
}

// Native: the forwardPayload the depositor attaches to the RUDA transfer so R*
// routes a JettonUsed{amount, data} to the SSM game. R* loadRef's the transfer's
// forwardPayload to THIS cell, which must directly hold [^gameAddressCell, ^dataCell]
// (same shape as test_utils.buildJettonUsageForwardPayload — NOT double-wrapped).
//   forwardPayload (the cell returned here) = [ ^gameAddressCell, ^dataCell ]
export function buildNativeRollForwardPayload(ssmAddress: Address, player: Address, queryId: bigint | number = 0): Cell {
    const gameAddressCell = beginCell().storeAddress(ssmAddress).endCell();
    const dataCell = encodeRollIntakeData(player, queryId);
    return beginCell().storeRef(gameAddressCell).storeRef(dataCell).endCell();
}

// Custom: CustomRollPayload {master, player, queryId} (one ref inside the
// transfer-notification's forwardPayload).
export function encodeCustomRollPayload(master: Address, player: Address, queryId: bigint | number = 0): Cell {
    return beginCell().storeAddress(master).storeAddress(player).storeUint(queryId, 64).endCell();
}

// RollContext {player, stake, isNative, origin, escrowWallet, queryId} — the
// opaque cell carried through the slot chain (ssm_common.tolk).
export function encodeRollContext(ctx: {
    player: Address;
    stake: bigint;
    isNative: boolean;
    origin: Address;
    escrowWallet: Address;
    queryId: bigint | number;
}): Cell {
    return beginCell()
        .storeAddress(ctx.player)
        .storeCoins(ctx.stake)
        .storeBit(ctx.isNative)
        .storeAddress(ctx.origin)
        .storeAddress(ctx.escrowWallet)
        .storeUint(ctx.queryId, 64)
        .endCell();
}

// Owner (GM) config message.
export function encodeSetSsmConfig(ssmSlotCode: Cell, rudaMasterAddress: Address): Cell {
    return beginCell()
        .storeUint(Opcodes.OP_SET_SSM_CONFIG, 32)
        .storeRef(ssmSlotCode)
        .storeAddress(rudaMasterAddress)
        .endCell();
}
