#!/usr/bin/env ts-node
// SPDX-License-Identifier: UNLICENSED
/**
 * diagnoseKeeper — read-only on-chain diagnosis of a masterchain library keeper.
 *
 * The decisive datum for "the funded keeper stays uninit" is (a) the compute-phase SKIP
 * reason of its latest inbound tx and (b) whether the DELIVERED StateInit actually carried
 * the `library` dict and hashes to the keeper address. This script fetches both — it makes
 * no sends and needs no keys (public providers suffice; set TONCENTER_API_KEY / an endpoint
 * to dodge the 429 storm).
 *
 * Usage:
 *   ts-node scripts/diagnoseKeeper.ts --keeper <address> [--testnet|--mainnet]
 */
import { Address, beginCell, storeStateInit } from '@ton/core';
import * as dotenv from 'dotenv';
import {
    ProviderManager,
    getTonClientWithRateLimit,
    type Network as ProviderNetwork,
} from 'ton-provider-system';

dotenv.config();

function parseArgs(): { network: 'testnet' | 'mainnet'; address: Address } {
    const args = process.argv.slice(2);
    let network: 'testnet' | 'mainnet' = 'testnet';
    let keeper: string | undefined;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--mainnet') network = 'mainnet';
        else if (args[i] === '--testnet') network = 'testnet';
        else if (args[i] === '--keeper' && args[i + 1]) keeper = args[++i];
    }
    if (!keeper) {
        throw new Error('Usage: ts-node scripts/diagnoseKeeper.ts --keeper <address> [--testnet|--mainnet]');
    }
    return { network, address: Address.parse(keeper) };
}

async function main(): Promise<void> {
    const { network, address } = parseArgs();
    console.log(`\n=== Keeper diagnosis: ${address.toString()} (${network}) ===`);

    const pm = ProviderManager.getInstance();
    await pm.init(network as ProviderNetwork);
    const custom = (process.env.DEPLOY_RPC_ENDPOINT || process.env.TON_RPC_ENDPOINT || '').trim();
    if (custom) {
        pm.setCustomEndpoint(custom);
        console.log('Using pinned RPC endpoint.');
    }
    const { client, withRateLimit } = await getTonClientWithRateLimit(pm);

    const state = await withRateLimit(() => client.getContractState(address));
    console.log(`account.state : ${state.state}`);
    console.log(`balance       : ${(Number(state.balance) / 1e9).toFixed(4)} TON`);

    const txs = await withRateLimit(() => client.getTransactions(address, { limit: 1 }));
    if (txs.length === 0) {
        console.log('latest tx     : (none yet on this account)');
        return;
    }
    const tx = txs[0];
    const d = tx.description;
    if (d.type === 'generic') {
        const cp = d.computePhase;
        if (cp.type === 'skipped') {
            console.log(`compute phase : SKIPPED — reason = ${cp.reason}`);
            if (cp.reason === 'bad-state') {
                console.log('  (bad-state on an uninit account ⇒ the DELIVERED StateInit hash != the keeper address.)');
            } else if (cp.reason === 'no-gas') {
                console.log('  (no-gas ⇒ raise KEEPER_FUNDING; masterchain storage/library fees are ~1000× basechain.)');
            } else if (cp.reason === 'no-state') {
                console.log('  (no-state ⇒ the inbound message carried no StateInit at all.)');
            }
        } else {
            console.log(`compute phase : VM (success=${cp.success}, exitCode=${cp.exitCode}, activated=${cp.accountActivated})`);
        }
    } else {
        console.log(`tx description: ${d.type}`);
    }

    const inInit = tx.inMessage?.init;
    if (!inInit) {
        console.log('delivered init: NONE — the latest inbound message carried no StateInit.');
    } else {
        const libSize = inInit.libraries?.size ?? 0;
        const h = beginCell().store(storeStateInit(inInit)).endCell().hash().toString('hex');
        const addrHash = address.hash.toString('hex');
        console.log(`delivered init: libraries=${libSize}, hash=${h}`);
        console.log(`address hash  : ${addrHash}`);
        console.log(`init hash == address : ${h === addrHash}`);
        console.log(
            libSize > 0
                ? '=> the delivered init CARRIES the libraries.'
                : '=> the delivered init has NO libraries (dropped in transit / wrong init serialized).',
        );
    }
    console.log('');
}

main()
    .then(() => {
        ProviderManager.resetInstance();
        process.exit(0);
    })
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
