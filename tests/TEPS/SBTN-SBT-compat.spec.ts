// SPDX-License-Identifier: UNLICENSED
/**
 * SBTN vs SBT standard compatibility (TEP-6666 vs TEP-85).
 * Checks that SBTN item implements the same getters and messages as SBT.
 */
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, SendMode, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import { SBTNCollection } from '../../wrappers/tep/sbtn/SBTNCollection';
import { SBTNItem } from '../../wrappers/tep/sbtn/SBTNItem';
import { Op } from '../../wrappers/tep/sbtn/types';
import '@ton/test-utils';
import { randomAddress } from '@ton/test-utils';
import { activateTVM12, GasLogAndSave } from '../helpers';

describe('SBTN-SBT-compat', () => {
    let GAS_LOG = new GasLogAndSave('sbtn_compat');
    let sbtnItemCode: Cell;
    let sbtnCollectionCode: Cell;

    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sbtnCollection: SandboxContract<SBTNCollection>;

    const ERROR_SBTN_TRANSFER_FORBIDDEN = 967;
    const ERROR_NOT_FROM_OWNER = 962;
    const ERROR_NOT_AUTHORITY = 963;
    const ERROR_ALREADY_REVOKED = 964;

    async function sbtnFixture(ownerAddress: Address, index: bigint | number) {
        await sbtnCollection.sendDeploySbtn(owner.getSender(), {
            ownerAddress,
            index,
            value: toNano('0.1'),
            attachTonAmount: toNano('0.05'),
            individualContent: beginCell().endCell(),
        });
        const addr = await sbtnCollection.getSbtnAddress(ownerAddress, index);
        return blockchain.openContract(SBTNItem.createFromAddress(addr));
    }

    beforeAll(async () => {
        sbtnItemCode = await compile('SBTNItem');
        sbtnCollectionCode = await compile('SBTNCollection');
        GAS_LOG.rememberBocSize('sbtn-item', sbtnItemCode);
        GAS_LOG.rememberBocSize('sbtn-collection', sbtnCollectionCode);
    });
    afterAll(() => {
        GAS_LOG.saveCurrentRunAfterAll();
    });

    beforeAll(async () => {
        blockchain = await Blockchain.create();
        activateTVM12(blockchain);
        owner = await blockchain.treasury('owner');
        sbtnCollection = blockchain.openContract(
            SBTNCollection.createFromConfig(
                { sbtnItemCode, adminAddress: owner.address },
                sbtnCollectionCode,
            ),
        );
        await sbtnCollection.sendDeploy(owner.getSender(), toNano('0.05'));
    });

    describe('get_nft_data (SBT shape)', () => {
        it('should return initialized, index, collection, owner, authority (collection), revoked_at', async () => {
            const ownerA = randomAddress();
            const sbtnItem = await sbtnFixture(ownerA, 0n);
            const data = await sbtnItem.getNftData();
            expect(data.init).toBe(true);
            expect(data.index).toBe(0n);
            expect(data.collectionAddress).toEqualAddress(sbtnCollection.address);
            expect(data.ownerAddress).toEqualAddress(ownerA);
            expect(data.authority).toEqualAddress(sbtnCollection.address);
            expect(data.revokedAt).toBe(0n);
        });

        it('should return collection as authority when initialized', async () => {
            const ownerA = randomAddress();
            const sbtnItem = await sbtnFixture(ownerA, 1n);
            const data = await sbtnItem.getNftData();
            expect(data.authority).toEqualAddress(sbtnCollection.address);
            const authAddr = await sbtnItem.getAuthorityAddress();
            expect(authAddr).toEqualAddress(sbtnCollection.address);
        });
    });

    describe('prove_ownership', () => {
        it('should send ownership_proof with item_id == index and owner', async () => {
            const ownerA = await blockchain.treasury('ownerA');
            const dest = await blockchain.treasury('dest');
            const sbtnItem = await sbtnFixture(ownerA.address, 2n);
            const result = await sbtnItem.sendProveOwnership(ownerA.getSender(), {
                value: toNano('0.05'),
                destination: dest.address,
                queryId: 42,
                withContent: false,
            });
            expect(result.transactions).toHaveTransaction({
                from: ownerA.address,
                to: sbtnItem.address,
                op: Op.ProveOwnership,
                success: true,
            });
            expect(result.transactions).toHaveTransaction({
                from: sbtnItem.address,
                to: dest.address,
                op: Op.OwnershipProof,
                success: true,
            });
        });

        it('should reject prove_ownership from non-owner', async () => {
            const ownerA = await blockchain.treasury('ownerA');
            const notOwner = await blockchain.treasury('notOwner');
            const dest = await blockchain.treasury('dest');
            const sbtnItem = await sbtnFixture(ownerA.address, 3n);
            const result = await sbtnItem.sendProveOwnership(notOwner.getSender(), {
                value: toNano('0.05'),
                destination: dest.address,
                withContent: false,
            });
            expect(result.transactions).toHaveTransaction({
                from: notOwner.address,
                to: sbtnItem.address,
                op: Op.ProveOwnership,
                success: false,
                exitCode: ERROR_NOT_FROM_OWNER,
            });
        });
    });

    describe('request_owner', () => {
        it('should send owner_info (anyone can request)', async () => {
            const ownerA = await blockchain.treasury('ownerA');
            const requester = await blockchain.treasury('requester');
            const dest = await blockchain.treasury('dest');
            const sbtnItem = await sbtnFixture(ownerA.address, 4n);
            const result = await sbtnItem.sendRequestOwner(requester.getSender(), {
                value: toNano('0.05'),
                destination: dest.address,
                withContent: false,
            });
            expect(result.transactions).toHaveTransaction({
                from: requester.address,
                to: sbtnItem.address,
                op: Op.RequestOwner,
                success: true,
            });
            expect(result.transactions).toHaveTransaction({
                from: sbtnItem.address,
                to: dest.address,
                op: Op.OwnerInfo,
                success: true,
            });
        });

        it('request_owner after destroy is rejected (active=false)', async () => {
            const ownerA = await blockchain.treasury('ownerA');
            const requester = await blockchain.treasury('requester');
            const dest = await blockchain.treasury('dest');
            const sbtnItem = await sbtnFixture(ownerA.address, 13n);
            await sbtnItem.sendDestroy(ownerA.getSender(), {
                value: toNano('0.05'),
                queryId: 50,
            });
            const data = await sbtnItem.getNftData();
            expect(data.ownerAddress).toBeNull();
            const ERROR_NOT_INITIALIZED = 969;
            const result = await sbtnItem.sendRequestOwner(requester.getSender(), {
                value: toNano('0.05'),
                destination: dest.address,
                withContent: false,
            });
            expect(result.transactions).toHaveTransaction({
                from: requester.address,
                to: sbtnItem.address,
                op: Op.RequestOwner,
                success: false,
                exitCode: ERROR_NOT_INITIALIZED,
            });
        });
    });

    describe('destroy', () => {
        it('should destroy and send Excesses to owner', async () => {
            const ownerA = await blockchain.treasury('ownerA');
            const sbtnItem = await sbtnFixture(ownerA.address, 5n);
            const result = await sbtnItem.sendDestroy(ownerA.getSender(), {
                value: toNano('0.05'),
                queryId: 44,
            });
            expect(result.transactions).toHaveTransaction({
                from: ownerA.address,
                to: sbtnItem.address,
                op: Op.Destroy,
                success: true,
            });
            expect(result.transactions).toHaveTransaction({
                from: sbtnItem.address,
                to: ownerA.address,
                op: Op.Excesses,
                success: true,
            });
            const data = await sbtnItem.getNftData();
            expect(data.ownerAddress).toBeNull();
        });

        it('should reject destroy from non-owner', async () => {
            const ownerA = await blockchain.treasury('ownerA');
            const notOwner = await blockchain.treasury('notOwner');
            const sbtnItem = await sbtnFixture(ownerA.address, 6n);
            const result = await sbtnItem.sendDestroy(notOwner.getSender(), {
                value: toNano('0.05'),
                queryId: 45,
            });
            expect(result.transactions).toHaveTransaction({
                from: notOwner.address,
                to: sbtnItem.address,
                op: Op.Destroy,
                success: false,
                exitCode: ERROR_NOT_FROM_OWNER,
            });
        });
    });

    describe('revoke', () => {
        it('should revoke by collection and get_revoked_time > 0', async () => {
            const ownerA = await blockchain.treasury('ownerA');
            const sbtnItem = await sbtnFixture(ownerA.address, 7n);
            expect(await sbtnItem.getRevokedTime()).toBe(0);
            const result = await owner.send({
                to: sbtnCollection.address,
                value: toNano('0.05'),
                sendMode: SendMode.PAY_GAS_SEPARATELY,
                body: beginCell()
                    .storeUint(Op.RevokeSbtnItem, 32)
                    .storeUint(46, 64)
                    .storeAddress(sbtnItem.address)
                    .endCell(),
            });
            expect(result.transactions).toHaveTransaction({
                from: sbtnCollection.address,
                to: sbtnItem.address,
                op: Op.Revoke,
                success: true,
            });
            expect(await sbtnItem.getRevokedTime()).toBeGreaterThan(0);
        });

        it('should reject revoke from non-collection', async () => {
            const ownerA = await blockchain.treasury('ownerA');
            const sbtnItem = await sbtnFixture(ownerA.address, 8n);
            const result = await sbtnItem.sendRevoke(ownerA.getSender(), {
                value: toNano('0.05'),
                queryId: 47,
            });
            expect(result.transactions).toHaveTransaction({
                from: ownerA.address,
                to: sbtnItem.address,
                op: Op.Revoke,
                success: false,
                exitCode: ERROR_NOT_AUTHORITY,
            });
        });

        it('should reject second revoke (already revoked)', async () => {
            const ownerA = await blockchain.treasury('ownerA');
            const sbtnItem = await sbtnFixture(ownerA.address, 9n);
            await sbtnCollection.sendRevokeToItem(owner.getSender(), {
                itemAddress: sbtnItem.address,
                value: toNano('0.05'),
                queryId: 48,
            });
            expect(await sbtnItem.getRevokedTime()).toBeGreaterThan(0);
            const result = await owner.send({
                to: sbtnCollection.address,
                value: toNano('0.05'),
                sendMode: SendMode.PAY_GAS_SEPARATELY,
                body: beginCell()
                    .storeUint(Op.RevokeSbtnItem, 32)
                    .storeUint(49, 64)
                    .storeAddress(sbtnItem.address)
                    .endCell(),
            });
            expect(result.transactions).toHaveTransaction({
                from: sbtnCollection.address,
                to: sbtnItem.address,
                op: Op.Revoke,
                success: false,
                exitCode: ERROR_ALREADY_REVOKED,
            });
        });
    });

    describe('transfer rejected', () => {
        it('should reject AskToChangeOwnership (SBT transfer opcode)', async () => {
            const ownerA = await blockchain.treasury('ownerA');
            const sbtnItem = await sbtnFixture(ownerA.address, 10n);
            const receiver = randomAddress();
            const result = await ownerA.send({
                to: sbtnItem.address,
                value: toNano('0.05'),
                sendMode: SendMode.PAY_GAS_SEPARATELY,
                body: beginCell()
                    .storeUint(Op.AskToChangeOwnership, 32)
                    .storeUint(0, 64)
                    .storeAddress(receiver)
                    .storeAddress(null)
                    .storeBit(0)
                    .storeCoins(0n)
                    .storeBit(0)
                    .endCell(),
            });
            expect(result.transactions).toHaveTransaction({
                from: ownerA.address,
                to: sbtnItem.address,
                op: Op.AskToChangeOwnership,
                success: false,
                exitCode: ERROR_SBTN_TRANSFER_FORBIDDEN,
            });
            const data = await sbtnItem.getNftData();
            expect(data.ownerAddress).toEqualAddress(ownerA.address);
        });
    });

    describe('get_authority_address / get_revoked_time', () => {
        it('should return collection as authority when initialized', async () => {
            const ownerA = await blockchain.treasury('ownerA');
            const sbtnItem = await sbtnFixture(ownerA.address, 11n);
            const authAddr = await sbtnItem.getAuthorityAddress();
            expect(authAddr).toEqualAddress(sbtnCollection.address);
        });
    });
});
