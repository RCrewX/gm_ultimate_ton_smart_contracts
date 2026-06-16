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
import { Op, buildRoyaltyParamsCell, type RoyaltyParams } from './types';

export type NFTCollectionConfig = {
    nftItemCode: Cell;
    ownerAddress: Address;
    royaltyParams: RoyaltyParams;
    content?: Cell;
    nextItemIndex?: number;
};

/** Build CollectionContent cell: collectionMetadata (ref) + commonContent (ref) */
function buildDefaultContentCell(): Cell {
    return beginCell()
        .storeRef(beginCell().endCell())
        .storeRef(beginCell().endCell())
        .endCell();
}

export function nftCollectionConfigToCell(config: NFTCollectionConfig): Cell {
    const nextItemIndex = config.nextItemIndex ?? 0;
    const content = config.content ?? buildDefaultContentCell();
    const royaltyParamsCell = buildRoyaltyParamsCell(config.royaltyParams);
    return beginCell()
        .storeAddress(config.ownerAddress)
        .storeUint(nextItemIndex, 64)
        .storeRef(content)
        .storeRef(config.nftItemCode)
        .storeRef(royaltyParamsCell)
        .endCell();
}

export class NFTCollection implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address): NFTCollection {
        return new NFTCollection(address);
    }

    static createFromConfig(
        config: NFTCollectionConfig,
        code: Cell,
        workchain = 0
    ): NFTCollection {
        const data = nftCollectionConfigToCell(config);
        const init = { code, data };
        return new NFTCollection(contractAddress(workchain, init), init);
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
        ownerAddress: Address;
    }> {
        const res = await provider.get('get_collection_data', []);
        const nextItemIndex = res.stack.readBigNumber();
        const collectionMetadata = res.stack.readCell();
        const adminAddress = res.stack.readAddress();
        return {
            nextItemIndex,
            collectionMetadata,
            adminAddress,
            ownerAddress: adminAddress,
        };
    }

    async getNftAddressByIndex(
        provider: ContractProvider,
        itemIndex: bigint | number
    ): Promise<Address> {
        const res = await provider.get('get_nft_address_by_index', [
            { type: 'int', value: BigInt(itemIndex) },
        ]);
        return res.stack.readAddress();
    }

    async getNftContent(
        provider: ContractProvider,
        itemIndex: bigint | number,
        individualContent: Cell
    ): Promise<Cell> {
        const res = await provider.get('get_nft_content', [
            { type: 'int', value: BigInt(itemIndex) },
            { type: 'cell', cell: individualContent },
        ]);
        return res.stack.readCell();
    }

    async getRoyaltyParams(provider: ContractProvider): Promise<RoyaltyParams> {
        const res = await provider.get('royalty_params', []);
        const numerator = res.stack.readNumber();
        const denominator = res.stack.readNumber();
        const royaltyAddress = res.stack.readAddress();
        return { numerator, denominator, royaltyAddress };
    }

    /** Build royalty params as slice/cell for response body assertions */
    static buildRoyaltyParams(params: RoyaltyParams): Cell {
        return buildRoyaltyParamsCell(params);
    }

    async sendGetRoyaltyParams(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; queryId?: number | bigint }
    ): Promise<void> {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.CARRY_ALL_REMAINING_BALANCE,
            body: beginCell()
                .storeUint(Op.RequestRoyaltyParams, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .endCell(),
        });
    }

    async sendDeployNft(
        provider: ContractProvider,
        via: Sender,
        opts: {
            to: Address;
            index: bigint | number;
            value: bigint;
            content?: Cell;
            /** Amount forwarded to NFT item; if omitted, uses value (collection must receive >= this + gas) */
            attachTonAmount?: bigint;
        }
    ): Promise<void> {
        const attachAmount = opts.attachTonAmount ?? opts.value;
        const initParams = beginCell()
            .storeAddress(opts.to)
            .storeRef(opts.content ?? beginCell().endCell())
            .endCell();
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Op.DeployNft, 32)
                .storeUint(0, 64)
                .storeUint(Number(opts.index), 64)
                .storeCoins(attachAmount)
                .storeRef(initParams)
                .endCell(),
        });
    }

    async sendBatchDeployNFT(
        provider: ContractProvider,
        via: Sender,
        opts: {
            items: Array<{ to: Address; index: number | bigint; content?: Cell }>;
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
            const initParams = beginCell()
                .storeAddress(item.to)
                .storeRef(item.content ?? beginCell().endCell())
                .endCell();
            deployList.set(BigInt(item.index), {
                attachTonAmount: attachAmount,
                initParams,
            });
        }
        const body = beginCell()
            .storeUint(Op.BatchDeployNfts, 32)
            .storeUint(0, 64)
            .storeDict(deployList)
            .endCell();
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body,
        });
    }

    async sendChangeOwner(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; newOwner: Address }
    ): Promise<void> {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Op.ChangeCollectionAdmin, 32)
                .storeUint(0, 64)
                .storeAddress(opts.newOwner)
                .endCell(),
        });
    }
}
