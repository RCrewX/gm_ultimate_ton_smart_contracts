// SPDX-License-Identifier: UNLICENSED
// UniversalBlockchainPassport ITEM — the per-id typed content model + write-authority
// gates (LOCKED design §3.3/§3.4/§3.5/§3.9). Item-level tests: the collection authority
// is played by a treasury (the item gates SYSTEM writes against storage.collectionAddress),
// so these prove the on-chain rules without the full GM/R* pipe.
import { beginCell, toNano, Cell } from '@ton/core';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import {
    UniversalBlockchainPassport,
    PassportOp,
    buildCoreSystemUpdate,
    snakeCell,
} from '../../wrappers/printers/universal_passport/UniversalBlockchainPassportPrinter';

// errors.tolk
const ERR_NOT_FROM_COLLECTION = 960;
const ERR_NOT_FROM_OWNER = 962;
const ERR_NOT_INITIALIZED = 969;
const ERR_FIELD_NOT_OWNER_WRITABLE = 971;

function setSystemContentBody(reputation: bigint | number): Cell {
    return beginCell()
        .storeUint(PassportOp.SetPassportSystemContent, 32)
        .storeUint(0, 64)
        .storeRef(buildCoreSystemUpdate(reputation))
        .endCell();
}
function setNicknameBody(nickname: string): Cell {
    return beginCell()
        .storeUint(PassportOp.SetNickname, 32)
        .storeUint(0, 64)
        .storeRef(snakeCell(nickname))
        .endCell();
}

describe('UniversalBlockchainPassport item — typed content + write authority', () => {
    let blockchain: Blockchain;
    let itemCode: Cell;
    let collection: SandboxContract<TreasuryContract>; // plays the SYSTEM authority
    let owner: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;

    beforeAll(async () => { itemCode = await compile('UniversalBlockchainPassport'); });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        collection = await blockchain.treasury('collection');
        owner = await blockchain.treasury('owner');
        stranger = await blockchain.treasury('stranger');
    });

    // Owner self-deploys their own passport(id). Content starts zeroed-per-id.
    async function deployCore(index = 0) {
        const item = blockchain.openContract(
            UniversalBlockchainPassport.createFromConfig(
                { index, collectionAddress: collection.address, ownerAddress: owner.address },
                itemCode,
            ),
        );
        await item.sendOwnerInit(owner.getSender(), { value: toNano('0.1') });
        return item;
    }

    it('owner self-deploys (§3.3): active, EMPTY zeroed content (reputation 0, empty nickname)', async () => {
        const item = await deployCore(0);
        const data = await item.getNftData();
        expect(data.isInitialized).toBe(true);
        expect(data.ownerAddress).toEqualAddress(owner.address);
        expect(data.collectionAddress).toEqualAddress(collection.address);
        const core = await item.getPassportCore();
        expect(core.reputation).toBe(0n);
        expect(core.nickname).toBe('');
        expect(await item.getReputation()).toBe(0n);
    });

    it('owner can set nickname (owner-writable field); reputation untouched', async () => {
        const item = await deployCore(0);
        await item.sendSetNickname(owner.getSender(), { value: toNano('0.05'), nickname: 'neo' });
        const core = await item.getPassportCore();
        expect(core.nickname).toBe('neo');
        expect(core.reputation).toBe(0n);
    });

    it('SYSTEM reputation write only from the collection authority; reputation getter returns it', async () => {
        const item = await deployCore(0);
        // collection (== storage.collectionAddress) sets reputation
        const res = await collection.send({ to: item.address, value: toNano('0.05'), body: setSystemContentBody(99) });
        expect(res.transactions).toHaveTransaction({ from: collection.address, to: item.address, success: true });
        expect(await item.getReputation()).toBe(99n);
    });

    it('a NON-collection SYSTEM write is REJECTED (960 NOT_FROM_COLLECTION)', async () => {
        const item = await deployCore(0);
        const res = await stranger.send({ to: item.address, value: toNano('0.05'), body: setSystemContentBody(7) });
        expect(res.transactions).toHaveTransaction({ to: item.address, success: false, exitCode: ERR_NOT_FROM_COLLECTION });
        expect(await item.getReputation()).toBe(0n); // unchanged
    });

    it('a NON-owner nickname write is REJECTED (962 NOT_FROM_OWNER)', async () => {
        const item = await deployCore(0);
        const res = await stranger.send({ to: item.address, value: toNano('0.05'), body: setNicknameBody('hacker') });
        expect(res.transactions).toHaveTransaction({ to: item.address, success: false, exitCode: ERR_NOT_FROM_OWNER });
        expect((await item.getPassportCore()).nickname).toBe('');
    });

    it('per-field MERGE: a SYSTEM reputation write PRESERVES the owner nickname (and vice-versa)', async () => {
        const item = await deployCore(0);
        await item.sendSetNickname(owner.getSender(), { value: toNano('0.05'), nickname: 'keep-me' });
        await collection.send({ to: item.address, value: toNano('0.05'), body: setSystemContentBody(42) });
        let core = await item.getPassportCore();
        expect(core.reputation).toBe(42n);   // system field set
        expect(core.nickname).toBe('keep-me'); // owner field preserved
        // owner re-writes nickname; reputation preserved
        await item.sendSetNickname(owner.getSender(), { value: toNano('0.05'), nickname: 'trinity' });
        core = await item.getPassportCore();
        expect(core.reputation).toBe(42n);
        expect(core.nickname).toBe('trinity');
    });

    it('nickname is the ONLY owner-writable field: SetNickname on a non-core id is REJECTED (971)', async () => {
        const item = await deployCore(1); // id=1 ACTIVITY — system-only, no owner field
        const res = await owner.send({ to: item.address, value: toNano('0.05'), body: setNicknameBody('x') });
        expect(res.transactions).toHaveTransaction({ to: item.address, success: false, exitCode: ERR_FIELD_NOT_OWNER_WRITABLE });
    });

    it('ADDRESS STABLE across content edits (§3.9): content is not in the determinant', async () => {
        const item = await deployCore(0);
        const addrBefore = item.address;
        await item.sendSetNickname(owner.getSender(), { value: toNano('0.05'), nickname: 'morpheus' });
        await collection.send({ to: item.address, value: toNano('0.05'), body: setSystemContentBody(500) });
        // The content-free deterministic address still resolves to the SAME, now-content-full item.
        const recomputed = UniversalBlockchainPassport.createFromConfig(
            { index: 0, collectionAddress: collection.address, ownerAddress: owner.address },
            itemCode,
        ).address;
        expect(recomputed.equals(addrBefore)).toBe(true);
        const core = await item.getPassportCore();
        expect(core.reputation).toBe(500n);
        expect(core.nickname).toBe('morpheus');
        expect((await item.getNftData()).itemIndex).toBe(0n);
    });

    it('writes before init are rejected (969 NOT_INITIALIZED)', async () => {
        // Build the item but DO NOT self-deploy; a system write must hit the not-init guard.
        const item = blockchain.openContract(
            UniversalBlockchainPassport.createFromConfig(
                { index: 0, collectionAddress: collection.address, ownerAddress: owner.address },
                itemCode,
            ),
        );
        // First message carries the stateInit (account is created) but active=false → 969.
        const res = await collection.send({ to: item.address, value: toNano('0.05'), body: setSystemContentBody(1), init: item.init });
        expect(res.transactions).toHaveTransaction({ to: item.address, success: false, exitCode: ERR_NOT_INITIALIZED });
    });
});
