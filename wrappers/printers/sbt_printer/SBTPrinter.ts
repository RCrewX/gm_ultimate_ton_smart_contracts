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

// =============================================================================
// SBTPrinter (collection) — GM-owned, R*-governed soulbound (sbtn) collection.
// Distinct from the base SBTNCollection by carrying FEATURE-SPACE (version, extra).
// Reuses the proven, gate-fixed tep/sbtn SBTNItem code as `sbtnItemCode`.
//
// Storage (contracts/printers/sbt_printer/storage.tolk SbtnPrinterCollectionStorage):
//   adminAddress, nextItemIndex(uint256), content(ref), sbtnItemCode(ref),
//   version(uint32), extra(maybe ref)
// =============================================================================

export const SBTPrinterOp = {
    DeploySbtn: 0x00000001,
    ChangeCollectionAdmin: 0x00000003,
    RevokeSbtnItem: 0x00000004,
    SetSbtContent: 0x6f89f5e4, // collection -> item (content edit)
    EditSbtItem: 0x00000007, // admin (GM) -> collection (content edit)
} as const;

export type SBTPrinterConfig = {
    sbtnItemCode: Cell;
    adminAddress: Address; // = GameManager
    content?: Cell;
    nextItemIndex?: number | bigint;
    version?: number;
    extra?: Cell | null;
};

/** Build SbtnCollectionContent cell: collectionMetadata (ref) */
function buildDefaultContentCell(): Cell {
    return beginCell().storeRef(beginCell().endCell()).endCell();
}

export function sbtPrinterConfigToCell(config: SBTPrinterConfig): Cell {
    const nextItemIndex = config.nextItemIndex ?? 0;
    const content = config.content ?? buildDefaultContentCell();
    return beginCell()
        .storeAddress(config.adminAddress)
        .storeUint(typeof nextItemIndex === 'bigint' ? nextItemIndex : BigInt(nextItemIndex), 256)
        .storeRef(content)
        .storeRef(config.sbtnItemCode)
        .storeUint(config.version ?? 1, 32)
        .storeMaybeRef(config.extra ?? null)
        .endCell();
}

export class SBTPrinter implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address): SBTPrinter {
        return new SBTPrinter(address);
    }

    static createFromConfig(config: SBTPrinterConfig, code: Cell, workchain = 0): SBTPrinter {
        const data = sbtPrinterConfigToCell(config);
        const init = { code, data };
        return new SBTPrinter(contractAddress(workchain, init), init);
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

    async getSbtnAddress(
        provider: ContractProvider,
        ownerAddress: Address,
        index: bigint | number,
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

    async getVersion(provider: ContractProvider): Promise<bigint> {
        const res = await provider.get('get_version', []);
        return res.stack.readBigNumber();
    }

    /**
     * Direct DeploySbtn (mint). Admin-gated (admin == GM); in production driven by
     * the R* recipe flow. Exists mainly for the auth-gate tests.
     */
    async sendDeploySbtn(
        provider: ContractProvider,
        via: Sender,
        opts: {
            ownerAddress: Address;
            index: bigint | number;
            value: bigint;
            individualContent?: Cell;
            attachTonAmount?: bigint;
            queryId?: bigint | number;
        },
    ): Promise<void> {
        const attachAmount = opts.attachTonAmount ?? opts.value;
        const individualContent = opts.individualContent ?? beginCell().endCell();
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(SBTPrinterOp.DeploySbtn, 32)
                .storeUint(Number(opts.queryId ?? 0), 64)
                .storeAddress(opts.ownerAddress)
                .storeUint(typeof opts.index === 'bigint' ? opts.index : BigInt(opts.index), 256)
                .storeCoins(attachAmount)
                .storeRef(individualContent)
                .endCell(),
        });
    }

    /** Direct RevokeSbtnItem (admin-gated): collection forwards Revoke to the item. */
    async sendRevokeToItem(
        provider: ContractProvider,
        via: Sender,
        opts: { itemAddress: Address; value: bigint; queryId?: bigint | number },
    ): Promise<void> {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(SBTPrinterOp.RevokeSbtnItem, 32)
                .storeUint(Number(opts.queryId ?? 0), 64)
                .storeAddress(opts.itemAddress)
                .endCell(),
        });
    }

    /**
     * Direct EditSbtItem (admin-gated: admin == GM). In production driven by the
     * R* ANVIL recipe flow; this helper exists mainly for the auth-gate tests.
     */
    async sendEditSbtItem(
        provider: ContractProvider,
        via: Sender,
        opts: { itemAddress: Address; newContent: Cell; value: bigint; queryId?: bigint | number },
    ): Promise<void> {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(SBTPrinterOp.EditSbtItem, 32)
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
                .storeUint(SBTPrinterOp.ChangeCollectionAdmin, 32)
                .storeUint(Number(opts.queryId ?? 0), 64)
                .storeAddress(opts.newAdmin)
                .endCell(),
        });
    }
}
