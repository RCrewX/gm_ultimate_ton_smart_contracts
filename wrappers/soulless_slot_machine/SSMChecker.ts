// SPDX-License-Identifier: UNLICENSED
import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
} from '@ton/core';
import { Opcodes } from './types';

// =============================================================================
// SSMChecker — the ephemeral custom-intake verifier child of a SoullessSlotMachine.
// Storage = key {ssmAddress, player, master} + a REF cell of volatiles
// {phase, escrowWallet, stake, queryId, deadline} — see
// contracts/soulless_slot_machine/ssm_checker_static.tolk (SSMCheckerStorage).
// The address is derived from the KEY with volatiles zeroed, so SSM (and this
// wrapper) can recompute it before the checker ever runs.
// =============================================================================

export type SSMCheckerConfig = {
    ssmAddress: Address;
    player: Address;
    master: Address;
};

// addr_none placeholder for the zeroed volatile escrowWallet ($00, 2 bits).
function addrNoneCell(): Cell {
    return beginCell().storeUint(0, 2).endCell();
}

// Volatiles zeroed exactly as calcDeployedChecker builds them at deploy time.
function zeroVolatilesCell(): Cell {
    return beginCell()
        .storeUint(0, 8) // phase = 0
        .storeSlice(addrNoneCell().beginParse()) // escrowWallet = addr_none
        .storeCoins(0) // stake
        .storeUint(0, 64) // queryId
        .storeUint(0, 32) // deadline
        .endCell();
}

export function ssmCheckerConfigToCell(config: SSMCheckerConfig): Cell {
    return beginCell()
        .storeAddress(config.ssmAddress)
        .storeAddress(config.player)
        .storeAddress(config.master)
        .storeRef(zeroVolatilesCell())
        .endCell();
}

export class SSMChecker implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new SSMChecker(address);
    }

    static createFromConfig(config: SSMCheckerConfig, code: Cell, workchain = 0) {
        const data = ssmCheckerConfigToCell(config);
        const init = { code, data };
        return new SSMChecker(contractAddress(workchain, init), init);
    }

    // StartVerify {escrowWallet, stake, queryId, deadline} — drive as the SSM to begin
    // (or, on a busy checker, refund) a verification.
    async sendStartVerify(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        args: { escrowWallet: Address; stake: bigint; queryId: bigint | number; deadline: number },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Opcodes.OP_START_VERIFY, 32)
                .storeAddress(args.escrowWallet)
                .storeCoins(args.stake)
                .storeUint(args.queryId, 64)
                .storeUint(args.deadline, 32)
                .endCell(),
        });
    }

    // ResponseWalletAddress {queryId, jettonWalletAddress?, ownerAddress?} — drive as the
    // queried master vouching that `jettonWalletAddress` is its wallet for owner=SSM.
    async sendResponseWalletAddress(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        jettonWalletAddress: Address | null,
        queryId: bigint | number = 0,
        ownerAddress: Address | null = null,
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Opcodes.OP_RESPONSE_WALLET_ADDRESS, 32)
                .storeUint(queryId, 64)
                .storeAddress(jettonWalletAddress)
                .storeMaybeRef(ownerAddress ? beginCell().storeAddress(ownerAddress).endCell() : null)
                .endCell(),
        });
    }

    // Reclaim {queryId} — player or SSM reclaims an expired escrow after the deadline.
    async sendReclaim(provider: ContractProvider, via: Sender, value: bigint, queryId: bigint | number = 0) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(Opcodes.OP_RECLAIM, 32).storeUint(queryId, 64).endCell(),
        });
    }

    // get_checker_state -> (phase, player, master, escrowWallet, stake, deadline).
    // Throws if the account is gone (checker self-destructed after settling).
    async getCheckerState(provider: ContractProvider): Promise<{
        phase: number;
        player: Address;
        master: Address;
        escrowWallet: Address | null;
        stake: bigint;
        deadline: number;
    }> {
        const r = await provider.get('get_checker_state', []);
        return {
            phase: r.stack.readNumber(),
            player: r.stack.readAddress(),
            master: r.stack.readAddress(),
            escrowWallet: r.stack.readAddressOpt(),
            stake: r.stack.readBigNumber(),
            deadline: r.stack.readNumber(),
        };
    }
}
