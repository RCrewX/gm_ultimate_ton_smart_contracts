// SPDX-License-Identifier: UNLICENSED
import { Address, toNano } from '@ton/core';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { Retranslator } from '../../wrappers/game_manager/Retranslator';
import {
    MULTISPLAV_FILTER_BITS,
    MULTISPLAV_FILTER_K,
    MULTISPLAV_TIER_CAP,
} from '../../wrappers/game_manager/RetranslatorTypes';

// =============================================================================
// Multisplav provenance Bloom filter — PURE unit tests through the real Tolk
// helpers (get_multisplav_empty_filter / _add_origin / _probably_seen). These
// are side-effect-free getters, so a bare deployed R* suffices (no GM/printer).
//
// Key property under test (note_encrypt_multisplav.txt §4): the filter has
//   * NO false-negatives  — a real duplicate is ALWAYS caught
//   * false-positives only — a fresh origin may RARELY be mis-flagged as seen,
//     and the rate stays in the note's ballpark for 512 bits / k=3 at 20–40 origins.
// All addresses are deterministic (no RNG) so the assertions are reproducible.
// =============================================================================

// Deterministic, distinct address from an index (spread across the 256-bit hashpart).
function addrOf(n: number): Address {
    const buf = Buffer.alloc(32);
    buf.writeUInt32BE((0xa5a5a5a5 ^ n) >>> 0, 0);
    buf.writeUInt32BE((0x5a5a5a5a ^ (n * 2654435761)) >>> 0, 12);
    buf.writeUInt32BE(n >>> 0, 28);
    return new Address(0, buf);
}

describe('multisplav Bloom filter (pure, via getters)', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let R: SandboxContract<Retranslator>;

    beforeAll(async () => {
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('bloomOwner');
        const code = await compile('Retranslator');
        R = blockchain.openContract(
            Retranslator.createFromConfig({ gameManagerAddress: owner.address, ownerAddress: owner.address }, code),
        );
        await R.sendDeploy(owner.getSender(), toNano('0.5'));
    }, 120000);

    it('exposes the locked params (512 bits, k=3, tier cap 64)', async () => {
        const p = await R.getMultisplavParams();
        expect(p.bits).toBe(MULTISPLAV_FILTER_BITS);
        expect(p.k).toBe(MULTISPLAV_FILTER_K);
        expect(p.tierCap).toBe(MULTISPLAV_TIER_CAP);
    });

    it('empty filter reports nothing as seen', async () => {
        const empty = await R.getMultisplavEmptyFilter();
        for (let i = 0; i < 16; i++) {
            expect(await R.getMultisplavProbablySeen(empty, addrOf(i))).toBe(false);
        }
    });

    it('addOrigin then probablySeen is true; a different origin is (usually) not', async () => {
        const empty = await R.getMultisplavEmptyFilter();
        const A = addrOf(1);
        const B = addrOf(2);
        const withA = await R.getMultisplavAddOrigin(empty, A);
        expect(await R.getMultisplavProbablySeen(withA, A)).toBe(true);
        expect(await R.getMultisplavProbablySeen(withA, B)).toBe(false);
    });

    it('NO false-negatives: every added origin is always caught (30 origins)', async () => {
        let filter = await R.getMultisplavEmptyFilter();
        const added: Address[] = [];
        for (let i = 0; i < 30; i++) {
            const a = addrOf(i);
            filter = await R.getMultisplavAddOrigin(filter, a);
            added.push(a);
        }
        // Re-check ALL of them against the FINAL filter — none may be missed.
        for (const a of added) {
            expect(await R.getMultisplavProbablySeen(filter, a)).toBe(true);
        }
    });

    it('false-positive rate stays low at ~30 origins (512 bits / k=3)', async () => {
        // Build a filter holding 30 distinct origins (indices 0..29).
        let filter = await R.getMultisplavEmptyFilter();
        for (let i = 0; i < 30; i++) {
            filter = await R.getMultisplavAddOrigin(filter, addrOf(i));
        }
        // Probe 256 FRESH origins (disjoint index space) and measure false "seen".
        const trials = 256;
        let falsePositives = 0;
        for (let i = 0; i < trials; i++) {
            if (await R.getMultisplavProbablySeen(filter, addrOf(100000 + i))) {
                falsePositives++;
            }
        }
        const rate = falsePositives / trials;
        // Theory for m=512,k=3,n=30 is ~0.3–0.5%; the note's uint256 (m=256) table is
        // ~2.6% at 30. Assert comfortably under that (sample noise tolerant).
        // eslint-disable-next-line no-console
        console.log(`multisplav FP @30 origins (512b/k3): ${falsePositives}/${trials} = ${(rate * 100).toFixed(2)}%`);
        expect(rate).toBeLessThan(0.05);
    });

    it('false-positive rate climbs but stays bounded at ~40 origins', async () => {
        let filter = await R.getMultisplavEmptyFilter();
        for (let i = 0; i < 40; i++) {
            filter = await R.getMultisplavAddOrigin(filter, addrOf(i));
        }
        const trials = 256;
        let fp = 0;
        for (let i = 0; i < trials; i++) {
            if (await R.getMultisplavProbablySeen(filter, addrOf(200000 + i))) fp++;
        }
        const rate = fp / trials;
        // eslint-disable-next-line no-console
        console.log(`multisplav FP @40 origins (512b/k3): ${fp}/${trials} = ${(rate * 100).toFixed(2)}%`);
        // Still no false-negatives at 40 either.
        for (let i = 0; i < 40; i++) {
            expect(await R.getMultisplavProbablySeen(filter, addrOf(i))).toBe(true);
        }
        expect(rate).toBeLessThan(0.08);
    });
});
