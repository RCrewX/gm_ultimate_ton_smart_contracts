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
    toNano,
} from '@ton/core';
import {
    Opcodes,
    encodeRollIntakeData,
    encodeCustomRollPayload,
    encodeCheckerCallback,
} from './types';

// Storage: { ownerAddress(=GM), ssmSlotCode (ref), rudaMasterAddress, ssmCheckerCode (ref) } —
// see contracts/soulless_slot_machine/static.tolk (SSMStorage). The old `pendingRolls` dict is
// gone: custom-intake verification now lives on the ephemeral SSMChecker child (gm-fix-1b).
export type SoullessSlotMachineConfig = {
    ownerAddress: Address;       // GameManager
    ssmSlotCode: Cell;           // compiled SSMSlot code
    rudaMasterAddress: Address;  // RUDA jetton minter (native NFT origin)
    ssmCheckerCode: Cell;        // compiled SSMChecker code (custom-intake verifier child)
};

export function soullessSlotMachineConfigToCell(config: SoullessSlotMachineConfig): Cell {
    return beginCell()
        .storeAddress(config.ownerAddress)
        .storeRef(config.ssmSlotCode)
        .storeAddress(config.rudaMasterAddress)
        .storeRef(config.ssmCheckerCode)
        .endCell();
}

export class SoullessSlotMachine implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new SoullessSlotMachine(address);
    }

    static createFromConfig(config: SoullessSlotMachineConfig, code: Cell, workchain = 0) {
        const data = soullessSlotMachineConfigToCell(config);
        const init = { code, data };
        return new SoullessSlotMachine(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    // Native intake: drive a JettonUsed exactly as GM would deliver it (sender
    // MUST be the SSM owner == GM). Used in integration tests with a GM-stand-in.
    async sendJettonUsed(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        jettonAmount: bigint,
        player: Address,
        queryId: bigint | number = 0,
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Opcodes.OP_JETTON_USED, 32)
                .storeCoins(jettonAmount)
                .storeRef(encodeRollIntakeData(player, queryId))
                .endCell(),
        });
    }

    // Custom intake PHASE 1: a TEP-74 transfer-notification straight from an escrow wallet
    // (the `via` sender stands in for that wallet W). SSM deploys an ephemeral SSMChecker child
    // keyed by (player, master) and hands it the escrow — it does NOT roll until the checker
    // verifies the origin via TEP-89 and replies VerifiedRoll.
    async sendCustomTransferNotification(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        jettonAmount: bigint,
        master: Address,
        player: Address,
        queryId: bigint | number = 0,
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Opcodes.OP_TRANSFER_NOTIFICATION, 32)
                .storeUint(queryId, 64)
                .storeCoins(jettonAmount)
                .storeAddress(player) // transferInitiator (present)
                .storeRef(encodeCustomRollPayload(master, player, queryId))
                .endCell(),
        });
    }

    // Raw checker-callback senders — used ONLY to prove the address gate: a VerifiedRoll /
    // RefundEscrow that does NOT come from the recomputed SSMChecker address is rejected
    // (ERR_INVALID_CHECKER_SENDER). In the real flow these come from the checker child.
    async sendVerifiedRoll(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        args: { player: Address; master: Address; escrowWallet: Address; stake: bigint; queryId: bigint | number },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeCheckerCallback(Opcodes.OP_VERIFIED_ROLL, args),
        });
    }

    async sendRefundEscrow(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        args: { player: Address; master: Address; escrowWallet: Address; stake: bigint; queryId: bigint | number },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeCheckerCallback(Opcodes.OP_REFUND_ESCROW, args),
        });
    }

    static setSsmConfigMessage(ssmSlotCode: Cell, ssmCheckerCode: Cell, rudaMasterAddress: Address): Cell {
        return beginCell()
            .storeUint(Opcodes.OP_SET_SSM_CONFIG, 32)
            .storeRef(ssmSlotCode)
            .storeRef(ssmCheckerCode)
            .storeAddress(rudaMasterAddress)
            .endCell();
    }

    // ----- Getters -----
    async getOwnerAddress(provider: ContractProvider): Promise<Address> {
        const r = await provider.get('get_owner_address', []);
        return r.stack.readAddress();
    }

    async getRudaMaster(provider: ContractProvider): Promise<Address> {
        const r = await provider.get('get_ruda_master', []);
        return r.stack.readAddress();
    }

    async getSlotCode(provider: ContractProvider): Promise<Cell> {
        const r = await provider.get('get_slot_code', []);
        return r.stack.readCell();
    }

    async getSlotAddress(provider: ContractProvider, reelIndex: number): Promise<Address> {
        const r = await provider.get('get_slot_address', [{ type: 'int', value: BigInt(reelIndex) }]);
        return r.stack.readAddress();
    }

    async getCheckerCode(provider: ContractProvider): Promise<Cell> {
        const r = await provider.get('get_checker_code', []);
        return r.stack.readCell();
    }

    // Deterministic address of the ephemeral SSMChecker for a (player, master) verification.
    async getCheckerAddress(provider: ContractProvider, player: Address, master: Address): Promise<Address> {
        const r = await provider.get('get_checker_address', [
            { type: 'slice', cell: beginCell().storeAddress(player).endCell() },
            { type: 'slice', cell: beginCell().storeAddress(master).endCell() },
        ]);
        return r.stack.readAddress();
    }

    // Pure reward mapping: returns (kind, nftType, nftTier, mintRudaAmount, returnEscrow).
    async getReward(
        provider: ContractProvider,
        symbols: number,
        isNative: boolean,
        stake: bigint,
    ): Promise<{ kind: number; nftType: bigint; nftTier: bigint; mintRudaAmount: bigint; returnEscrow: boolean }> {
        const r = await provider.get('get_reward', [
            { type: 'int', value: BigInt(symbols) },
            { type: 'int', value: isNative ? -1n : 0n },
            { type: 'int', value: stake },
        ]);
        return {
            kind: r.stack.readNumber(),
            nftType: r.stack.readBigNumber(),
            nftTier: r.stack.readBigNumber(),
            mintRudaAmount: r.stack.readBigNumber(),
            returnEscrow: r.stack.readBoolean(),
        };
    }
}
