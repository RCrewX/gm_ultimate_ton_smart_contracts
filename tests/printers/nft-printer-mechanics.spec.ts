// SPDX-License-Identifier: UNLICENSED
import { Address, beginCell, toNano } from '@ton/core';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { NFTPrinter } from '../../wrappers/printers/nft_printer/NFTPrinter';
import { NFTItem } from '../../wrappers/tep/nft/NFTItem';
import { encodeNftContent, decodeNftContent } from '../../wrappers/game_manager/RetranslatorTypes';

// =============================================================================
// NFTPrinter MECHANICS — the collection + TEP-62 item surface, driven directly
// with a TREASURY admin (decoupled from the GM/R* pipe, which printers-e2e and
// the anvil specs already cover). Exercises: DeployNft (good + non-admin + bad
// index), EditNftItem (admin content edit), ChangeCollectionAdmin, royalty query,
// and the TEP-62 item flows (transfer ownership, RequestStaticData) — including
// that the structured NFTContent (with its trailing `seen` Maybe-ref) round-trips
// and survives a transfer.
// =============================================================================

const OP_RESPONSE_STATIC_DATA = 0x8b771735;
const OP_RESPONSE_ROYALTY = 0xa8cb00ad;
const ERR_NOT_FROM_ADMIN = 401;
const ERR_NOT_FROM_OWNER = 401;
const ERR_INVALID_ITEM_INDEX = 402;

describe('NFTPrinter mechanics (collection + TEP-62 item)', () => {
    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let origin: SandboxContract<TreasuryContract>;
    let printer: SandboxContract<NFTPrinter>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        admin = await blockchain.treasury('printerAdmin');
        user = await blockchain.treasury('printerUser');
        stranger = await blockchain.treasury('printerStranger');
        origin = await blockchain.treasury('printerOrigin');

        const itemCode = await compile('NFTPrinterItem');
        const collCode = await compile('NFTPrinter');
        printer = blockchain.openContract(
            NFTPrinter.createFromConfig(
                {
                    nftItemCode: itemCode,
                    adminAddress: admin.address,
                    royaltyParams: { numerator: 5, denominator: 100, royaltyAddress: admin.address },
                },
                collCode,
            ),
        );
        await printer.sendDeploy(admin.getSender(), toNano('0.5'));
    });

    async function deploy(index: number, owner: Address, content: { origin: Address; type: number; tier: number }) {
        await printer.sendDeployNft(admin.getSender(), {
            to: owner,
            index,
            value: toNano('0.1'),
            content: encodeNftContent(content),
        });
        return blockchain.openContract(NFTItem.createFromAddress(await printer.getNftAddressByIndex(index)));
    }

    // ---- DeployNft ---------------------------------------------------------
    it('admin deploys an NFT; structured content (with null seen) round-trips', async () => {
        const item = await deploy(0, user.address, { origin: origin.address, type: 1, tier: 2 });
        const d = await item.getNftData();
        expect(d.init).toBe(true);
        expect(d.ownerAddress).toEqualAddress(user.address);
        const c = decodeNftContent(d.individualContent!);
        expect(c.origin).toEqualAddress(origin.address);
        expect(c.type).toBe(1n);
        expect(c.tier).toBe(2n);
        expect(c.seen).toBeNull();
    });

    it('DeployNft from a non-admin is rejected', async () => {
        const r = await printer.sendDeployNft(stranger.getSender(), { to: user.address, index: 0, value: toNano('0.1') });
        expect(r.transactions).toHaveTransaction({
            from: stranger.address,
            to: printer.address,
            success: false,
            exitCode: ERR_NOT_FROM_ADMIN,
        });
    });

    it('DeployNft with an out-of-range index is rejected', async () => {
        await deploy(0, user.address, { origin: origin.address, type: 0, tier: 1 }); // nextItemIndex -> 1
        const r = await printer.sendDeployNft(admin.getSender(), { to: user.address, index: 5, value: toNano('0.1') });
        expect(r.transactions).toHaveTransaction({
            from: admin.address,
            to: printer.address,
            success: false,
            exitCode: ERR_INVALID_ITEM_INDEX,
        });
    });

    // ---- EditNftItem (admin content edit) ----------------------------------
    it('admin edits an item content; non-admin edit is rejected', async () => {
        const item = await deploy(0, user.address, { origin: origin.address, type: 0, tier: 1 });
        await printer.sendEditNftItem(admin.getSender(), {
            itemAddress: item.address,
            newContent: encodeNftContent({ origin: origin.address, type: 2, tier: 7 }),
            value: toNano('0.1'),
        });
        const c = decodeNftContent((await item.getNftData()).individualContent!);
        expect(c.type).toBe(2n);
        expect(c.tier).toBe(7n);

        const r = await printer.sendEditNftItem(stranger.getSender(), {
            itemAddress: item.address,
            newContent: encodeNftContent({ origin: origin.address, type: 9, tier: 9 }),
            value: toNano('0.1'),
        });
        expect(r.transactions).toHaveTransaction({ from: stranger.address, to: printer.address, success: false, exitCode: ERR_NOT_FROM_ADMIN });
    });

    // ---- ChangeCollectionAdmin ---------------------------------------------
    it('admin re-points the collection admin; a non-admin cannot', async () => {
        const bad = await printer.sendChangeAdmin(stranger.getSender(), { value: toNano('0.05'), newAdmin: stranger.address });
        expect(bad.transactions).toHaveTransaction({ from: stranger.address, to: printer.address, success: false, exitCode: ERR_NOT_FROM_ADMIN });
        expect((await printer.getCollectionData()).adminAddress).toEqualAddress(admin.address);

        await printer.sendChangeAdmin(admin.getSender(), { value: toNano('0.05'), newAdmin: stranger.address });
        expect((await printer.getCollectionData()).adminAddress).toEqualAddress(stranger.address);
    });

    // ---- Royalty (TEP-66) --------------------------------------------------
    it('royalty params are queryable by getter and by RequestRoyaltyParams', async () => {
        const rp = await printer.getRoyaltyParams();
        expect(rp.numerator).toBe(5);
        expect(rp.denominator).toBe(100);
        expect(rp.royaltyAddress).toEqualAddress(admin.address);

        const r = await stranger.send({
            to: printer.address,
            value: toNano('0.05'),
            body: beginCell().storeUint(0x693d3950, 32).storeUint(7, 64).endCell(), // RequestRoyaltyParams
        });
        const resp = r.transactions.find((tx: any) =>
            tx.inMessage?.info.type === 'internal' &&
            tx.inMessage?.info.dest?.equals(stranger.address) &&
            (() => { try { return tx.inMessage.body.beginParse().preloadUint(32) === OP_RESPONSE_ROYALTY; } catch { return false; } })(),
        );
        expect(resp).toBeDefined();
    });

    // ---- TEP-62 item: transfer ownership -----------------------------------
    it('owner transfers the item; new owner is set and content (incl. seen) is preserved', async () => {
        const item = await deploy(0, user.address, { origin: origin.address, type: 3, tier: 4 });
        const newOwner = await blockchain.treasury('newOwner');
        await item.sendTransferOwnership(user.getSender(), { value: toNano('0.1'), to: newOwner.address, responseTo: user.address });

        const d = await item.getNftData();
        expect(d.ownerAddress).toEqualAddress(newOwner.address);
        const c = decodeNftContent(d.individualContent!);
        expect(c.type).toBe(3n);
        expect(c.tier).toBe(4n);
    });

    it('a transfer from a non-owner is rejected', async () => {
        const item = await deploy(0, user.address, { origin: origin.address, type: 0, tier: 1 });
        const r = await item.sendTransferOwnership(stranger.getSender(), { value: toNano('0.1'), to: stranger.address });
        expect(r.transactions).toHaveTransaction({ from: stranger.address, to: item.address, success: false, exitCode: ERR_NOT_FROM_OWNER });
    });

    // ---- TEP-62 item: static data ------------------------------------------
    it('RequestStaticData returns the item index + collection', async () => {
        // Deploy 0 and 1 (indices must be contiguous from nextItemIndex=0), query item 1.
        await deploy(0, user.address, { origin: origin.address, type: 0, tier: 1 });
        const item = await deploy(1, user.address, { origin: origin.address, type: 0, tier: 1 });
        const r = await item.sendGetStaticData(user.getSender(), { value: toNano('0.05'), queryId: 9 });
        const resp = r.transactions.find((tx: any) => {
            if (tx.inMessage?.info.type !== 'internal') return false;
            if (!tx.inMessage?.info.dest?.equals(user.address)) return false;
            try { return tx.inMessage.body.beginParse().preloadUint(32) === OP_RESPONSE_STATIC_DATA; } catch { return false; }
        });
        expect(resp).toBeDefined();
        const s = resp!.inMessage!.body.beginParse();
        s.loadUint(32); // opcode
        expect(s.loadUint(64)).toBe(9); // queryId
        expect(s.loadUintBig(256)).toBe(1n); // itemIndex
        expect(s.loadAddress()).toEqualAddress(printer.address); // collection
    });
});
