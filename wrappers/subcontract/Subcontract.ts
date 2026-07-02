// SPDX-License-Identifier: UNLICENSED
import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode, toNano } from '@ton/core';
import { sign } from '@ton/crypto';
import { encodeForward, encodeForwardWithInit, encodeWithdraw, encodeSetRedirectExcess, encodeSetExcessThreshold, GAS_COST_FORWARD, GAS_COST_FORWARD_WITH_INIT, Forward, ForwardWithInit, Withdraw, SetRedirectExcess, SetExcessThreshold, encodeExternalInner, encodeExternalEnvelope, ExternalInner, encodeManualDeploy } from './types';

/**
 * Build the owner-signed external message body (the ExternalEnvelope) that authorises one
 * Forward / ForwardWithInit. The signed inner binds the instance `id` FIRST — an envelope
 * signed for one instance can never be replayed against a sibling with a different id
 * (GM-A-001). Deliver it via `blockchain.sendMessage(external({ to, body }))` — the sandbox
 * ContractProvider does not expose external(), so this mirrors the Ship session pattern.
 */
export function buildSubcontractExternal(args: {
    secretKey: Buffer;
    id: bigint;         // MUST equal the target subcontract's storage.id (or a foreign id, to prove rejection)
    seqno: number;
    validUntil: number;
    command: Forward | ForwardWithInit;
}): Cell {
    const innerCell = encodeExternalInner({
        id: args.id,
        seqno: args.seqno,
        validUntil: args.validUntil,
        command: args.command,
    });
    const signature = sign(innerCell.hash(), args.secretKey);
    return encodeExternalEnvelope({ signature, inner: innerCell });
}

export type SubcontractConfig = {
    ownerAddress: Address;
    id: bigint;
    ownerPublicKey: bigint; // Ed25519 public key (256 bits) for external message signature verification
};

export function subcontractConfigToCell(config: SubcontractConfig): Cell {
    return beginCell()
        .storeAddress(config.ownerAddress)
        .storeUint(config.id, 256)
        .storeBit(false) // redirectExcess: false by default (DEFAULT_REDIRECT_EXCESS)
        .storeCoins(toNano('0.5')) // excessThreshold: 0.5 TON by default (DEFAULT_EXCESS_THRESHOLD)
        .storeUint(config.ownerPublicKey, 256) // ownerPublicKey
        .storeUint(0, 32) // extSeqno: starts at 0
        .endCell();
}

export class Subcontract implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Subcontract(address);
    }

    static createFromConfig(config: SubcontractConfig, code: Cell, workchain = 0) {
        const data = subcontractConfigToCell(config);
        const init = { code, data };
        return new Subcontract(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeManualDeploy({ queryId: 0n }),
        });
    }

    async sendForward(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        destination: Address,
        messageBody: Cell,
        forwardTonAmount: bigint = toNano('0.1'),
        bounce: boolean = false,
        sendMode: number = SendMode.PAY_GAS_SEPARATELY,
        queryId: bigint = 0n
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeForward({ queryId, destination, forwardTonAmount, bounce, sendMode, messageBody }),
        });
    }

    async sendForwardWithInit(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        destination: Address,
        stateInit: Cell,
        messageBody: Cell,
        forwardTonAmount: bigint = toNano('0.1'),
        sendMode: number = SendMode.PAY_GAS_SEPARATELY,
        queryId: bigint = 0n
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeForwardWithInit({ queryId, destination, forwardTonAmount, sendMode, stateInit, messageBody }),
        });
    }

    async sendWithdraw(
        provider: ContractProvider,
        via: Sender,
        amount: bigint,
        receiver: Address,
        value: bigint = toNano('0.01'),
        queryId: bigint = 0n
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeWithdraw({ queryId, amount, receiver }),
        });
    }

    async sendSetRedirectExcess(
        provider: ContractProvider,
        via: Sender,
        redirectExcess: boolean,
        value: bigint = toNano('0.01'),
        queryId: bigint = 0n
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeSetRedirectExcess({ queryId, redirectExcess }),
        });
    }

    async sendSetExcessThreshold(
        provider: ContractProvider,
        via: Sender,
        excessThreshold: bigint,
        value: bigint = toNano('0.01'),
        queryId: bigint = 0n
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeSetExcessThreshold({ queryId, excessThreshold }),
        });
    }

    async sendManualDeploy(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        queryId: bigint = 0n
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeManualDeploy({ queryId }),
        });
    }

    // Backward compatibility: sendRedirectMessage now uses sendForward internally
    async sendRedirectMessage(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        destination: Address,
        messageBody: Cell,
        forwardTonAmount: bigint = toNano('0.1'),
        queryId: bigint = 0n
    ) {
        // Use sendForward with default bounce=false and sendMode=PAY_GAS_SEPARATELY
        await this.sendForward(
            provider,
            via,
            value,
            destination,
            messageBody,
            forwardTonAmount,
            false, // NoBounce (default for old RedirectMessage behavior)
            SendMode.PAY_GAS_SEPARATELY,
            queryId
        );
    }

    async getOwnerAddress(provider: ContractProvider): Promise<Address> {
        const result = await provider.get('get_owner_address', []);
        return result.stack.readAddress();
    }

    async getId(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('get_id', []);
        return result.stack.readBigNumber();
    }

    async getSubcontractAddress(provider: ContractProvider, id: bigint): Promise<Address> {
        const result = await provider.get('get_subcontract_address', [
            { type: 'int', value: id }
        ]);
        return result.stack.readAddress();
    }

    async getSubcontractByIdAddress(provider: ContractProvider, ownerAddress: Address, id: bigint): Promise<Address> {
        const result = await provider.get('get_subcontract_by_id_address', [
            { type: 'slice', cell: beginCell().storeAddress(ownerAddress).endCell() },
            { type: 'int', value: id }
        ]);
        return result.stack.readAddress();
    }

    async getRedirectExcess(provider: ContractProvider): Promise<boolean> {
        const result = await provider.get('get_redirect_excess', []);
        return result.stack.readBoolean();
    }

    async getExcessThreshold(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('get_excess_threshold', []);
        return result.stack.readBigNumber();
    }

    async getTonBalance(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('tonBalance', []);
        return result.stack.readBigNumber();
    }

    async getOwnerPublicKey(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('get_owner_public_key', []);
        return result.stack.readBigNumber();
    }

    async getExtSeqno(provider: ContractProvider): Promise<number> {
        const result = await provider.get('get_ext_seqno', []);
        return result.stack.readNumber();
    }

    /**
     * Send external message with owner signature
     * @param provider Contract provider
     * @param secretKey Owner's secret key (64 bytes for Ed25519)
     * @param command Forward or ForwardWithInit command
     * @param validUntil Unix timestamp when message expires (default: now + 3600 seconds)
     */
    async sendExternalForward(
        provider: ContractProvider,
        secretKey: Buffer,
        command: Forward,
        validUntil?: number
    ): Promise<void> {
        // Get current seqno + instance id (both bound into the signed inner)
        const seqno = await this.getExtSeqno(provider);
        const id = await this.getId(provider);

        // Set validUntil to 1 hour from now if not provided
        const validUntilTime = validUntil ?? Math.floor(Date.now() / 1000) + 3600;

        // Build ExternalInner
        const inner: ExternalInner = {
            id,
            seqno,
            validUntil: validUntilTime,
            command,
        };

        // Encode inner cell
        const innerCell = encodeExternalInner(inner);

        // Compute hash of inner cell (this is what gets signed)
        const hash = innerCell.hash();

        // Sign the hash
        const signature = sign(hash, secretKey);

        // Build envelope
        const envelope = encodeExternalEnvelope({
            signature,
            inner: innerCell,
        });

        // Send external message
        await provider.external(envelope);
    }

    /**
     * Send external message with owner signature (ForwardWithInit variant)
     * @param provider Contract provider
     * @param secretKey Owner's secret key (64 bytes for Ed25519)
     * @param command ForwardWithInit command
     * @param validUntil Unix timestamp when message expires (default: now + 3600 seconds)
     */
    async sendExternalForwardWithInit(
        provider: ContractProvider,
        secretKey: Buffer,
        command: ForwardWithInit,
        validUntil?: number
    ): Promise<void> {
        // Get current seqno + instance id (both bound into the signed inner)
        const seqno = await this.getExtSeqno(provider);
        const id = await this.getId(provider);

        // Set validUntil to 1 hour from now if not provided
        const validUntilTime = validUntil ?? Math.floor(Date.now() / 1000) + 3600;

        // Build ExternalInner
        const inner: ExternalInner = {
            id,
            seqno,
            validUntil: validUntilTime,
            command,
        };

        // Encode inner cell
        const innerCell = encodeExternalInner(inner);
        
        // Compute hash of inner cell (this is what gets signed)
        const hash = innerCell.hash();
        
        // Sign the hash
        const signature = sign(hash, secretKey);
        
        // Build envelope
        const envelope = encodeExternalEnvelope({
            signature,
            inner: innerCell,
        });
        
        // Send external message
        await provider.external(envelope);
    }
}

