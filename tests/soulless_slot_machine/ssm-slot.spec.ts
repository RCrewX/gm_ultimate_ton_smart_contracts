// SPDX-License-Identifier: UNLICENSED
import { beginCell, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { SSMSlot } from '../../wrappers/soulless_slot_machine/SSMSlot';
import {
    encodeRollContext,
    RUDA_AMOUNT_100,
    SYM_ZERO,
    SYM_SEVEN,
    SYM_X,
} from '../../wrappers/soulless_slot_machine/types';
import {
    setupSsmLight,
    setSeed,
    readRollSymbols,
    SsmLight,
    SSM_REELS,
} from './ssm_setup';

// =============================================================================
// SSMSlot mechanics: sender-gating (only SSM drives reel 0; only the previous
// slot drives reel i>0), the SSM-side last-slot gate on RollResult, the slot
// self-refund (keep only the storage tax), and symbol bounds.
// =============================================================================

const ERR_SLOT_INVALID_SENDER = 1300;
const ERR_INVALID_SLOT_RESULT_SENDER = 946;

describe('SSMSlot mechanics', () => {
    let S: SsmLight;

    beforeEach(async () => {
        S = await setupSsmLight();
    });

    function dummyCtx() {
        return encodeRollContext({
            player: S.player.address,
            stake: RUDA_AMOUNT_100,
            isNative: true,
            origin: S.rudaMaster.address,
            escrowWallet: S.ssm.address,
            queryId: 0,
        });
    }

    it('reel 0 rejects a RollStep from anyone but the SSM', async () => {
        const slot0 = S.blockchain.openContract(
            SSMSlot.createFromConfig({ ssmAddress: S.ssm.address, reelIndex: 0 }, S.slotCode),
        );
        await slot0.sendDeploy(S.gm.getSender(), toNano('0.1'));

        const stranger = await S.blockchain.treasury('strangerSlot0');
        const r = await slot0.sendRollStep(stranger.getSender(), toNano('0.5'), dummyCtx(), 0);
        expect(r.transactions).toHaveTransaction({
            from: stranger.address,
            to: slot0.address,
            success: false,
            exitCode: ERR_SLOT_INVALID_SENDER,
        });
    });

    it('reel 1 rejects a RollStep from anyone but reel 0', async () => {
        const slot1 = S.blockchain.openContract(
            SSMSlot.createFromConfig({ ssmAddress: S.ssm.address, reelIndex: 1 }, S.slotCode),
        );
        await slot1.sendDeploy(S.gm.getSender(), toNano('0.1'));

        // Even the SSM itself is not the valid sender for reel 1 (only reel 0 is).
        const r = await slot1.sendRollStep(S.gm.getSender(), toNano('0.5'), dummyCtx(), 0);
        expect(r.transactions).toHaveTransaction({
            to: slot1.address,
            success: false,
            exitCode: ERR_SLOT_INVALID_SENDER,
        });
    });

    it('SSM rejects a RollResult that is not from the last slot', async () => {
        const stranger = await S.blockchain.treasury('fakeLastSlot');
        const body = beginCell()
            .storeUint(0x55320002, 32) // OP_ROLL_RESULT
            .storeRef(dummyCtx())
            .storeUint(0, 8)
            .endCell();
        const r = await stranger.send({ to: S.ssm.address, value: toNano('0.5'), body });
        expect(r.transactions).toHaveTransaction({
            from: stranger.address,
            to: S.ssm.address,
            success: false,
            exitCode: ERR_INVALID_SLOT_RESULT_SENDER,
        });
    });

    it('a full roll deploys SSM_REELS slots, each in {0,7,X}, and self-refunds', async () => {
        setSeed(S.blockchain, 7);
        const r = await S.ssm.sendJettonUsed(
            S.gm.getSender(),
            toNano('1.5'),
            RUDA_AMOUNT_100,
            S.player.address,
            1n,
        );

        // All three reels deployed and the result returned to SSM.
        const slotAddrs = [
            await S.ssm.getSlotAddress(0),
            await S.ssm.getSlotAddress(1),
            await S.ssm.getSlotAddress(2),
        ];
        for (let i = 0; i < SSM_REELS; i++) {
            expect(r.transactions).toHaveTransaction({ to: slotAddrs[i], success: true });
        }

        const symbols = readRollSymbols(r, S.ssm.address);
        expect(symbols).not.toBeNull();
        for (let i = 0; i < SSM_REELS; i++) {
            const sym = (symbols! >> (2 * i)) & 3;
            expect([SYM_ZERO, SYM_SEVEN, SYM_X]).toContain(sym);
        }

        // Self-refund: each spent slot keeps only ~the storage tax (<= 0.02 TON).
        for (const addr of slotAddrs) {
            const c = await S.blockchain.getContract(addr);
            expect(c.balance).toBeLessThanOrEqual(toNano('0.02'));
        }
    });
});
