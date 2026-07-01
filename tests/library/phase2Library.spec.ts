// SPDX-License-Identifier: UNLICENSED
/**
 * Phase 2 unit + sandbox coverage for the live library-cell deploy path:
 *   - CLI precedence (CLI > env > off) + singleton/unknown rejection;
 *   - the masterchain keeper: libraries-dict keying, StateInit on wc -1, determinism;
 *   - library-aware contractCodes shape (library cell + isLibrary + fullCode);
 *   - the keeper's published library actually resolves a child in a sandbox.
 *
 * Pure pieces run fast; the two compile-backed tests share one compile via beforeAll.
 */
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import {
    compileAllContracts,
    buildFullContractCodes,
    buildLibraryAwareContractCodes,
    type CompiledContracts,
} from '../../scripts/lib/abiCore';
import {
    applyLibraryMode,
    resolveLibrarySelectionWithCli,
    toLibraryCell,
    buildSandboxLibs,
} from '../../scripts/lib/library';
import {
    buildLibrarianPlan,
    buildLibrariesDict,
    libraryKey,
    LIBRARIAN_WORKCHAIN,
} from '../../scripts/lib/librarian';
import { JettonMinter, jettonContentToCell } from '../../wrappers/tep/jetton/JettonMinter';
import { JettonWallet } from '../../wrappers/tep/jetton/JettonWallet';

// Deterministic fake admin for address math (the librarian's admin = deployer/owner).
const ADMIN = new Address(0, Buffer.alloc(32, 3));

describe('Phase 2 — CLI precedence (CLI > env > off)', () => {
    it('--no-library forces off, overriding DEPLOY_LIBRARY_MODE env', () => {
        const sel = resolveLibrarySelectionWithCli({ noLibrary: true }, { DEPLOY_LIBRARY_MODE: '1' });
        expect(sel.enabled).toBe(false);
    });

    it('--library enables with the default selection', () => {
        const sel = resolveLibrarySelectionWithCli({ library: true }, {});
        expect(sel.enabled).toBe(true);
        expect(sel.codes).toEqual(['jettonWallet', 'ship', 'coordinateCell']);
    });

    it('--library-codes implies enabled and sets the explicit list', () => {
        const sel = resolveLibrarySelectionWithCli({ libraryCodes: 'jettonWallet, ssmSlot' }, {});
        expect(sel.enabled).toBe(true);
        expect(sel.codes).toEqual(['jettonWallet', 'ssmSlot']);
    });

    it('falls back to env when no CLI flag is given', () => {
        expect(resolveLibrarySelectionWithCli({}, {}).enabled).toBe(false);
        expect(resolveLibrarySelectionWithCli({}, { DEPLOY_LIBRARY_MODE: 'on' }).enabled).toBe(true);
    });

    it('rejects a singleton selector from the CLI', () => {
        expect(() => resolveLibrarySelectionWithCli({ libraryCodes: 'gameManager' }, {})).toThrow(/singleton/);
        expect(() => resolveLibrarySelectionWithCli({ libraryCodes: 'nope' }, {})).toThrow(/unknown/);
    });
});

describe('Phase 2 — masterchain Librarian (SETLIBCODE publisher)', () => {
    let walletCode: Cell;
    let minterCode: Cell;
    let librarianCode: Cell;

    beforeAll(async () => {
        walletCode = await compile('JettonWallet');
        minterCode = await compile('JettonMinter');
        librarianCode = await compile('Librarian');
    }, 120000);

    it('buildLibrariesDict keys each code by its representation hash, public=true (sandbox seed)', () => {
        const dict = buildLibrariesDict([walletCode]);
        const key = libraryKey(walletCode);
        expect(dict.has(key)).toBe(true);
        const entry = dict.get(key)!;
        expect(entry.public).toBe(true);
        expect(entry.root.equals(walletCode)).toBe(true);
    });

    it('buildLibrarianPlan produces a deterministic wc -1 account publishing one code', () => {
        const a = buildLibrarianPlan(walletCode, ADMIN, librarianCode);
        const b = buildLibrarianPlan(walletCode, ADMIN, librarianCode);
        expect(a.address.workChain).toBe(LIBRARIAN_WORKCHAIN);
        expect(a.address.equals(b.address)).toBe(true); // deterministic
        expect(a.codeHash).toBe(walletCode.hash().toString('hex'));
        expect(a.publishedCode.equals(walletCode)).toBe(true);
    });

    it('a different published code yields a different librarian address', () => {
        const forWallet = buildLibrarianPlan(walletCode, ADMIN, librarianCode);
        const forMinter = buildLibrarianPlan(minterCode, ADMIN, librarianCode);
        expect(forWallet.address.equals(forMinter.address)).toBe(false);
    });

    it("a published library resolves a child in a sandbox (seeded libs)", async () => {
        const blockchain = await Blockchain.create();
        // The sandbox has no global-library context; seed the published root so a library
        // child can resolve it. The true global (wc -1) publish is proven only on a live run.
        blockchain.libs = buildSandboxLibs([walletCode]);

        const admin: SandboxContract<TreasuryContract> = await blockchain.treasury('admin');
        const holder: SandboxContract<TreasuryContract> = await blockchain.treasury('holder');

        const minter = blockchain.openContract(
            JettonMinter.createFromConfig(
                {
                    admin: admin.address,
                    content: jettonContentToCell({ type: 1, uri: 'https://example.com/j.json' }),
                    wallet_code: toLibraryCell(walletCode),
                },
                minterCode,
            ),
        );
        await minter.sendDeploy(admin.getSender(), toNano('0.1'));
        const mintAmount = toNano('42');
        const res = await minter.sendMint(admin.getSender(), holder.address, mintAmount, toNano('0.05'), toNano('0.2'));

        const walletAddr = await minter.getWalletAddress(holder.address);
        expect(res.transactions).toHaveTransaction({ from: minter.address, to: walletAddr, deploy: true, success: true });
        const wallet = blockchain.openContract(JettonWallet.createFromAddress(walletAddr));
        expect(await wallet.getJettonBalance()).toBe(mintAmount); // get-method resolved the library
    });
});

describe('Phase 2 — library-aware contractCodes', () => {
    let compiled: CompiledContracts;

    beforeAll(async () => {
        compiled = await compileAllContracts();
    }, 180000);

    it('disabled selection == buildFullContractCodes (default path unchanged)', () => {
        const { effective, wrapped } = applyLibraryMode(compiled, { enabled: false, codes: [] });
        expect(buildLibraryAwareContractCodes(compiled, effective, wrapped)).toEqual(buildFullContractCodes(compiled));
    });

    it('librarized entries publish the library cell + isLibrary + fullCode; others unchanged', () => {
        const { effective, wrapped } = applyLibraryMode(compiled, { enabled: true, codes: ['jettonWallet', 'ship', 'coordinateCell'] });
        const codes = buildLibraryAwareContractCodes(compiled, effective, wrapped);
        const full = buildFullContractCodes(compiled);

        // jettonWallet: primary entry describes the library cell (so its sha256(boc)
        // hash differs from the full code's); the full code is preserved in fullCode.
        expect(codes.jettonWallet.isLibrary).toBe(true);
        expect(codes.jettonWallet.fullCode?.hash).toBe(full.jettonWallet.hash);
        expect(codes.jettonWallet.hash).not.toBe(full.jettonWallet.hash);
        // The library-cell entry's hex must be the wrapped (library) cell, not the full code.
        expect(codes.jettonWallet.hex).toBe(toLibraryCell(compiled.jettonWalletCode).toBoc().toString('hex'));

        // ship + coordinateCell (nested) likewise.
        expect(codes.games.ton_race_game.ship.isLibrary).toBe(true);
        expect(codes.games.ton_race_game.ship.fullCode?.hash).toBe(full.games.ton_race_game.ship.hash);
        expect(codes.games.ton_race_game.coordinateCell.isLibrary).toBe(true);

        // A non-selected, code-only child (ssmSlot) and the game singleton are untouched.
        expect(codes.games.soulless_slot_machine.ssmSlot?.isLibrary).toBeUndefined();
        expect(codes.games.ton_race_game.game.isLibrary).toBeUndefined();
        expect(codes.games.ton_race_game.game.hash).toBe(full.games.ton_race_game.game.hash);
    });
});
