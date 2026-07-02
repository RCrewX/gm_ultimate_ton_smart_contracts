// SPDX-License-Identifier: UNLICENSED
import { Address, beginCell, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { SoullessSlotMachine } from '../../wrappers/soulless_slot_machine/SoullessSlotMachine';
import { SSMSlot } from '../../wrappers/soulless_slot_machine/SSMSlot';
import { Retranslator } from '../../wrappers/game_manager/Retranslator';
import { JettonWallet } from '../../wrappers/tep/jetton/JettonWallet';
import { JettonMinter, jettonContentToCell } from '../../wrappers/tep/jetton/JettonMinter';
import { NFTItem } from '../../wrappers/tep/nft/NFTItem';
import {
    Opcodes as SsmOpcodes,
    RUDA_AMOUNT_100,
    CUSTOM_ALLOWED_AMOUNT,
    OUT_NFT,
    expectedOutcome,
    buildNativeRollForwardPayload,
    encodeCustomRollPayload,
} from '../../wrappers/soulless_slot_machine/types';
import { AnvilRecipe, ANVIL_OPCODES, decodeNftContent } from '../../wrappers/game_manager/RetranslatorTypes';
import { buildGameConstants } from '../../lib/gameConstants';
import { setupAnvil, mintItem, anvilInitBody, itemContent, itemAlive, AnvilSystem } from '../printers/anvil_setup';

// =============================================================================
// CROSS-SYSTEM E2E (plan 3): a freshly-wired GM/R*/printer/minter sandbox with
// the redesigned SSM REGISTERED as a game. Drives a full native roll and a full
// custom roll end-to-end (reward routes through the real pipe to the printer),
// plus a full ANVIL combine + melt — and asserts the PUBLISHED constants/opcodes
// are the ones the contracts actually use (guards deployment_latest.json drift).
// =============================================================================

type E2ESystem = AnvilSystem & {
    ssm: SandboxContract<SoullessSlotMachine>;
    slotCode: Awaited<ReturnType<typeof compile>>;
};

const ROLL_VALUE = toNano('1.6');

async function setupE2E(): Promise<E2ESystem> {
    const base = await setupAnvil(); // GM, R*, jettonMinter, NFT printer + toolsInfo, jetton/games info
    const slotCode = await compile('SSMSlot');
    const ssmCode = await compile('SoullessSlotMachine');

    const ssm = base.blockchain.openContract(
        SoullessSlotMachine.createFromConfig(
            { ownerAddress: base.gameManager.address, ssmSlotCode: slotCode, rudaMasterAddress: base.jettonMinter.address },
            ssmCode,
        ),
    );
    await ssm.sendDeploy(base.ownerAccount.getSender(), toNano('0.5'));

    // Register SSM as the active game so its MintNft / ForwardMintRequest rewards
    // pass R*'s active-game gate, and native rolls route JettonUsed to it.
    await base.gameManager.sendRedirectMessage(
        base.ownerAccount.getSender(),
        toNano('1'),
        base.retranslator.address,
        Retranslator.setGamesInfoMessage({
            active_game: ssm.address,
            ssm: ssm.address,
            ton_race_game: base.game.address,
            ubps: null,
        }),
        toNano('0.9'),
    );

    return Object.assign(base, { ssm, slotCode });
}

// Read the packed symbols from the slot -> SSM RollResult.
function rollSymbols(messageResult: any, ssmAddress: Address): number | null {
    for (const tx of messageResult.transactions) {
        if (tx.inMessage?.info.type !== 'internal') continue;
        if (!tx.inMessage?.info.dest?.equals(ssmAddress)) continue;
        try {
            const s = tx.inMessage.body.beginParse();
            if (s.loadUint(32) !== SsmOpcodes.OP_ROLL_RESULT) continue;
            s.loadRef();
            return s.loadUint(8);
        } catch { /* not it */ }
    }
    return null;
}

describe('SSM + ANVIL cross-system e2e', () => {
    let S: E2ESystem;
    let player: SandboxContract<TreasuryContract>;

    beforeEach(async () => {
        S = await setupE2E();
        player = await S.blockchain.treasury('e2ePlayer');
    }, 120000);

    it('native roll: an NFT-outcome reward mints a real NFT (origin=RUDA master) to the player', async () => {
        // The owner (funded with RUDA by initContractSystem) is the depositor.
        const ownerWallet = S.blockchain.openContract(
            JettonWallet.createFromConfig({ ownerAddress: S.ownerAccount.address, minterAddress: S.jettonMinter.address }, S.jettonWalletCode),
        );

        let proven = false;
        for (let seed = 1; seed <= 40 && !proven; seed++) {
            S.blockchain.random = Buffer.alloc(32, seed & 0xff);
            const idxBefore = Number(await S.retranslator.getNextNftIndex());

            const payload = buildNativeRollForwardPayload(S.ssm.address, player.address, seed);
            const r = await ownerWallet.sendTransfer(
                S.ownerAccount.getSender(),
                ROLL_VALUE,
                RUDA_AMOUNT_100,
                S.gameManager.address, // deposit to the house (GM)
                S.ownerAccount.address,
                null as any,
                toNano('1.4'),
                payload,
            );

            const symbols = rollSymbols(r, S.ssm.address);
            if (symbols === null) continue; // routing didn't complete this seed
            const exp = expectedOutcome(symbols, true, RUDA_AMOUNT_100);
            if (exp.kind !== OUT_NFT) continue;

            // The MintNft reward deployed a real NFT at idxBefore to the player.
            const itemAddr = await S.nftPrinter.getNftAddressByIndex(idxBefore);
            const item = S.blockchain.openContract(NFTItem.createFromAddress(itemAddr));
            const data = await item.getNftData();
            expect(data.init).toBe(true);
            expect(data.ownerAddress).toEqualAddress(player.address);
            const c = decodeNftContent(data.individualContent!);
            expect(c.origin).toEqualAddress(S.jettonMinter.address); // native origin = RUDA master
            expect(c.type).toBe(exp.nftType);
            expect(c.tier).toBe(exp.nftTier);
            proven = true;
        }
        expect(proven).toBe(true);
    });

    it('custom roll: the FULL TEP-89 handshake against a real master mints an NFT with the custom origin', async () => {
        // A real, distinct custom jetton master (NOT the RUDA master). The genuine escrow +
        // TEP-89 discovery runs end to end: depositor transfers custom tokens to SSM → SSM's
        // custom wallet W notifies SSM → SSM asks the master for its wallet-for-SSM → master
        // answers W → SSM verifies and rolls with the custom master as origin.
        const customMinter = S.blockchain.openContract(
            JettonMinter.createFromConfig(
                { admin: S.ownerAccount.address, content: jettonContentToCell({ type: 0, uri: 'custom' }), wallet_code: S.jettonWalletCode },
                S.jettonMinterCode,
            ),
        );
        await customMinter.sendDeploy(S.ownerAccount.getSender(), toNano('0.5'));

        // Mint plenty of custom tokens to a depositor (one escrow == CUSTOM_ALLOWED_AMOUNT/roll).
        const depositor = await S.blockchain.treasury('e2eCustomDepositor');
        await customMinter.sendMint(
            S.ownerAccount.getSender(),
            depositor.address,
            CUSTOM_ALLOWED_AMOUNT * 60n,
            toNano('0.05'),
            toNano('0.2'),
        );
        const depWallet = S.blockchain.openContract(
            JettonWallet.createFromConfig({ ownerAddress: depositor.address, minterAddress: customMinter.address }, S.jettonWalletCode),
        );

        let proven = false;
        for (let seed = 1; seed <= 40 && !proven; seed++) {
            S.blockchain.random = Buffer.alloc(32, (seed * 3) & 0xff);
            const idxBefore = Number(await S.retranslator.getNextNftIndex());

            // Depositor escrows CUSTOM_ALLOWED_AMOUNT to SSM with the CustomRollPayload. The
            // whole handshake + roll resolves inside this one transfer cascade.
            const payload = encodeCustomRollPayload(customMinter.address, player.address, seed);
            const r = await depWallet.sendTransfer(
                depositor.getSender(),
                toNano('2.6'),          // total value: funds the escrow hop + the two TEP-89 hops + the roll
                CUSTOM_ALLOWED_AMOUNT,
                S.ssm.address,          // transferRecipient == SSM (escrow lands in SSM's custom wallet W)
                depositor.address,      // response/excess
                null as any,            // customPayload
                toNano('1.9'),          // forward TON carried to SSM (>= MIN_ROLL_VALUE after fees)
                payload,
            );

            const symbols = rollSymbols(r, S.ssm.address);
            if (symbols === null) continue; // this escrow's master didn't verify/roll this seed
            const exp = expectedOutcome(symbols, false, CUSTOM_ALLOWED_AMOUNT);
            if (exp.kind !== OUT_NFT) continue;

            const itemAddr = await S.nftPrinter.getNftAddressByIndex(idxBefore);
            const item = S.blockchain.openContract(NFTItem.createFromAddress(itemAddr));
            const data = await item.getNftData();
            expect(data.ownerAddress).toEqualAddress(player.address);
            const c = decodeNftContent(data.individualContent!);
            expect(c.origin).toEqualAddress(customMinter.address); // proven custom origin (== the real master)
            expect(c.type).toBe(exp.nftType);
            expect(c.tier).toBe(exp.nftTier);
            proven = true;
        }
        expect(proven).toBe(true);
    });

    it('ANVIL combine + melt run end-to-end in the same wired system', async () => {
        const originR = await S.blockchain.treasury('e2eOriginR');

        // Combine I(2|3|R)+I(2|3|R) -> I(2|4|R).
        const a = await mintItem(S, player.address, { origin: originR.address, type: 2, tier: 3 });
        const b = await mintItem(S, player.address, { origin: originR.address, type: 2, tier: 3 });
        await player.send({ to: a.address, value: toNano('1.5'), body: anvilInitBody(AnvilRecipe.COMBINE, true, b.index) });
        expect((await itemContent(S, a.address)).tier).toBe(4n);
        expect(await itemAlive(S, b.address)).toBe(false);

        // Melt a native NFT -> burned + RUDA minted to player.
        const m = await mintItem(S, player.address, { origin: S.jettonMinter.address, type: 1, tier: 2 });
        await player.send({ to: m.address, value: toNano('1.5'), body: anvilInitBody(AnvilRecipe.MELT, false, 0) });
        expect(await itemAlive(S, m.address)).toBe(false);
        const playerRuda = S.blockchain.openContract(
            JettonWallet.createFromConfig({ ownerAddress: player.address, minterAddress: S.jettonMinter.address }, S.jettonWalletCode),
        );
        expect(await playerRuda.getJettonBalance()).toBe(10n ** 2n - 1n); // 10^2 - 1
    });

    it('ABI consistency: published opcodes match the on-chain struct opcodes used here', async () => {
        const c = buildGameConstants();
        // SSM intake/reward opcodes the contracts actually parse/emit.
        expect(Number(c.opcodes.soullessSlotMachine.OP_JETTON_USED)).toBe(SsmOpcodes.OP_JETTON_USED);
        expect(Number(c.opcodes.soullessSlotMachine.OP_ROLL_RESULT)).toBe(SsmOpcodes.OP_ROLL_RESULT);
        expect(Number(c.opcodes.soullessSlotMachine.OP_MINT_NFT)).toBe(SsmOpcodes.OP_MINT_NFT);
        // ANVIL recipe + item-flow opcodes.
        expect(Number(c.opcodes.anvil.OP_ANVIL_COMBINE)).toBe(ANVIL_OPCODES.OP_ANVIL_COMBINE);
        expect(Number(c.opcodes.anvil.OP_ANVIL_INIT)).toBe(ANVIL_OPCODES.OP_ANVIL_INIT);
        expect(Number(c.opcodes.anvil.OP_PRINTER_ANVIL_APPLY)).toBe(ANVIL_OPCODES.OP_PRINTER_ANVIL_APPLY);
        // Enums published for the consumer.
        expect(c.enums.AnvilRecipe.COMBINE).toBe(AnvilRecipe.COMBINE);
        expect(c.schemaVersion).toBe(12); // matches CONSTANTS_SCHEMA_VERSION (lib/gameConstants) + abi-guard
    });
});
