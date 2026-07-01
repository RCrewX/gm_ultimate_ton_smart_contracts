// SPDX-License-Identifier: UNLICENSED
/**
 * Library resolution (plan §6.3) — proves the CHILD side of library-cell deploy mode.
 *
 * A library-mode child stores its code as a library REFERENCE cell (tag 0x02 + the real
 * code's representation hash). It only executes once the real code is resolvable. On-chain
 * that resolution comes from the masterchain global library the `Librarian` publishes; the
 * @ton/sandbox has NO global-library context, so here we seed `blockchain.libs` with the
 * published root (exactly the code the Librarian publishes) and prove:
 *   - a JettonMinter whose wallet_code is the library cell mints + deploys a wallet;
 *   - the wallet's get-method (get_wallet_data) RESOLVES (library resolved from the seed);
 *   - the deployed wallet address == the off-chain address derived from the SAME library cell.
 *
 * The seed key is the Librarian's published `codeHash`, tying this child-side proof to the
 * publisher. The true GLOBAL publish (wc -1) is proven only on the live acceptance run.
 */
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { toLibraryCell, buildSandboxLibs } from '../../scripts/lib/library';
import { buildLibrarianPlan } from '../../scripts/lib/librarian';
import { JettonMinter, jettonContentToCell } from '../../wrappers/tep/jetton/JettonMinter';
import { JettonWallet } from '../../wrappers/tep/jetton/JettonWallet';

describe('Library resolution — child resolves the published code (seeded libs)', () => {
    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let holder: SandboxContract<TreasuryContract>;
    let jettonWalletCode: Cell;
    let jettonMinterCode: Cell;
    let librarianCode: Cell;
    let walletLibraryCell: Cell;

    beforeAll(async () => {
        jettonWalletCode = await compile('JettonWallet');
        jettonMinterCode = await compile('JettonMinter');
        librarianCode = await compile('Librarian');
        walletLibraryCell = toLibraryCell(jettonWalletCode);
    }, 120000);

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        // Seed the published root — the SAME code a Librarian publishes for `jettonWallet`.
        blockchain.libs = buildSandboxLibs([jettonWalletCode]);
        admin = await blockchain.treasury('admin');
        holder = await blockchain.treasury('holder');
    });

    it('the seed key equals the Librarian’s published code hash (publisher ↔ resolution link)', () => {
        const plan = buildLibrarianPlan(jettonWalletCode, admin.address, librarianCode);
        // The library reference cell embeds exactly the code hash the Librarian publishes.
        expect(walletLibraryCell.bits.length).toBe(8 + 256); // tag(8) + repr hash(256)
        expect(plan.codeHash).toBe(jettonWalletCode.hash().toString('hex'));
    });

    it('a library-mode wallet deploys, resolves get_wallet_data, and matches the off-chain address', async () => {
        const minter = blockchain.openContract(
            JettonMinter.createFromConfig(
                {
                    admin: admin.address,
                    content: jettonContentToCell({ type: 1, uri: 'https://example.com/j.json' }),
                    wallet_code: walletLibraryCell,
                },
                jettonMinterCode,
            ),
        );
        await minter.sendDeploy(admin.getSender(), toNano('0.1'));

        const mintAmount = toNano('123');
        const res = await minter.sendMint(admin.getSender(), holder.address, mintAmount, toNano('0.05'), toNano('0.2'));

        const walletAddr = await minter.getWalletAddress(holder.address);
        // The wallet was deployed by the minter and initialized successfully...
        expect(res.transactions).toHaveTransaction({ from: minter.address, to: walletAddr, deploy: true, success: true });

        // ...its get-method resolves (the library was resolved from the seed)...
        const wallet = blockchain.openContract(JettonWallet.createFromAddress(walletAddr));
        expect(await wallet.getJettonBalance()).toBe(mintAmount);

        // ...and the on-chain address equals the off-chain address derived from the SAME
        // library cell (library mode is address-consistent, and NOT the full-code address).
        const offchainLibrary = JettonWallet.createFromConfig(
            { ownerAddress: holder.address, minterAddress: minter.address }, walletLibraryCell,
        );
        expect(offchainLibrary.address.equals(walletAddr)).toBe(true);
        const offchainFull = JettonWallet.createFromConfig(
            { ownerAddress: holder.address, minterAddress: minter.address }, jettonWalletCode,
        );
        expect(offchainFull.address.equals(walletAddr)).toBe(false);
    });
});
