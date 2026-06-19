// SPDX-License-Identifier: UNLICENSED
/**
 * Shared context + module contract for the unified seed runner.
 *
 * ONE shared ctx (network, provider, deployer, deployment artifact, compiled codes)
 * is built once and handed to every selected module so race + tokens seed over a
 * single provider/deployer/network. (The UBPS module is an adapter over the existing
 * scripts/seedUbps seeder, which self-manages its own provider — see ubpsModule.ts.)
 */
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Address, Cell } from '@ton/core';
import { compile } from '@ton/blueprint';
import { readDeploymentData, DeploymentData } from '../../../lib/buildOutput';
import { SeedNetwork } from '../../seedUbps/types';
import { ResilientProvider, Deployer, loadDeployerAsync } from './rpc';

export { fmtTon } from './rpc';

/** Render an address user-friendly for the target chain (testnet → kQ/0Q). Mirrors lib/buildOutput.formatAddress. */
export const fmtAddr = (addr: Address, network: SeedNetwork, bounceable = true): string =>
    addr.toString({ urlSafe: true, bounceable, testOnly: network === 'testnet' });

/** Only the codes the new seeders need (race: ship+coordinateCell; tokens: jetton master+wallet). */
export interface SeedCodes {
    shipCode?: Cell;
    coordinateCellCode?: Cell;
    jettonMinterCode?: Cell;
    jettonWalletCode?: Cell;
}

export interface CostEstimate {
    required: bigint;
    breakdown: Record<string, string>; // human-readable nano→TON strings
}

export interface ManifestPart {
    module: string;
    summary: { deployed: number; skipped: number; funded: number; errors: number };
    [k: string]: unknown;
}

export interface SeedContext {
    network: 'testnet';
    dryRun: boolean;
    live: boolean; // !dryRun — resilient reads/sends only on the live run
    prov: ResilientProvider | null;
    deployer: Deployer | null;
    deployment: DeploymentData;
    codes: SeedCodes;
}

/** Per-module options forwarded from the CLI (passthrough flags). */
export interface SeedOptions {
    // tokens
    tokens: string[]; // labels, e.g. ['A','B','C','D','E']
    tokenAmount: bigint; // raw units minted per token
    owner: Address | null; // mint recipient; null => deployer
    // race
    pilots: number;
    moves: number;
    directions: string[]; // e.g. ['LEFT','UP','RIGHT']
    pilotIndexBase: number; // wallet-index namespace offset (avoid UBPS collision)
    // ubps (delegated to the existing seeder)
    ubpsFile: string | null;
    ubpsIncludes: string[];
    usersCap?: number;
}

/**
 * A seedable unit. estimateCost is pure-ish (may read the deployment file for counts);
 * run performs the (idempotent) seeding and returns its manifest part.
 */
export interface SeedModule {
    name: 'ubps' | 'race' | 'tokens';
    estimateCost(ctx: SeedContext, opts: SeedOptions): Promise<CostEstimate>;
    run(ctx: SeedContext, opts: SeedOptions): Promise<ManifestPart>;
}

/** Compile exactly the codes the selected modules need (skip the rest — compile is heavy). */
export async function compileSeedCodes(need: { race: boolean; tokens: boolean }): Promise<SeedCodes> {
    const codes: SeedCodes = {};
    if (need.race) {
        codes.shipCode = await compile('Ship');
        codes.coordinateCellCode = await compile('CoordinateCell');
    }
    if (need.tokens) {
        codes.jettonMinterCode = await compile('JettonMinter');
        codes.jettonWalletCode = await compile('JettonWallet');
    }
    return codes;
}

export function loadDeployment(): DeploymentData {
    return readDeploymentData();
}

export { loadDeployerAsync };

/** Per-module manifest path (gitignored: deployment_info/ + *.manifest.json). */
export function manifestPath(moduleName: string, network: string): string {
    return join(process.cwd(), 'deployment_info', `${moduleName}-seed.${network}.manifest.json`);
}

export function writeManifest(moduleName: string, network: string, manifest: unknown): string {
    const p = manifestPath(moduleName, network);
    writeFileSync(p, JSON.stringify(manifest, null, 2), 'utf-8');
    return p;
}

export function deploymentInfoExists(): boolean {
    return existsSync(join(process.cwd(), 'deployment_info', 'deployment_latest.json'));
}
