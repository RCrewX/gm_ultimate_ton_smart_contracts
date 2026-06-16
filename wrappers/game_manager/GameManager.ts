// SPDX-License-Identifier: UNLICENSED
import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode, toNano } from '@ton/core';
import { encodeR1, encodeRedirectMessage, encodeSetRetranslator, RedirectMessage } from './types';
import {
    encodeForwardMintRequest,
    encodeRequestBurn,
    encodeMintNft,
    encodeMintSbt,
    encodeRevokeSbt,
    encodeEditNft,
    encodeEditSbt,
    ForwardMintRequest,
    RequestBurn,
} from './RetranslatorTypes';

// =============================================================================
// GameManager (GM) — the stable dumb pipe + sole on-chain authority.
// Storage (static.tolk GameManagerStorage):
//   ownerAddress, retranslatorAddress, my_little_tax, config?
// retranslatorAddress is set to ownerAddress at deploy (placeholder), then
// pointed at the real R* via SetRetranslator.
// =============================================================================

export type GameManagerConfig = {
    ownerAddress: Address;
    retranslatorAddress?: Address; // defaults to ownerAddress (deploy-time placeholder)
};

export const DEFAULT_MY_LITTLE_TAX = toNano('0.02');

export function gameManagerConfigToCell(config: GameManagerConfig): Cell {
    return beginCell()
        .storeAddress(config.ownerAddress)
        .storeAddress(config.retranslatorAddress ?? config.ownerAddress) // retranslatorAddress
        .storeCoins(DEFAULT_MY_LITTLE_TAX) // my_little_tax
        .storeMaybeRef(null) // config: cell?
        .endCell();
}

export class GameManager implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new GameManager(address);
    }

    static createFromConfig(config: GameManagerConfig, code: Cell, workchain = 0) {
        const data = gameManagerConfigToCell(config);
        const init = { code, data };
        return new GameManager(contractAddress(workchain, init), init);
    }

    // ========================================================================
    // Static message builders
    // ========================================================================

    /** Wrap an arbitrary inner request body into an R1 envelope. */
    static r1Message(data: Cell): Cell {
        return encodeR1({ data });
    }

    static setRetranslatorMessage(retranslatorAddress: Address): Cell {
        return encodeSetRetranslator({ retranslatorAddress });
    }

    static redirectMessage(
        destination: Address,
        messageBody: Cell,
        forwardTonAmount: bigint = toNano('0.1'),
        queryId: bigint = 0n,
    ): Cell {
        return encodeRedirectMessage({ queryId, destination, messageBody, forwardTonAmount });
    }

    // ========================================================================
    // Provider-based send methods
    // ========================================================================

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    /** Owner points GM at the Retranslator (the swappable brain). */
    async sendSetRetranslator(provider: ContractProvider, via: Sender, value: bigint, retranslatorAddress: Address) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeSetRetranslator({ retranslatorAddress }),
        });
    }

    /** Send a raw R1 (opaque inner body) into the pipe. */
    async sendR1(provider: ContractProvider, via: Sender, value: bigint, data: Cell) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeR1({ data }),
        });
    }

    /** Convenience: R1-wrap a ForwardMintRequest. */
    async sendForwardMintRequest(provider: ContractProvider, via: Sender, value: bigint, req: ForwardMintRequest) {
        await this.sendR1(provider, via, value, encodeForwardMintRequest(req));
    }

    /** Convenience: R1-wrap a RequestBurn (owner-initiated). */
    async sendRequestBurn(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        jettonAmount: bigint,
        sendExcessesTo: Address | null = null,
        customPayload: Cell | null = null,
        queryId: bigint = 0n,
    ) {
        await this.sendR1(provider, via, value, encodeRequestBurn({ queryId, jettonAmount, sendExcessesTo, customPayload }));
    }

    /** Convenience: R1-wrap a MintNft printer request (initiator = game OR owner). */
    async sendMintNft(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        receiver: Address,
        content: Cell,
    ) {
        await this.sendR1(provider, via, value, encodeMintNft({ receiver, content }));
    }

    /** Convenience: R1-wrap a MintSbt printer request (initiator = game OR owner). */
    async sendMintSbt(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        receiver: Address,
        individualContent: Cell,
    ) {
        await this.sendR1(provider, via, value, encodeMintSbt({ receiver, individualContent }));
    }

    /** Convenience: R1-wrap a RevokeSbt printer request (owner-only on R*). */
    async sendRevokeSbt(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        itemAddress: Address,
        queryId: bigint = 0n,
    ) {
        await this.sendR1(provider, via, value, encodeRevokeSbt({ queryId, itemAddress }));
    }

    /** ⚒ ANVIL: R1-wrap an EditNft (owner/GM-only on R*; opaque content cell). */
    async sendEditNft(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        itemAddress: Address,
        content: Cell,
    ) {
        await this.sendR1(provider, via, value, encodeEditNft({ itemAddress, content }));
    }

    /** ⚒ ANVIL: R1-wrap an EditSbt (owner/GM-only on R*; opaque content cell). */
    async sendEditSbt(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        itemAddress: Address,
        content: Cell,
    ) {
        await this.sendR1(provider, via, value, encodeEditSbt({ itemAddress, content }));
    }

    async sendRedirectMessage(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        destination: Address,
        messageBody: Cell,
        forwardTonAmount: bigint = toNano('0.1'),
        queryId: bigint = 0n,
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeRedirectMessage({ queryId, destination, messageBody, forwardTonAmount }),
        });
    }

    // ========================================================================
    // Get methods
    // ========================================================================

    async getOwnerAddress(provider: ContractProvider): Promise<Address> {
        const result = await provider.get('get_owner_address', []);
        return result.stack.readAddress();
    }

    async getRetranslatorAddress(provider: ContractProvider): Promise<Address> {
        const result = await provider.get('get_retranslator_address', []);
        return result.stack.readAddress();
    }
}
