// SPDX-License-Identifier: UNLICENSED
import { beginCell, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { AnvilErrors, ANVIL_MULTISPLAV_MINT_TAG, MULTISPLAV_MINT_STAKE, decodeNftContent } from '../../wrappers/game_manager/RetranslatorTypes';
import { JettonMinter } from '../../wrappers/tep/jetton/JettonMinter';
import { JettonWallet } from '../../wrappers/tep/jetton/JettonWallet';
import { NFTItem } from '../../wrappers/tep/nft/NFTItem';
import { setupAnvil, AnvilSystem } from './anvil_setup';

// =============================================================================
// ANVIL 1000-RUDA -> I(5|0|N) mint:
//   * a fresh type-5 tier-0 NATIVE item is minted to the depositor with an EMPTY
//     provenance filter (ready to accumulate foreign origins via alloy).
//   * the 1000-RUDA stake is BURNED (R* -> GM's own RUDA wallet -> minter), the
//     SSM honest-burn model — the house does NOT keep the stake.
//   * a wrong stake amount is rejected with no mint and no burn.
// =============================================================================

const TAG = ANVIL_MULTISPLAV_MINT_TAG;

describe('ANVIL 1000-RUDA multisplav mint (+ burn)', () => {
    let S: AnvilSystem;

    beforeEach(async () => {
        S = await setupAnvil();
    }, 120000);

    function gmWallet(): SandboxContract<JettonWallet> {
        return S.blockchain.openContract(
            JettonWallet.createFromConfig(
                { ownerAddress: S.gameManager.address, minterAddress: S.jettonMinter.address },
                S.jettonWalletCode,
            ),
        );
    }
    function userWallet(): SandboxContract<JettonWallet> {
        return S.blockchain.openContract(
            JettonWallet.createFromConfig(
                { ownerAddress: S.user.address, minterAddress: S.jettonMinter.address },
                S.jettonWalletCode,
            ),
        );
    }

    // Mint `amount` RUDA to the user via GM -> minter.
    async function fundUser(amount: bigint) {
        await S.gameManager.sendRedirectMessage(
            S.ownerAccount.getSender(),
            toNano('0.4'),
            S.jettonMinter.address,
            JettonMinter.mintMessage(S.jettonMinter.address, S.user.address, amount, toNano('0.1'), toNano('0.2')),
            toNano('0.3'),
        );
    }

    it('mints I(5|0|N) with an EMPTY filter AND burns the 1000-RUDA stake', async () => {
        // Baselines (the harness may pre-mint a RUDA supply; assert DELTAS, not absolutes).
        const supplyBaseline = await S.jettonMinter.getTotalSupply();
        const gmBaseline = await gmWallet().getJettonBalance();

        await fundUser(MULTISPLAV_MINT_STAKE);
        expect(await userWallet().getJettonBalance()).toBe(MULTISPLAV_MINT_STAKE);
        expect(await S.jettonMinter.getTotalSupply()).toBe(supplyBaseline + MULTISPLAV_MINT_STAKE);

        const newIndex = Number(await S.retranslator.getNextNftIndex());

        const taggedPayload = beginCell().storeUint(TAG, 32).endCell();
        await userWallet().sendTransfer(
            S.user.getSender(),
            toNano('1.5'),            // TON for transfer + forward chain
            MULTISPLAV_MINT_STAKE,    // full RUDA stake (raw 1000; 0-decimal)
            S.gameManager.address,    // recipient = GM (house wallet)
            S.user.address,           // excess back to user
            null as any,
            toNano('1'),              // forward TON funds the mint + burn chain
            taggedPayload,
        );

        // (1) A fresh I(5|0|N) was minted to the depositor with an empty filter.
        const itemAddr = await S.nftPrinter.getNftAddressByIndex(newIndex);
        const item = S.blockchain.openContract(NFTItem.createFromAddress(itemAddr));
        const data = await item.getNftData();
        expect(data.init).toBe(true);
        expect(data.ownerAddress).toEqualAddress(S.user.address);
        const c = decodeNftContent(data.individualContent!);
        expect(c.origin).toEqualAddress(S.nativeMaster);
        expect(c.type).toBe(5n);
        expect(c.tier).toBe(0n);
        // Filter is present and EMPTY: nothing is seen yet.
        expect(c.seen).not.toBeNull();
        expect(await S.retranslator.getMultisplavProbablySeen(c.seen!, S.user.address)).toBe(false);
        expect(await S.retranslator.getMultisplavProbablySeen(c.seen!, S.nativeMaster)).toBe(false);

        // (2) The stake was BURNED: GM's wallet returns to baseline (the 1000 in then
        // out) and total supply drops back to the pre-funding baseline (1000 burned).
        expect(await gmWallet().getJettonBalance()).toBe(gmBaseline);
        expect(await S.jettonMinter.getTotalSupply()).toBe(supplyBaseline);
    });

    it('rejects a wrong stake amount — no mint, no burn', async () => {
        await fundUser(500n);
        const supplyAfterFund = await S.jettonMinter.getTotalSupply();
        const indexBefore = await S.retranslator.getNextNftIndex();
        const taggedPayload = beginCell().storeUint(TAG, 32).endCell();
        const r = await userWallet().sendTransfer(
            S.user.getSender(), toNano('1.5'), 500n, // wrong stake (raw 500 != 1000)
            S.gameManager.address, S.user.address, null as any, toNano('1'), taggedPayload,
        );
        expect(r.transactions).toHaveTransaction({
            to: S.retranslator.address,
            success: false,
            exitCode: AnvilErrors.BAD_MULTISPLAV_MINT_AMOUNT, // 982
        });
        expect(await S.retranslator.getNextNftIndex()).toBe(indexBefore); // no mint
        // The 500 RUDA landed in GM's wallet (the transfer settled before the
        // notification was rejected); nothing was minted or burned, so supply is unchanged.
        expect(await S.jettonMinter.getTotalSupply()).toBe(supplyAfterFund);
    });
});
