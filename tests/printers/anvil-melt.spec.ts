// SPDX-License-Identifier: UNLICENSED
import { toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { AnvilRecipe } from '../../wrappers/game_manager/RetranslatorTypes';
import { JettonWallet } from '../../wrappers/tep/jetton/JettonWallet';
import {
    setupAnvil,
    mintItem,
    anvilInitBody,
    itemAlive,
    AnvilSystem,
} from './anvil_setup';

// =============================================================================
// ANVIL melt: burn an NFT, mint RUDA to the owner. Native I(X|K|N) -> 10^K-1 raw;
// the non-native escape I(0|10|R) -> 100 RUDA. R* emits TWO R3s (destroy item1 +
// mint RUDA). The house never holds the payout — it is freshly minted (NFT burned).
// =============================================================================

describe('ANVIL melt (burn -> RUDA)', () => {
    let S: AnvilSystem;
    let originR: SandboxContract<TreasuryContract>;

    beforeEach(async () => {
        S = await setupAnvil();
        originR = await S.blockchain.treasury('originR');
    }, 120000);

    function userRudaWallet() {
        return S.blockchain.openContract(
            JettonWallet.createFromConfig({ ownerAddress: S.user.address, minterAddress: S.jettonMinter.address }, S.jettonWalletCode),
        );
    }

    it('native I(2|3|N) -> item burned, 10^3-1 RUDA minted to user', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: S.nativeMaster, type: 2, tier: 3 });

        await S.user.send({ to: i1.address, value: toNano('1.5'), body: anvilInitBody(AnvilRecipe.MELT, false, 0) });

        expect(await itemAlive(S, i1.address)).toBe(false);
        expect(await userRudaWallet().getJettonBalance()).toBe(999n); // 10^3 - 1 raw
    });

    it('non-native I(0|10|R) -> item burned, 100 RUDA minted to user', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: originR.address, type: 0, tier: 10 });

        await S.user.send({ to: i1.address, value: toNano('1.5'), body: anvilInitBody(AnvilRecipe.MELT, false, 0) });

        expect(await itemAlive(S, i1.address)).toBe(false);
        expect(await userRudaWallet().getJettonBalance()).toBe(100n); // MELT_HUNDRED_RUDA raw (0-decimal)
    });

    it('non-native melt that is not I(0|10|R) is rejected; item survives', async () => {
        const i1 = await mintItem(S, S.user.address, { origin: originR.address, type: 2, tier: 3 });

        const r = await S.user.send({ to: i1.address, value: toNano('1.5'), body: anvilInitBody(AnvilRecipe.MELT, false, 0) });

        expect(r.transactions).toHaveTransaction({
            to: S.retranslator.address,
            success: false,
            exitCode: 979, // ERR_ANVIL_MELT_NON_NATIVE
        });
        expect(await itemAlive(S, i1.address)).toBe(true);
    });
});
