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
import {
    UBPSConfig,
    ubpsConfigToCell,
    unitConfigToCell,
    questionConfigToCell,
    answerConfigToCell,
    beliefSetConfigToCell,
    encodeActivateQuestion,
    encodeActivateAnswer,
    encodeCreateBeliefSet,
} from './types';

// UBPS master — root authority. Storage: { ownerAddress, unitCode, questionCode,
// answerCode, beliefSetCode, nextBsIndex } (contracts/ubps/static.tolk UBPSStorage).
export class UBPS implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
        readonly config?: UBPSConfig,
    ) {}

    static createFromAddress(address: Address) {
        return new UBPS(address);
    }

    static createFromConfig(config: UBPSConfig, code: Cell, workchain = 0) {
        const data = ubpsConfigToCell(config);
        const init = { code, data };
        return new UBPS(contractAddress(workchain, init), init, config);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    // ---- Operations (any user / a Unit interface may send these) ----
    async sendActivateQuestion(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        questionId: bigint,
        questionBytes: Cell,
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeActivateQuestion(questionId, questionBytes),
        });
    }

    async sendActivateAnswer(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        questionAddress: Address,
        answerId: bigint,
        answerBytes: Cell,
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeActivateAnswer(questionAddress, answerId, answerBytes),
        });
    }

    async sendCreateBeliefSet(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        root: boolean,
        aCount: number,
        bsCount: number,
        aSet: Cell,
        bsSet: Cell,
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeCreateBeliefSet(root, aCount, bsCount, aSet, bsSet),
        });
    }

    // ---- Off-chain deterministic address calc (mirrors the get-methods) ----
    // Requires the child codes; pass them in (from compile output) or read via
    // getCodes(). The master address is `this.address`.
    unitAddress(userAddress: Address, unitCode: Cell, workchain = 0): Address {
        return contractAddress(workchain, {
            code: unitCode,
            data: unitConfigToCell({ ubpsMaster: this.address, userAddress }),
        });
    }

    questionAddress(questionId: bigint, questionCode: Cell, workchain = 0): Address {
        return contractAddress(workchain, {
            code: questionCode,
            data: questionConfigToCell({ ubpsMaster: this.address, questionId }),
        });
    }

    answerAddress(questionAddress: Address, answerId: bigint, answerCode: Cell, workchain = 0): Address {
        return contractAddress(workchain, {
            code: answerCode,
            data: answerConfigToCell({ ubpsMaster: this.address, questionAddress, answerId }),
        });
    }

    beliefSetAddress(bsIndex: bigint | number, beliefSetCode: Cell, workchain = 0): Address {
        return contractAddress(workchain, {
            code: beliefSetCode,
            data: beliefSetConfigToCell({ ubpsMaster: this.address, bsIndex }),
        });
    }

    // ---- Getters ----
    async getOwner(provider: ContractProvider): Promise<Address> {
        const r = await provider.get('get_owner', []);
        return r.stack.readAddress();
    }

    async getNextBsIndex(provider: ContractProvider): Promise<bigint> {
        const r = await provider.get('get_next_bs_index', []);
        return r.stack.readBigNumber();
    }

    async getCodes(provider: ContractProvider): Promise<{
        unitCode: Cell; questionCode: Cell; answerCode: Cell; beliefSetCode: Cell;
    }> {
        const r = await provider.get('get_codes', []);
        return {
            unitCode: r.stack.readCell(),
            questionCode: r.stack.readCell(),
            answerCode: r.stack.readCell(),
            beliefSetCode: r.stack.readCell(),
        };
    }

    async getUnitAddress(provider: ContractProvider, userAddress: Address): Promise<Address> {
        const r = await provider.get('get_unit_address', [
            { type: 'slice', cell: beginCell().storeAddress(userAddress).endCell() },
        ]);
        return r.stack.readAddress();
    }

    async getQuestionAddress(provider: ContractProvider, questionId: bigint): Promise<Address> {
        const r = await provider.get('get_question_address', [{ type: 'int', value: questionId }]);
        return r.stack.readAddress();
    }

    async getAnswerAddress(provider: ContractProvider, questionAddress: Address, answerId: bigint): Promise<Address> {
        const r = await provider.get('get_answer_address', [
            { type: 'slice', cell: beginCell().storeAddress(questionAddress).endCell() },
            { type: 'int', value: answerId },
        ]);
        return r.stack.readAddress();
    }

    async getBeliefSetAddress(provider: ContractProvider, bsIndex: bigint | number): Promise<Address> {
        const r = await provider.get('get_belief_set_address', [{ type: 'int', value: BigInt(bsIndex) }]);
        return r.stack.readAddress();
    }
}
