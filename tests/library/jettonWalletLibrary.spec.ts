// SPDX-License-Identifier: UNLICENSED
/**
 * Phase 0 PoC — prove a library-mode child deploys, resolves at run time, and matches
 * the off-chain address computed from the SAME library cell.
 *
 * A JettonMinter is deployed whose `wallet_code` is the JettonWallet code wrapped as a
 * library reference cell. Minting must deploy a wallet whose code is that library cell,
 * the wallet's get-method must run (library resolved via blockchain.libs), and its
 * address must equal the off-chain `createFromConfig(..., libraryCell)` address — and
 * differ from the legacy (full-code) address (the two modes are distinct, not mixable).
 */
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { JettonMinter, jettonContentToCell } from '../../wrappers/tep/jetton/JettonMinter';
import { JettonWallet } from '../../wrappers/tep/jetton/JettonWallet';
import { toLibraryCell, buildSandboxLibs } from '../../scripts/lib/library';

describe('Library-cell deploy mode — PoC (jetton wallet)', () => {
    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let holder: SandboxContract<TreasuryContract>;
    let jettonWalletCode: Cell;
    let jettonMinterCode: Cell;
    let walletLibraryCell: Cell;

    beforeAll(async () => {
        jettonWalletCode = await compile('JettonWallet');
        jettonMinterCode = await compile('JettonMinter');
        walletLibraryCell = toLibraryCell(jettonWalletCode);
    }, 120000);

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        // Register the real JettonWallet code in the library context so a library-mode
        // wallet can resolve + execute. Without this seed the wallet would be inert.
        blockchain.libs = buildSandboxLibs([jettonWalletCode]);
        admin = await blockchain.treasury('admin');
        holder = await blockchain.treasury('holder');
    });

    afterEach(() => {
        blockchain = null as any;
    });

    it('library cell is the 0x02 exotic tag + the full code representation hash', () => {
        expect(walletLibraryCell.isExotic).toBe(true);
        // 8-bit tag + 256-bit hash = 264 bits.
        expect(walletLibraryCell.bits.length).toBe(264);
        const slice = walletLibraryCell.beginParse(true); // allowExotic
        expect(slice.loadUint(8)).toBe(2);
        expect(slice.loadBuffer(32).toString('hex')).toBe(jettonWalletCode.hash().toString('hex'));
    });

    it('a library-mode jetton wallet deploys, resolves, and matches the off-chain address', async () => {
        const minter = blockchain.openContract(
            JettonMinter.createFromConfig(
                {
                    admin: admin.address,
                    content: jettonContentToCell({ type: 1, uri: 'https://example.com/jetton.json' }),
                    wallet_code: walletLibraryCell, // <-- library cell, not full code
                },
                jettonMinterCode,
            ),
        );

        const deployRes = await minter.sendDeploy(admin.getSender(), toNano('0.1'));
        expect(deployRes.transactions).toHaveTransaction({
            from: admin.address,
            to: minter.address,
            deploy: true,
            success: true,
        });

        // The minter stores the library cell as wallet_code; its get-method derives the
        // holder wallet address from it.
        const onChainWalletAddr = await minter.getWalletAddress(holder.address);

        // Off-chain derivation MUST use the SAME library cell to match.
        const offChainLibraryAddr = JettonWallet.createFromConfig(
            { ownerAddress: holder.address, minterAddress: minter.address },
            walletLibraryCell,
        ).address;
        expect(onChainWalletAddr.equals(offChainLibraryAddr)).toBe(true);

        // The legacy (full-code) address is a DIFFERENT account — modes are mutually
        // exclusive, so this guards against accidentally mixing them.
        const legacyAddr = JettonWallet.createFromConfig(
            { ownerAddress: holder.address, minterAddress: minter.address },
            jettonWalletCode,
        ).address;
        expect(onChainWalletAddr.equals(legacyAddr)).toBe(false);

        // Mint to the holder: this DEPLOYS the wallet whose code is the library cell.
        const mintAmount = toNano('100');
        const mintRes = await minter.sendMint(
            admin.getSender(),
            holder.address,
            mintAmount,
            toNano('0.05'),
            toNano('0.2'),
        );

        // Wallet account was deployed at the library-mode address and ran successfully
        // (it could only execute internal_transfer by resolving the library code).
        expect(mintRes.transactions).toHaveTransaction({
            from: minter.address,
            to: onChainWalletAddr,
            deploy: true,
            success: true,
        });

        // Get-method runs (library resolved) and returns the minted balance.
        const wallet = blockchain.openContract(JettonWallet.createFromAddress(onChainWalletAddr));
        const balance = await wallet.getJettonBalance();
        expect(balance).toBe(mintAmount);
    });
});
