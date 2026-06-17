#!/usr/bin/env ts-node
// SPDX-License-Identifier: UNLICENSED
/**
 * Retranslator (R*) HOT-SWAP script (standalone CLI) — swap the swappable "brain"
 * without redeploying GameManager (GM).
 *
 * The swap flow itself lives in scripts/lib/swapRetranslator.ts (shared with retro
 * mode of scripts/deploySystem.ts). This file is just the CLI: parse args, connect,
 * supply the operator `send` primitive, and call `runRetranslatorSwap`.
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

import { toNano, Address, Cell, internal } from '@ton/core';
import { compile } from '@ton/blueprint';
import { TonClient, WalletContractV4 } from '@ton/ton';
import { keyPairFromSecretKey, mnemonicToPrivateKey } from '@ton/crypto';
import * as dotenv from 'dotenv';

import { Network, readNetworkDeploymentData } from '../lib/buildOutput';
import { runRetranslatorSwap, SwapContext, SwapSend } from './lib/swapRetranslator';
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

    // The operator send primitive — only wired on --execute (loads the wallet).
    let send: SwapSend = async () => {
        throw new Error('internal: send invoked during dry-run');
    };
    if (execute) {
        const { wallet, keyPair } = await loadWallet();
        const bal = await withRateLimit(() => client.getBalance(wallet.address));
        console.log(`Operator wallet: ${wallet.address.toString()}  balance ${(Number(bal) / 1e9).toFixed(3)} TON`);
        if (bal < toNano('1')) throw new Error('operator wallet balance < 1 TON; top up before swapping.');
        send = (to, value, body, op, stateInit) =>
            sendAndWait(client, wallet, keyPair, to, value, withRateLimit, op, body, stateInit);
    }

    const ctx: SwapContext = {
        client,
        withRateLimit,
        network,
        isTestnet,
        gmAddress,
        oldRAddress,
        retranslatorCode,
        send,
    };

    const res = await runRetranslatorSwap(ctx, { dryRun: !execute, newVersion });
    if (!res.executed) {
        console.log('\nDRY-RUN complete. No messages were sent. Re-run with --execute (operator) to perform the swap.');
    }
}

main()
    .then(() => {
        ProviderManager.resetInstance();
        process.exit(0);
    })
    .catch((e) => {
        console.error('\nswapRetranslator FAILED:', e?.message || e);
        ProviderManager.resetInstance();
        process.exit(1);
    });
