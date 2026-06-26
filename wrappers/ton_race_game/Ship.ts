// SPDX-License-Identifier: UNLICENSED
import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';
import { sign } from '@ton/crypto';
import {
    encodeRequestToMove,
    encodeRequestToFastTravel,
    encodeRequestToHardTravel,
    encodeRequestShipToMint,
    encodeResetShip,
    encodeWithdrawExcessTON,
    encodeSetSessionKey,
    encodeSessionMoveInner,
    encodeShipExternalEnvelope,
    loadGameFieldsOpt,
    SetSessionKey,
} from './types';
import { MoveMode, XY, HP_TYPE_BITS, HardTravelInfo } from './structs';
import { Coins, loadCoins } from '@ton/sandbox/dist/config/config.tlb-gen';

/**
 * Build the session-key-signed external message body that authorises ONE bounded move/exit.
 * Signed by the SESSION key — never the wallet key (no per-move wallet popup).
 *
 * Sandbox note: the @ton ContractProvider does not expose external(), so tests deliver
 * this via `blockchain.sendMessage(external({ to: ship.address, body }))`.
 */
export function buildShipSessionMoveExternal(args: {
    sessionSecretKey: Buffer;
    seqno: number;
    validUntil: number; // MUST equal the ship's stored sessionValidUntil
    moveMode: number; // MoveMode uint8 (LEFT/UP/RIGHT/EXIT)
}): Cell {
    const innerCell = encodeSessionMoveInner({
        seqno: args.seqno,
        validUntil: args.validUntil,
        moveMode: args.moveMode,
    });
    const signature = sign(innerCell.hash(), args.sessionSecretKey);
    return encodeShipExternalEnvelope(signature, innerCell);
}

export type ShipConfig = {
    userAddress: Address,
    gameAddress: Address,
    coordinateCellCode: Cell,
};

export function shipConfigToCell(config: ShipConfig): Cell {
    return beginCell()
        .storeAddress(config.userAddress)
        .storeAddress(config.gameAddress)
        .storeUint(0, HP_TYPE_BITS) // max_hp: 0 (will be set when gameFields are initialized)
        .storeMaybeRef(null) // gameFields: null
        .storeMaybeRef(null) // fastTravelInfo: null
        .storeRef(config.coordinateCellCode)
        .storeBit(false) // movement_in_process: false (no move in flight)
        .storeBit(false) // cashback_to_ship: false (no auto move in flight)
        .storeCoins(0) // pending_mint_amount: 0
        .storeMaybeRef(null) // sessionInfo: null (no active session on a fresh ship)
        .endCell();
}



export class Ship implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Ship(address);
    }

    static createFromConfig(config: ShipConfig, code: Cell, workchain = 0) {
        const data = shipConfigToCell(config);
        const init = { code, data };
        return new Ship(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendMove(provider: ContractProvider, via: Sender, value: bigint, move: MoveMode) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeRequestToMove({ mode: move }),
        });
    }

    async sendFastTravel(provider: ContractProvider, via: Sender, value: bigint, xy: XY) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeRequestToFastTravel({ xy }),
        });
    }

    async sendHardTravel(provider: ContractProvider, via: Sender, value: bigint, info: HardTravelInfo) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeRequestToHardTravel({ info }),
        });
    }

    async sendResetShip(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeResetShip(),
        });
    }

    async getCurrentGameData(provider: ContractProvider) {
        const result = await provider.get('currentGameData', []);
        return loadGameFieldsOpt(result.stack);
    }

    async getTonBalance(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('tonBalance', []);
        return result.stack.readBigNumber();
    }

    async getMovementInProcess(provider: ContractProvider): Promise<boolean> {
        const result = await provider.get('get_movement_in_process', []);
        return result.stack.readBoolean();
    }

    async getMaxHp(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('get_max_hp', []);
        return result.stack.readBigNumber();
    }

    async getPendingMintAmount(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('get_pending_mint_amount', []);
        return result.stack.readBigNumber();
    }

    async sendRequestShipToMint(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeRequestShipToMint(),
        });
    }

    /** Owner reclaim of the ship's surplus TON (must come from the ship's userAddress).
     *  The ship keeps WITHDRAW_KEEP_AMOUNT; the rest is sent back to userAddress. */
    async sendWithdrawExcessTON(provider: ContractProvider, via: Sender, value: bigint, queryId: bigint = 0n) {
        return await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeWithdrawExcessTON({ queryId }),
        });
    }

    /** One-time session authorise / rotate / revoke (must come from the ship's userAddress).
     *  Any TON sent stays on the ship as the float that funds external moves. */
    async sendSetSessionKey(provider: ContractProvider, via: Sender, value: bigint, msg: SetSessionKey) {
        return await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeSetSessionKey(msg),
        });
    }

    async getSessionPublicKey(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('get_session_public_key', []);
        return result.stack.readBigNumber();
    }

    async getSessionSeqno(provider: ContractProvider): Promise<number> {
        const result = await provider.get('get_session_seqno', []);
        return result.stack.readNumber();
    }

    async getSessionValidUntil(provider: ContractProvider): Promise<number> {
        const result = await provider.get('get_session_valid_until', []);
        return result.stack.readNumber();
    }

    async getSessionMovesLeft(provider: ContractProvider): Promise<number> {
        const result = await provider.get('get_session_moves_left', []);
        return result.stack.readNumber();
    }
}
