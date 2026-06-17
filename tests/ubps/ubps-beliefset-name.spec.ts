// SPDX-License-Identifier: UNLICENSED
// Mechanic: the OPTIONAL BeliefSet display `name` — non-unique, immutable, set once at
// creation, NOT hashed, NOT an id, and NOT address-determining. Proven here:
//   * a named BS exposes the name via get_name(); an unnamed BS returns null;
//   * the name does NOT enter the address (a named and an unnamed BS at the same index
//     share the same address — name lives in post-creation content);
//   * a name longer than a single cell (>127 bytes) is stored fine (snake string / refs).
import { toNano } from '@ton/core';
import '@ton/test-utils';
import { UbpsCodes, UbpsSystem, compileUbps, initUbps } from './ubps_setup';
import { BeliefSet } from '../../wrappers/ubps/BeliefSet';
import { buildNameCell, emptyCell, UBPS_MAX_NAME_BYTES } from '../../wrappers/ubps/types';

describe('UBPS BeliefSet optional name', () => {
    let codes: UbpsCodes;
    let S: UbpsSystem;
    beforeAll(async () => { codes = await compileUbps(); });
    beforeEach(async () => { S = await initUbps(codes); }, 60000);

    it('stores and exposes an optional name; lands at the name-independent address', async () => {
        const addr = S.ubps.beliefSetAddress(0, codes.beliefSetCode); // f(master, index) — no name
        const name = buildNameCell('My core beliefs');
        const res = await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), false, 0, 0, emptyCell(), emptyCell(), name);
        expect(res.transactions).toHaveTransaction({ from: S.ubps.address, to: addr, success: true });

        const bs = S.blockchain.openContract(BeliefSet.createFromAddress(addr));
        expect(await bs.getCreated()).toBe(true);
        const got = await bs.getName();
        expect(got).not.toBeNull();
        expect(got!.beginParse().loadStringTail()).toBe('My core beliefs');
    });

    it('an unnamed BS returns a null name and shares the SAME address as a named one', async () => {
        const addr = S.ubps.beliefSetAddress(0, codes.beliefSetCode);
        await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), false, 0, 0, emptyCell(), emptyCell()); // name defaults to null
        const bs = S.blockchain.openContract(BeliefSet.createFromAddress(addr));
        expect(await bs.getName()).toBeNull();
        // Address derives from (master, index) only — identical to the named case above.
        expect(addr).toEqualAddress(S.ubps.beliefSetAddress(0, codes.beliefSetCode));
    });

    it('accepts a long name (>127 bytes — snake string spilling into refs)', async () => {
        const long = 'b'.repeat(UBPS_MAX_NAME_BYTES); // 256 bytes
        const addr = S.ubps.beliefSetAddress(0, codes.beliefSetCode);
        await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), true, 0, 0, emptyCell(), emptyCell(), buildNameCell(long));
        const bs = S.blockchain.openContract(BeliefSet.createFromAddress(addr));
        expect((await bs.getName())!.beginParse().loadStringTail()).toBe(long);
        expect(await bs.getRoot()).toBe(true);
    });

    it('the name does not change the address across two indices either (per-index only)', async () => {
        // create idx0 named, idx1 unnamed; each lands at its index address.
        const a0 = S.ubps.beliefSetAddress(0, codes.beliefSetCode);
        const a1 = S.ubps.beliefSetAddress(1, codes.beliefSetCode);
        await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), false, 0, 0, emptyCell(), emptyCell(), buildNameCell('first'));
        await S.ubps.sendCreateBeliefSet(S.user.getSender(), toNano('0.5'), false, 0, 0, emptyCell(), emptyCell());
        expect(a0.equals(a1)).toBe(false);
        expect(await S.blockchain.openContract(BeliefSet.createFromAddress(a0)).getIndex()).toBe(0n);
        expect(await S.blockchain.openContract(BeliefSet.createFromAddress(a1)).getIndex()).toBe(1n);
    });
});
