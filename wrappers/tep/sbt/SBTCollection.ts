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
import { Op, buildSbtItemInitParams } from './types';

export type SBTCollectionConfig = {
    sbtItemCode: Cell;
    adminAddress: Address;
    content?: Cell;
    nextItemIndex?: number;
};

/** Build SbtCollectionContent cell: collectionMetadata (ref) */
function buildDefaultContentCell(): Cell {
    return beginCell().storeRef(beginCell().endCell()).endCell();
}

export function sbtCollectionConfigToCell(config: SBTCollectionConfig): Cell {
    const nextItemIndex = config.nextItemIndex ?? 0;
    const content = config.content ?? buildDefaultContentCell();
    return beginCell()
        .storeAddress(config.adminAddress)
        .storeUint(nextItemIndex, 64)
        .storeRef(content)
        .storeRef(config.sbtItemCode)
        .endCell();
}

export class SBTCollection implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address): SBTCollection {
        return new SBTCollection(address);
    }

    static createFromConfig(
        config: SBTCollectionConfig,
        code: Cell,
        workchain = 0
    ): SBTCollection {
        const data = sbtCollectionConfigToCell(config);
        const init = { code, data };
        return new SBTCollection(contractAddress(workchain, init), init);
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

    async getSbtAddressByIndex(
        provider: ContractProvider,
        itemIndex: bigint | number
    ): Promise<Address> {
        const res = await provider.get('get_sbt_address_by_index', [
            { type: 'int', value: BigInt(itemIndex) },
        ]);
        return res.stack.readAddress();
    }

    async sendDeploySbt(
        provider: ContractProvider,
        via: Sender,
        opts: {
            to: Address;
            index: bigint | number;
            value: bigint;
            content?: Cell;
            authority?: Address | null;
            attachTonAmount?: bigint;
        }
    ): Promise<void> {
        const attachAmount = opts.attachTonAmount ?? opts.value;
        const initParams = buildSbtItemInitParams({
            ownerAddress: opts.to,
            content: opts.content ?? beginCell().endCell(),
            authority: opts.authority ?? null,
        });
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Op.DeploySbt, 32)
                .storeUint(0, 64)
                .storeUint(Number(opts.index), 64)
                .storeCoins(attachAmount)
                .storeRef(initParams)
                .endCell(),
        });
    }

    async sendBatchDeploySbt(
        provider: ContractProvider,
        via: Sender,
        opts: {
            items: Array<{
                to: Address;
                index: number | bigint;
                content?: Cell;
                authority?: Address | null;
            }>;
            value: bigint;
        }
    ): Promise<void> {
        const batchValueSer: DictionaryValue<{ attachTonAmount: bigint; initParams: Cell }> = {
            serialize: (v, b) => {
                b.storeCoins(v.attachTonAmount);
                b.storeRef(v.initParams);
            },
            parse: (s) => ({
                attachTonAmount: s.loadCoins(),
                initParams: s.loadRef(),
            }),
        };
        const deployList = Dictionary.empty(
            Dictionary.Keys.BigUint(64),
            batchValueSer
        );
        const attachAmount = opts.value / BigInt(opts.items.length);
        for (const item of opts.items) {
            const initParams = buildSbtItemInitParams({
                ownerAddress: item.to,
                content: item.content ?? beginCell().endCell(),
                authority: item.authority ?? null,
            });
            deployList.set(BigInt(item.index), {
                attachTonAmount: attachAmount,
                initParams,
            });
        }
        const body = beginCell()
            .storeUint(Op.BatchDeploySbt, 32)
            .storeUint(0, 64)
            .storeDict(deployList)
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
}
