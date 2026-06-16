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
import { buildRoyaltyParamsCell, type RoyaltyParams } from '../../tep/nft/types';

// =============================================================================
// NFTPrinter (collection) — GM-owned, R*-governed TEP-62 collection.
// Distinct from the base NFTCollection by carrying FEATURE-SPACE (version, extra).
// Reuses the proven tep/nft NFTItem code as `nftItemCode`.
//
// Storage (contracts/printers/nft_printer/storage.tolk NftPrinterCollectionStorage):
//   adminAddress, nextItemIndex(uint64), content(ref), nftItemCode(ref),
//   royaltyParams(ref), version(uint32), extra(maybe ref)
// =============================================================================

/** Opcodes for the NFTPrinter collection (subset of TEP-62 surface). */
export const NFTPrinterOp = {
    DeployNft: 0x00000001,
    ChangeCollectionAdmin: 0x00000003,
    SetNftContent: 0x00000005, // collection -> item (content edit)
    EditNftItem: 0x00000006, // admin (GM) -> collection (content edit)
    RequestRoyaltyParams: 0x693d3950,
    ResponseRoyaltyParams: 0xa8cb00ad,
} as const;

export type NFTPrinterConfig = {
    nftItemCode: Cell;
    adminAddress: Address; // = GameManager
    royaltyParams: RoyaltyParams;
    content?: Cell;
    nextItemIndex?: number | bigint;
    version?: number;
    extra?: Cell | null;
};

/** Build CollectionContent cell: collectionMetadata (ref) + commonContent (ref) */
function buildDefaultContentCell(): Cell {
    return beginCell()
        .storeRef(beginCell().endCell())
        .storeRef(beginCell().endCell())
        .endCell();
}

export function nftPrinterConfigToCell(config: NFTPrinterConfig): Cell {
    const nextItemIndex = config.nextItemIndex ?? 0;
    const content = config.content ?? buildDefaultContentCell();
    const royaltyParamsCell = buildRoyaltyParamsCell(config.royaltyParams);
    return beginCell()
        .storeAddress(config.adminAddress)
        .storeUint(typeof nextItemIndex === 'bigint' ? nextItemIndex : BigInt(nextItemIndex), 64)
        .storeRef(content)
        .storeRef(config.nftItemCode)
        .storeRef(royaltyParamsCell)
        .storeUint(config.version ?? 1, 32)
        .storeMaybeRef(config.extra ?? null)
        .endCell();
}

export class NFTPrinter implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address): NFTPrinter {
        return new NFTPrinter(address);
    }

    static createFromConfig(config: NFTPrinterConfig, code: Cell, workchain = 0): NFTPrinter {
        const data = nftPrinterConfigToCell(config);
        const init = { code, data };
        return new NFTPrinter(contractAddress(workchain, init), init);
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
        return {
            nextItemIndex: res.stack.readBigNumber(),
            collectionMetadata: res.stack.readCell(),
            adminAddress: res.stack.readAddress(),
        };
    }

    async getNftAddressByIndex(provider: ContractProvider, itemIndex: bigint | number): Promise<Address> {
        const res = await provider.get('get_nft_address_by_index', [
            { type: 'int', value: BigInt(itemIndex) },
        ]);
        return res.stack.readAddress();
    }

    async getRoyaltyParams(provider: ContractProvider): Promise<RoyaltyParams> {
        const res = await provider.get('royalty_params', []);
        return {
            numerator: res.stack.readNumber(),
            denominator: res.stack.readNumber(),
            royaltyAddress: res.stack.readAddress(),
        };
    }

    async getVersion(provider: ContractProvider): Promise<bigint> {
        const res = await provider.get('get_version', []);
        return res.stack.readBigNumber();
    }

    /**
     * Direct DeployNft (mint). On-chain this is admin-gated (admin == GM), so in
     * production it is driven by the R* recipe flow; this helper exists mainly for
     * the auth-gate tests (a non-GM sender must be rejected).
     */
    async sendDeployNft(
        provider: ContractProvider,
        via: Sender,
        opts: {
            to: Address;
            index: bigint | number;
            value: bigint;
            content?: Cell;
            attachTonAmount?: bigint;
            queryId?: bigint | number;
        },
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
                .storeUint(NFTPrinterOp.DeployNft, 32)
                .storeUint(Number(opts.queryId ?? 0), 64)
                .storeUint(typeof opts.index === 'bigint' ? opts.index : BigInt(opts.index), 64)
                .storeCoins(attachAmount)
                .storeRef(initParams)
                .endCell(),
        });
    }

    /**
     * Direct EditNftItem (admin-gated: admin == GM). In production driven by the
     * R* ANVIL recipe flow; this helper exists mainly for the auth-gate tests.
     */
    async sendEditNftItem(
        provider: ContractProvider,
        via: Sender,
        opts: { itemAddress: Address; newContent: Cell; value: bigint; queryId?: bigint | number },
    ): Promise<void> {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(NFTPrinterOp.EditNftItem, 32)
                .storeUint(Number(opts.queryId ?? 0), 64)
                .storeAddress(opts.itemAddress)
                .storeRef(opts.newContent)
                .endCell(),
        });
    }

    async sendChangeAdmin(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; newAdmin: Address; queryId?: bigint | number },
    ): Promise<void> {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(NFTPrinterOp.ChangeCollectionAdmin, 32)
                .storeUint(Number(opts.queryId ?? 0), 64)
                .storeAddress(opts.newAdmin)
                .endCell(),
        });
    }
}
