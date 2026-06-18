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
// UniversalBlockchainPassportPrinter (collection) + UniversalBlockchainPassport (item).
// GM-owned, R*-governed soulbound passport. The collection is the SYSTEM-write
// authority (admin == GM, driven by the R* pipe); owners SELF-DEPLOY their passport(id)
// and write their own nickname directly. See contracts/printers/universal_passport/.
//
// Collection storage (PassportPrinterCollectionStorage):
//   adminAddress, nextItemIndex(uint256), content(ref), passportItemCode(ref),
//   version(uint32), extra(maybe ref)
// Item StateInit data (PassportItemStorage, content excluded from the determinant):
//   index(uint256), collection(addr), owner(addr), active(bool), revokedAt(uint64),
//   individualContent(ref=empty)
// =============================================================================

export const PassportOp = {
    PassportDeploy: 0x00000001,
    ChangeCollectionAdmin: 0x00000003,
    RevokePassportItem: 0x00000004,
    EditPassportItem: 0x00000007,          // admin(GM) -> collection (SYSTEM content edit)
    SetPassportSystemContent: 0x6f89f5e4,  // collection -> item (SYSTEM content write)
    PassportOwnerInit: 0x55504900,         // owner -> item self-deploy ("UPI\0")
    SetNickname: 0x55504e4b,               // owner -> item nickname write ("UPNK")
} as const;

// --- Passport content ids (the item's index selects the schema) ---
export const PassportId = { CORE: 0, ACTIVITY: 1, AVATAR: 2 } as const;

// --- Typed content builders (must match storage.tolk struct serialization) ---
/** Raw-bytes cell for a Cell<SnakeString> field (short strings; one cell). */
export function snakeCell(s: string): Cell {
    return beginCell().storeBuffer(Buffer.from(s, 'utf8')).endCell();
}

/** id=0 full content: reputation (uint256) + nickname (Cell<SnakeString> ref). */
export function buildCoreContent(reputation: bigint | number, nickname: string): Cell {
    return beginCell().storeUint(BigInt(reputation), 256).storeRef(snakeCell(nickname)).endCell();
}

/** id=0 SYSTEM payload (reputation only) — the item merges it, keeping nickname. */
export function buildCoreSystemUpdate(reputation: bigint | number): Cell {
    return beginCell().storeUint(BigInt(reputation), 256).endCell();
}

/** id=1 content: onchain_activity (uint256). */
export function buildActivityContent(activity: bigint | number): Cell {
    return beginCell().storeUint(BigInt(activity), 256).endCell();
}

/** id=2 content: avatar url (Cell<SnakeString> ref). */
export function buildAvatarContent(url: string): Cell {
    return beginCell().storeRef(snakeCell(url)).endCell();
}

/** Canonical EMPTY (zeroed) content per id — mirrors emptyContentForId() on-chain. */
export function emptyContentForId(id: number): Cell {
    if (id === PassportId.CORE) return buildCoreContent(0, '');
    if (id === PassportId.ACTIVITY) return buildActivityContent(0);
    if (id === PassportId.AVATAR) return buildAvatarContent('');
    return beginCell().endCell();
}

export type PassportPrinterConfig = {
    passportItemCode: Cell;
    adminAddress: Address; // = GameManager
    content?: Cell;
    nextItemIndex?: number | bigint;
    version?: number;
    extra?: Cell | null;
};

function buildDefaultContentCell(): Cell {
    return beginCell().storeRef(beginCell().endCell()).endCell();
}

export function passportPrinterConfigToCell(config: PassportPrinterConfig): Cell {
    const nextItemIndex = config.nextItemIndex ?? 0;
    const content = config.content ?? buildDefaultContentCell();
    return beginCell()
        .storeAddress(config.adminAddress)
        .storeUint(typeof nextItemIndex === 'bigint' ? nextItemIndex : BigInt(nextItemIndex), 256)
        .storeRef(content)
        .storeRef(config.passportItemCode)
        .storeUint(config.version ?? 1, 32)
        .storeMaybeRef(config.extra ?? null)
        .endCell();
}

export class UniversalBlockchainPassportPrinter implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address): UniversalBlockchainPassportPrinter {
        return new UniversalBlockchainPassportPrinter(address);
    }

    static createFromConfig(config: PassportPrinterConfig, code: Cell, workchain = 0): UniversalBlockchainPassportPrinter {
        const data = passportPrinterConfigToCell(config);
        const init = { code, data };
        return new UniversalBlockchainPassportPrinter(contractAddress(workchain, init), init);
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

    async getPassportAddress(provider: ContractProvider, ownerAddress: Address, index: bigint | number): Promise<Address> {
        const res = await provider.get('get_passport_address', [
            { type: 'slice', cell: beginCell().storeAddress(ownerAddress).endCell() },
            { type: 'int', value: BigInt(index) },
        ]);
        return res.stack.readAddress();
    }

    async getPassportItemCode(provider: ContractProvider): Promise<Cell> {
        const res = await provider.get('get_passport_item_code', []);
        return res.stack.readCell();
    }

    async getVersion(provider: ContractProvider): Promise<bigint> {
        const res = await provider.get('get_version', []);
        return res.stack.readBigNumber();
    }

    /** Direct PassportDeploy (system mint). Admin-gated (admin == GM); in production driven by R*. */
    async sendPassportDeploy(
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
        const individualContent = opts.individualContent ?? emptyContentForId(Number(opts.index));
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(PassportOp.PassportDeploy, 32)
                .storeUint(Number(opts.queryId ?? 0), 64)
                .storeAddress(opts.ownerAddress)
                .storeUint(typeof opts.index === 'bigint' ? opts.index : BigInt(opts.index), 256)
                .storeCoins(attachAmount)
                .storeRef(individualContent)
                .endCell(),
        });
    }

    /** Direct RevokePassportItem (admin-gated): collection forwards Revoke to the item. */
    async sendRevokeToItem(
        provider: ContractProvider,
        via: Sender,
        opts: { itemAddress: Address; value: bigint; queryId?: bigint | number },
    ): Promise<void> {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(PassportOp.RevokePassportItem, 32)
                .storeUint(Number(opts.queryId ?? 0), 64)
                .storeAddress(opts.itemAddress)
                .endCell(),
        });
    }

    /** Direct EditPassportItem (admin-gated: admin == GM). newContent = per-id SYSTEM payload. */
    async sendEditPassportItem(
        provider: ContractProvider,
        via: Sender,
        opts: { itemAddress: Address; newContent: Cell; value: bigint; queryId?: bigint | number },
    ): Promise<void> {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(PassportOp.EditPassportItem, 32)
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
                .storeUint(PassportOp.ChangeCollectionAdmin, 32)
                .storeUint(Number(opts.queryId ?? 0), 64)
                .storeAddress(opts.newAdmin)
                .endCell(),
        });
    }
}

// --- Item-side wrapper (owner self-deploy + owner nickname write + getters) ---
export type PassportItemConfig = {
    index: bigint | number;
    collectionAddress: Address;
    ownerAddress: Address;
};

/** Item StateInit data — content-free determinant (active=false, revokedAt=0, empty content). */
export function passportItemConfigToCell(config: PassportItemConfig): Cell {
    return beginCell()
        .storeUint(typeof config.index === 'bigint' ? config.index : BigInt(config.index), 256)
        .storeAddress(config.collectionAddress)
        .storeAddress(config.ownerAddress)
        .storeBit(false)          // active
        .storeUint(0, 64)         // revokedAt
        .storeRef(beginCell().endCell()) // individualContent (empty)
        .endCell();
}

export class UniversalBlockchainPassport implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address): UniversalBlockchainPassport {
        return new UniversalBlockchainPassport(address);
    }

    static createFromConfig(config: PassportItemConfig, code: Cell, workchain = 0): UniversalBlockchainPassport {
        const data = passportItemConfigToCell(config);
        const init = { code, data };
        return new UniversalBlockchainPassport(contractAddress(workchain, init), init);
    }

    /** OWNER self-deploy (§3.3): activate this passport(id) with EMPTY content. */
    async sendOwnerInit(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; queryId?: bigint | number },
    ): Promise<void> {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(PassportOp.PassportOwnerInit, 32)
                .storeUint(Number(opts.queryId ?? 0), 64)
                .endCell(),
        });
    }

    /** OWNER nickname write (id=0). Merges, preserving system reputation. */
    async sendSetNickname(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; nickname: string; queryId?: bigint | number },
    ): Promise<void> {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(PassportOp.SetNickname, 32)
                .storeUint(Number(opts.queryId ?? 0), 64)
                .storeRef(snakeCell(opts.nickname))
                .endCell(),
        });
    }

    async getNftData(provider: ContractProvider): Promise<{
        isInitialized: boolean;
        itemIndex: bigint;
        collectionAddress: Address;
        ownerAddress: Address;
        content: Cell | null;
        authority: Address;
        revokedAt: bigint;
    }> {
        const res = await provider.get('get_nft_data', []);
        return {
            isInitialized: res.stack.readBoolean(),
            itemIndex: res.stack.readBigNumber(),
            collectionAddress: res.stack.readAddress(),
            ownerAddress: res.stack.readAddress(),
            content: res.stack.readCellOpt(),
            authority: res.stack.readAddress(),
            revokedAt: res.stack.readBigNumber(),
        };
    }

    /** id=0 reputation (the UBPS filter seam). */
    async getReputation(provider: ContractProvider): Promise<bigint> {
        const res = await provider.get('get_reputation', []);
        return res.stack.readBigNumber();
    }

    /** id=0 core content {reputation, nickname}. */
    async getPassportCore(provider: ContractProvider): Promise<{ reputation: bigint; nickname: string }> {
        const res = await provider.get('get_passport_core', []);
        const reputation = res.stack.readBigNumber();
        const nicknameCell = res.stack.readCell();
        const slice = nicknameCell.beginParse();
        const nickname = slice.remainingBits > 0 ? slice.loadBuffer(slice.remainingBits / 8).toString('utf8') : '';
        return { reputation, nickname };
    }
}
