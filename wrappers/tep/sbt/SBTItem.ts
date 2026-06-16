// SPDX-License-Identifier: UNLICENSED
import {
    Address,
    beginCell,
    Cell,
    Contract,
    ContractProvider,
    Sender,
    SendMode,
    toNano,
} from '@ton/core';
import { Op } from './types';

export class SBTItem implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address): SBTItem {
        return new SBTItem(address);
    }

    async getNftData(provider: ContractProvider): Promise<{
        init: boolean;
        index: bigint;
        collectionAddress: Address;
        ownerAddress: Address | null;
        individualContent: Cell | null;
        authority: Address | null;
        revokedAt: bigint;
    }> {
        const res = await provider.get('get_nft_data', []);
        const isInitialized = res.stack.readBoolean();
        const itemIndex = res.stack.readBigNumber();
        const collectionAddress = res.stack.readAddress();
        let ownerAddress: Address | null = null;
        let individualContent: Cell | null = null;
        let authority: Address | null = null;
        let revokedAt = 0n;
        if (isInitialized) {
            ownerAddress = res.stack.readAddressOpt();
            individualContent = res.stack.readCellOpt();
            authority = res.stack.readAddressOpt();
            revokedAt = res.stack.readBigNumber();
        }
        return {
            init: isInitialized,
            index: itemIndex,
            collectionAddress,
            ownerAddress,
            individualContent,
            authority,
            revokedAt,
        };
    }

    async getAuthorityAddress(provider: ContractProvider): Promise<Address | null> {
        const res = await provider.get('get_authority_address', []);
        const cell = res.stack.readCell();
        const slice = cell.beginParse();
        const b0 = slice.loadBit();
        const b1 = slice.loadBit();
        if (!b0 && !b1) return null; // addr_none (2 zero bits)
        const addrSlice = cell.beginParse();
        return addrSlice.loadAddress();
    }

    async getRevokedTime(provider: ContractProvider): Promise<number> {
        const res = await provider.get('get_revoked_time', []);
        return res.stack.readNumber();
    }

    async sendProveOwnership(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint;
            destination: Address;
            queryId?: number | bigint;
            forwardPayload?: Cell;
            withContent?: boolean;
        }
    ): Promise<void> {
        const body = beginCell()
            .storeUint(Op.ProveOwnership, 32)
            .storeUint(Number(opts.queryId ?? 0), 64)
            .storeAddress(opts.destination)
            .storeRef(opts.forwardPayload ?? beginCell().endCell())
            .storeBit(opts.withContent ?? false)
            .endCell();
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.CARRY_ALL_REMAINING_BALANCE,
            body,
        });
    }

    async sendRequestOwner(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint;
            destination: Address;
            queryId?: number | bigint;
            forwardPayload?: Cell;
            withContent?: boolean;
        }
    ): Promise<void> {
        const body = beginCell()
            .storeUint(Op.RequestOwner, 32)
            .storeUint(Number(opts.queryId ?? 0), 64)
            .storeAddress(opts.destination)
            .storeRef(opts.forwardPayload ?? beginCell().endCell())
            .storeBit(opts.withContent ?? false)
            .endCell();
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.CARRY_ALL_REMAINING_BALANCE,
            body,
        });
    }

    async sendDestroy(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; queryId?: number | bigint }
    ): Promise<void> {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.CARRY_ALL_REMAINING_BALANCE,
            body: beginCell()
                .storeUint(Op.Destroy, 32)
                .storeUint(Number(opts.queryId ?? 0), 64)
                .endCell(),
        });
    }

    async sendRevoke(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; queryId?: number | bigint }
    ): Promise<void> {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Op.Revoke, 32)
                .storeUint(Number(opts.queryId ?? 0), 64)
                .endCell(),
        });
    }

    async sendGetStaticData(
        provider: ContractProvider,
        via: Sender,
        opts: { value?: bigint; queryId?: number | bigint }
    ): Promise<void> {
        await provider.internal(via, {
            value: opts.value ?? toNano('0.05'),
            sendMode: SendMode.CARRY_ALL_REMAINING_BALANCE,
            body: beginCell()
                .storeUint(Op.RequestStaticData, 32)
                .storeUint(Number(opts.queryId ?? 0), 64)
                .endCell(),
        });
    }
}
