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
} from './types';

// Storage: { ownerAddress(=GM), ssmSlotCode (ref), rudaMasterAddress } —
// see contracts/soulless_slot_machine/static.tolk (SSMStorage).
export type SoullessSlotMachineConfig = {
    ownerAddress: Address;       // GameManager
    ssmSlotCode: Cell;           // compiled SSMSlot code
    rudaMasterAddress: Address;  // RUDA jetton minter (native NFT origin)
};

export function soullessSlotMachineConfigToCell(config: SoullessSlotMachineConfig): Cell {
    return beginCell()
        .storeAddress(config.ownerAddress)
        .storeRef(config.ssmSlotCode)
        .storeAddress(config.rudaMasterAddress)
        .storeDict(null) // pendingRolls: empty map<address, PendingRoll> on a fresh SSM
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
    // (the `via` sender stands in for that wallet W). SSM records a pending roll and emits a
    // RequestWalletAddress to the claimed master — it does NOT roll until Phase 2 verifies.
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

    // Custom intake PHASE 2: the claimed master answers TEP-89. Drive this as the master
    // (`via` == the master) vouching that `jettonWalletAddress` is its wallet for owner=SSM.
    // A genuine reply returns the escrow wallet W that notified SSM in Phase 1.
    async sendResponseWalletAddress(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        jettonWalletAddress: Address,
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

    // Custom timeout: reclaim an expired escrow (master never answered). Callable by the
    // escrow's player or the SSM owner (GM).
    async sendReclaimExpiredEscrow(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        wallet: Address,
        queryId: bigint | number = 0,
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Opcodes.OP_RECLAIM_EXPIRED_ESCROW, 32)
                .storeUint(queryId, 64)
                .storeAddress(wallet)
                .endCell(),
        });
    }

    static setSsmConfigMessage(ssmSlotCode: Cell, rudaMasterAddress: Address): Cell {
        return beginCell()
            .storeUint(Opcodes.OP_SET_SSM_CONFIG, 32)
            .storeRef(ssmSlotCode)
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

    // Pending custom-roll escrow keyed by wallet W. Returns null when no record exists.
    async getPendingRoll(
        provider: ContractProvider,
        wallet: Address,
    ): Promise<{ player: Address; stake: bigint; master: Address; queryId: bigint; deadline: number } | null> {
        const r = await provider.get('get_pending_roll', [
            { type: 'slice', cell: beginCell().storeAddress(wallet).endCell() },
        ]);
        const isFound = r.stack.readBoolean();
        const player = r.stack.readAddress();
        const stake = r.stack.readBigNumber();
        const master = r.stack.readAddress();
        const queryId = r.stack.readBigNumber();
        const deadline = r.stack.readNumber();
        if (!isFound) return null;
        return { player, stake, master, queryId, deadline };
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
