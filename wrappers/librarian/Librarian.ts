// SPDX-License-Identifier: UNLICENSED
/**
 * Librarian — masterchain (workchain -1) public-library publisher wrapper.
 *
 * One Librarian instance publishes ONE code cell as a PUBLIC global library via
 * SETLIBCODE (mode 2). Its StateInit is a plain {code, data} (NO `library` field), so it
 * deploys normally on wc -1 — unlike a `library`-bearing StateInit, which the executor
 * rejects with `cskip_bad_state`. The genesis (deploy) message triggers the publish; all
 * later ops are admin-gated. See contracts/librarian/librarian.tolk for the full rationale.
 */
import {
    Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode, toNano,
} from '@ton/core';

/** Opcodes — must match contracts/librarian/librarian.tolk. */
export const LibrarianOp = {
    withdraw: 0x00000010,
    rePublish: 0x00000011,
    removeLib: 0x00000012,
    setAdmin: 0x00000013,
} as const;

/** Masterchain workchain — the ONLY workchain a public library may be published from. */
export const LIBRARIAN_WORKCHAIN = -1;

export type LibrarianConfig = {
    adminAddress: Address;
    /** The real (full) code cell to publish as a public library. */
    code: Cell;
    /** Idempotency flag; genesis config is always false. */
    published?: boolean;
};

/** storage: adminAddress:address ++ code:^cell ++ published:bool */
export function librarianConfigToCell(config: LibrarianConfig): Cell {
    return beginCell()
        .storeAddress(config.adminAddress)
        .storeRef(config.code)
        .storeBit(config.published ?? false)
        .endCell();
}

export class Librarian implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Librarian(address);
    }

    /**
     * Build a Librarian on the MASTERCHAIN (wc -1). Public libraries can only be published
     * from workchain -1, so the workchain is forced and asserted here — a librarian on any
     * other workchain would silently fail to publish a globally-resolvable library.
     */
    static createFromConfig(config: LibrarianConfig, code: Cell, workchain = LIBRARIAN_WORKCHAIN) {
        if (workchain !== LIBRARIAN_WORKCHAIN) {
            throw new Error(
                `Librarian must be deployed on workchain ${LIBRARIAN_WORKCHAIN} (masterchain) to publish a ` +
                `public library; got workchain ${workchain}.`,
            );
        }
        const data = librarianConfigToCell(config);
        const init = { code, data };
        return new Librarian(contractAddress(workchain, init), init);
    }

    /** Genesis deploy: an empty-body internal message triggers the one-time publish. */
    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        return await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    private static opBody(op: number, queryId: bigint | number = 0) {
        return beginCell().storeUint(op, 32).storeUint(queryId, 64).endCell();
    }

    /** Admin: reserve the rent floor, return the surplus balance to the admin. */
    async sendWithdraw(provider: ContractProvider, via: Sender, value: bigint = toNano('0.05'), queryId: bigint | number = 0) {
        return await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: Librarian.opBody(LibrarianOp.withdraw, queryId),
        });
    }

    /** Admin: re-run SETLIBCODE(code, 2) — recover after a rent-lapse drop. */
    async sendRePublish(provider: ContractProvider, via: Sender, value: bigint = toNano('0.05'), queryId: bigint | number = 0) {
        return await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: Librarian.opBody(LibrarianOp.rePublish, queryId),
        });
    }

    /** Admin: SETLIBCODE(code, 0) — unpublish the library. */
    async sendRemove(provider: ContractProvider, via: Sender, value: bigint = toNano('0.05'), queryId: bigint | number = 0) {
        return await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: Librarian.opBody(LibrarianOp.removeLib, queryId),
        });
    }

    /** Admin: rotate the admin address. */
    async sendSetAdmin(provider: ContractProvider, via: Sender, newAdmin: Address, value: bigint = toNano('0.05'), queryId: bigint | number = 0) {
        return await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(LibrarianOp.setAdmin, 32)
                .storeUint(queryId, 64)
                .storeAddress(newAdmin)
                .endCell(),
        });
    }

    async getPublished(provider: ContractProvider): Promise<boolean> {
        const res = await provider.get('get_published', []);
        return res.stack.readBoolean();
    }

    async getAdmin(provider: ContractProvider): Promise<Address> {
        const res = await provider.get('get_admin', []);
        return res.stack.readAddress();
    }

    async getCodeHash(provider: ContractProvider): Promise<bigint> {
        const res = await provider.get('get_code_hash', []);
        return res.stack.readBigNumber();
    }
}
