// SPDX-License-Identifier: UNLICENSED
/**
 * Deterministic test-wallet derivation for the UBPS seeder.
 *
 * The repo has no HD-index helper, so we derive N reproducible keypairs from a
 * single master seed:
 *
 *     keyPairFromSeed( sha256( seedBytes ‖ uint32BE(index) ) )  ->  WalletContractV4
 *
 * Same master seed + index => same address on every run, so the seeder is
 * resumable and the user can fund the exact wallets it will sign as. The master
 * seed is read from the env var TEST_USERS_SEED (TESTNET ONLY) and is NEVER
 * printed — only the derived public addresses ever leave this module.
 */
import { createHash } from 'crypto';
import { keyPairFromSeed, KeyPair } from '@ton/crypto';
import { WalletContractV4 } from '@ton/ton';

export interface DerivedWallet {
    index: number;
    keyPair: KeyPair;
    wallet: WalletContractV4;
}

/**
 * Read the master seed bytes from TEST_USERS_SEED. Accepts hex (0x-prefixed or
 * bare) or, failing that, the raw utf-8 of the string. The value is NEVER logged.
 * Throws (with the var NAME only, never the value) when unset.
 */
export function readTestUsersSeed(): Buffer {
    const raw = (process.env.TEST_USERS_SEED || '').trim();
    if (!raw) {
        throw new Error('TEST_USERS_SEED is not set (testnet-only master seed for deterministic test wallets)');
    }
    const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
    if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0 && hex.length >= 32) {
        return Buffer.from(hex, 'hex');
    }
    // Fallback: treat the literal string as the seed material.
    return Buffer.from(raw, 'utf8');
}

function indexSeed(seedBytes: Buffer, index: number): Buffer {
    const idx = Buffer.alloc(4);
    idx.writeUInt32BE(index >>> 0, 0);
    // sha256 -> 32 bytes, exactly what keyPairFromSeed expects.
    return createHash('sha256').update(Buffer.concat([seedBytes, idx])).digest();
}

export function deriveUserWallet(seedBytes: Buffer, index: number): DerivedWallet {
    const keyPair = keyPairFromSeed(indexSeed(seedBytes, index));
    const wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
    return { index, keyPair, wallet };
}

export function deriveUserWallets(seedBytes: Buffer, n: number): DerivedWallet[] {
    const out: DerivedWallet[] = [];
    for (let i = 0; i < n; i++) out.push(deriveUserWallet(seedBytes, i));
    return out;
}
