// SPDX-License-Identifier: UNLICENSED
import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode, toNano } from '@ton/core';
import { XY, MoveMode, MoveData, X_TYPE_BITS, Y_TYPE_BITS } from './structs';
import { encodeMove, encodeMoveShipToCC, encodeWithdrawTON, encodeWithdrawJetton, encodeWithdrawNFT } from './types';

export type CoordinateCellConfig = {
    gameAddress: Address,
    xy: XY,
    shipCode: Cell,
};

export function coordinateCellConfigToCell(config: CoordinateCellConfig): Cell {
    return beginCell().storeAddress(config.gameAddress).storeInt(config.xy.x, X_TYPE_BITS).storeUint(config.xy.y, Y_TYPE_BITS).storeBit(false).storeMaybeRef(null).storeRef(config.shipCode).endCell();
}

export class CoordinateCell implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new CoordinateCell(address);
    }

    static createFromConfig(config: CoordinateCellConfig, code: Cell, workchain = 0) {
        const data = coordinateCellConfigToCell(config);
        const init = { code, data };
        return new CoordinateCell(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendMove(provider: ContractProvider, via: Sender, value: bigint, user: Address, mode: MoveMode, moveData: MoveData) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeMove({ user, mode, moveData }),
        });
    }

    async sendMoveShipToCC(provider: ContractProvider, via: Sender, value: bigint, user: Address, ship_hp: bigint, mode: MoveMode) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeMoveShipToCC({ user, ship_hp, mode }),
        });
    }

    async getTonBalance(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('tonBalance', []);
        return result.stack.readBigNumber();
    }

    async sendWithdrawTON(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        recipient: Address,
        amount: bigint,
        queryId: bigint = 0n
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeWithdrawTON({ queryId, recipient, amount }),
        });
    }

    async sendWithdrawJetton(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        jettonWalletAddress: Address,
        recipient: Address,
        amount: bigint,
        forwardTonAmount: bigint = toNano('0.1'),
        queryId: bigint = 0n
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeWithdrawJetton({
                queryId,
                jettonWalletAddress,
                recipient,
                amount,
                forwardTonAmount,
            }),
        });
    }

    async sendWithdrawNFT(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        nftAddress: Address,
        recipient: Address,
        forwardTonAmount: bigint = toNano('0.1'),
        responseDestination: Address | null = null,
        customPayload: Cell | null = null,
        queryId: bigint = 0n
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeWithdrawNFT({
                queryId,
                nftAddress,
                recipient,
                forwardTonAmount,
                responseDestination,
                customPayload,
            }),
        });
    }

    async getOpened(provider: ContractProvider): Promise<boolean> {
        const result = await provider.get('get_opened', []);
        return result.stack.readBoolean();
    }
}
