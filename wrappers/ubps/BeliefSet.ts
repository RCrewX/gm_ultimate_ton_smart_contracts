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
import { BeliefSetConfig, beliefSetConfigToCell } from './types';

// BeliefSet (BS) — storage { ubpsMaster, bsIndex, created, root, aCount, bsCount,
// aSet, bsSet } (static.tolk BeliefSetStorage). B = BS with root=true. Created once
// by the master, immutable thereafter. Address derives from bsIndex only.
export class BeliefSet implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new BeliefSet(address);
    }

    // Address calc / pre-populate deploy: created/root=false, counts=0, empty sets.
    static createFromConfig(config: BeliefSetConfig, code: Cell, workchain = 0) {
        const data = beliefSetConfigToCell(config);
        const init = { code, data };
        return new BeliefSet(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async getCreated(provider: ContractProvider): Promise<boolean> {
        const r = await provider.get('get_created', []);
        return r.stack.readBoolean();
    }

    async getRoot(provider: ContractProvider): Promise<boolean> {
        const r = await provider.get('get_root', []);
        return r.stack.readBoolean();
    }

    async getIndex(provider: ContractProvider): Promise<bigint> {
        const r = await provider.get('get_index', []);
        return r.stack.readBigNumber();
    }

    async getSets(provider: ContractProvider): Promise<{
        aCount: number; bsCount: number; aSet: Cell; bsSet: Cell;
    }> {
        const r = await provider.get('get_sets', []);
        return {
            aCount: r.stack.readNumber(),
            bsCount: r.stack.readNumber(),
            aSet: r.stack.readCell(),
            bsSet: r.stack.readCell(),
        };
    }

    async getMaster(provider: ContractProvider): Promise<Address> {
        const r = await provider.get('get_master', []);
        return r.stack.readAddress();
    }
}
