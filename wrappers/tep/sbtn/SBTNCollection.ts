// SPDX-License-Identifier: UNLICENSED
import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    type DictionaryValue,
    Sender,
    SendMode,
    toNano,
} from '@ton/core';
import { Op } from './types';

export type SBTNCollectionConfig = {
    sbtnItemCode: Cell;
    adminAddress: Address;
    content?: Cell;
    nextItemIndex?: number | bigint;
};

/** Build SbtnCollectionContent cell: collectionMetadata (ref) */
function buildDefaultContentCell(): Cell {
    return beginCell().storeRef(beginCell().endCell()).endCell();
}

export function sbtnCollectionConfigToCell(config: SBTNCollectionConfig): Cell {
    const nextItemIndex = config.nextItemIndex ?? 0;
    const nextBig = typeof nextItemIndex === 'bigint' ? nextItemIndex : BigInt(nextItemIndex);
    const content = config.content ?? buildDefaultContentCell();
    return beginCell()
        .storeAddress(config.adminAddress)
        .storeUint(nextBig, 256)
        .storeRef(content)
        .storeRef(config.sbtnItemCode)
        .endCell();
}

export class SBTNCollection implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address): SBTNCollection {
        return new SBTNCollection(address);
    }

    static createFromConfig(
        config: SBTNCollectionConfig,
        code: Cell,
        workchain = 0
    ): SBTNCollection {
        const data = sbtnCollectionConfigToCell(config);
        const init = { code, data };
        return new SBTNCollection(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint): Promise<void> {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async getCollectionData(provider: ContractProvider): Promise<{
        nextItemIndex: bigint;
        collectionMetadata: Cell;
        adminAddress: Address;
    }> {
        const res = await provider.get('get_collection_data', []);
        const nextItemIndex = res.stack.readBigNumber();
        const collectionMetadata = res.stack.readCell();
        const adminAddress = res.stack.readAddress();
        return {
            nextItemIndex,
            collectionMetadata,
            adminAddress,
        };
    }

    async getSbtnAddress(
        provider: ContractProvider,
        ownerAddress: Address,
        index: bigint | number
    ): Promise<Address> {
        const res = await provider.get('get_sbtn_address', [
            { type: 'slice', cell: beginCell().storeAddress(ownerAddress).endCell() },
            { type: 'int', value: BigInt(index) },
        ]);
        return res.stack.readAddress();
    }

    async getSbtnItemCode(provider: ContractProvider): Promise<Cell> {
        const res = await provider.get('get_sbtn_item_code', []);
        return res.stack.readCell();
    }

    async sendDeploySbtn(
        provider: ContractProvider,
        via: Sender,
        opts: {
            ownerAddress: Address;
            index: bigint | number;
            value: bigint;
            individualContent?: Cell;
            attachTonAmount?: bigint;
        }
    ): Promise<void> {
        const attachAmount = opts.attachTonAmount ?? opts.value;
        const individualContent = opts.individualContent ?? beginCell().endCell();
        const body = beginCell()
            .storeUint(Op.DeploySbtn, 32)
            .storeUint(0, 64)
            .storeAddress(opts.ownerAddress)
            .storeUint(Number(opts.index), 256)
            .storeCoins(attachAmount)
            .storeRef(individualContent)
            .endCell();
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body,
        });
    }


    async sendChangeAdmin(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; newAdmin: Address }
    ): Promise<void> {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Op.ChangeCollectionAdmin, 32)
                .storeUint(0, 64)
                .storeAddress(opts.newAdmin)
                .endCell(),
        });
    }

    /** Only collection can revoke; admin requests via collection, collection forwards Revoke to item. */
    async sendRevokeToItem(
        provider: ContractProvider,
        via: Sender,
        opts: { itemAddress: Address; value: bigint; queryId?: number | bigint }
    ): Promise<void> {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Op.RevokeSbtnItem, 32)
                .storeUint(Number(opts.queryId ?? 0), 64)
                .storeAddress(opts.itemAddress)
                .endCell(),
        });
    }
}
