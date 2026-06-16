// SPDX-License-Identifier: UNLICENSED
import {
    Address,
    beginCell,
    Cell,
    Contract,
    ContractProvider,
    Sender,
    SendMode,
    Slice,
    toNano,
} from '@ton/core';
import { Op } from './types';

export type NFTItemTransferParams = {
    value: bigint;
    to: Address;
    responseTo?: Address;
    queryId?: number | bigint;
    forwardAmount?: bigint;
    forwardBody?: Cell | Slice;
};

export class NFTItem implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address): NFTItem {
        return new NFTItem(address);
    }

    async getNftData(provider: ContractProvider): Promise<{
        init: boolean;
        index: bigint;
        collectionAddress: Address;
        ownerAddress: Address | null;
        individualContent: Cell | null;
    }> {
        const res = await provider.get('get_nft_data', []);
        const isInitialized = res.stack.readBoolean();
        const itemIndex = res.stack.readBigNumber();
        const collectionAddress = res.stack.readAddress();
        let ownerAddress: Address | null = null;
        let individualContent: Cell | null = null;
        if (isInitialized) {
            ownerAddress = res.stack.readAddress();
            individualContent = res.stack.readCell();
        }
        return {
            init: isInitialized,
            index: itemIndex,
            collectionAddress,
            ownerAddress,
            individualContent,
        };
    }

    async sendTransferOwnership(
        provider: ContractProvider,
        via: Sender,
        params: NFTItemTransferParams
    ): Promise<void> {
        const queryId = params.queryId ?? 0;
        const forwardAmount = params.forwardAmount ?? 0n;
        const bodyBuilder = beginCell()
            .storeUint(Op.AskToChangeOwnership, 32)
            .storeUint(Number(queryId), 64)
            .storeAddress(params.to)
            .storeAddress(params.responseTo ?? null)
            .storeBit(0) // TEP-62 custom_payload: Maybe ^Cell (0 = nothing)
            .storeCoins(forwardAmount);
        if (params.forwardBody !== undefined) {
            if (params.forwardBody instanceof Cell) {
                bodyBuilder.storeBit(1).storeRef(params.forwardBody);
            } else {
                bodyBuilder.storeSlice(params.forwardBody);
            }
        } else {
            // Contract requires forwardPayload to have at least 1 bit
            bodyBuilder.storeBit(0);
        }
        await provider.internal(via, {
            value: params.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: bodyBuilder.endCell(),
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
