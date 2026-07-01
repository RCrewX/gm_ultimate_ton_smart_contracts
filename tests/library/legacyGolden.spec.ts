// SPDX-License-Identifier: UNLICENSED
/**
 * Phase 1 golden + invariants — the library-mode flag must be a true opt-in:
 *
 *   1. Mode OFF (default) is byte-for-byte the legacy path — it reproduces the
 *      committed deployment_latest.json codes and owner-derived addresses, and the
 *      disabled `applyLibraryMode` is a no-op (same Cell references).
 *   2. Mode ON yields DISTINCT addresses for code-bearing accounts (the wrapped child
 *      codes change their representation hash) while SINGLETON addresses are unchanged.
 *   3. Singleton codes are hard-blocked from library mode.
 *
 * No RPC, no keys — this drives the offline assembly point only.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Address } from '@ton/core';
import { buildOfflineDeploymentData } from '../../scripts/lib/abiCore';
import {
    applyLibraryMode,
    assertSelectable,
    resolveLibrarySelection,
    type LibrarySelection,
} from '../../scripts/lib/library';
import { compileAllContracts } from '../../scripts/lib/abiCore';

const OFF: LibrarySelection = { enabled: false, codes: [] };
const ON_DEFAULT: LibrarySelection = { enabled: true, codes: ['jettonWallet', 'ship', 'coordinateCell'] };

// Compare against a FROZEN, committed snapshot — NOT the mutable, gitignored
// deployment_info/deployment_latest.json (a `--library` run pollutes that file with
// isLibrary/fullCode entries and would falsely break this golden). Regenerate the
// fixture only when a .tolk change intentionally moves code hashes.
const deploymentJson = JSON.parse(
    readFileSync(join(__dirname, 'fixtures/legacyDeployment.json'), 'utf-8'),
);
const owner = Address.parse(deploymentJson.testnet.ownerAddress.bounceable);

describe('Library-cell deploy mode — Phase 1 flag + selective wrapping', () => {
    it('disabled applyLibraryMode is a no-op (same Cell references)', async () => {
        const compiled = await compileAllContracts();
        const { effective, wrapped } = applyLibraryMode(compiled, OFF);
        expect(wrapped).toHaveLength(0);
        for (const key of Object.keys(compiled) as Array<keyof typeof compiled>) {
            // Identity, not just equality — disabled mode must not re-wrap or clone codes.
            expect(effective[key]).toBe(compiled[key]);
        }
    }, 120000);

    it('mode OFF reproduces the frozen legacy snapshot codes + owner-derived addresses', async () => {
        const data = await buildOfflineDeploymentData(owner, 0n, 0n, undefined, OFF);

        // contractCodes are deterministic + owner-independent: every entry must match.
        expect(data.contractCodes).toEqual(deploymentJson.contractCodes);

        // Owner-derived addresses (independent of jetton content URI / ship-station id /
        // pubkey) must match the committed snapshot exactly.
        const t = data.testnet;
        const j = deploymentJson.testnet;
        expect(t.gameManager).toEqual(j.gameManager);
        expect(t.retranslator).toEqual(j.retranslator);
        expect(t.games!.ton_race_game!.game).toEqual(j.games.ton_race_game.game);
        expect(t.games!.ton_race_game!.ownerShip).toEqual(j.games.ton_race_game.ownerShip);
    }, 120000);

    it('mode ON yields distinct code-bearing addresses but identical singletons', async () => {
        const off = await buildOfflineDeploymentData(owner, 0n, 0n, undefined, OFF);
        const on = await buildOfflineDeploymentData(owner, 0n, 0n, undefined, ON_DEFAULT);

        const offT = off.testnet;
        const onT = on.testnet;

        // Singletons that neither use nor embed a librarized code keep their address.
        // GM data = {owner}; retranslator data = {GM, owner, active} — no child code.
        expect(onT.gameManager).toEqual(offT.gameManager);
        expect(onT.retranslator).toEqual(offT.retranslator);

        // Accounts whose CODE or DATA carries a librarized code get a NEW address —
        // this is the embedded-code propagation the analysis calls out:
        //  - jettonMinter STORAGE embeds wallet_code (now the library cell);
        //  - ownerJettonWallet uses the library wallet code (and the new minter addr);
        //  - game DATA embeds ship + coordinateCell codes (both librarized);
        //  - ownerShip CODE is the library ship code (and embeds coordinateCell code).
        expect(onT.jettonMinter).not.toEqual(offT.jettonMinter);
        expect(onT.ownerJettonWallet).not.toEqual(offT.ownerJettonWallet);
        expect(onT.games!.ton_race_game!.game).not.toEqual(offT.games!.ton_race_game!.game);
        expect(onT.games!.ton_race_game!.ownerShip).not.toEqual(offT.games!.ton_race_game!.ownerShip);

        // Library mode is internally self-consistent (deterministic across runs).
        const on2 = await buildOfflineDeploymentData(owner, 0n, 0n, undefined, ON_DEFAULT);
        expect(on2.testnet.games!.ton_race_game!.ownerShip).toEqual(onT.games!.ton_race_game!.ownerShip);
    }, 120000);

    it('singleton + unknown codes are hard-blocked from library mode', () => {
        expect(() => assertSelectable(['gameManager'])).toThrow(/singleton/);
        expect(() => assertSelectable(['jettonMinter'])).toThrow(/singleton/);
        expect(() => assertSelectable(['retranslator'])).toThrow(/singleton/);
        expect(() => assertSelectable(['not_a_real_code'])).toThrow(/unknown/);
        // Eligible mass-replicated codes pass.
        expect(() => assertSelectable(['jettonWallet', 'ship', 'coordinateCell'])).not.toThrow();
    });

    it('resolveLibrarySelection reads env (off by default, validates the list)', () => {
        expect(resolveLibrarySelection({}).enabled).toBe(false);
        const def = resolveLibrarySelection({ DEPLOY_LIBRARY_MODE: '1' });
        expect(def.enabled).toBe(true);
        expect(def.codes).toEqual(['jettonWallet', 'ship', 'coordinateCell']);
        const explicit = resolveLibrarySelection({ DEPLOY_LIBRARY_MODE: 'true', LIBRARY_CODES: 'jettonWallet, ssmSlot' });
        expect(explicit.codes).toEqual(['jettonWallet', 'ssmSlot']);
        expect(() => resolveLibrarySelection({ DEPLOY_LIBRARY_MODE: 'on', LIBRARY_CODES: 'gameManager' })).toThrow(/singleton/);
    });
});
