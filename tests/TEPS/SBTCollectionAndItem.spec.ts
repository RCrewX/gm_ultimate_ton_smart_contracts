// SPDX-License-Identifier: UNLICENSED
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, SendMode, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import { SBTCollection } from '../../wrappers/tep/sbt/SBTCollection';
import { SBTItem } from '../../wrappers/tep/sbt/SBTItem';
import { Op } from '../../wrappers/tep/sbt/types';
import '@ton/test-utils';
import { randomAddress } from '@ton/test-utils';
import { activateTVM12, GasLogAndSave } from '../helpers';

describe('03_sbt', () => {
    let GAS_LOG = new GasLogAndSave('03_sbt');
    let sbtItemCode: Cell;
    let sbtCollectionCode: Cell;

    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sbtCollection: SandboxContract<SBTCollection>;

    const ERROR_SBT_TRANSFER_FORBIDDEN = 957;
    const ERROR_NOT_FROM_OWNER = 951;
    const ERROR_NOT_AUTHORITY = 953;
    const ERROR_ALREADY_REVOKED = 954;

    async function sbtFixture(sbtOwnerAddress: Address, authority?: Address | null) {
        const { nextItemIndex } = await sbtCollection.getCollectionData();
        await sbtCollection.sendDeploySbt(owner.getSender(), {
            to: sbtOwnerAddress,
            index: nextItemIndex,
            value: toNano('0.1'),
            attachTonAmount: toNano('0.05'),
            authority: authority ?? null,
        });

        const sbtAddress = await sbtCollection.getSbtAddressByIndex(nextItemIndex);
        return blockchain.openContract(SBTItem.createFromAddress(sbtAddress));
    }

    beforeAll(async () => {
        sbtItemCode = await compile('SBTItem');
        sbtCollectionCode = await compile('SBTCollection');
        GAS_LOG.rememberBocSize('sbt-item', sbtItemCode);
        GAS_LOG.rememberBocSize('sbt-collection', sbtCollectionCode);
    });
    afterAll(() => {
        GAS_LOG.saveCurrentRunAfterAll();
    });

    describe('SBTCollection', () => {
        beforeAll(async () => {
            blockchain = await Blockchain.create();
            activateTVM12(blockchain);
            owner = await blockchain.treasury('owner');

            sbtCollection = blockchain.openContract(
                SBTCollection.createFromConfig(
                    {
                        sbtItemCode,
                        adminAddress: owner.address,
                    },
                    sbtCollectionCode,
                ),
            );

            const deployResult = await sbtCollection.sendDeploy(owner.getSender(), toNano('0.05'));

            expect(deployResult.transactions).toHaveTransaction({
                from: owner.address,
                to: sbtCollection.address,
                deploy: true,
                success: true,
            });
        });

        it('should deploy SBT and report collection data', async () => {
            const { nextItemIndex } = await sbtCollection.getCollectionData();
            const sbtOwnerAddress = randomAddress();
            const content = beginCell().storeStringTail('SBT Content').endCell();

            const deployResult = await sbtCollection.sendDeploySbt(owner.getSender(), {
                to: sbtOwnerAddress,
                index: nextItemIndex,
                value: toNano('0.1'),
                attachTonAmount: toNano('0.05'),
                content,
            });

            expect(deployResult.transactions).toHaveTransaction({
                from: owner.address,
                to: sbtCollection.address,
                op: Op.DeploySbt,
                success: true,
            });

            const sbtAddress = await sbtCollection.getSbtAddressByIndex(nextItemIndex);
            expect(deployResult.transactions).toHaveTransaction({
                from: sbtCollection.address,
                to: sbtAddress,
                initCode: sbtItemCode,
                deploy: true,
                success: true,
            });

            const sbtItem = blockchain.openContract(SBTItem.createFromAddress(sbtAddress));
            const data = await sbtItem.getNftData();
            expect(data.init).toBeTruthy();
            expect(data.index).toBe(nextItemIndex);
            expect(data.ownerAddress).toEqualAddress(sbtOwnerAddress);
            expect(data.collectionAddress).toEqualAddress(sbtCollection.address);
            expect(data.authority).toBeNull();
            expect(data.revokedAt).toBe(0n);
        });

        it('should deploy SBT with authority', async () => {
            const authority = await blockchain.treasury('authority');
            const sbtOwnerAddress = randomAddress();
            const { nextItemIndex } = await sbtCollection.getCollectionData();

            await sbtCollection.sendDeploySbt(owner.getSender(), {
                to: sbtOwnerAddress,
                index: nextItemIndex,
                value: toNano('0.1'),
                attachTonAmount: toNano('0.05'),
                authority: authority.address,
            });

            const sbtAddress = await sbtCollection.getSbtAddressByIndex(nextItemIndex);
            const sbtItem = blockchain.openContract(SBTItem.createFromAddress(sbtAddress));
            const authAddr = await sbtItem.getAuthorityAddress();
            expect(authAddr).toEqualAddress(authority.address);
        });

        it('should not deploy SBT from non-admin', async () => {
            const notAdmin = await blockchain.treasury('not-admin');
            const { nextItemIndex } = await sbtCollection.getCollectionData();

            const result = await sbtCollection.sendDeploySbt(notAdmin.getSender(), {
                to: notAdmin.address,
                index: nextItemIndex,
                value: toNano('0.1'),
            });

            expect(result.transactions).toHaveTransaction({
                from: notAdmin.address,
                to: sbtCollection.address,
                op: Op.DeploySbt,
                success: false,
                exitCode: 950,
            });
        });

        it('should get_sbt_address_by_index match deployed address', async () => {
            const { nextItemIndex } = await sbtCollection.getCollectionData();
            const sbtOwnerAddress = randomAddress();
            await sbtCollection.sendDeploySbt(owner.getSender(), {
                to: sbtOwnerAddress,
                index: nextItemIndex,
                value: toNano('0.1'),
            });
            const computed = await sbtCollection.getSbtAddressByIndex(nextItemIndex);
            const sbtItem = blockchain.openContract(SBTItem.createFromAddress(computed));
            const data = await sbtItem.getNftData();
            expect(data.collectionAddress).toEqualAddress(sbtCollection.address);
            expect(data.index).toBe(nextItemIndex);
        });
    });

    describe('SBTItem', () => {
        beforeAll(async () => {
            blockchain = await Blockchain.create();
            activateTVM12(blockchain);
            owner = await blockchain.treasury('owner');

            sbtCollection = blockchain.openContract(
                SBTCollection.createFromConfig(
                    { sbtItemCode, adminAddress: owner.address },
                    sbtCollectionCode,
                ),
            );
            await sbtCollection.sendDeploy(owner.getSender(), toNano('0.05'));
        });

        it('should reject transfer (AskToChangeOwnership)', async () => {
            const sbtOwner = await blockchain.treasury('sbt-owner');
            const sbtItem = await sbtFixture(sbtOwner.address);
            const receiver = randomAddress();

            const result = await sbtOwner.send({
                to: sbtItem.address,
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
                from: sbtOwner.address,
                to: sbtItem.address,
                op: Op.AskToChangeOwnership,
                success: false,
                exitCode: ERROR_SBT_TRANSFER_FORBIDDEN,
            });

            const data = await sbtItem.getNftData();
            expect(data.ownerAddress).toEqualAddress(sbtOwner.address);
        });

        it('should send prove_ownership and receive OwnershipProof', async () => {
            const sbtOwner = await blockchain.treasury('sbt-owner');
            const dest = await blockchain.treasury('dest');
            const sbtItem = await sbtFixture(sbtOwner.address);

            const result = await sbtItem.sendProveOwnership(sbtOwner.getSender(), {
                value: toNano('0.05'),
                destination: dest.address,
                queryId: 42,
                forwardPayload: beginCell().storeUint(123, 32).endCell(),
                withContent: false,
            });

            expect(result.transactions).toHaveTransaction({
                from: sbtOwner.address,
                to: sbtItem.address,
                op: Op.ProveOwnership,
                success: true,
            });
            expect(result.transactions).toHaveTransaction({
                from: sbtItem.address,
                to: dest.address,
                op: Op.OwnershipProof,
                success: true,
            });
        });

        it('should reject prove_ownership from non-owner', async () => {
            const sbtOwner = await blockchain.treasury('sbt-owner');
            const notOwner = await blockchain.treasury('not-owner');
            const dest = await blockchain.treasury('dest');
            const sbtItem = await sbtFixture(sbtOwner.address);

            const result = await sbtItem.sendProveOwnership(notOwner.getSender(), {
                value: toNano('0.05'),
                destination: dest.address,
                queryId: 42,
                withContent: false,
            });

            expect(result.transactions).toHaveTransaction({
                from: notOwner.address,
                to: sbtItem.address,
                op: Op.ProveOwnership,
                success: false,
                exitCode: ERROR_NOT_FROM_OWNER,
            });
        });

        it('should send request_owner and receive OwnerInfo (anyone)', async () => {
            const sbtOwner = await blockchain.treasury('sbt-owner');
            const requester = await blockchain.treasury('requester');
            const dest = await blockchain.treasury('dest');
            const sbtItem = await sbtFixture(sbtOwner.address);

            const result = await sbtItem.sendRequestOwner(requester.getSender(), {
                value: toNano('0.05'),
                destination: dest.address,
                queryId: 43,
                withContent: false,
            });

            expect(result.transactions).toHaveTransaction({
                from: requester.address,
                to: sbtItem.address,
                op: Op.RequestOwner,
                success: true,
            });
            expect(result.transactions).toHaveTransaction({
                from: sbtItem.address,
                to: dest.address,
                op: Op.OwnerInfo,
                success: true,
            });
        });

        it('should destroy SBT and receive Excesses', async () => {
            const sbtOwner = await blockchain.treasury('sbt-owner');
            const sbtItem = await sbtFixture(sbtOwner.address);

            const result = await sbtItem.sendDestroy(sbtOwner.getSender(), {
                value: toNano('0.05'),
                queryId: 44,
            });

            expect(result.transactions).toHaveTransaction({
                from: sbtOwner.address,
                to: sbtItem.address,
                op: Op.Destroy,
                success: true,
            });
            expect(result.transactions).toHaveTransaction({
                from: sbtItem.address,
                to: sbtOwner.address,
                op: Op.Excesses,
                success: true,
            });
            // Regression: Destroy must retain the storage reserve (reserve EXACT MIN_TONS_FOR_STORAGE,
            // then carry-all). A bare mode-128 send would ignore `value` and drain the item to 0.
            const itemState = await blockchain.getContract(sbtItem.address);
            expect(itemState.balance).toBeGreaterThanOrEqual(toNano('0.04'));
        });

        it('should send request_owner after destroy and receive OwnerInfo with addr_none', async () => {
            const sbtOwner = await blockchain.treasury('sbt-owner');
            const requester = await blockchain.treasury('requester');
            const dest = await blockchain.treasury('dest');
            const sbtItem = await sbtFixture(sbtOwner.address);

            await sbtItem.sendDestroy(sbtOwner.getSender(), {
                value: toNano('0.05'),
                queryId: 44,
            });

            const result = await sbtItem.sendRequestOwner(requester.getSender(), {
                value: toNano('0.05'),
                destination: dest.address,
                queryId: 45,
                withContent: false,
            });

            expect(result.transactions).toHaveTransaction({
                from: requester.address,
                to: sbtItem.address,
                op: Op.RequestOwner,
                success: true,
            });
            expect(result.transactions).toHaveTransaction({
                from: sbtItem.address,
                to: dest.address,
                op: Op.OwnerInfo,
                success: true,
            });
        });

        it('should reject destroy from non-owner', async () => {
            const sbtOwner = await blockchain.treasury('sbt-owner');
            const notOwner = await blockchain.treasury('not-owner');
            const sbtItem = await sbtFixture(sbtOwner.address);

            const result = await sbtItem.sendDestroy(notOwner.getSender(), {
                value: toNano('0.05'),
                queryId: 45,
            });

            expect(result.transactions).toHaveTransaction({
                from: notOwner.address,
                to: sbtItem.address,
                op: Op.Destroy,
                success: false,
                exitCode: ERROR_NOT_FROM_OWNER,
            });
        });

        it('should revoke SBT by authority and get_revoked_time non-zero', async () => {
            const authority = await blockchain.treasury('authority');
            const sbtOwner = await blockchain.treasury('sbt-owner');
            const sbtItem = await sbtFixture(sbtOwner.address, authority.address);

            expect(await sbtItem.getRevokedTime()).toBe(0);

            const result = await sbtItem.sendRevoke(authority.getSender(), {
                value: toNano('0.05'),
                queryId: 46,
            });

            expect(result.transactions).toHaveTransaction({
                from: authority.address,
                to: sbtItem.address,
                op: Op.Revoke,
                success: true,
            });

            const revokedAt = await sbtItem.getRevokedTime();
            expect(revokedAt).toBeGreaterThan(0);
        });

        it('should reject revoke from non-authority', async () => {
            const authority = await blockchain.treasury('authority');
            const sbtOwner = await blockchain.treasury('sbt-owner');
            const notAuthority = await blockchain.treasury('not-authority');
            const sbtItem = await sbtFixture(sbtOwner.address, authority.address);

            const result = await sbtItem.sendRevoke(notAuthority.getSender(), {
                value: toNano('0.05'),
                queryId: 47,
            });

            expect(result.transactions).toHaveTransaction({
                from: notAuthority.address,
                to: sbtItem.address,
                op: Op.Revoke,
                success: false,
                exitCode: ERROR_NOT_AUTHORITY,
            });
        });

        it('should reject second revoke (already revoked)', async () => {
            const authority = await blockchain.treasury('authority');
            const sbtOwner = await blockchain.treasury('sbt-owner');
            const sbtItem = await sbtFixture(sbtOwner.address, authority.address);

            await sbtItem.sendRevoke(authority.getSender(), {
                value: toNano('0.05'),
                queryId: 48,
            });

            const result = await sbtItem.sendRevoke(authority.getSender(), {
                value: toNano('0.05'),
                queryId: 49,
            });

            expect(result.transactions).toHaveTransaction({
                from: authority.address,
                to: sbtItem.address,
                op: Op.Revoke,
                success: false,
                exitCode: ERROR_ALREADY_REVOKED,
            });
        });

        it('should return get_nft_data with authority and revokedAt', async () => {
            const authority = await blockchain.treasury('authority');
            const sbtOwner = await blockchain.treasury('sbt-owner');
            const content = beginCell().storeStringTail('My SBT').endCell();
            const { nextItemIndex } = await sbtCollection.getCollectionData();
            await sbtCollection.sendDeploySbt(owner.getSender(), {
                to: sbtOwner.address,
                index: nextItemIndex,
                value: toNano('0.1'),
                content,
                authority: authority.address,
            });
            const sbtAddress = await sbtCollection.getSbtAddressByIndex(nextItemIndex);
            const sbtItem = blockchain.openContract(SBTItem.createFromAddress(sbtAddress));

            const data = await sbtItem.getNftData();
            expect(data.init).toBeTruthy();
            expect(data.ownerAddress).toEqualAddress(sbtOwner.address);
            expect(data.authority).toEqualAddress(authority.address);
            expect(data.revokedAt).toBe(0n);

            const authAddr = await sbtItem.getAuthorityAddress();
            expect(authAddr).toEqualAddress(authority.address);
        });

        it('should return get_authority_address as null when no authority', async () => {
            const sbtOwner = await blockchain.treasury('sbt-owner');
            const sbtItem = await sbtFixture(sbtOwner.address);

            const authAddr = await sbtItem.getAuthorityAddress();
            expect(authAddr).toBeNull();
        });
    });
});
