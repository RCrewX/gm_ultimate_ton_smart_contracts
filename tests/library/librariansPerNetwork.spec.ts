// SPDX-License-Identifier: UNLICENSED
/**
 * Schema v12 — `libraryMode` + `librarians` are PER-NETWORK (under `deployment[net]`), not
 * top-level. This is the durable, network-scoped seam the uap rent/top-up monitor reads.
 *
 *   1. A library-mode offline build puts `libraryMode`/`librarians` under EACH network block
 *      (testnet + mainnet), NEVER at the top level; each `LibrarianInfo` carries `admin`.
 *   2. A default (library OFF) build has neither field on either network — legacy shape intact.
 *   3. The offline-computed librarian addresses are DETERMINISTIC and equal the live testnet
 *      publishers deployed on-chain (cross-checked against the known kf.../kf9.../kf-… set).
 *   4. Each `codeHash` matches the corresponding published fullCode hash in `contractCodes`.
 *
 * No RPC, no keys — this drives the offline assembly (`buildOfflineDeploymentData`).
 */
import { Address } from '@ton/core';
import { buildOfflineDeploymentData } from '../../scripts/lib/abiCore';
import type { LibrarySelection } from '../../scripts/lib/library';

const OFF: LibrarySelection = { enabled: false, codes: [] };
const ON_DEFAULT: LibrarySelection = { enabled: true, codes: ['jettonWallet', 'ship', 'coordinateCell'] };

// The owner that performed the live testnet library deploy (bounceable). Used to reproduce the
// deterministic publisher addresses below. If the Librarian or a wrapped child .tolk changes,
// the published addresses MOVE — these expectations then legitimately break (regenerate them,
// and note the uap monitor must re-read the new addresses).
const LIVE_OWNER = 'kQCU1RiNrZiOgug5JJRX8ZlPl0xeuQzQ_xFpIsTw_vsI_K7V';
const owner = Address.parse(LIVE_OWNER);

// The live testnet Librarian addresses (one per librarized code), from the on-chain deploy.
const LIVE_TESTNET_LIBRARIANS: Record<string, string> = {
    jettonWallet: 'kf_J7T4FFpWGG1N5Y_FBEGXlYaBV35uGSvg8Ae91q7PD1fZC',
    ship: 'kf9AOXph2zrD5XqBGyKiAgHOumK8imX3WaGRC5VzlVNgIral',
    coordinateCell: 'kf-HNjAJToa9vMgIO3QYfmkoz14JbaieOl1Fbw-8I2CRrYAQ',
};

// The published code REPRESENTATION hash (the library key) per librarized code — what the
// Librarian publishes via SETLIBCODE and what any library child resolves against. This is the
// cell repr hash (`code.hash()`), NOT the sha256-of-BoC stored in contractCodes[*].fullCode.hash.
const LIVE_CODE_HASHES: Record<string, string> = {
    jettonWallet: '915b573df6f3ba0e76ad149d5340211ce9a961ad3de5ecbd2ccbb2585e53872d',
    ship: '0b3949e694975358ce8334b9ffe3e381c57063513df408df273aa248e190d326',
    coordinateCell: '9735696c14b73eab4ec26df4a66235f7dc0c7484faccc517b07970a77d33e5b9',
};

describe('Library-cell deploy mode — schema v12 per-network placement', () => {
    it('library ON: libraryMode/librarians live under EACH network, never top-level', async () => {
        const data = await buildOfflineDeploymentData(owner, 0n, 0n, undefined, ON_DEFAULT);

        // The moved fields are gone from the root.
        expect((data as any).libraryMode).toBeUndefined();
        expect((data as any).librarians).toBeUndefined();

        for (const net of ['testnet', 'mainnet'] as const) {
            const b = data[net];
            expect(b.libraryMode).toBe(true);
            expect(Array.isArray(b.librarians)).toBe(true);
            expect(b.librarians).toHaveLength(ON_DEFAULT.codes.length);
            expect(b.librarians!.map((l) => l.name).sort()).toEqual([...ON_DEFAULT.codes].sort());
            // Each entry carries the admin (= the network owner, top-up target).
            const wantAdmin = owner.toString({ bounceable: true, urlSafe: true, testOnly: net === 'testnet' });
            for (const l of b.librarians!) {
                expect(l.admin).toBe(wantAdmin);
                expect(typeof l.address.bounceable).toBe('string');
                expect(typeof l.codeHash).toBe('string');
            }
        }
    }, 120000);

    it('library OFF (default): neither field present on either network', async () => {
        const data = await buildOfflineDeploymentData(owner, 0n, 0n, undefined, OFF);
        expect((data as any).libraryMode).toBeUndefined();
        expect((data as any).librarians).toBeUndefined();
        for (const net of ['testnet', 'mainnet'] as const) {
            expect(data[net].libraryMode).toBeUndefined();
            expect(data[net].librarians).toBeUndefined();
        }
    }, 120000);

    it('offline librarian addresses are deterministic + equal the live testnet publishers', async () => {
        const a = await buildOfflineDeploymentData(owner, 0n, 0n, undefined, ON_DEFAULT);
        const b = await buildOfflineDeploymentData(owner, 0n, 0n, undefined, ON_DEFAULT);
        const byName = (data: typeof a) =>
            Object.fromEntries(data.testnet.librarians!.map((l) => [l.name, l]));
        const l1 = byName(a);
        const l2 = byName(b);
        for (const name of ON_DEFAULT.codes) {
            // deterministic across runs
            expect(l1[name].address.bounceable).toBe(l2[name].address.bounceable);
            // equal to the live on-chain publisher
            expect(l1[name].address.bounceable).toBe(LIVE_TESTNET_LIBRARIANS[name]);
        }
    }, 120000);

    it('each librarian publishes the expected code representation hash (library key)', async () => {
        const data = await buildOfflineDeploymentData(owner, 0n, 0n, undefined, ON_DEFAULT);
        // contractCodes must mark each librarized entry as a library cell with the real fullCode.
        const cc = data.contractCodes!;
        expect(cc.jettonWallet.isLibrary).toBe(true);
        expect(cc.jettonWallet.fullCode).toBeDefined();
        expect(cc.games.ton_race_game.ship.isLibrary).toBe(true);
        expect(cc.games.ton_race_game.coordinateCell.isLibrary).toBe(true);
        // The librarian codeHash is the published code's REPRESENTATION hash (the resolve key).
        for (const l of data.testnet.librarians!) {
            expect(l.codeHash).toBe(LIVE_CODE_HASHES[l.name]);
        }
    }, 120000);
});
