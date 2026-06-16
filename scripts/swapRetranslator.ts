#!/usr/bin/env ts-node
// SPDX-License-Identifier: UNLICENSED
/**
 * Retranslator (R*) HOT-SWAP script — swap the swappable "brain" without
 * redeploying GameManager (GM).
 *
 * It reads the LIVE old R* state, builds a new R* v(old+1) with MIGRATED mint
 * counters (the §4.2.1 crux — else item-address collisions), deploys it, copies
 * the registries verbatim via GM relay, repoints GM (`SetRetranslator`), verifies
 * continuity, and refreshes `deployment_info/deployment_latest.json`.
 *
 * SAFETY: dry-run by DEFAULT — it only READS the chain and prints the plan. It
 * sends NOTHING (no deploy, no repoint) unless you pass `--execute`. Deploy is the
 * operator's action; running with `--execute` requires PRIVATE_KEY/MNEMONIC in env.
 *
 * Usage:
 *   ts-node scripts/swapRetranslator.ts                 # testnet, DRY-RUN (read + plan only)
 *   ts-node scripts/swapRetranslator.ts --mainnet       # mainnet, DRY-RUN
 *   ts-node scripts/swapRetranslator.ts --execute       # testnet, ACTUALLY swap (operator)
 *   ts-node scripts/swapRetranslator.ts --mainnet --execute
 *   ts-node scripts/swapRetranslator.ts --version 7     # override the new R* version
 *
 * Pre-req: the system is already deployed (deployment_latest.json has gameManager +
 * retranslator for the chosen network). The mainnet runbook (scripts/RETRANSLATOR_SWAP_RUNBOOK.md)
 * covers the quiesce/drain/rollback procedure to wrap around `--execute` on mainnet.
 *
 * Environment (only needed for --execute):
 *   PRIVATE_KEY   128-hex private key, OR  MNEMONIC  24-word mnemonic
 */

import { toNano, beginCell, Address, Cell, internal } from '@ton/core';
import { compile } from '@ton/blueprint';
import { TonClient, WalletContractV4 } from '@ton/ton';
import { keyPairFromSecretKey, mnemonicToPrivateKey } from '@ton/crypto';
import * as dotenv from 'dotenv';

import { GameManager } from '../wrappers/game_manager/GameManager';
import { Retranslator } from '../wrappers/game_manager/Retranslator';
import {
    encodeSetJettonInfo,
    encodeSetGamesInfo,
    encodeSetToolsInfo,
    encodeSetAllowBurn,
} from '../wrappers/game_manager/RetranslatorTypes';
import { GAS_COST_REDIRECT_MESSAGE, GAS_COST_SET_RETRANSLATOR } from '../wrappers/game_manager/types';
import {
    Network,
    readDeploymentData,
    readNetworkDeploymentData,
    writeFullDeploymentData,
    formatAddress,
} from '../lib/buildOutput';
import { ProviderManager, getTonClientWithRateLimit, type Network as ProviderNetwork } from 'ton-provider-system';

dotenv.config();

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------
interface SwapOptions {
    network: Network;
    execute: boolean; // false => dry-run (read + plan only)
    newVersion?: bigint; // optional override; default = old + 1
}

function parseArgs(): SwapOptions {
    const args = process.argv.slice(2);
    let network: Network = 'testnet';
    let execute = false;
    let newVersion: bigint | undefined;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--mainnet') network = 'mainnet';
        else if (a === '--testnet') network = 'testnet';
        else if (a === '--execute') execute = true;
        else if (a === '--version' && args[i + 1]) newVersion = BigInt(args[++i]);
        else if (a === '--help' || a === '-h') {
            console.log('See file header for usage. Default is DRY-RUN; pass --execute to swap.');
            process.exit(0);
        }
    }
    return { network, execute, newVersion };
}

// ----------------------------------------------------------------------------
// Minimal send helpers (modeled on scripts/deploySystem.ts; only used on --execute)
// ----------------------------------------------------------------------------
async function loadWallet() {
    const pk = (process.env.PRIVATE_KEY || '').trim();
    const mn = (process.env.MNEMONIC || '').trim();
    let keyPair: { publicKey: Buffer; secretKey: Buffer };
    if (pk) {
        const clean = pk.startsWith('0x') ? pk.slice(2) : pk;
        if (clean.length !== 128) throw new Error(`PRIVATE_KEY must be 128 hex chars, got ${clean.length}`);
        keyPair = keyPairFromSecretKey(Buffer.from(clean, 'hex'));
    } else if (mn) {
        const words = mn.split(/\s+/).filter((w) => w.length > 0);
        if (words.length !== 24) throw new Error(`MNEMONIC must be 24 words, got ${words.length}`);
        keyPair = await mnemonicToPrivateKey(words);
    } else {
        throw new Error('--execute needs PRIVATE_KEY or MNEMONIC in env');
    }
    const wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
    return { wallet, keyPair };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getSeqno(client: TonClient, addr: Address, rl: <T>(f: () => Promise<T>) => Promise<T>): Promise<number> {
    try {
        const st = await rl(() => client.getContractState(addr));
        if (st.state !== 'active') return 0;
        const r = await rl(() => client.runMethod(addr, 'seqno'));
        return r.stack.readNumber();
    } catch {
        return 0;
    }
}

async function sendAndWait(
    client: TonClient,
    wallet: WalletContractV4,
    keyPair: { publicKey: Buffer; secretKey: Buffer },
    to: Address,
    value: bigint,
    rl: <T>(f: () => Promise<T>) => Promise<T>,
    op: string,
    body?: Cell,
    stateInit?: { code: Cell; data: Cell },
): Promise<void> {
    const before = await getSeqno(client, wallet.address, rl);
    const seqno = before;
    const transfer = wallet.createTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [internal({ to, value, body, init: stateInit, bounce: false })],
    });
    await rl(() => client.sendExternalMessage(wallet, transfer));
    console.log(`  · ${op}: sent (seqno ${seqno})`);
    const start = Date.now();
    while (Date.now() - start < 90000) {
        await sleep(2500);
        if ((await getSeqno(client, wallet.address, rl)) > before) {
            console.log(`  · ${op}: confirmed`);
            await sleep(4000);
            return;
        }
    }
    console.warn(`  · ${op}: NOT confirmed within timeout — verify manually`);
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main(): Promise<void> {
    const { network, execute, newVersion } = parseArgs();
    const isTestnet = network === 'testnet';

    console.log('\n=== Retranslator (R*) hot-swap ===');
    console.log(`Network : ${network}`);
    console.log(`Mode    : ${execute ? 'EXECUTE (will deploy + repoint)' : 'DRY-RUN (read + plan only — no sends)'}`);

    // Locate the live GM + R* from the published deployment.
    const netData = readNetworkDeploymentData(network, true);
    if (!netData?.gameManager || !netData.retranslator) {
        throw new Error(`deployment_latest.json has no gameManager/retranslator for ${network}; deploy the system first.`);
    }
    const gmAddress = Address.parse(netData.gameManager.bounceable);
    const oldRAddress = Address.parse(netData.retranslator.bounceable);
    console.log(`GameManager : ${gmAddress.toString()}`);
    console.log(`Old R*      : ${oldRAddress.toString()}`);

    // Connect (read-only is enough for the dry-run plan).
    const pm = ProviderManager.getInstance();
    await pm.init(network as ProviderNetwork);
    const { client, withRateLimit } = await getTonClientWithRateLimit(pm);

    const retranslatorCode = await compile('Retranslator');
    const gameManager = client.open(GameManager.createFromAddress(gmAddress));
    const oldR = client.open(Retranslator.createFromAddress(oldRAddress));

    // Sanity: GM must currently point at the R* the deployment file names.
    const gmPointsAt = await withRateLimit(() => gameManager.getRetranslatorAddress());
    if (!gmPointsAt.equals(oldRAddress)) {
        throw new Error(
            `GM points at ${gmPointsAt.toString()} but deployment_latest names ${oldRAddress.toString()}. Reconcile before swapping.`,
        );
    }

    // ---- READ live old R* state (the migration source of truth) ----
    const oldVersion = await withRateLimit(() => oldR.getVersion());
    const nextNftIndex = await withRateLimit(() => oldR.getNextNftIndex());
    const nextSbtIndex = await withRateLimit(() => oldR.getNextSbtIndex());
    const allowBurn = await withRateLimit(() => oldR.getAllowBurn());
    const jettonInfo = await withRateLimit(() => oldR.getJettonInfoCell()).catch(() => null);
    const gamesInfo = await withRateLimit(() => oldR.getGamesInfoCell()).catch(() => null);
    const toolsInfo = await withRateLimit(() => oldR.getToolsInfo()).catch(() => null);

    const targetVersion = newVersion ?? oldVersion + 1n;
    if (targetVersion <= oldVersion) throw new Error(`--version ${targetVersion} must be > current version ${oldVersion}`);

    // ---- BUILD new R* init with MIGRATED counters ----
    const newR = Retranslator.createFromConfig(
        {
            gameManagerAddress: gmAddress,
            ownerAddress: await withRateLimit(() => oldR.getOwner()),
            version: targetVersion,
            active: true,
            allow_burn: allowBurn,
            nextNftIndex, // migrated — prevents item-address collisions
            nextSbtIndex, // migrated
        },
        retranslatorCode,
    );

    console.log('\n--- MIGRATION PLAN ---');
    console.log(`version       : ${oldVersion}  ->  ${targetVersion}`);
    console.log(`nextNftIndex  : ${nextNftIndex} (migrated verbatim)`);
    console.log(`nextSbtIndex  : ${nextSbtIndex} (migrated verbatim)`);
    console.log(`allow_burn    : ${allowBurn}`);
    console.log(`registries    : jettonInfo=${jettonInfo ? 'copy' : 'none'} gamesInfo=${gamesInfo ? 'copy' : 'none'} toolsInfo=${toolsInfo ? 'copy' : 'none'}`);
    console.log(`new R* addr   : ${newR.address.toString()}`);
    if (newR.address.equals(oldRAddress)) throw new Error('computed new R* address == old R* — version did not change the address; abort.');
    console.log('steps         : deploy newR* -> seed registries via GM relay -> SetRetranslator(newR*) -> verify -> regen deployment json');

    if (!execute) {
        console.log('\nDRY-RUN complete. No messages were sent. Re-run with --execute (operator) to perform the swap.');
        return;
    }

    // ===================== EXECUTE (operator only) =====================
    console.log('\n--- EXECUTING SWAP ---');
    const { wallet, keyPair } = await loadWallet();
    const bal = await withRateLimit(() => client.getBalance(wallet.address));
    console.log(`Operator wallet: ${wallet.address.toString()}  balance ${(Number(bal) / 1e9).toFixed(3)} TON`);
    if (bal < toNano('1')) throw new Error('operator wallet balance < 1 TON; top up before swapping.');

    // 1) deploy new R*
    const alreadyThere = (await withRateLimit(() => client.getContractState(newR.address))).state === 'active';
    if (alreadyThere) {
        console.log('  · new R* already deployed; skipping deploy');
    } else {
        await sendAndWait(client, wallet, keyPair, newR.address, toNano('0.5'), withRateLimit, 'deploy newR*', beginCell().endCell(), {
            code: retranslatorCode,
            data: newR.init!.data,
        });
    }

    // 2) seed registries on new R* via GM relay (opaque copy)
    const relay = (body: Cell, op: string) =>
        sendAndWait(
            client,
            wallet,
            keyPair,
            gmAddress,
            GAS_COST_REDIRECT_MESSAGE + toNano('0.9'),
            withRateLimit,
            op,
            GameManager.redirectMessage(newR.address, body, toNano('0.9')),
        );
    if (jettonInfo) await relay(encodeSetJettonInfo({ jettonInfo }), 'seed jettonInfo');
    if (gamesInfo) await relay(encodeSetGamesInfo({ gamesInfo }), 'seed gamesInfo');
    if (toolsInfo) await relay(encodeSetToolsInfo({ toolsInfo }), 'seed toolsInfo');
    await relay(encodeSetAllowBurn({ allow_burn: allowBurn }), 'seed allowBurn');

    // 3) repoint GM atomically
    await sendAndWait(
        client,
        wallet,
        keyPair,
        gmAddress,
        GAS_COST_SET_RETRANSLATOR + toNano('0.05'),
        withRateLimit,
        'SetRetranslator(newR*)',
        GameManager.setRetranslatorMessage(newR.address),
    );

    // 4) verify continuity
    console.log('\n--- VERIFY ---');
    const newGmPointsAt = await withRateLimit(() => gameManager.getRetranslatorAddress());
    const newROpened = client.open(Retranslator.createFromAddress(newR.address));
    const vNew = await withRateLimit(() => newROpened.getVersion());
    const nftNew = await withRateLimit(() => newROpened.getNextNftIndex());
    const sbtNew = await withRateLimit(() => newROpened.getNextSbtIndex());
    const ok =
        newGmPointsAt.equals(newR.address) && vNew === targetVersion && nftNew === nextNftIndex && sbtNew === nextSbtIndex;
    console.log(`GM -> ${newGmPointsAt.toString()} (${newGmPointsAt.equals(newR.address) ? 'OK' : 'MISMATCH'})`);
    console.log(`version=${vNew} nextNft=${nftNew} nextSbt=${sbtNew} (${ok ? 'continuity OK' : 'CHECK FAILED'})`);
    if (!ok) throw new Error('post-swap verification FAILED — investigate before declaring the swap done.');

    // 5) refresh deployment_latest.json (R* address only; GM untouched)
    const full = readDeploymentData();
    full.timestamp = new Date().toISOString();
    full[network].retranslator = formatAddress(newR.address, isTestnet);
    writeFullDeploymentData(full);
    console.log('\nSwap complete. deployment_latest.json updated with the new R* address.');
    console.log(`Old R* (${oldRAddress.toString()}) is now inert (GM no longer routes to it). Keep it parked for rollback until the new R* is proven.`);
}

main().catch((e) => {
    console.error('\nswapRetranslator FAILED:', e?.message || e);
    process.exit(1);
});
