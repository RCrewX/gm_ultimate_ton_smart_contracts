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
import { AnswerConfig, answerConfigToCell } from './types';

// Answer (A) — storage { ubpsMaster, questionAddress, answerId, active, answerBytes }
// (static.tolk AnswerStorage). Deployed inactive; activated only by the master.
export class Answer implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Answer(address);
    }

    static createFromConfig(config: AnswerConfig, code: Cell, workchain = 0) {
        const data = answerConfigToCell(config);
        const init = { code, data };
        return new Answer(contractAddress(workchain, init), init);
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

    async getAnswer(provider: ContractProvider): Promise<Cell | null> {
        const r = await provider.get('get_answer', []);
        return r.stack.readCellOpt();
    }

    async getId(provider: ContractProvider): Promise<bigint> {
        const r = await provider.get('get_id', []);
        return r.stack.readBigNumber();
    }

    async getQuestionAddress(provider: ContractProvider): Promise<Address> {
        const r = await provider.get('get_question_address', []);
        return r.stack.readAddress();
    }

    async getMaster(provider: ContractProvider): Promise<Address> {
        const r = await provider.get('get_master', []);
        return r.stack.readAddress();
    }
}
