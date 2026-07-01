// SPDX-License-Identifier: UNLICENSED
/**
 * Root-cause regression (plan §6.1) — locks in WHY a public library must be published by a
 * running masterchain contract (Librarian, SETLIBCODE), NOT via a StateInit `library` field.
 *
 * @ton/sandbox runs the real TVM + transaction executor, so both facts are proven
 * deterministically here (the clean signal the live testnet never gave):
 *   (a) a WalletV4 whose StateInit carries a `library` dict, on wc -1, is REJECTED — compute
 *       is skipped with `bad-state` and the account stays UNINIT (this is the retired keeper);
 *   (b) the `Librarian` (plain {code,data} StateInit, SETLIBCODE at runtime) on wc -1 goes
 *       ACTIVE and its publish path runs (published==true, a SETLIBCODE action is emitted).
 */
import { Blockchain } from '@ton/sandbox';
import {
    toNano, beginCell, storeStateInit, contractAddress, Address, Cell, Dictionary, type Message,
} from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { WalletContractV4 } from '@ton/ton';
import { keyPairFromSecretKey } from '@ton/crypto';
import { SimpleLibraryValue, libraryKey } from '../../scripts/lib/librarian';
import { Librarian } from '../../wrappers/librarian/Librarian';

/** The compute-phase skip reason of a tx, or null if compute ran. */
function skipReason(tx: any): string | null {
    const d = tx.description;
    if (d.type === 'generic' && d.computePhase?.type === 'skipped') return d.computePhase.reason;
    return null;
}

/** actionPhase {success,total} for the tx that landed on `addr`, or null. */
function actionOnAccount(res: any, addr: Address): { success: boolean; total: number } | null {
    const tx = res.transactions.find(
        (t: any) => t.inMessage?.info?.type === 'internal' && t.inMessage.info.dest?.equals?.(addr),
    );
    const d = tx?.description;
    if (d?.type === 'generic' && d.actionPhase) return { success: d.actionPhase.success, total: d.actionPhase.totalActions };
    return null;
}

describe('Root cause — StateInit.library rejected; Librarian (SETLIBCODE) active (wc -1)', () => {
    let blockchain: Blockchain;
    let jettonWalletCode: Cell;
    let librarianCode: Cell;
    const kp = keyPairFromSecretKey(Buffer.alloc(64, 9));

    beforeAll(async () => {
        jettonWalletCode = await compile('JettonWallet');
        librarianCode = await compile('Librarian');
    }, 120000);

    beforeEach(async () => {
        blockchain = await Blockchain.create();
    });

    it('(a) WalletV4 with a `library` in StateInit on wc -1 → bad-state / UNINIT', async () => {
        // Build the retired keeper StateInit inline (WalletV4 + a `libraries` dict on wc -1).
        const w = WalletContractV4.create({ publicKey: kp.publicKey, workchain: -1 });
        const libraries = Dictionary.empty(Dictionary.Keys.BigUint(256), SimpleLibraryValue);
        libraries.set(libraryKey(jettonWalletCode), { public: true, root: jettonWalletCode });
        const stateInit = { code: w.init!.code, data: w.init!.data, libraries };
        const initCell = beginCell().store(storeStateInit(stateInit)).endCell();
        const address = new Address(-1, initCell.hash());

        // Direct-inject the internal deploy with the EXACT init (parity holds at injection).
        const injectedHash = beginCell().store(storeStateInit(stateInit)).endCell().hash().toString('hex');
        expect(injectedHash).toBe(address.hash.toString('hex'));

        const msg: Message = {
            info: {
                type: 'internal', src: new Address(-1, Buffer.alloc(32, 1)), dest: address,
                value: { coins: toNano('5') }, ihrDisabled: true, bounce: false, bounced: false,
                ihrFee: 0n, forwardFee: 0n, createdLt: 0n, createdAt: 0,
            },
            init: stateInit,
            body: beginCell().endCell(),
        };
        const res = await blockchain.sendMessage(msg);
        const sc = await blockchain.getContract(address);
        // The executor refuses to APPLY a StateInit containing a `library` field.
        expect(skipReason(res.transactions[0])).toBe('bad-state');
        expect(sc.accountState?.type).toBe('uninit');
    });

    it('(b) Librarian (SETLIBCODE, no library in StateInit) on wc -1 → ACTIVE + published', async () => {
        const admin = await blockchain.treasury('admin');
        const librarian = blockchain.openContract(
            Librarian.createFromConfig({ adminAddress: admin.address, code: jettonWalletCode }, librarianCode),
        );
        expect(librarian.address.workChain).toBe(-1);

        const res = await librarian.sendDeploy(admin.getSender(), toNano('3'));
        // The account initializes (unlike the library-bearing keeper above)...
        expect((await blockchain.getContract(librarian.address)).accountState?.type).toBe('active');
        // ...and its genesis publish ran: `published` flipped and a SETLIBCODE output action fired.
        expect(await librarian.getPublished()).toBe(true);
        expect(await librarian.getCodeHash()).toBe(BigInt('0x' + jettonWalletCode.hash().toString('hex')));
        const action = actionOnAccount(res, librarian.address);
        expect(action?.success).toBe(true);
        expect(action?.total).toBeGreaterThanOrEqual(1); // the SETLIBCODE action

        // Comparison target: the same publisher on a NON-masterchain workchain is refused by
        // the wrapper — a public library can only be published from wc -1.
        expect(() =>
            Librarian.createFromConfig({ adminAddress: admin.address, code: jettonWalletCode }, librarianCode, 0),
        ).toThrow(/workchain/i);
    });
});
