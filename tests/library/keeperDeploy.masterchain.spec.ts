// SPDX-License-Identifier: UNLICENSED
/**
 * Emulator root-cause for the masterchain library keeper (plan PART 1).
 *
 * Live testnet rejected the keeper (WalletContractV4 + `library` in StateInit, wc-1) both ways:
 * internal deploy → cskip_bad_state; external self-deploy → external rejected (VM never started).
 * `@ton/sandbox` runs the real TVM + transaction executor, so we reproduce it deterministically
 * here and capture the exact TransactionDescription — the clean signal we never had on testnet.
 *
 * This spec is DIAGNOSTIC first (it logs what the emulator does); the assertions encode whatever
 * the run reveals so it stays a regression guard.
 */
import { Blockchain } from '@ton/sandbox';
import { toNano, beginCell, storeStateInit, contractAddress, Address, Cell, type Message } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { WalletContractV4 } from '@ton/ton';
import { keyPairFromSecretKey } from '@ton/crypto';
import { buildKeeperStateInit, buildKeeperExternalDeploy, type KeeperPlan } from '../../scripts/lib/libraryKeeper';
import { toLibraryCell } from '../../scripts/lib/library';
import { JettonMinter, jettonContentToCell } from '../../wrappers/tep/jetton/JettonMinter';
import { JettonWallet } from '../../wrappers/tep/jetton/JettonWallet';

/** The compute-phase skip reason of a generic tx, or null if compute ran. */
function skipReason(tx: any): string | null {
    const d = tx.description;
    if (d.type === 'generic' && d.computePhase?.type === 'skipped') return d.computePhase.reason;
    return null;
}

function describeTx(tag: string, tx: any): string {
    const d = tx.description;
    if (d.type === 'generic') {
        const cp = d.computePhase;
        const compute = cp.type === 'skipped'
            ? `compute=SKIPPED(${cp.reason})`
            : `compute=vm(success=${cp.success},exit=${cp.exitCode},steps=${cp.vmSteps})`;
        const action = d.actionPhase ? `action(success=${d.actionPhase.success},result=${d.actionPhase.resultCode})` : 'action=none';
        const aborted = d.aborted ? ' ABORTED' : '';
        return `${tag} ${compute} ${action}${aborted}`;
    }
    return `${tag} desc=${d.type}`;
}

describe('Keeper masterchain deploy — emulator root-cause', () => {
    let blockchain: Blockchain;
    let kp: { publicKey: Buffer; secretKey: Buffer };
    let keeper: KeeperPlan;

    beforeAll(async () => {
        const code = await compile('JettonWallet');
        kp = keyPairFromSecretKey(Buffer.alloc(64, 9));
        keeper = buildKeeperStateInit([code], kp.publicKey);
        console.log('keeper address:', keeper.address.toString(), '(wc', keeper.address.workChain, ')');
        console.log('keeper libraries:', keeper.stateInit.libraries?.size);
    }, 120000);

    beforeEach(async () => {
        blockchain = await Blockchain.create();
    });

    it('CONTROL: same WalletV4 on wc-1 WITHOUT libraries — does it initialize?', async () => {
        // Isolate the `library` field: deploy a plain WalletV4 on wc-1 (no libraries) via the
        // same direct-inject path. If THIS goes active, the library field is the sole culprit.
        const w = WalletContractV4.create({ publicKey: kp.publicKey, workchain: -1 });
        const msg: Message = {
            info: {
                type: 'internal', src: new Address(-1, Buffer.alloc(32, 1)), dest: w.address,
                value: { coins: toNano('5') }, ihrDisabled: true, bounce: false, bounced: false,
                ihrFee: 0n, forwardFee: 0n, createdLt: 0n, createdAt: 0,
            },
            init: w.init,
            body: beginCell().endCell(),
        };
        const res = await blockchain.sendMessage(msg);
        res.transactions.forEach((tx, i) => console.log(describeTx(`[control-nolib tx${i}]`, tx)));
        const sc = await blockchain.getContract(w.address);
        console.log('[control-nolib] wallet state:', sc.accountState?.type, '| balance', (Number(sc.balance) / 1e9).toFixed(4));
        // Same wallet, same wc-1, same deploy path — WITHOUT libraries it initializes fine.
        expect(sc.accountState?.type).toBe('active');
    });

    it('DIRECT-INJECT internal (no forwarding) — is the delivered init applied?', async () => {
        // Inject the internal message straight into the executor with the EXACT init cell,
        // bypassing any forwarding contract that might re-serialize/drop libraries.
        const msg: Message = {
            info: {
                type: 'internal', src: new Address(-1, Buffer.alloc(32, 1)), dest: keeper.address,
                value: { coins: toNano('5') }, ihrDisabled: true, bounce: false, bounced: false,
                ihrFee: 0n, forwardFee: 0n, createdLt: 0n, createdAt: 0,
            },
            init: keeper.stateInit,
            body: beginCell().endCell(),
        };
        // Confirm the init we inject hashes to the address (parity holds at injection).
        const injectedHash = beginCell().store(storeStateInit(keeper.stateInit)).endCell().hash().toString('hex');
        console.log('[direct] injected init libraries:', keeper.stateInit.libraries?.size, '| hash==address:', injectedHash === keeper.address.hash.toString('hex'));
        const res = await blockchain.sendMessage(msg);
        res.transactions.forEach((tx, i) => {
            console.log(describeTx(`[direct tx${i}]`, tx));
            const inInit = tx.inMessage?.init;
            if (inInit) {
                const h = beginCell().store(storeStateInit(inInit)).endCell().hash().toString('hex');
                console.log(`  [direct tx${i}] delivered init libs=${inInit.libraries?.size} hash==address=${h === keeper.address.hash.toString('hex')}`);
            }
        });
        const sc = await blockchain.getContract(keeper.address);
        console.log('[direct] keeper state:', sc.accountState?.type, '| balance', (Number(sc.balance) / 1e9).toFixed(4), 'TON');
        // ROOT CAUSE: the delivered init carries the libraries AND hashes to the address,
        // yet the executor refuses to APPLY a StateInit containing a `library` field —
        // compute is skipped with `bad-state` and the account stays uninit.
        expect(skipReason(res.transactions[0])).toBe('bad-state');
        expect(sc.accountState?.type).toBe('uninit');
    });

    it('INTERNAL deploy via forwarding treasury (value + StateInit-with-libraries)', async () => {
        const deployer = await blockchain.treasury('deployer');
        const res = await deployer.send({ to: keeper.address, value: toNano('5'), init: keeper.stateInit, bounce: false });
        res.transactions.forEach((tx, i) => {
            console.log(describeTx(`[internal tx${i}]`, tx));
            const inInit = tx.inMessage?.init;
            if (inInit) {
                const h = beginCell().store(storeStateInit(inInit)).endCell().hash().toString('hex');
                console.log(`  [internal tx${i}] delivered init libs=${inInit.libraries?.size} hash==address=${h === keeper.address.hash.toString('hex')}`);
            }
        });
        const sc = await blockchain.getContract(keeper.address);
        console.log('[internal] keeper state:', sc.accountState?.type, '| balance', (Number(sc.balance) / 1e9).toFixed(4), 'TON');
        expect(sc.accountState?.type).toBe('uninit'); // same rejection through a real forwarder
    });

    it('FIX: SETLIBCODE publisher (no library in StateInit) goes ACTIVE on wc-1', async () => {
        const jettonWalletCode = await compile('JettonWallet');
        const keeperCode = await compile('LibraryKeeper');
        // Storage: struct LibraryKeeperStorage { code: cell; published: bool } →
        // storeRef(code) + storeBit(published).
        const data = beginCell().storeRef(jettonWalletCode).storeBit(false).endCell();
        const init = { code: keeperCode, data }; // NO `library` field — deploys normally.
        const addr = contractAddress(-1, init);
        console.log('[fix] publisher address:', addr.toString(), '(wc', addr.workChain, ')');

        const msg: Message = {
            info: {
                type: 'internal', src: new Address(-1, Buffer.alloc(32, 1)), dest: addr,
                value: { coins: toNano('5') }, ihrDisabled: true, bounce: false, bounced: false,
                ihrFee: 0n, forwardFee: 0n, createdLt: 0n, createdAt: 0,
            },
            init,
            body: beginCell().endCell(),
        };
        const res = await blockchain.sendMessage(msg);
        res.transactions.forEach((tx, i) => console.log(describeTx(`[fix tx${i}]`, tx)));
        const sc = await blockchain.getContract(addr);
        console.log('[fix] publisher state:', sc.accountState?.type, '| balance', (Number(sc.balance) / 1e9).toFixed(4));
        // The whole point: a SETLIBCODE publisher (no library in StateInit) INITIALIZES,
        // unlike the WalletV4+library-in-StateInit keeper (bad-state) above.
        expect(sc.accountState?.type).toBe('active');

        // Best-effort: does @ton/sandbox resolve the published library from account state?
        // (Plan PART 1.3: it may not model global publish; if so, the true proof is the live run.)
        try {
            const admin = await blockchain.treasury('admin');
            const holder = await blockchain.treasury('holder');
            const minterCode = await compile('JettonMinter');
            const minter = blockchain.openContract(JettonMinter.createFromConfig(
                { admin: admin.address, content: jettonContentToCell({ type: 1, uri: 'x' }), wallet_code: toLibraryCell(jettonWalletCode) },
                minterCode,
            ));
            await minter.sendDeploy(admin.getSender(), toNano('0.1'));
            await minter.sendMint(admin.getSender(), holder.address, toNano('10'), toNano('0.05'), toNano('0.2'));
            const w = blockchain.openContract(JettonWallet.createFromAddress(await minter.getWalletAddress(holder.address)));
            const bal = await w.getJettonBalance();
            console.log('[fix] library resolved from published account state? balance =', bal.toString(), '(non-zero ⇒ emulator models global publish)');
        } catch (e: any) {
            console.log('[fix] emulator did NOT resolve the library from account state (expected — seed blockchain.libs or verify on live):', (e?.message || e).slice(0, 80));
        }
    });

    it('EXTERNAL self-deploy (fund first, then external init) — emulator behavior', async () => {
        const deployer = await blockchain.treasury('deployer');
        await deployer.send({ to: keeper.address, value: toNano('5'), bounce: false }); // fund, no init
        const before = await blockchain.getContract(keeper.address);
        console.log('[external] pre-deploy keeper state:', before.accountState?.type, '| balance', (Number(before.balance) / 1e9).toFixed(4));
        const ext = await buildKeeperExternalDeploy(keeper, kp);
        try {
            const res = await blockchain.sendMessage(ext);
            res.transactions.forEach((tx, i) => console.log(describeTx(`[external tx${i}]`, tx)));
        } catch (e: any) {
            console.log('[external] sendMessage threw:', e?.message || e);
        }
        const sc = await blockchain.getContract(keeper.address);
        console.log('[external] keeper state:', sc.accountState?.type, '| balance', (Number(sc.balance) / 1e9).toFixed(4), 'TON');
        // External self-deploy is ALSO rejected (external not accepted) — the account can't
        // initialize from a library-bearing StateInit regardless of transport.
        expect(sc.accountState?.type).toBe('uninit');
    });
});
