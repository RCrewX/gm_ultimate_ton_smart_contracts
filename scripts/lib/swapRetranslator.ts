// SPDX-License-Identifier: UNLICENSED
/**
 * swapRetranslator (lib) — the Retranslator (R*) HOT-SWAP flow, extracted so BOTH
 * the standalone script (scripts/swapRetranslator.ts) and retro mode
 * (scripts/deploySystem.ts retroUpdate) share ONE implementation.
 *
 * It reads the LIVE old R* state, builds a new R* v(old+1) with MIGRATED mint
 * counters (the crux — else item-address collisions), deploys it, copies the
 * registries verbatim via GM relay, repoints GM (`SetRetranslator`), verifies
 * continuity, and refreshes deployment_info/deployment_latest.json's R* address.
 *
 * The caller supplies a `send` primitive (operator-gated) so each caller keeps its
 * own provider-rotation / confirmation logic; the lib NEVER sends on a dry-run.
 */
import { toNano, beginCell, Address, Cell } from '@ton/core';
import { TonClient } from '@ton/ton';
import { GameManager } from '../../wrappers/game_manager/GameManager';
import { Retranslator } from '../../wrappers/game_manager/Retranslator';
import {
    encodeSetJettonInfo,
    encodeSetGamesInfo,
    encodeSetToolsInfo,
    encodeSetAllowBurn,
} from '../../wrappers/game_manager/RetranslatorTypes';
import { GAS_COST_REDIRECT_MESSAGE, GAS_COST_SET_RETRANSLATOR } from '../../wrappers/game_manager/types';
import { Network, readDeploymentData, writeFullDeploymentData, formatAddress } from '../../lib/buildOutput';

type RateLimit = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Send a message from the operator wallet and wait for it to be processed.
 * `stateInit` present → it is a deploy. The caller implements the actual send
 * (provider rotation, seqno wait, etc).
 */
export type SwapSend = (
    to: Address,
    value: bigint,
    body: Cell,
    op: string,
    stateInit?: { code: Cell; data: Cell },
) => Promise<void>;

export interface SwapContext {
    client: TonClient;
    withRateLimit: RateLimit;
    network: Network;
    isTestnet: boolean;
    gmAddress: Address;
    oldRAddress: Address;
    retranslatorCode: Cell;
    send: SwapSend;
}

export interface SwapResult {
    newRAddress: Address;
    targetVersion: bigint;
    oldVersion: bigint;
    nextNftIndex: bigint;
    nextSbtIndex: bigint;
    executed: boolean; // false on dry-run (read + plan only)
}

/**
 * Run (or, on dryRun, just plan) the R* hot-swap. On dryRun it reads the chain and
 * prints the migration plan, sending nothing. On a live run it deploys the new R*,
 * reseeds the registries, repoints GM, verifies continuity, and updates the json.
 */
export async function runRetranslatorSwap(
    ctx: SwapContext,
    opts: { dryRun: boolean; newVersion?: bigint },
): Promise<SwapResult> {
    const { client, withRateLimit, gmAddress, oldRAddress, retranslatorCode, isTestnet, network } = ctx;
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
    const owner = await withRateLimit(() => oldR.getOwner());

    const targetVersion = opts.newVersion ?? oldVersion + 1n;
    if (targetVersion <= oldVersion) {
        throw new Error(`--version ${targetVersion} must be > current version ${oldVersion}`);
    }

    // ---- BUILD new R* init with MIGRATED counters ----
    const newR = Retranslator.createFromConfig(
        {
            gameManagerAddress: gmAddress,
            ownerAddress: owner,
            version: targetVersion,
            active: true,
            allow_burn: allowBurn,
            nextNftIndex, // migrated — prevents item-address collisions
            nextSbtIndex, // migrated
        },
        retranslatorCode,
    );

    console.log('\n--- R* MIGRATION PLAN ---');
    console.log(`version       : ${oldVersion}  ->  ${targetVersion}`);
    console.log(`nextNftIndex  : ${nextNftIndex} (migrated verbatim)`);
    console.log(`nextSbtIndex  : ${nextSbtIndex} (migrated verbatim)`);
    console.log(`allow_burn    : ${allowBurn}`);
    console.log(
        `registries    : jettonInfo=${jettonInfo ? 'copy' : 'none'} gamesInfo=${gamesInfo ? 'copy' : 'none'} toolsInfo=${toolsInfo ? 'copy' : 'none'}`,
    );
    console.log(`new R* addr   : ${newR.address.toString()}`);
    if (newR.address.equals(oldRAddress)) {
        throw new Error('computed new R* address == old R* — version did not change the address; abort.');
    }
    console.log('steps         : deploy newR* -> seed registries via GM relay -> SetRetranslator(newR*) -> verify -> regen json');

    if (opts.dryRun) {
        return { newRAddress: newR.address, targetVersion, oldVersion, nextNftIndex, nextSbtIndex, executed: false };
    }

    // ===================== EXECUTE (operator only) =====================
    console.log('\n--- EXECUTING R* SWAP ---');

    // 1) deploy new R* (skip if already there)
    const alreadyThere = (await withRateLimit(() => client.getContractState(newR.address))).state === 'active';
    if (alreadyThere) {
        console.log('  · new R* already deployed; skipping deploy');
    } else {
        await ctx.send(newR.address, toNano('0.5'), beginCell().endCell(), 'deploy newR*', {
            code: retranslatorCode,
            data: newR.init!.data,
        });
    }

    // 2) seed registries on new R* via GM relay (opaque copy)
    const relay = (body: Cell, op: string) =>
        ctx.send(
            gmAddress,
            GAS_COST_REDIRECT_MESSAGE + toNano('0.9'),
            GameManager.redirectMessage(newR.address, body, toNano('0.9')),
            op,
        );
    if (jettonInfo) await relay(encodeSetJettonInfo({ jettonInfo }), 'seed jettonInfo');
    if (gamesInfo) await relay(encodeSetGamesInfo({ gamesInfo }), 'seed gamesInfo');
    if (toolsInfo) await relay(encodeSetToolsInfo({ toolsInfo }), 'seed toolsInfo');
    await relay(encodeSetAllowBurn({ allow_burn: allowBurn }), 'seed allowBurn');

    // 3) repoint GM
    await ctx.send(
        gmAddress,
        GAS_COST_SET_RETRANSLATOR + toNano('0.05'),
        GameManager.setRetranslatorMessage(newR.address),
        'SetRetranslator(newR*)',
    );

    // 4) verify continuity
    console.log('\n--- VERIFY R* ---');
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
    console.log('\nR* swap complete. deployment_latest.json updated with the new R* address.');
    console.log(
        `Old R* (${oldRAddress.toString()}) is now inert (GM no longer routes to it). Keep it parked for rollback until proven.`,
    );

    return { newRAddress: newR.address, targetVersion, oldVersion, nextNftIndex, nextSbtIndex, executed: true };
}
