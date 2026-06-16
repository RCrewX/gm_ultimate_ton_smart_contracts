// SPDX-License-Identifier: UNLICENSED
import { toNano } from '@ton/core';
import '@ton/test-utils';
import {
    RUDA_AMOUNT_10,
    RUDA_AMOUNT_100,
    expectedOutcome,
    OUT_NOTHING,
    OUT_NFT,
    OUT_MINT_RUDA,
} from '../../wrappers/soulless_slot_machine/types';
import {
    setupSsmLight,
    setSeed,
    readRollSymbols,
    findEmittedRequest,
    findEscrowReturn,
    hasCashback,
    SsmLight,
} from './ssm_setup';

// =============================================================================
// Native RUDA roll: intake validation, the slot chain, and reward ROUTING.
// SSM owner is a GM stand-in, so we assert the exact R1 envelope SSM emits per
// outcome (the downstream R1 -> GM -> R* -> minter/printer is covered by
// printers-e2e and the ton_race_game specs). Routing correctness is checked
// against the reference map for WHATEVER symbols each seed produces, so the test
// does not depend on hitting a specific triple; the pure get_reward spec already
// covers every row (incl. 777 -> 10x).
// =============================================================================

describe('SSM native RUDA roll', () => {
    let S: SsmLight;

    beforeEach(async () => {
        S = await setupSsmLight();
    });

    it('rejects a stake that is not 10/100/1000 RUDA', async () => {
        const r = await S.ssm.sendJettonUsed(S.gm.getSender(), toNano('1.5'), toNano('50'), S.player.address, 1n);
        expect(r.transactions).toHaveTransaction({
            from: S.gm.address,
            to: S.ssm.address,
            success: false,
            exitCode: 943, // ERR_INVALID_RUDA_AMOUNT
        });
    });

    it('rejects a roll without enough attached TON', async () => {
        const r = await S.ssm.sendJettonUsed(S.gm.getSender(), toNano('0.5'), RUDA_AMOUNT_10, S.player.address, 1n);
        expect(r.transactions).toHaveTransaction({
            from: S.gm.address,
            to: S.ssm.address,
            success: false,
            exitCode: 945, // ERR_INSUFFICIENT_ROLL_VALUE
        });
    });

    it('rejects a JettonUsed not delivered by GM (the owner)', async () => {
        const stranger = await S.blockchain.treasury('notGm');
        const r = await S.ssm.sendJettonUsed(stranger.getSender(), toNano('1.5'), RUDA_AMOUNT_100, S.player.address, 1n);
        expect(r.transactions).toHaveTransaction({
            from: stranger.address,
            to: S.ssm.address,
            success: false,
            exitCode: 940, // ERR_INVALID_OWNER_SENDER
        });
    });

    it('routes every rolled outcome per the reward map; always cashes back; never returns escrow', async () => {
        const stake = RUDA_AMOUNT_100;
        const seen = new Set<string>();

        for (let seed = 1; seed <= 18; seed++) {
            setSeed(S.blockchain, seed);
            const r = await S.ssm.sendJettonUsed(S.gm.getSender(), toNano('1.5'), stake, S.player.address, BigInt(seed));

            const symbols = readRollSymbols(r, S.ssm.address);
            expect(symbols).not.toBeNull();
            const exp = expectedOutcome(symbols!, true, stake);
            const req = findEmittedRequest(r, S.gm.address);

            // Cashback is always returned to the player; native never returns escrow.
            expect(hasCashback(r, S.player.address)).toBe(true);
            expect(findEscrowReturn(r, S.ssm.address)).toBeNull();

            if (exp.kind === OUT_NOTHING) {
                expect(req).toBeNull(); // loss: house keeps the (already-deposited) RUDA
                seen.add('nothing');
            } else if (exp.kind === OUT_NFT) {
                if (req?.op !== 'mintNft') throw new Error(`seed ${seed}: expected mintNft, got ${req?.op}`);
                expect(req.receiver).toEqualAddress(S.player.address);
                expect(req.origin).toEqualAddress(S.rudaMaster.address); // native origin = RUDA master
                expect(req.type).toBe(exp.nftType);
                expect(req.tier).toBe(exp.nftTier);
                seen.add('nft');
            } else if (exp.kind === OUT_MINT_RUDA) {
                if (req?.op !== 'forwardMint') throw new Error(`seed ${seed}: expected forwardMint, got ${req?.op}`);
                expect(req.receiver).toEqualAddress(S.player.address);
                expect(req.amount).toBe(exp.mintRudaAmount); // burn-and-mint amount
                seen.add('token');
            }
        }

        // The two common branches must both have been exercised by real rolls.
        expect(seen.has('nft')).toBe(true);
        expect(seen.has('token')).toBe(true);
    });
});
