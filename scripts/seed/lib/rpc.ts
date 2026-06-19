// SPDX-License-Identifier: UNLICENSED
/**
 * Shared RPC / deployer helpers for the unified seed runner (race + tokens modules).
 *
 * These mirror the equivalents inside scripts/seedUbps/seedSteps.ts (which keeps them
 * private). They are re-implemented here — NOT exported from there — so the unified
 * seeders can run against the SAME ResilientProvider without touching the UBPS seeder.
 * Every send helper re-reads on-chain state via the passed LiveRpc, so a provider
 * restart re-runs an action idempotently (never double-sends).
 */
import { Address } from '@ton/core';
import { WalletContractV4 } from '@ton/ton';
import { mnemonicToPrivateKey, keyPairFromSecretKey, KeyPair } from '@ton/crypto';
import { ResilientProvider, LiveRpc } from '../../seedUbps/provider';

export interface Deployer {
    wallet: WalletContractV4;
    keyPair: KeyPair;
}

export const fmtTon = (n: bigint): string => (Number(n) / 1e9).toFixed(4);

/** Load the deployer wallet from MNEMONIC (24 words) or PRIVATE_KEY (128 hex). Never logs the secret. */
export async function loadDeployerAsync(): Promise<Deployer> {
    const mn = (process.env.MNEMONIC || '').trim();
    if (mn) {
        const words = mn.split(/\s+/).filter(Boolean);
        if (words.length !== 24) throw new Error(`MNEMONIC must be 24 words, got ${words.length}`);
        const keyPair = await mnemonicToPrivateKey(words);
        return { wallet: WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 }), keyPair };
    }
    const pk = (process.env.PRIVATE_KEY || '').trim();
    if (pk) {
        const clean = pk.startsWith('0x') ? pk.slice(2) : pk;
        if (clean.length !== 128) throw new Error(`PRIVATE_KEY must be 128 hex chars, got ${clean.length}`);
        const keyPair = keyPairFromSecretKey(Buffer.from(clean, 'hex'));
        return { wallet: WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 }), keyPair };
    }
    throw new Error('Set MNEMONIC or PRIVATE_KEY for the deployer wallet');
}

// --- read helpers (resilient on live, best-effort on dry-run) ---
export async function isActive(prov: ResilientProvider | null, resilient: boolean, addr: Address): Promise<boolean> {
    if (!prov) return false;
    const fn = (r: LiveRpc) => r.withRateLimit(() => r.client.getContractState(addr));
    const st = resilient
        ? await prov.attempt(`getState ${addr.toString().slice(0, 8)}…`, fn)
        : await prov.read('getState', fn, null);
    return st ? st.state === 'active' : false;
}

export async function getBalance(prov: ResilientProvider | null, resilient: boolean, addr: Address): Promise<bigint> {
    if (!prov) return 0n;
    const fn = (r: LiveRpc) => r.withRateLimit(() => r.client.getBalance(addr));
    return resilient
        ? prov.attempt(`getBalance ${addr.toString().slice(0, 8)}…`, fn)
        : prov.read('getBalance', fn, 0n);
}

// These run INSIDE prov.attempt against a live snapshot.
export async function curSeqno(r: LiveRpc, wallet: WalletContractV4): Promise<number> {
    return r.withRateLimit(() => r.client.open(wallet).getSeqno());
}

/** Wait (time-bounded) for a wallet's seqno to advance past `prev`. A missed confirmation is harmless — the next step re-reads real state. */
export async function waitSeqno(r: LiveRpc, wallet: WalletContractV4, prev: number, label: string, maxMs = 60000): Promise<void> {
    const start = Date.now();
    const opened = r.client.open(wallet);
    while (Date.now() - start < maxMs) {
        try {
            const cur = await r.withRateLimit(() => opened.getSeqno());
            if (cur > prev) return;
        } catch { /* keep waiting */ }
        await new Promise(res => setTimeout(res, 2500));
    }
    console.warn(`  ! ${label}: seqno did not advance within ${maxMs}ms (continuing).`);
}

export { ResilientProvider, LiveRpc };
