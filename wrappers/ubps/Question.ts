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
import { QuestionConfig, questionConfigToCell } from './types';

// Question (Q) — storage { ubpsMaster, questionId, active, questionBytes }
// (static.tolk QuestionStorage). Deployed inactive; activated only by the master.
export class Question implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Question(address);
    }

    // Address calc / inactive deploy: active=false, questionBytes=null.
    static createFromConfig(config: QuestionConfig, code: Cell, workchain = 0) {
        const data = questionConfigToCell(config);
        const init = { code, data };
        return new Question(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async getActive(provider: ContractProvider): Promise<boolean> {
        const r = await provider.get('get_active', []);
        return r.stack.readBoolean();
    }

    async getQuestion(provider: ContractProvider): Promise<Cell | null> {
        const r = await provider.get('get_question', []);
        return r.stack.readCellOpt();
    }

    async getId(provider: ContractProvider): Promise<bigint> {
        const r = await provider.get('get_id', []);
        return r.stack.readBigNumber();
    }

    async getMaster(provider: ContractProvider): Promise<Address> {
        const r = await provider.get('get_master', []);
        return r.stack.readAddress();
    }
}
