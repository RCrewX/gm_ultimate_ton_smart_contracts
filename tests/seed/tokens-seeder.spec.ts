// SPDX-License-Identifier: UNLICENSED
/**
 * Sandbox proof of the tokens seeder's core sequence: deploy a plain jetton master
 * (admin = the signing operator) and mint `amount` raw units to a recipient. This is the
 * exact deploy→mint the live seeder performs (admin = deployer; recipient = --owner),
 * verified against an in-memory blockchain — it replaces a live run for correctness.
 */
import { Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { JettonMinter } from '../../wrappers/tep/jetton/JettonMinter';
import { JettonWallet } from '../../wrappers/tep/jetton/JettonWallet';
import { tokenMaster } from '../../scripts/seed/tokensModule';

describe('tokens seeder — deploy master + mint to recipient', () => {
    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;     // the "deployer" (admin/minter)
    let recipient: SandboxContract<TreasuryContract>; // the "--owner" (mint recipient)
    let jettonMinterCode: Cell;
    let jettonWalletCode: Cell;

    beforeAll(async () => {
        jettonMinterCode = await compile('JettonMinter');
        jettonWalletCode = await compile('JettonWallet');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        admin = await blockchain.treasury('admin');
        recipient = await blockchain.treasury('recipient');
    });

    it('mints exactly 1,000,000 raw units of token A to the recipient', async () => {
        const AMOUNT = 1_000_000n;
        const master = blockchain.openContract(tokenMaster(admin.address, 'A', jettonMinterCode, jettonWalletCode));

        const dep = await master.sendDeploy(admin.getSender(), toNano('0.5'));
        expect(dep.transactions).toHaveTransaction({ from: admin.address, to: master.address, deploy: true, success: true });

        // admin (== deployer) mints to the recipient (== --owner)
        await master.sendMint(admin.getSender(), recipient.address, AMOUNT, toNano('0.1'), toNano('0.2'));

        const wAddr = await master.getWalletAddress(recipient.address);
        const wallet = blockchain.openContract(JettonWallet.createFromAddress(wAddr));
        expect(await wallet.getJettonBalance()).toBe(AMOUNT);
        expect(await master.getTotalSupply()).toBe(AMOUNT);
        // admin is the on-chain minter authority
        expect(await master.getAdminAddress()).toEqualAddress(admin.address);
    });

    it('the 5 labelled masters A–E are independent (distinct addresses)', () => {
        const labels = ['A', 'B', 'C', 'D', 'E'];
        const addrs = labels.map(l => tokenMaster(admin.address, l, jettonMinterCode, jettonWalletCode).address.toRawString());
        expect(new Set(addrs).size).toBe(labels.length);
    });

    it('re-mint tops up a partial balance to exactly the target amount', async () => {
        const TARGET = 1_000_000n;
        const master = blockchain.openContract(tokenMaster(admin.address, 'B', jettonMinterCode, jettonWalletCode));
        await master.sendDeploy(admin.getSender(), toNano('0.5'));

        // first mint a partial amount, then top up the shortfall (what the idempotent seeder does)
        await master.sendMint(admin.getSender(), recipient.address, 400_000n, toNano('0.1'), toNano('0.2'));
        const wAddr = await master.getWalletAddress(recipient.address);
        const wallet = blockchain.openContract(JettonWallet.createFromAddress(wAddr));
        const bal = await wallet.getJettonBalance();
        await master.sendMint(admin.getSender(), recipient.address, TARGET - bal, toNano('0.1'), toNano('0.2'));
        expect(await wallet.getJettonBalance()).toBe(TARGET);
    });
});
