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
import { Opcodes } from './types';

// Storage: { ssmAddress, reelIndex } — see ssm_common.tolk (SSMSlotStorage).
export type SSMSlotConfig = {
    ssmAddress: Address;
    reelIndex: number;
};

export function ssmSlotConfigToCell(config: SSMSlotConfig): Cell {
    return beginCell()
        .storeAddress(config.ssmAddress)
        .storeUint(config.reelIndex, 8)
        .endCell();
}

export class SSMSlot implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new SSMSlot(address);
    }

    static createFromConfig(config: SSMSlotConfig, code: Cell, workchain = 0) {
        const data = ssmSlotConfigToCell(config);
        const init = { code, data };
        return new SSMSlot(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    // Drive a RollStep directly (used to test the sender gate / self-refund).
    //   body = RollStep { ctx: ^RollContext, symbols: uint8 }
    async sendRollStep(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        ctx: Cell,
        symbols: number,
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(Opcodes.OP_ROLL_STEP, 32)
                .storeRef(ctx)
                .storeUint(symbols, 8)
                .endCell(),
        });
    }

    async getSsmAddress(provider: ContractProvider): Promise<Address> {
        const r = await provider.get('get_ssm_address', []);
        return r.stack.readAddress();
    }

    async getReelIndex(provider: ContractProvider): Promise<number> {
        const r = await provider.get('get_reel_index', []);
        return r.stack.readNumber();
    }
}
