// SPDX-License-Identifier: UNLICENSED
/**
 * SBTN-specific behavior (TEP-6666): owner-bound addressing, sbtn_init once, get_sbtn_address, get_sbtn_item_code.
 */
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import { SBTNCollection } from '../../wrappers/tep/sbtn/SBTNCollection';
import { SBTNItem } from '../../wrappers/tep/sbtn/SBTNItem';
import { buildSbtnInitBody, calcSbtnItemAddress, Op } from '../../wrappers/tep/sbtn/types';
import '@ton/test-utils';
import { randomAddress } from '@ton/test-utils';
import { activateTVM12, GasLogAndSave } from '../helpers';

describe('SBTN-specific', () => {
    let GAS_LOG = new GasLogAndSave('sbtn_specific');
    let sbtnItemCode: Cell;
    let sbtnCollectionCode: Cell;

    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sbtnCollection: SandboxContract<SBTNCollection>;

    const ERROR_ALREADY_INITIALIZED = 961;
    const ERROR_NOT_FROM_COLLECTION = 960;

    beforeAll(async () => {
        sbtnItemCode = await compile('SBTNItem');
        sbtnCollectionCode = await compile('SBTNCollection');
        GAS_LOG.rememberBocSize('sbtn-item', sbtnItemCode);
        GAS_LOG.rememberBocSize('sbtn-collection', sbtnCollectionCode);
    });
    afterAll(() => {
        GAS_LOG.saveCurrentRunAfterAll();
    });

    beforeEach(async () => {
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

    describe('owner-bound addressing', () => {
        it('get_sbtn_address(ownerA, 0) equals deployed item address', async () => {
            const ownerA = randomAddress();
            await sbtnCollection.sendDeploySbtn(owner.getSender(), {
                ownerAddress: ownerA,
                index: 0n,
                value: toNano('0.1'),
                attachTonAmount: toNano('0.05'),
                individualContent: beginCell().endCell(),
            });
            const computed = await sbtnCollection.getSbtnAddress(ownerA, 0);
            const expected = calcSbtnItemAddress(ownerA, sbtnCollection.address, 0n, sbtnItemCode);
            expect(computed.equals(expected)).toBe(true);
            const sbtnItem = blockchain.openContract(SBTNItem.createFromAddress(computed));
            const data = await sbtnItem.getNftData();
            expect(data.init).toBe(true);
            expect(data.ownerAddress).toEqualAddress(ownerA);
        });

        it('same (owner, index) yields same address; different owner or index yields different address', async () => {
            const ownerA = randomAddress();
            const ownerB = randomAddress();
            const addrA0 = calcSbtnItemAddress(ownerA, sbtnCollection.address, 0n, sbtnItemCode);
            const addrA0Again = calcSbtnItemAddress(ownerA, sbtnCollection.address, 0n, sbtnItemCode);
            const addrA1 = calcSbtnItemAddress(ownerA, sbtnCollection.address, 1n, sbtnItemCode);
            const addrB0 = calcSbtnItemAddress(ownerB, sbtnCollection.address, 0n, sbtnItemCode);
            expect(addrA0.equals(addrA0Again)).toBe(true);
            expect(addrA0.equals(addrA1)).toBe(false);
            expect(addrA0.equals(addrB0)).toBe(false);
        });
    });

    // StateInit data cell for an inert (active=false) item, mirroring calcSbtnItemAddress's layout.
    const buildInertItemData = (ownerAddress: Address, index: bigint) =>
        beginCell()
            .storeUint(index, 256)
            .storeAddress(sbtnCollection.address)
            .storeAddress(ownerAddress)
            .storeBit(false) // active
            .storeUint(0, 64) // revokedAt
            .storeRef(beginCell().endCell()) // individualContent
            .endCell();

    describe('sbtn_init access control (security boundary, SBTN_02 §3.1)', () => {
        it('second sbtn_init to an already-active item is rejected (already initialized)', async () => {
            // Drive through the real collection so the sender genuinely IS the collection:
            // a repeat DeploySbtn for the same (owner, index) re-sends sbtn_init to the same address.
            const ownerA = randomAddress();
            await sbtnCollection.sendDeploySbtn(owner.getSender(), {
                ownerAddress: ownerA,
                index: 0n,
                value: toNano('0.1'),
                attachTonAmount: toNano('0.05'),
                individualContent: beginCell().endCell(),
            });
            const addr = await sbtnCollection.getSbtnAddress(ownerA, 0);
            const sbtnItem = blockchain.openContract(SBTNItem.createFromAddress(addr));
            expect((await sbtnItem.getNftData()).init).toBe(true);

            const result = await sbtnCollection.sendDeploySbtn(owner.getSender(), {
                ownerAddress: ownerA,
                index: 0n,
                value: toNano('0.1'),
                attachTonAmount: toNano('0.05'),
                individualContent: beginCell().endCell(),
            });
            // The collection -> item sbtn_init is rejected because the item is already active.
            expect(result.transactions).toHaveTransaction({
                from: sbtnCollection.address,
                to: sbtnItem.address,
                op: Op.SbtnInit,
                success: false,
                exitCode: ERROR_ALREADY_INITIALIZED,
            });
            expect((await sbtnItem.getNftData()).init).toBe(true);
        });

        it('sbtn_init from a non-collection sender is rejected (960) and the item stays inert', async () => {
            const ownerA = randomAddress();
            const attacker = await blockchain.treasury('attacker');
            const addr = calcSbtnItemAddress(ownerA, sbtnCollection.address, 0n, sbtnItemCode);
            const sbtnItem = blockchain.openContract(SBTNItem.createFromAddress(addr));

            // Deploy the item inert (empty body hits the contract's else-branch: no opcode, no throw, active=false).
            await attacker.send({
                to: addr,
                value: toNano('0.1'),
                init: { code: sbtnItemCode, data: buildInertItemData(ownerA, 0n) },
                body: beginCell().endCell(),
            });
            expect((await sbtnItem.getNftData()).init).toBe(false);

            // Attacker tries to activate it with attacker-chosen content -> must be rejected (960).
            const result = await attacker.send({
                to: addr,
                value: toNano('0.1'),
                body: buildSbtnInitBody({ individualContent: beginCell().storeUint(0xdead, 16).endCell() }),
            });
            expect(result.transactions).toHaveTransaction({
                from: attacker.address,
                to: addr,
                op: Op.SbtnInit,
                success: false,
                exitCode: ERROR_NOT_FROM_COLLECTION,
            });
            // Still inert: the spoof did not flip active.
            expect((await sbtnItem.getNftData()).init).toBe(false);
        });
    });

    describe('destroy retains the storage reserve (SBTN_02 §5.1)', () => {
        it('after destroy the item keeps >= MIN_TONS_FOR_STORAGE and owner gets Excesses', async () => {
            const ownerA = await blockchain.treasury('ownerA');
            await sbtnCollection.sendDeploySbtn(owner.getSender(), {
                ownerAddress: ownerA.address,
                index: 0n,
                value: toNano('0.1'),
                attachTonAmount: toNano('0.1'),
                individualContent: beginCell().endCell(),
            });
            const addr = await sbtnCollection.getSbtnAddress(ownerA.address, 0);
            const sbtnItem = blockchain.openContract(SBTNItem.createFromAddress(addr));
            expect((await sbtnItem.getNftData()).init).toBe(true);

            const result = await sbtnItem.sendDestroy(ownerA.getSender(), {
                value: toNano('0.1'),
                queryId: 99,
            });
            expect(result.transactions).toHaveTransaction({
                from: sbtnItem.address,
                to: ownerA.address,
                op: Op.Excesses,
                success: true,
            });
            // Reserve retained: account balance not drained below storage tax.
            const balance = (await blockchain.getContract(addr)).balance;
            expect(balance).toBeGreaterThanOrEqual(toNano('0.05'));
        });
    });

    describe('get_sbtn_item_code', () => {
        it('returns code equal to compiled SBTNItem', async () => {
            const codeFromCollection = await sbtnCollection.getSbtnItemCode();
            expect(codeFromCollection.equals(sbtnItemCode)).toBe(true);
        });
    });

    describe('get_collection_data', () => {
        it('returns next_item_index, collection content, admin', async () => {
            const data = await sbtnCollection.getCollectionData();
            expect(data.nextItemIndex).toBe(0n);
            expect(data.adminAddress).toEqualAddress(owner.address);
        });

        it('next_item_index advances after minting new type id', async () => {
            const ownerA = randomAddress();
            await sbtnCollection.sendDeploySbtn(owner.getSender(), {
                ownerAddress: ownerA,
                index: 0n,
                value: toNano('0.1'),
                attachTonAmount: toNano('0.05'),
                individualContent: beginCell().endCell(),
            });
            const dataAfter = await sbtnCollection.getCollectionData();
            expect(dataAfter.nextItemIndex).toBe(1n);
        });
    });
});
