// SPDX-License-Identifier: UNLICENSED
/**
 * Tokens seeder — deploy N plain, independent jetton masters (labelled A,B,C,D,E by
 * default) and mint `amount` raw units of each to an owner. These are PLAIN standalone
 * jettons (their own masters, no GM, R-star or RUDA path) — exactly the "foreign jetton" shape
 * the SSM custom-jetton path + multisplav testing needs.
 *
 * DESIGN NOTE (deviation from plan §6.2 wording, kept faithful to its INTENT): the
 * master's `admin` is the DEPLOYER (the wallet that signs), and the mint RECIPIENT is
 * `--owner` (default = deployer). Only the admin can mint, so making the deployer the
 * admin is what lets `--owner <a browser wallet>` actually receive tokens (the stated
 * use case). The master address is keyed to (admin=deployer, content, wallet_code), so it
 * is stable regardless of which recipient `--owner` names — good for idempotent re-runs.
 *
 * Idempotent: a master already deployed is skipped; a recipient whose jetton balance is
 * already ≥ amount is skipped; a partial balance is topped up to exactly `amount`.
 */
import { Address, Cell, toNano } from '@ton/core';
import { JettonMinter, jettonContentToCell } from '../../wrappers/tep/jetton/JettonMinter';
import { JettonWallet } from '../../wrappers/tep/jetton/JettonWallet';
import { ResilientProvider, LiveRpc, isActive, curSeqno, waitSeqno } from './lib/rpc';
import {
    SeedContext, SeedOptions, SeedModule, CostEstimate, ManifestPart, fmtAddr, fmtTon, writeManifest,
} from './lib/context';

// --- tunable amounts (per token) ---
// Jetton-master deploy needs only deploy gas + the minter's storage floor (sandbox-measured
// well under 0.1 TON; see tests/seed/tokens-seeder.spec.ts). 0.25 keeps a comfortable margin.
const MASTER_DEPLOY_VALUE = toNano('0.25'); // deploy a jetton master (was 0.5 — generous)
const MINT_FORWARD = toNano('0.1');         // forward TON carried to the recipient wallet
const MINT_TOTAL = toNano('0.2');           // total TON for the mint (sendMint adds ~0.015 itself)
const TOKEN_BUFFER = toNano('0.1');         // per-token fee headroom

/** Exposed so the sandbox spec deploys with the exact value the live seeder uses. */
export const TOKENS_MASTER_DEPLOY_VALUE = MASTER_DEPLOY_VALUE;
export const TOKENS_MINT_FORWARD = MINT_FORWARD;
export const TOKENS_MINT_TOTAL = MINT_TOTAL;

/** Off-chain content URI for a labelled test token (label lives ONLY here, never on-chain as a name). */
export function tokenContentUri(label: string): string {
    return `https://gm-ultimate.local/test-token/${label}.json`;
}

/** The deterministic master for a labelled test token (admin = the signing deployer). */
export function tokenMaster(admin: Address, label: string, jettonMinterCode: Cell, jettonWalletCode: Cell): JettonMinter {
    return JettonMinter.createFromConfig({
        admin,
        content: jettonContentToCell({ type: 1, uri: tokenContentUri(label) }),
        wallet_code: jettonWalletCode,
    }, jettonMinterCode);
}

async function getJettonBalance(prov: ResilientProvider | null, resilient: boolean, walletAddr: Address): Promise<bigint> {
    if (!prov) return 0n;
    const fn = (r: LiveRpc) => r.withRateLimit(() => r.client.open(JettonWallet.createFromAddress(walletAddr)).getJettonBalance());
    return resilient ? prov.attempt('getJettonBalance', fn) : prov.read('getJettonBalance', fn, 0n);
}

interface TokenManifestEntry {
    label: string;
    master: { bounceable: string; raw: string };
    recipient: string;
    recipientWallet: string;
    amount: string;
    status: string; // deployed+minted | skipped | minted | planned
}

export const tokensModule: SeedModule = {
    name: 'tokens',

    async estimateCost(_ctx: SeedContext, opts: SeedOptions): Promise<CostEstimate> {
        const n = BigInt(opts.tokens.length);
        const perToken = MASTER_DEPLOY_VALUE + MINT_TOTAL + toNano('0.015') + TOKEN_BUFFER;
        const required = perToken * n;
        return {
            required,
            breakdown: {
                tokens: String(opts.tokens.length),
                perToken: `${fmtTon(perToken)} TON`,
                total: `${fmtTon(required)} TON`,
            },
        };
    },

    async run(ctx: SeedContext, opts: SeedOptions): Promise<ManifestPart> {
        const { network, dryRun, live, prov, deployer, codes } = ctx;
        const manifest = { module: 'tokens', network, seededAt: new Date().toISOString(), tokens: [] as TokenManifestEntry[], summary: { deployed: 0, skipped: 0, funded: 0, errors: 0 } };

        if (!codes.jettonMinterCode || !codes.jettonWalletCode) throw new Error('tokens module: jetton codes not compiled');

        // admin = the signing deployer; recipient = --owner (default deployer).
        const admin = deployer?.wallet.address ?? null;
        const recipient = opts.owner ?? admin;
        if (!dryRun && (!admin || !recipient)) throw new Error('tokens module: deployer keys required to mint (set MNEMONIC/PRIVATE_KEY)');

        console.log(`\n=== tokens seed (${network}) ${dryRun ? '[DRY-RUN — no sends]' : '[LIVE]'} ===`);
        if (admin) console.log(`admin/minter (deployer): ${fmtAddr(admin, network)}`);
        else console.log('admin/minter: (unknown — set MNEMONIC/PRIVATE_KEY to resolve master addresses)');
        if (recipient) console.log(`recipient (--owner):     ${fmtAddr(recipient, network)}`);
        console.log(`tokens: ${opts.tokens.join(', ')}  amount each: ${opts.tokenAmount.toString()} raw units`);

        const canSend = !dryRun && !!prov && !!deployer;

        for (const label of opts.tokens) {
            if (!admin || !recipient) {
                // dry-run without keys: addresses depend on admin; just record the plan.
                manifest.tokens.push({ label, master: { bounceable: '(unresolved)', raw: '(unresolved)' }, recipient: '(unresolved)', recipientWallet: '(unresolved)', amount: opts.tokenAmount.toString(), status: 'planned' });
                console.log(`  + ${label}: (master unresolved — needs deployer keys)`);
                continue;
            }
            const master = tokenMaster(admin, label, codes.jettonMinterCode, codes.jettonWalletCode);
            const recipientWallet = JettonWallet.createFromConfig({ ownerAddress: recipient, minterAddress: master.address }, codes.jettonWalletCode).address;
            const entry: TokenManifestEntry = {
                label,
                master: { bounceable: fmtAddr(master.address, network), raw: master.address.toRawString() },
                recipient: fmtAddr(recipient, network),
                recipientWallet: fmtAddr(recipientWallet, network),
                amount: opts.tokenAmount.toString(),
                status: 'planned',
            };

            const masterActive = await isActive(prov, live, master.address);
            const curBal = await getJettonBalance(prov, live, recipientWallet);
            const needDeploy = !masterActive;
            const needMint = curBal < opts.tokenAmount;
            console.log(`  ${dryRun ? '+' : '>'} ${label} master=${fmtAddr(master.address, network)} ` +
                `[${needDeploy ? 'deploy' : 'exists'}] mint:${needMint ? `${(opts.tokenAmount - curBal).toString()} raw` : 'skip (balance ok)'}`);

            if (canSend) {
                await prov!.attempt(`token ${label}`, async (rpc) => {
                    const sender = rpc.client.open(deployer!.wallet).sender(deployer!.keyPair.secretKey);
                    // deploy master (skip if already active)
                    const active = (await rpc.withRateLimit(() => rpc.client.getContractState(master.address))).state === 'active';
                    if (!active) {
                        const before = await curSeqno(rpc, deployer!.wallet);
                        await rpc.client.open(master).sendDeploy(sender, MASTER_DEPLOY_VALUE);
                        await waitSeqno(rpc, deployer!.wallet, before, `deploy master ${label}`);
                    }
                    // mint the shortfall to exactly `amount` (re-read balance, restart-safe)
                    const bal = await rpc.withRateLimit(() => rpc.client.open(JettonWallet.createFromAddress(recipientWallet)).getJettonBalance());
                    if (bal < opts.tokenAmount) {
                        const before = await curSeqno(rpc, deployer!.wallet);
                        await rpc.client.open(master).sendMint(sender, recipient, opts.tokenAmount - bal, MINT_FORWARD, MINT_TOTAL);
                        await waitSeqno(rpc, deployer!.wallet, before, `mint ${label}`);
                    }
                });
            }

            if (needDeploy || needMint) {
                entry.status = needDeploy && needMint ? 'deployed+minted' : (needMint ? 'minted' : 'deployed');
                manifest.summary.deployed++;
            } else {
                entry.status = 'skipped';
                manifest.summary.skipped++;
            }
            manifest.tokens.push(entry);
        }

        if (dryRun) {
            console.log('\n--- tokens manifest preview (dry-run; not written) ---');
            console.log(JSON.stringify(manifest, null, 2));
        } else {
            const p = writeManifest('tokens', network, manifest);
            console.log(`\nTokens manifest written -> ${p}`);
        }
        console.log(`tokens summary: ${JSON.stringify(manifest.summary)}`);
        return manifest;
    },
};
