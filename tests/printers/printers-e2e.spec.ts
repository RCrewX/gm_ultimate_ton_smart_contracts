// SPDX-License-Identifier: UNLICENSED
import { beginCell, toNano, Address, Cell } from '@ton/core';
import { SandboxContract } from '@ton/sandbox';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { GAS_COST_REDIRECT_MESSAGE } from '../../wrappers/game_manager/types';
import { Retranslator } from '../../wrappers/game_manager/Retranslator';
import { ROpcodes } from '../../wrappers/game_manager/RetranslatorTypes';
import { NFTPrinter, NFTPrinterOp } from '../../wrappers/printers/nft_printer/NFTPrinter';
import {
    UniversalBlockchainPassportPrinter,
    UniversalBlockchainPassport,
    PassportOp,
    buildCoreContent,
    buildCoreSystemUpdate,
} from '../../wrappers/printers/universal_passport/UniversalBlockchainPassportPrinter';
import { NFTItem } from '../../wrappers/tep/nft/NFTItem';
import {
    encodeNftContent,
    decodeNftContent,
} from '../../wrappers/game_manager/RetranslatorTypes';

// =============================================================================
// NFTPrinter + UniversalBlockchainPassportPrinter e2e through the GM/R* pipe.
//   R1{recipe} -> GM -R2-> R* (validate recipe + assign index) -R3-> GM -R4->
//   printer (sender == admin == GM) -> item.
// Plus the recipe-auth and authority gates.
// =============================================================================

const R3_OP = 0x52330003;

type PrinterSystem = ContractSystem & {
    nftPrinter: SandboxContract<NFTPrinter>;
    passportPrinter: SandboxContract<UniversalBlockchainPassportPrinter>;
    nftItemCode: Cell;
    passportItemCode: Cell;
};

describe('NFT/SBT Printers (GM-owned, R*-governed)', () => {
    let S: PrinterSystem;

    beforeEach(async () => {
        const base = await initContractSystem();

        // The printers use their own editable item variants (standard item +
        // collection-gated SetContent edit handler; storage layout identical).
        const nftItemCode = await compile('NFTPrinterItem');
        const passportItemCode = await compile('UniversalBlockchainPassport');
        const nftCollectionCode = await compile('NFTPrinter');
        const sbtCollectionCode = await compile('UniversalBlockchainPassportPrinter');

        // Deploy the two printer collections with adminAddress = GameManager.
        const nftPrinter = base.blockchain.openContract(
            NFTPrinter.createFromConfig(
                {
                    nftItemCode,
                    adminAddress: base.gameManager.address,
                    royaltyParams: { numerator: 5, denominator: 100, royaltyAddress: base.ownerAccount.address },
                },
                nftCollectionCode,
            ),
        );
        let r = await nftPrinter.sendDeploy(base.ownerAccount.getSender(), toNano('0.5'));

        const passportPrinter = base.blockchain.openContract(
            UniversalBlockchainPassportPrinter.createFromConfig(
                {
                    passportItemCode,
                    adminAddress: base.gameManager.address,
                },
                sbtCollectionCode,
            ),
        );
        await passportPrinter.sendDeploy(base.ownerAccount.getSender(), toNano('0.5'));

        // Push the printer addresses into R*.toolsInfo via GM RedirectMessage -> SetToolsInfo.
        await base.gameManager.sendRedirectMessage(
            base.ownerAccount.getSender(),
            toNano('0.3'),
            base.retranslator.address,
            Retranslator.setToolsInfoMessage({
                feeNumerator: 0,
                feeDenominator: 1,
                feeCollector: null,
                nftPrinterAddress: nftPrinter.address,
                passportPrinterAddress: passportPrinter.address,
                extra: null,
            }),
            toNano('0.2'),
        );

        S = Object.assign(base, { nftPrinter, passportPrinter, nftItemCode, passportItemCode });
    }, 100000);

    afterEach(() => {
        cleanupContractSystem(S);
        S = null as any;
    });

    // -------------------------------------------------------------------------
    // Happy paths
    // -------------------------------------------------------------------------

    it('toolsInfo carries both printer addresses', async () => {
        const tools = await S.retranslator.getToolsInfo();
        expect(tools).not.toBeNull();
        const s = tools!.beginParse();
        s.loadUint(16); // feeNumerator
        s.loadUint(16); // feeDenominator
        s.loadAddressAny(); // feeCollector (null -> addr_none); skip
        const nftAddr = s.loadAddress();
        const sbtAddr = s.loadAddress();
        expect(nftAddr).toEqualAddress(S.nftPrinter.address);
        expect(sbtAddr).toEqualAddress(S.passportPrinter.address);
    });

    it('mint NFT (owner initiator): R1->R4 deploys an item to the receiver', async () => {
        const receiver = await S.blockchain.treasury('nftReceiver');
        const content = encodeNftContent({ origin: S.ownerAccount.address, type: 7, tier: 3 });

        expect(await S.retranslator.getNextNftIndex()).toBe(0n);

        S.messageResult = await S.gameManager.sendMintNft(
            S.ownerAccount.getSender(),
            toNano('1'),
            receiver.address,
            content,
        );

        // R* replied R3 to GM.
        expect(S.messageResult.transactions).toHaveTransaction({
            from: S.retranslator.address,
            to: S.gameManager.address,
            success: true,
            op: R3_OP,
        });
        // GM emitted DeployNft (R4) to the NFTPrinter collection.
        expect(S.messageResult.transactions).toHaveTransaction({
            from: S.gameManager.address,
            to: S.nftPrinter.address,
            success: true,
            op: NFTPrinterOp.DeployNft,
        });

        // Index advanced on R*.
        expect(await S.retranslator.getNextNftIndex()).toBe(1n);

        // The item was deployed & initialized to the receiver at index 0.
        const itemAddr = await S.nftPrinter.getNftAddressByIndex(0);
        expect(S.messageResult.transactions).toHaveTransaction({
            from: S.nftPrinter.address,
            to: itemAddr,
            success: true,
            deploy: true,
        });
        const item = S.blockchain.openContract(NFTItem.createFromAddress(itemAddr));
        const data = await item.getNftData();
        expect(data.init).toBe(true);
        expect(data.index).toBe(0n);
        expect(data.ownerAddress).toEqualAddress(receiver.address);
        expect(data.collectionAddress).toEqualAddress(S.nftPrinter.address);
        // Structured content {origin, type, tier} round-trips through the item.
        const nftContent = decodeNftContent(data.individualContent!);
        expect(nftContent.origin).toEqualAddress(S.ownerAccount.address);
        expect(nftContent.type).toBe(7n);
        expect(nftContent.tier).toBe(3n);
    });

    it('mint SBT (owner initiator): deploys a soulbound item to the receiver', async () => {
        const receiver = await S.blockchain.treasury('sbtReceiver');
        const content = buildCoreContent(42, 'dragon'); // id=0 CORE: reputation + nickname

        expect(await S.retranslator.getNextSbtIndex()).toBe(0n);

        S.messageResult = await S.gameManager.sendMintSbt(
            S.ownerAccount.getSender(),
            toNano('1'),
            receiver.address,
            content,
        );

        expect(S.messageResult.transactions).toHaveTransaction({
            from: S.gameManager.address,
            to: S.passportPrinter.address,
            success: true,
            op: PassportOp.PassportDeploy,
        });
        expect(await S.retranslator.getNextSbtIndex()).toBe(1n);

        const itemAddr = await S.passportPrinter.getPassportAddress(receiver.address, 0);
        expect(S.messageResult.transactions).toHaveTransaction({
            from: S.passportPrinter.address,
            to: itemAddr,
            success: true,
            deploy: true,
        });
        const item = S.blockchain.openContract(UniversalBlockchainPassport.createFromAddress(itemAddr));
        const data = await item.getNftData();
        expect(data.isInitialized).toBe(true);
        expect(data.ownerAddress).toEqualAddress(receiver.address);
        expect(data.revokedAt).toBe(0n);
        // Typed per-id CORE content {reputation, nickname} round-trips through the item.
        const core = await item.getPassportCore();
        expect(core.reputation).toBe(42n);
        expect(core.nickname).toBe('dragon');
        expect(await item.getReputation()).toBe(42n);
    });

    it('mint NFT (registered active game initiator) is allowed', async () => {
        // Register a treasury as the active game so we can send the R1 from it.
        const gameTreasury = await S.blockchain.treasury('gameTreasury');
        await S.gameManager.sendRedirectMessage(
            S.ownerAccount.getSender(),
            toNano('1'),
            S.retranslator.address,
            // Register the treasury in the ton_race_game reward slot and make it active.
            Retranslator.setGamesInfoMessage({
                active_game: gameTreasury.address,
                ssm: null,
                ton_race_game: gameTreasury.address,
                ubps: null,
            }),
            toNano('0.9'),
        );

        const receiver = await S.blockchain.treasury('gameNftReceiver');
        const content = encodeNftContent({ origin: gameTreasury.address, type: 1, tier: 1 });
        S.messageResult = await S.gameManager.sendMintNft(
            gameTreasury.getSender(),
            toNano('1'),
            receiver.address,
            content,
        );
        expect(S.messageResult.transactions).toHaveTransaction({
            from: S.gameManager.address,
            to: S.nftPrinter.address,
            success: true,
            op: NFTPrinterOp.DeployNft,
        });
    });

    it('mint SBT by a registered game is REJECTED (SBT create is owner/GM-only)', async () => {
        // Register a treasury as the active game.
        const gameTreasury = await S.blockchain.treasury('sbtGameTreasury');
        await S.gameManager.sendRedirectMessage(
            S.ownerAccount.getSender(),
            toNano('1'),
            S.retranslator.address,
            // Register the treasury in the ton_race_game reward slot and make it active.
            Retranslator.setGamesInfoMessage({
                active_game: gameTreasury.address,
                ssm: null,
                ton_race_game: gameTreasury.address,
                ubps: null,
            }),
            toNano('0.9'),
        );

        const receiver = await S.blockchain.treasury('sbtGameReceiver');
        const content = buildCoreContent(0, 'forbidden');
        S.messageResult = await S.gameManager.sendMintSbt(
            gameTreasury.getSender(),
            toNano('1'),
            receiver.address,
            content,
        );
        // R* rejects: only the owner may mint SBTs.
        expect(S.messageResult.transactions).toHaveTransaction({
            from: S.gameManager.address,
            to: S.retranslator.address,
            success: false,
            exitCode: 920, // ERR_INVALID_OWNER_SENDER
        });
        expect(await S.retranslator.getNextSbtIndex()).toBe(0n); // unchanged
    });

    it('revoke SBT (owner): R* forwards revoke; item is revoked', async () => {
        const receiver = await S.blockchain.treasury('sbtToRevoke');
        const content = buildCoreContent(0, 'to-revoke');
        await S.gameManager.sendMintSbt(S.ownerAccount.getSender(), toNano('1'), receiver.address, content);

        const itemAddr = await S.passportPrinter.getPassportAddress(receiver.address, 0);
        const item = S.blockchain.openContract(UniversalBlockchainPassport.createFromAddress(itemAddr));
        expect((await item.getNftData()).revokedAt).toBe(0n);

        S.messageResult = await S.gameManager.sendRevokeSbt(
            S.ownerAccount.getSender(),
            toNano('0.5'),
            itemAddr,
        );
        expect(S.messageResult.transactions).toHaveTransaction({
            from: S.gameManager.address,
            to: S.passportPrinter.address,
            success: true,
            op: PassportOp.RevokePassportItem,
        });
        expect(S.messageResult.transactions).toHaveTransaction({
            from: S.passportPrinter.address,
            to: itemAddr,
            success: true,
        });
        expect((await item.getNftData()).revokedAt).toBeGreaterThan(0n);
    });

    // -------------------------------------------------------------------------
    // Recipe-auth + authority gates
    // -------------------------------------------------------------------------

    it('mint by a non-allowed initiator is rejected by R*', async () => {
        const stranger = await S.blockchain.treasury('stranger');
        const content = encodeNftContent({ origin: stranger.address, type: 0, tier: 0 });
        S.messageResult = await S.gameManager.sendMintNft(
            stranger.getSender(),
            toNano('1'), // >= 0.2 so R* does the full game walk, then ERR_GAME_NOT_FOUND
            (await S.blockchain.treasury('r')).address,
            content,
        );
        expect(S.messageResult.transactions).toHaveTransaction({
            from: S.gameManager.address,
            to: S.retranslator.address,
            success: false,
            exitCode: 930, // ERR_GAME_NOT_FOUND
        });
        expect(await S.retranslator.getNextNftIndex()).toBe(0n); // unchanged
    });

    it('revoke by a non-owner is rejected by R*', async () => {
        const nonOwner = await S.blockchain.treasury('nonOwnerRevoke');
        const someItem = await S.blockchain.treasury('someItem');
        S.messageResult = await S.gameManager.sendRevokeSbt(
            nonOwner.getSender(),
            toNano('0.5'),
            someItem.address,
        );
        expect(S.messageResult.transactions).toHaveTransaction({
            from: S.gameManager.address,
            to: S.retranslator.address,
            success: false,
            exitCode: 920, // ERR_INVALID_OWNER_SENDER
        });
    });

    it('an R3 not from R* is rejected at GM', async () => {
        const notR = await S.blockchain.treasury('notRetranslator');
        // Hand-craft an R3 and send it from a non-R* address.
        const r3 = beginCell()
            .storeUint(R3_OP, 32)
            .storeAddress(S.nftPrinter.address)
            .storeRef(beginCell().endCell())
            .endCell();
        S.messageResult = await notR.send({
            to: S.gameManager.address,
            value: toNano('0.3'),
            body: r3,
        });
        expect(S.messageResult.transactions).toHaveTransaction({
            from: notR.address,
            to: S.gameManager.address,
            success: false,
            exitCode: 932, // ERR_INVALID_RETRANSLATOR_SENDER
        });
    });

    it('a direct DeployNft not from GM is rejected by the NFTPrinter', async () => {
        const stranger = await S.blockchain.treasury('strangerNft');
        const receiver = await S.blockchain.treasury('directReceiver');
        S.messageResult = await S.nftPrinter.sendDeployNft(stranger.getSender(), {
            to: receiver.address,
            index: 0,
            value: toNano('0.3'),
            attachTonAmount: toNano('0.05'),
        });
        expect(S.messageResult.transactions).toHaveTransaction({
            from: stranger.address,
            to: S.nftPrinter.address,
            success: false,
            exitCode: 401, // ERROR_NOT_FROM_ADMIN (tep/nft legacy code)
        });
    });

    it('a direct DeploySbtn not from GM is rejected by the UniversalBlockchainPassportPrinter', async () => {
        const stranger = await S.blockchain.treasury('strangerSbt');
        const receiver = await S.blockchain.treasury('directSbtReceiver');
        S.messageResult = await S.passportPrinter.sendPassportDeploy(stranger.getSender(), {
            ownerAddress: receiver.address,
            index: 0,
            value: toNano('0.3'),
            attachTonAmount: toNano('0.05'),
        });
        expect(S.messageResult.transactions).toHaveTransaction({
            from: stranger.address,
            to: S.passportPrinter.address,
            success: false,
            exitCode: 968, // ERROR_NOT_FROM_ADMIN (tep/sbtn)
        });
    });

    // -------------------------------------------------------------------------
    // ⚒ ANVIL — content editing (owner/GM edits everything; opaque cell through R*)
    // -------------------------------------------------------------------------

    it('ANVIL: owner edits an NFT item content end-to-end', async () => {
        const receiver = await S.blockchain.treasury('nftEditRcv');
        const content = encodeNftContent({ origin: S.ownerAccount.address, type: 1, tier: 1 });
        await S.gameManager.sendMintNft(S.ownerAccount.getSender(), toNano('1'), receiver.address, content);
        const itemAddr = await S.nftPrinter.getNftAddressByIndex(0);

        const newContent = encodeNftContent({ origin: receiver.address, type: 9, tier: 5 });
        S.messageResult = await S.gameManager.sendEditNft(
            S.ownerAccount.getSender(),
            toNano('0.5'),
            itemAddr,
            newContent,
        );

        // GM emitted EditNftItem (R4) to the NFTPrinter collection.
        expect(S.messageResult.transactions).toHaveTransaction({
            from: S.gameManager.address,
            to: S.nftPrinter.address,
            success: true,
            op: NFTPrinterOp.EditNftItem,
        });
        // Collection forwarded SetNftContent to the item.
        expect(S.messageResult.transactions).toHaveTransaction({
            from: S.nftPrinter.address,
            to: itemAddr,
            success: true,
            op: NFTPrinterOp.SetNftContent,
        });
        // The item's content is now the new structured value.
        const item = S.blockchain.openContract(NFTItem.createFromAddress(itemAddr));
        const parsed = decodeNftContent((await item.getNftData()).individualContent!);
        expect(parsed.origin).toEqualAddress(receiver.address);
        expect(parsed.type).toBe(9n);
        expect(parsed.tier).toBe(5n);
    });

    it('ANVIL: owner edits an SBT item content end-to-end', async () => {
        const receiver = await S.blockchain.treasury('sbtEditRcv');
        const content = buildCoreContent(1, 'keep-me'); // reputation 1 (system) + nickname (owner)
        await S.gameManager.sendMintSbt(S.ownerAccount.getSender(), toNano('1'), receiver.address, content);
        const itemAddr = await S.passportPrinter.getPassportAddress(receiver.address, 0);

        const newContent = buildCoreSystemUpdate(7); // SYSTEM edit: set reputation=7 (merge keeps nickname)
        S.messageResult = await S.gameManager.sendEditSbt(
            S.ownerAccount.getSender(),
            toNano('0.5'),
            itemAddr,
            newContent,
        );

        expect(S.messageResult.transactions).toHaveTransaction({
            from: S.gameManager.address,
            to: S.passportPrinter.address,
            success: true,
            op: PassportOp.EditPassportItem,
        });
        expect(S.messageResult.transactions).toHaveTransaction({
            from: S.passportPrinter.address,
            to: itemAddr,
            success: true,
            op: PassportOp.SetPassportSystemContent,
        });
        const item = S.blockchain.openContract(UniversalBlockchainPassport.createFromAddress(itemAddr));
        // SYSTEM edit updated reputation; the owner's nickname is PRESERVED (per-field merge).
        const core = await item.getPassportCore();
        expect(core.reputation).toBe(7n);
        expect(core.nickname).toBe('keep-me');
    });

    it('ANVIL: edit by a non-owner is rejected by R*', async () => {
        const nonOwner = await S.blockchain.treasury('nonOwnerEdit');
        const someItem = await S.blockchain.treasury('someEditItem');
        const newContent = encodeNftContent({ origin: nonOwner.address, type: 1, tier: 1 });
        S.messageResult = await S.gameManager.sendEditNft(
            nonOwner.getSender(),
            toNano('0.5'),
            someItem.address,
            newContent,
        );
        expect(S.messageResult.transactions).toHaveTransaction({
            from: S.gameManager.address,
            to: S.retranslator.address,
            success: false,
            exitCode: 920, // ERR_INVALID_OWNER_SENDER
        });
    });

    it('a direct EditNftItem not from GM is rejected by the NFTPrinter', async () => {
        const stranger = await S.blockchain.treasury('strangerEdit');
        const someItem = await S.blockchain.treasury('someItemEdit');
        S.messageResult = await S.nftPrinter.sendEditNftItem(stranger.getSender(), {
            itemAddress: someItem.address,
            newContent: encodeNftContent({ origin: stranger.address, type: 0, tier: 0 }),
            value: toNano('0.3'),
        });
        expect(S.messageResult.transactions).toHaveTransaction({
            from: stranger.address,
            to: S.nftPrinter.address,
            success: false,
            exitCode: 401, // ERROR_NOT_FROM_ADMIN
        });
    });
});
