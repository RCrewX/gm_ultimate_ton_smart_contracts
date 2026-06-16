// SPDX-License-Identifier: UNLICENSED
import { beginCell, Cell, toNano } from '@ton/core';
import { SandboxContract } from '@ton/sandbox';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { ContractSystem, initContractSystem, cleanupContractSystem } from '../test_utils';
import { Retranslator } from '../../wrappers/game_manager/Retranslator';
import {
    encodeNftContent,
    encodeSbtContent,
    encodeSetJettonInfo,
    encodeSetGamesInfo,
    encodeSetToolsInfo,
    encodeSetAllowBurn,
    snakeString,
} from '../../wrappers/game_manager/RetranslatorTypes';
import { Opcodes as GMOpcodes } from '../../wrappers/game_manager/types';
import { NFTPrinter, NFTPrinterOp } from '../../wrappers/printers/nft_printer/NFTPrinter';
import { SBTPrinter } from '../../wrappers/printers/sbt_printer/SBTPrinter';

// =============================================================================
// Retranslator (R*) HOT-SWAP — prove the swappable-brain promise: deploy R* vN+1
// with migrated state, seed its registries via GM, repoint GM atomically, verify
// continuity (esp. mint-index), and leave the old R* inert — all WITHOUT touching
// GM / games / printers / minter.  Refs plan §6.2 (a)-(f).
// =============================================================================

const R3_OP = GMOpcodes.OP_R3; // 0x52330003
const ERR_INVALID_RETRANSLATOR_SENDER = 932;

type PrinterSystem = ContractSystem & {
    nftPrinter: SandboxContract<NFTPrinter>;
    sbtPrinter: SandboxContract<SBTPrinter>;
};

describe('Retranslator R* hot-swap (no GM redeploy)', () => {
    let S: PrinterSystem;
    let retranslatorCode: Cell;

    beforeEach(async () => {
        const base = await initContractSystem();
        retranslatorCode = base.retranslatorCode;

        const nftItemCode = await compile('NFTPrinterItem');
        const sbtnItemCode = await compile('SBTPrinterItem');
        const nftCollectionCode = await compile('NFTPrinter');
        const sbtCollectionCode = await compile('SBTPrinter');

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
        await nftPrinter.sendDeploy(base.ownerAccount.getSender(), toNano('0.5'));

        const sbtPrinter = base.blockchain.openContract(
            SBTPrinter.createFromConfig({ sbtnItemCode, adminAddress: base.gameManager.address }, sbtCollectionCode),
        );
        await sbtPrinter.sendDeploy(base.ownerAccount.getSender(), toNano('0.5'));

        // Seed printer addresses into R*.toolsInfo (GM relay -> SetToolsInfo).
        await base.gameManager.sendRedirectMessage(
            base.ownerAccount.getSender(),
            toNano('0.3'),
            base.retranslator.address,
            Retranslator.setToolsInfoMessage({
                feeNumerator: 0,
                feeDenominator: 1,
                feeCollector: null,
                nftPrinterAddress: nftPrinter.address,
                sbtPrinterAddress: sbtPrinter.address,
                extra: null,
            }),
            toNano('0.2'),
        );

        S = Object.assign(base, { nftPrinter, sbtPrinter });
    }, 120000);

    afterEach(() => {
        cleanupContractSystem(S);
        S = null as any;
    });

    async function mintNft(receiver = S.ownerAccount.address) {
        return S.gameManager.sendMintNft(
            S.ownerAccount.getSender(),
            toNano('1'),
            receiver,
            encodeNftContent({ origin: S.ownerAccount.address, type: 1, tier: 1 }),
        );
    }
    async function mintSbt(receiver = S.ownerAccount.address) {
        return S.gameManager.sendMintSbt(
            S.ownerAccount.getSender(),
            toNano('1'),
            receiver,
            encodeSbtContent({ tatoo: snakeString('ink') }),
        );
    }

    // Re-seed all four registries on a freshly deployed R* by COPYING the opaque
    // cells verbatim from the old R* (this is exactly what swapRetranslator.ts does).
    async function copyRegistries(oldR: SandboxContract<Retranslator>, newRAddr: ReturnType<typeof Retranslator.createFromConfig>['address']) {
        const jetton = await oldR.getJettonInfoCell();
        const games = await oldR.getGamesInfoCell();
        const tools = await oldR.getToolsInfo();
        const allowBurn = await oldR.getAllowBurn();

        if (jetton) {
            await S.gameManager.sendRedirectMessage(S.ownerAccount.getSender(), toNano('1'), newRAddr, encodeSetJettonInfo({ jettonInfo: jetton }), toNano('0.9'));
        }
        if (games) {
            await S.gameManager.sendRedirectMessage(S.ownerAccount.getSender(), toNano('1'), newRAddr, encodeSetGamesInfo({ gamesInfo: games }), toNano('0.9'));
        }
        if (tools) {
            await S.gameManager.sendRedirectMessage(S.ownerAccount.getSender(), toNano('1'), newRAddr, encodeSetToolsInfo({ toolsInfo: tools }), toNano('0.9'));
        }
        await S.gameManager.sendRedirectMessage(S.ownerAccount.getSender(), toNano('1'), newRAddr, encodeSetAllowBurn({ allow_burn: allowBurn }), toNano('0.9'));
    }

    it('migrated swap: preserves counters + registries, repoints GM, no index collision, old R* inert, version bumped', async () => {
        const oldR = S.retranslator;

        // --- advance R* counters with real mints (2 NFT, 1 SBT) ---
        await mintNft();
        await mintNft();
        await mintSbt();
        const oldNft = await oldR.getNextNftIndex();
        const oldSbt = await oldR.getNextSbtIndex();
        const oldVersion = await oldR.getVersion();
        expect(oldNft).toBe(2n);
        expect(oldSbt).toBe(1n);

        // snapshot the opaque registries
        const oldJetton = (await oldR.getJettonInfoCell())!;
        const oldGames = (await oldR.getGamesInfoCell())!;
        const oldTools = (await oldR.getToolsInfo())!;
        const oldAllowBurn = await oldR.getAllowBurn();

        // GM currently points to old R*.
        expect((await S.gameManager.getRetranslatorAddress()).equals(oldR.address)).toBe(true);

        // --- build + deploy NEW R* v(old+1) with MIGRATED counters ---
        const newR = S.blockchain.openContract(
            Retranslator.createFromConfig(
                {
                    gameManagerAddress: S.gameManager.address,
                    ownerAddress: S.ownerAccount.address,
                    version: oldVersion + 1n,
                    active: true,
                    allow_burn: oldAllowBurn,
                    nextNftIndex: oldNft, // <-- the migration crux
                    nextSbtIndex: oldSbt,
                },
                retranslatorCode,
            ),
        );
        expect(newR.address.equals(oldR.address)).toBe(false); // distinct address (version in storage)
        await newR.sendDeploy(S.ownerAccount.getSender(), toNano('0.5'));

        // --- seed registries on new R* via GM relay (opaque copy) ---
        await copyRegistries(oldR, newR.address);

        // --- repoint GM atomically ---
        await S.gameManager.sendSetRetranslator(S.ownerAccount.getSender(), toNano('0.1'), newR.address);

        // (b) GM points to v2
        expect((await S.gameManager.getRetranslatorAddress()).equals(newR.address)).toBe(true);
        // (f) version bumped
        expect(await newR.getVersion()).toBe(oldVersion + 1n);
        // (a) counters migrated
        expect(await newR.getNextNftIndex()).toBe(oldNft);
        expect(await newR.getNextSbtIndex()).toBe(oldSbt);
        // (e) registries match (opaque cells identical)
        expect((await newR.getJettonInfoCell())!.hash().equals(oldJetton.hash())).toBe(true);
        expect((await newR.getGamesInfoCell())!.hash().equals(oldGames.hash())).toBe(true);
        expect((await newR.getToolsInfo())!.hash().equals(oldTools.hash())).toBe(true);
        expect(await newR.getAllowBurn()).toBe(oldAllowBurn);

        // (c) post-swap mint gets index == migrated value (no collision); routed via v2
        const res = await mintNft();
        expect(res.transactions).toHaveTransaction({
            from: S.gameManager.address,
            to: newR.address,
            success: true,
        });
        expect(res.transactions).toHaveTransaction({
            from: S.gameManager.address,
            to: S.nftPrinter.address,
            op: NFTPrinterOp.DeployNft,
            success: true,
        });
        // the item lands at exactly the migrated index, and the new R* advances it
        const itemAddr = await S.nftPrinter.getNftAddressByIndex(Number(oldNft));
        expect(res.transactions).toHaveTransaction({ from: S.nftPrinter.address, to: itemAddr, deploy: true, success: true });
        expect(await newR.getNextNftIndex()).toBe(oldNft + 1n);

        // (d) old R* is inert: the post-swap mint never touched it
        expect(res.transactions).not.toHaveTransaction({ to: oldR.address });

        // (d) a late R3 from the OLD R* is rejected by GM (err 932)
        const lateR3 = beginCell().storeUint(R3_OP, 32).storeAddress(S.nftPrinter.address).storeRef(beginCell().endCell()).endCell();
        const r3res = await S.blockchain.sendMessage({
            info: {
                type: 'internal',
                ihrDisabled: true,
                bounce: false,
                bounced: false,
                src: oldR.address,
                dest: S.gameManager.address,
                value: { coins: toNano('0.3') },
                ihrFee: 0n,
                forwardFee: 0n,
                createdLt: 0n,
                createdAt: 0,
            },
            body: lateR3,
        });
        expect(r3res.transactions).toHaveTransaction({
            from: oldR.address,
            to: S.gameManager.address,
            success: false,
            exitCode: ERR_INVALID_RETRANSLATOR_SENDER,
        });
    });

    it('swap WITHOUT migrating the counter collides at the printer (proves migration is required)', async () => {
        const oldR = S.retranslator;
        await mintNft();
        await mintNft(); // printer.nextItemIndex == 2, oldR.nextNftIndex == 2
        expect(await oldR.getNextNftIndex()).toBe(2n);

        // Deploy a NEW R* that FORGOT to migrate the NFT counter (starts at 0).
        const badR = S.blockchain.openContract(
            Retranslator.createFromConfig(
                {
                    gameManagerAddress: S.gameManager.address,
                    ownerAddress: S.ownerAccount.address,
                    version: (await oldR.getVersion()) + 1n,
                    active: true,
                    nextNftIndex: 0n, // <-- BUG: not migrated
                    nextSbtIndex: 0n,
                },
                retranslatorCode,
            ),
        );
        await badR.sendDeploy(S.ownerAccount.getSender(), toNano('0.5'));
        await copyRegistries(oldR, badR.address);
        await S.gameManager.sendSetRetranslator(S.ownerAccount.getSender(), toNano('0.1'), badR.address);

        // The mint: badR assigns index 0 (its un-migrated base). The printer accepts
        // `itemIndex <= nextItemIndex` (0 <= 2), so it does NOT throw 402 — instead it
        // silently RE-TARGETS the already-used item-0 address (the §4.2.1 collision) and
        // does not advance its own counter. The result is a counter DESYNC:
        //   printer.nextItemIndex stays 2, but badR.nextNftIndex advances 0 -> 1.
        const existingItem0 = await S.nftPrinter.getNftAddressByIndex(0);
        const res = await mintNft();
        // GM->printer DeployNft re-targets the EXISTING index-0 item address (collision)…
        expect(res.transactions).toHaveTransaction({ from: S.gameManager.address, to: S.nftPrinter.address });
        expect(res.transactions).toHaveTransaction({ from: S.nftPrinter.address, to: existingItem0 });
        // …no fresh item is created at the real tip (index 2)…
        expect(res.transactions).not.toHaveTransaction({ to: await S.nftPrinter.getNftAddressByIndex(2), deploy: true });
        // …and the two counters are now out of step → continuity broken without migration.
        expect((await S.nftPrinter.getCollectionData()).nextItemIndex).toBe(2n);
        expect(await badR.getNextNftIndex()).toBe(1n);
    });
});
