// SPDX-License-Identifier: UNLICENSED
/**
 * Unified Build Output Utilities
 * 
 * This module provides utilities for writing build artifacts to standardized locations:
 * - gas_costs/: Gas consumption measurements from tests
 * - deployment_info/: Deployment information and contract addresses
 * 
 * Each output type follows the pattern:
 * - <name>_latest.json: Always-updated file with latest data
 * - all/<name>-<timestamp>.json: Timestamped archive of all outputs
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Address, Cell } from '@ton/core';
import { createHash } from 'crypto';

// ============================================================================
// Types
// ============================================================================

export type Network = 'testnet' | 'mainnet';

export interface AddressInfo {
    bounceable: string;
    nonBounceable: string;
}

export interface ContractCodeInfo {
    hex: string;
    hash: string;
    hashBase64: string;
}

/**
 * Game-specific address info (addresses only, no codes)
 */
export interface TonRaceGameAddresses {
    game: AddressInfo;
    ownerShip?: AddressInfo;
}

export interface SoullessSlotMachineAddresses {
    ssm: AddressInfo;
}

/** UBPS — only the master is deployed at bootstrap; children deploy on demand. */
export interface UbpsAddresses {
    ubps: AddressInfo;
}

/**
 * Contract codes for all games (stored once at root level)
 */
export interface TonRaceGameCodes {
    game: ContractCodeInfo;
    ship: ContractCodeInfo;
    coordinateCell: ContractCodeInfo;
}

export interface SoullessSlotMachineCodes {
    soullessSlotMachine: ContractCodeInfo;
    /** SSMSlot — the ephemeral per-reel contract SSM deploys each roll. */
    ssmSlot?: ContractCodeInfo;
}

/** UBPS module codes: master + the four child contract types. */
export interface UbpsCodes {
    ubps: ContractCodeInfo;
    unit: ContractCodeInfo;
    question: ContractCodeInfo;
    answer: ContractCodeInfo;
    beliefSet: ContractCodeInfo;
}

/**
 * Network-specific deployment data (addresses and deployment status)
 */
export interface NetworkDeploymentData {
    deployed: boolean;
    ownerAddress?: AddressInfo;
    gameManager?: AddressInfo;
    retranslator?: AddressInfo;
    /** GM-owned, R*-governed printers (collections). admin == gameManager. */
    nftPrinter?: AddressInfo;
    passportPrinter?: AddressInfo;
    jettonMinter?: AddressInfo;
    ownerJettonWallet?: AddressInfo;
    ship_station?: AddressInfo;
    ownerJettonBalance?: string;
    games?: {
        ton_race_game?: TonRaceGameAddresses;
        soulless_slot_machine?: SoullessSlotMachineAddresses;
        /** Independent module — registration-only R* slot (never reward-authorized). */
        ubps?: UbpsAddresses;
    };
    status?: 'in_progress' | 'completed' | 'failed';
    error?: string;
}

/**
 * All contract codes (stored once, shared between networks)
 */
export interface ContractCodes {
    gameManager: ContractCodeInfo;
    retranslator?: ContractCodeInfo;
    jettonWallet: ContractCodeInfo;
    jettonMinter: ContractCodeInfo;
    subcontract: ContractCodeInfo;
    games: {
        ton_race_game: TonRaceGameCodes;
        soulless_slot_machine: SoullessSlotMachineCodes;
        ubps?: UbpsCodes;
    };
    /** Optional: NFT collection/item code hashes (TEP-62) */
    nftCollection?: ContractCodeInfo;
    nftItem?: ContractCodeInfo;
    /** Optional: SBT collection/item code hashes (TEP-85) */
    sbtCollection?: ContractCodeInfo;
    sbtItem?: ContractCodeInfo;
    /** Optional: SBTN collection/item code hashes (TEP-6666) */
    sbtnCollection?: ContractCodeInfo;
    sbtnItem?: ContractCodeInfo;
    /** Optional: GM-owned printer collection code hashes (mint + revoke + edit) */
    nftPrinter?: ContractCodeInfo;
    passportPrinter?: ContractCodeInfo;
    /** Optional: printer item variant code hashes (standard item + SetContent edit) */
    nftPrinterItem?: ContractCodeInfo;
    passportPrinterItem?: ContractCodeInfo;
}

/**
 * Root deployment data structure
 */
export interface DeploymentData {
    timestamp: string;
    /**
     * Non-secret source-of-truth constants (opcodes, error codes, gas costs,
     * amounts, enums, storage layout) for sibling projects to stay in sync.
     * Populated by `buildGameConstants()` (see lib/gameConstants.ts).
     * Typed loosely here to keep this module free of wrapper imports.
     */
    constants?: unknown;
    contractCodes?: ContractCodes;
    testnet: NetworkDeploymentData;
    mainnet: NetworkDeploymentData;
}

export interface GasCostsData {
    timestamp: string;
    gasCosts: Record<string, string>;
}

// ============================================================================
// Folder Paths
// ============================================================================

const ROOT_DIR = process.cwd();

export function getGasCostsDir(): string {
    return join(ROOT_DIR, 'gas_costs');
}

export function getDeploymentInfoDir(): string {
    return join(ROOT_DIR, 'deployment_info');
}

function ensureDir(dir: string): void {
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

function ensureAllDir(baseDir: string): string {
    const allDir = join(baseDir, 'all');
    ensureDir(allDir);
    return allDir;
}

// ============================================================================
// Gas Costs Output
// ============================================================================

/**
 * Write gas costs data to the gas_costs folder.
 * Creates:
 * - gas_costs/<name>_latest.json
 * - gas_costs/all/<name>-<timestamp>.json
 * 
 * @param name - Name of the gas cost category (e.g., 'game-manager', 'subcontract')
 * @param gasCosts - Record of operation names to cost strings
 */
export function writeGasCosts(name: string, gasCosts: Record<string, string>): void {
    const timestamp = new Date().toISOString();
    const data: GasCostsData = { timestamp, gasCosts };

    const baseDir = getGasCostsDir();
    ensureDir(baseDir);
    
    const allDir = ensureAllDir(baseDir);

    // Write latest version
    const latestPath = join(baseDir, `${name}_latest.json`);
    writeFileSync(latestPath, JSON.stringify(data, null, 2), 'utf-8');

    // Write timestamped version
    const timestampStr = timestamp.replace(/[:.]/g, '-');
    const archivedPath = join(allDir, `${name}-${timestampStr}.json`);
    writeFileSync(archivedPath, JSON.stringify(data, null, 2), 'utf-8');

    console.log(`✅ Gas costs written to ${latestPath}`);
    console.log(`   Archived to ${archivedPath}`);
}

/**
 * Read the latest gas costs for a given category.
 * 
 * @param name - Name of the gas cost category
 * @returns The gas costs data or null if not found
 */
export function readGasCosts(name: string): GasCostsData | null {
    const latestPath = join(getGasCostsDir(), `${name}_latest.json`);
    if (!existsSync(latestPath)) {
        return null;
    }
    try {
        const raw = readFileSync(latestPath, 'utf-8');
        return JSON.parse(raw) as GasCostsData;
    } catch {
        return null;
    }
}

// ============================================================================
// Deployment Info Output
// ============================================================================

/**
 * Format an Address for storage in deployment JSON.
 */
export function formatAddress(address: Address, isTestnet: boolean): AddressInfo {
    return {
        bounceable: address.toString({
            bounceable: true,
            urlSafe: true,
            testOnly: isTestnet,
        }),
        nonBounceable: address.toString({
            bounceable: false,
            urlSafe: true,
            testOnly: isTestnet,
        }),
    };
}

/**
 * Get contract code data (hex, hash, hashBase64) from a Cell.
 */
export function getContractCodeData(code: Cell): ContractCodeInfo {
    const boc = code.toBoc();
    const hex = boc.toString('hex');
    const hash = createHash('sha256').update(boc).digest('hex');
    const hashBase64 = createHash('sha256').update(boc).digest('base64');
    return { hex, hash, hashBase64 };
}

/**
 * Get the path to the latest deployment file.
 */
export function getDeploymentLatestPath(): string {
    return join(getDeploymentInfoDir(), 'deployment_latest.json');
}

/**
 * Read the current deployment data, or create empty structure if not exists.
 */
export function readDeploymentData(): DeploymentData {
    const latestPath = getDeploymentLatestPath();
    if (existsSync(latestPath)) {
        try {
            const raw = readFileSync(latestPath, 'utf-8');
            return JSON.parse(raw) as DeploymentData;
        } catch {
            // Fall through to create empty
        }
    }
    
    // Return empty structure
    return {
        timestamp: new Date().toISOString(),
        testnet: { deployed: false },
        mainnet: { deployed: false },
    };
}

/**
 * Write full deployment data (contract codes + both networks).
 * Used when you need to update everything at once.
 * 
 * Creates:
 * - deployment_info/deployment_latest.json
 * - deployment_info/all/deployment-<timestamp>.json
 * 
 * @param data - Full deployment data to write
 */
export function writeFullDeploymentData(data: DeploymentData): void {
    const baseDir = getDeploymentInfoDir();
    ensureDir(baseDir);
    
    const allDir = ensureAllDir(baseDir);

    // Write latest version
    const latestPath = getDeploymentLatestPath();
    writeFileSync(latestPath, JSON.stringify(data, null, 2), 'utf-8');

    // Write timestamped version
    const timestampStr = data.timestamp.replace(/[:.]/g, '-');
    const archivedPath = join(allDir, `deployment-${timestampStr}.json`);
    writeFileSync(archivedPath, JSON.stringify(data, null, 2), 'utf-8');

    console.log(`✅ Deployment info written to ${latestPath}`);
    console.log(`   Archived to ${archivedPath}`);
}

/**
 * Deep-merge contract codes so a partial `incoming` set can NEVER strip an entry that
 * exists in `existing`. This closes the clobber class: a producer that forgets a
 * code-only entry (ssmSlot / *Item) can no longer overwrite a complete
 * set with a partial one — surviving entries are carried forward. `incoming` values
 * win where present; the nested `games` codes are merged per-game.
 *
 * NOTE: the canonical producer (`scripts/lib/abiCore.ts buildFullContractCodes`) always
 * emits the COMPLETE set, so this is a second line of defense for any other writer.
 */
export function mergeContractCodes(
    existing: ContractCodes | undefined,
    incoming: ContractCodes | undefined,
): ContractCodes | undefined {
    if (!incoming) return existing;
    if (!existing) return incoming;
    return {
        ...existing,
        ...incoming,
        games: {
            ton_race_game: {
                ...existing.games?.ton_race_game,
                ...incoming.games?.ton_race_game,
            } as TonRaceGameCodes,
            soulless_slot_machine: {
                ...existing.games?.soulless_slot_machine,
                ...incoming.games?.soulless_slot_machine,
            } as SoullessSlotMachineCodes,
            ubps: (existing.games?.ubps || incoming.games?.ubps)
                ? ({ ...existing.games?.ubps, ...incoming.games?.ubps } as UbpsCodes)
                : undefined,
        },
    };
}

/**
 * Write deployment data for a specific network.
 * Preserves data for the other network, the full constants, and ALL contract codes.
 *
 * INVARIANT (clobber defense): this writer carries `constants` forward and DEEP-MERGES
 * the incoming `contractCodes` over the existing set, so it can never drop a code-only
 * entry or the constants block. (Previously it did `contractCodes ?? existing` — a full
 * replace — and omitted `constants`, which is how an offline code-only publish could get
 * overwritten by a live deploy.)
 *
 * Creates:
 * - deployment_info/deployment_latest.json
 * - deployment_info/all/deployment-<timestamp>.json
 *
 * @param network - The network being deployed to
 * @param networkData - The deployment data for this network
 * @param contractCodes - Optional contract codes (merged over the existing shared codes)
 */
export function writeDeploymentData(
    network: Network,
    networkData: NetworkDeploymentData,
    contractCodes?: ContractCodes
): void {
    const timestamp = new Date().toISOString();

    // Read existing data
    const existingData = readDeploymentData();

    // Check if contract codes have changed (if both exist)
    const otherNetwork: Network = network === 'testnet' ? 'mainnet' : 'testnet';
    const otherNetworkData = existingData[otherNetwork];

    if (otherNetworkData.deployed && contractCodes && existingData.contractCodes) {
        const existingCodes = existingData.contractCodes;
        const codesChanged =
            existingCodes.gameManager?.hash !== contractCodes.gameManager?.hash ||
            existingCodes.jettonMinter?.hash !== contractCodes.jettonMinter?.hash ||
            existingCodes.jettonWallet?.hash !== contractCodes.jettonWallet?.hash ||
            existingCodes.subcontract?.hash !== contractCodes.subcontract?.hash;

        if (codesChanged) {
            console.log(`⚠️  Contract codes changed. ${otherNetwork} deployment may need redeploy.`);
        }
    }

    // Update the data for the target network — carry constants forward + merge codes
    // so no code-only entry (ssmSlot/*Item) can be stripped.
    const data: DeploymentData = {
        timestamp,
        constants: existingData.constants,
        contractCodes: mergeContractCodes(existingData.contractCodes, contractCodes),
        testnet: network === 'testnet' ? networkData : existingData.testnet,
        mainnet: network === 'mainnet' ? networkData : existingData.mainnet,
    };

    writeFullDeploymentData(data);
}

/**
 * Read deployment data for a specific network.
 * 
 * @param network - The network to read deployment data for
 * @param requireDeployed - If true, returns null only if deployed=false AND status is not 'failed'/'in_progress'.
 *                          If false, always returns the network data (even if deployed=false).
 *                          Default: false (always return the data so caller can check status).
 * @returns The network deployment data or null if no deployment attempt exists
 */
export function readNetworkDeploymentData(network: Network, requireDeployed: boolean = false): NetworkDeploymentData | null {
    const data = readDeploymentData();
    const networkData = data[network];
    
    // If requireDeployed is true, only return data if successfully deployed
    if (requireDeployed && !networkData.deployed) {
        return null;
    }
    
    // If there's a status (meaning deployment was attempted), return the data
    // so caller can check the status and error message
    if (networkData.status) {
        return networkData;
    }
    
    // No deployment attempt exists for this network
    if (!networkData.deployed) {
        return null;
    }
    
    return networkData;
}

/**
 * Get contract codes from deployment data.
 * Returns null if no codes have been saved yet.
 */
export function getContractCodes(): ContractCodes | null {
    const data = readDeploymentData();
    return data.contractCodes ?? null;
}

/**
 * Get the latest deployment file for a specific network (for backwards compatibility).
 * Returns the deployment_latest.json path.
 */
export function getLatestDeploymentFilePath(): string {
    return getDeploymentLatestPath();
}

/**
 * Check if a network has been deployed.
 */
export function isNetworkDeployed(network: Network): boolean {
    const data = readDeploymentData();
    return data[network].deployed;
}

// ============================================================================
// External Test Result Output
// ============================================================================

export interface ExternalTestGasCost {
    operation: string;
    costNano: string;
    costTon: string;
}

export interface ExternalTestResult {
    timestamp: string;
    network: string;
    uniqueId: string;
    subcontractAddress: string;
    shipAddress: string;
    extSeqno: string;
    gasCosts: ExternalTestGasCost[];
    totalCostNano: string;
    totalCostTon: string;
    success: boolean;
    error?: string;
    shipStateAfterMoves?: {
        movementInProcess: boolean;
        balance: string;
    };
}

/**
 * Write external test result to deployment_info folder.
 * Creates:
 * - deployment_info/external-test_latest.json
 * - deployment_info/all/external-test-<timestamp>.json
 */
export function writeExternalTestResult(result: ExternalTestResult): void {
    const baseDir = getDeploymentInfoDir();
    ensureDir(baseDir);
    
    const allDir = ensureAllDir(baseDir);

    // Write latest version
    const latestPath = join(baseDir, 'external-test_latest.json');
    writeFileSync(latestPath, JSON.stringify(result, null, 2), 'utf-8');

    // Write timestamped version
    const timestampStr = result.timestamp.replace(/[:.]/g, '-');
    const archivedPath = join(allDir, `external-test-${timestampStr}.json`);
    writeFileSync(archivedPath, JSON.stringify(result, null, 2), 'utf-8');

    console.log(`✅ External test result saved to ${latestPath}`);
}

/**
 * Read the latest external test result.
 */
export function readExternalTestResult(): ExternalTestResult | null {
    const latestPath = join(getDeploymentInfoDir(), 'external-test_latest.json');
    if (!existsSync(latestPath)) {
        return null;
    }
    try {
        const raw = readFileSync(latestPath, 'utf-8');
        return JSON.parse(raw) as ExternalTestResult;
    } catch {
        return null;
    }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * List all archived files for a given category.
 * 
 * @param category - 'gas-costs' or 'deployment'
 * @param name - Optional name filter (e.g., 'game-manager' for gas costs)
 */
export function listArchivedFiles(category: 'gas-costs' | 'deployment', name?: string): string[] {
    const baseDir = category === 'gas-costs' ? getGasCostsDir() : getDeploymentInfoDir();
    const allDir = join(baseDir, 'all');
    
    if (!existsSync(allDir)) {
        return [];
    }
    
    const files = readdirSync(allDir).filter(f => f.endsWith('.json'));
    
    if (name) {
        return files.filter(f => f.startsWith(name + '-'));
    }
    
    return files;
}
