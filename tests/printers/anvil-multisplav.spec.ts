// SPDX-License-Identifier: UNLICENSED
import { beginCell, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { AnvilRecipe, MULTISPLAV_MINT_STAKE } from '../../wrappers/game_manager/RetranslatorTypes';
import { JettonMinter } from '../../wrappers/tep/jetton/JettonMinter';
import { JettonWallet } from '../../wrappers/tep/jetton/JettonWallet';
import { NFTItem } from '../../wrappers/tep/nft/NFTItem';
import { decodeNftContent } from '../../wrappers/game_manager/RetranslatorTypes';
import {
    setupAnvil,
    mintItem,
    anvilInitBody,
    itemContent,
    itemAlive,
    AnvilSystem,
} from './anvil_setup';

// =============================================================================
// ANVIL multisplav (type-5 alloy):
//   * I(5|K|N) + I(5|0|R) -> I(5|K+1|N)   (primary native, sacrifice non-native)
//   * 1000 RUDA -> I(5|0|N)               (jetton-intake mint; the stake is BURNED)
// plus the forbidden same-origin / non-native-primary rejections.
// NOTE: the provenance-filter behaviour (dup rejection, tier cap) and the burn
// assertions live in the focused multisplav-alloy.spec.ts / multisplav-mint.spec.ts.
// =============================================================================

const MULTISPLAV_MINT_TAG = 0x4d756c74; // "Mult"

describe('ANVIL multisplav (type-5)', () => {
    let S: AnvilSystem;
    let originR: SandboxContract<TreasuryContract>;
    let originB: SandboxContract<TreasuryContract>;

    beforeEach(async () => {
        S = await setupAnvil();
        originR = await S.blockchain.treasury('originR');
        originB = await S.blockchain.treasury('originB');
    }, 120000);

    it('I(5|2|N)+I(5|0|R) -> I(5|3|N); sacrifice destroyed', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: S.nativeMaster, type: 5, tier: 2 });
        const i2 = await mintItem(S, S.user.address, { origin: originR.address, type: 5, tier: 0 });

        await S.user.send({ to: i1.address, value: toNano('1.5'), body: anvilInitBody(AnvilRecipe.MULTISPLAV, true, i2.index) });

        const c1 = await itemContent(S, i1.address);
        expect(c1.origin).toEqualAddress(S.nativeMaster);
        expect(c1.type).toBe(5n);
        expect(c1.tier).toBe(3n);
        expect(await itemAlive(S, i2.address)).toBe(false);
    });

    it('forbidden: same-origin (both native) multisplav is rejected; primary unchanged', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: S.nativeMaster, type: 5, tier: 2 });
        const i2 = await mintItem(S, S.user.address, { origin: S.nativeMaster, type: 5, tier: 0 });

        const r = await S.user.send({ to: i1.address, value: toNano('1.5'), body: anvilInitBody(AnvilRecipe.MULTISPLAV, true, i2.index) });
        expect(r.transactions).toHaveTransaction({
            to: S.retranslator.address,
            success: false,
            exitCode: 978, // ERR_ANVIL_SAME_ORIGIN_MULTISPLAV
        });
        expect((await itemContent(S, i1.address)).tier).toBe(2n);
        expect(await itemAlive(S, i2.address)).toBe(true);
    });

    it('forbidden: non-native primary is rejected', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: originR.address, type: 5, tier: 2 });
        const i2 = await mintItem(S, S.user.address, { origin: originB.address, type: 5, tier: 0 });

        const r = await S.user.send({ to: i1.address, value: toNano('1.5'), body: anvilInitBody(AnvilRecipe.MULTISPLAV, true, i2.index) });
        expect(r.transactions).toHaveTransaction({
            to: S.retranslator.address,
            success: false,
            exitCode: 976, // ERR_ANVIL_MULTISPLAV_PRIMARY_NOT_NATIVE
        });
    });

    it('1000 RUDA -> I(5|0|N): jetton-intake mint to the depositor (stake burned)', async () => {
        // Give the user 1000 RUDA (raw; RUDA is 0-decimal) via GM -> minter.
        await S.gameManager.sendRedirectMessage(
            S.ownerAccount.getSender(),
            toNano('0.4'),
            S.jettonMinter.address,
            JettonMinter.mintMessage(S.jettonMinter.address, S.user.address, MULTISPLAV_MINT_STAKE, toNano('0.1'), toNano('0.2')),
            toNano('0.3'),
        );
        const userWallet = S.blockchain.openContract(
            JettonWallet.createFromConfig({ ownerAddress: S.user.address, minterAddress: S.jettonMinter.address }, S.jettonWalletCode),
        );
        expect(await userWallet.getJettonBalance()).toBe(MULTISPLAV_MINT_STAKE);

        const newIndex = Number(await S.retranslator.getNextNftIndex());

        // Transfer 1000 RUDA (raw) to GM with the multisplav-mint tag in the forwardPayload.
        const taggedPayload = beginCell().storeUint(MULTISPLAV_MINT_TAG, 32).endCell();
        await userWallet.sendTransfer(
            S.user.getSender(),
            toNano('1.5'),               // TON for the transfer + forward
            MULTISPLAV_MINT_STAKE,       // the full RUDA stake (raw 1000)
            S.gameManager.address,       // recipient = GM (house wallet)
            S.user.address,              // excess back to user
            null as any,
            toNano('1'),                 // forward TON to fund the mint chain
            taggedPayload,
        );

        // A fresh I(5|0|N) was minted to the depositor.
        const itemAddr = await S.nftPrinter.getNftAddressByIndex(newIndex);
        const item = S.blockchain.openContract(NFTItem.createFromAddress(itemAddr));
        const data = await item.getNftData();
        expect(data.init).toBe(true);
        expect(data.ownerAddress).toEqualAddress(S.user.address);
        const c = decodeNftContent(data.individualContent!);
        expect(c.origin).toEqualAddress(S.nativeMaster);
        expect(c.type).toBe(5n);
        expect(c.tier).toBe(0n);
    });

    it('1000-RUDA mint rejects a wrong stake amount', async () => {
        await S.gameManager.sendRedirectMessage(
            S.ownerAccount.getSender(),
            toNano('0.4'),
            S.jettonMinter.address,
            JettonMinter.mintMessage(S.jettonMinter.address, S.user.address, 500n, toNano('0.1'), toNano('0.2')),
            toNano('0.3'),
        );
        const userWallet = S.blockchain.openContract(
            JettonWallet.createFromConfig({ ownerAddress: S.user.address, minterAddress: S.jettonMinter.address }, S.jettonWalletCode),
        );
        const indexBefore = await S.retranslator.getNextNftIndex();
        const taggedPayload = beginCell().storeUint(MULTISPLAV_MINT_TAG, 32).endCell();
        const r = await userWallet.sendTransfer(
            S.user.getSender(), toNano('1.5'), 500n, // wrong stake (raw 500 != 1000)
            S.gameManager.address, S.user.address, null as any, toNano('1'), taggedPayload,
        );
        expect(r.transactions).toHaveTransaction({
            to: S.retranslator.address,
            success: false,
            exitCode: 982, // ERR_ANVIL_BAD_MULTISPLAV_MINT_AMOUNT
        });
        expect(await S.retranslator.getNextNftIndex()).toBe(indexBefore); // no mint
    });
});
