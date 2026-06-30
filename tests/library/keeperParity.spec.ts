// SPDX-License-Identifier: UNLICENSED
/**
 * Keeper StateInit parity — the guard against the "funded keeper stays uninit" failure.
 *
 * A masterchain account only initializes if the delivered StateInit hashes to its address.
 * The deploy address is derived from `storeKeeperStateInitCell` (with libraries); the wallet
 * send path serializes via `@ton/core` `storeStateInit`. Both MUST agree, and they must carry
 * the libraries. `assertInitParity` is the pre-send gate; these tests prove it accepts a real
 * keeper and REJECTS a library-less / mismatched init (the exact class of the live incident).
 */
import { beginCell, storeStateInit } from '@ton/core';
import { Cell } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import {
    buildKeeperStateInit,
    assertInitParity,
    storeKeeperStateInitCell,
    type KeeperPlan,
} from '../../scripts/lib/libraryKeeper';

const PUBKEY = Buffer.alloc(32, 7);

describe('Keeper StateInit parity (uninit guard)', () => {
    let code: Cell;
    let altCode: Cell;

    beforeAll(async () => {
        code = await compile('JettonWallet');
        altCode = await compile('JettonMinter');
    }, 120000);

    it('address == storeKeeperStateInitCell hash == storeStateInit hash (libraries included)', () => {
        const k = buildKeeperStateInit([code], PUBKEY);
        const addrHash = k.address.hash.toString('hex');
        expect(k.initCell.hash().toString('hex')).toBe(addrHash);
        expect(storeKeeperStateInitCell(k.stateInit).hash().toString('hex')).toBe(addrHash);
        // What the wallet send path (createTransfer → storeMessageRelaxed) will serialize:
        const deliverable = beginCell().store(storeStateInit(k.stateInit)).endCell();
        expect(deliverable.hash().toString('hex')).toBe(addrHash);
        expect(k.stateInit.libraries?.size).toBe(1);
    });

    it('assertInitParity accepts a real keeper', () => {
        expect(() => assertInitParity(buildKeeperStateInit([code], PUBKEY))).not.toThrow();
    });

    it('assertInitParity REJECTS a library-less delivered init (the live-incident class)', () => {
        const k = buildKeeperStateInit([code], PUBKEY);
        // Simulate the feared bug: the message would serialize a StateInit WITHOUT libraries,
        // while the address still embeds them. The delivered hash then ≠ the address.
        const tampered: KeeperPlan = {
            ...k,
            stateInit: { ...k.stateInit, libraries: undefined },
        };
        expect(() => assertInitParity(tampered)).toThrow(/parity|libraries/i);
    });

    it('assertInitParity REJECTS an address/init mismatch', () => {
        const k = buildKeeperStateInit([code], PUBKEY);
        const other = buildKeeperStateInit([altCode], PUBKEY);
        const mismatched: KeeperPlan = { ...k, address: other.address };
        expect(() => assertInitParity(mismatched)).toThrow(/parity|inconsistency/i);
    });
});
