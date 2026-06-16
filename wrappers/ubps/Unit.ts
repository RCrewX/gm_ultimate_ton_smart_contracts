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
import { UnitConfig, unitConfigToCell, encodeSetPointer } from './types';

// Unit (U) — storage { ubpsMaster, userAddress, up } (static.tolk UnitStorage).
// Mutable only via SetPointer (sender must be userAddress).
export class Unit implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Unit(address);
    }

    static createFromConfig(config: UnitConfig, code: Cell, workchain = 0) {
        const data = unitConfigToCell(config);
        const init = { code, data };
        return new Unit(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    // Set the pointer to any address, or pass null to clear it.
    async sendSetPointer(provider: ContractProvider, via: Sender, value: bigint, up: Address | null) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeSetPointer(up),
        });
    }

    async getPointer(provider: ContractProvider): Promise<Address | null> {
        const r = await provider.get('get_pointer', []);
        return r.stack.readAddressOpt();
    }

    async getUser(provider: ContractProvider): Promise<Address> {
        const r = await provider.get('get_user', []);
        return r.stack.readAddress();
    }

    async getMaster(provider: ContractProvider): Promise<Address> {
        const r = await provider.get('get_master', []);
        return r.stack.readAddress();
    }
}
