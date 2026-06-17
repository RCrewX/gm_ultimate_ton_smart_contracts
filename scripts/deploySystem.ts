#!/usr/bin/env ts-node
// SPDX-License-Identifier: UNLICENSED
/**
 * Deploy System Script (Standalone)
 *
 * Deploys the complete game system using the ton-provider-system package.
 * Does NOT require Blueprint - uses TonClient directly.
 *
 * Usage:
 *   pnpm deploy                     # Deploy to testnet
 *   pnpm deploy --mainnet           # Deploy to mainnet
 *   pnpm deploy --id 5              # Deploy with ship station ID 5
 *   pnpm deploy --mainnet --id 10   # Deploy to mainnet with ID 10
 *
 * Environment:
 *   PRIVATE_KEY          - 128-hex private key (required)
 *   JETTON_CONTENT_URI   - Jetton metadata URI (optional)
 *   OWNER_PUBLIC_KEY     - Public key for external signatures (optional, derived from PRIVATE_KEY)
 */

import { toNano, beginCell, Address, Cell, SendMode, internal, external, storeMessage } from '@ton/core';
import { compile } from '@ton/blueprint';
import { TonClient, WalletContractV4 } from '@ton/ton';
import { keyPairFromSecretKey, mnemonicToPrivateKey } from '@ton/crypto';
import * as dotenv from 'dotenv';

import { GameManager } from '../wrappers/game_manager/GameManager';
import { Retranslator } from '../wrappers/game_manager/Retranslator';
import { Game } from '../wrappers/ton_race_game/Game';
import { Ship } from '../wrappers/ton_race_game/Ship';
import { SoullessSlotMachine } from '../wrappers/soulless_slot_machine/SoullessSlotMachine';
import { UBPS } from '../wrappers/ubps/UBPS';
import { JettonMinter, jettonContentToCell } from '../wrappers/tep/jetton/JettonMinter';
import { JettonWallet } from '../wrappers/tep/jetton/JettonWallet';
import { Subcontract } from '../wrappers/subcontract/Subcontract';
import { NFTPrinter } from '../wrappers/printers/nft_printer/NFTPrinter';
import { SBTPrinter } from '../wrappers/printers/sbt_printer/SBTPrinter';
import { ToolsInfo, GamesInfo } from '../wrappers/game_manager/RetranslatorTypes';
import { GAS_COST_REDIRECT_MESSAGE, GAS_COST_SET_RETRANSLATOR } from '../wrappers/game_manager/types';
import { GAS_COST_MANUAL_DEPLOY } from '../wrappers/subcontract/types';
import { BASIC_STORAGE_TAX } from '../wrappers/ton_race_game/types';
import {
    Network,
    NetworkDeploymentData,
    DeploymentData,
    ContractCodes,
    writeFullDeploymentData,
    readDeploymentData,
    formatAddress,
} from '../lib/buildOutput';
import { buildGameConstants } from '../lib/gameConstants';
import {
    compileAllContracts,
    buildFullContractCodes,
    calculateNetworkAddresses,
    createPrinters,
    buildOfflineDeploymentData,
    type CompiledContracts,
} from './lib/abiCore';
import { detectChanges } from './lib/changeDetection';
import {
    planRetroActions,
    orphanWarning,
    type ChangeReport,
    type TrackedDescriptor,
    type LeafChange,
    type LeafKind,
} from './lib/changeClassifier';
import { runRetranslatorSwap, type SwapContext, type SwapSend } from './lib/swapRetranslator';
import { verifyDeploymentHashes } from './lib/verifyDeploymentHashes';
import {
    ProviderManager,
    getTonClientWithRateLimit,
    type Network as ProviderNetwork,
} from 'ton-provider-system';

// Load environment variables
dotenv.config();

// ============================================================================
// Configuration
// ============================================================================

const API_TIMEOUT = 30000;
const DEPLOYMENT_TIMEOUT = 120000;
const TRANSACTION_WAIT_TIME = 5000;
const RETRY_DELAY = 10000;
const BASE_MINT_AMOUNT = 5500n;

// ============================================================================
// CLI Argument Parsing
// ============================================================================

/** hard = classical full idempotent walk; retro = change-detection incremental update. */
type DeployMode = 'hard' | 'retro';

interface CliOptions {
    network: Network;
    shipStationId: bigint;
    /** Offline ABI publish: assemble the full artifact with placeholder addrs, no RPC/keys. */
    offline: boolean;
    /** Deploy strategy (default: retro). */
    mode: DeployMode;
    /** Retro: print the computed action plan and send NOTHING. */
    dryRun: boolean;
    /** Retro: skip the mainnet orphan confirmation gate before an orphaning send. */
    assumeYes: boolean;
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let network: Network = 'testnet';
    let shipStationId = 1n;
    let offline = false;
    let mode: DeployMode = 'retro';
    let dryRun = false;
    let assumeYes = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--mainnet') {
            network = 'mainnet';
        } else if (arg === '--testnet') {
            network = 'testnet';
        } else if (arg === '--offline') {
            offline = true;
        } else if (arg === '--mode' && args[i + 1]) {
            const m = args[++i];
            if (m !== 'hard' && m !== 'retro') {
                throw new Error(`--mode must be 'hard' or 'retro', got '${m}'`);
            }
            mode = m;
        } else if (arg === '--dry-run') {
            dryRun = true;
        } else if (arg === '--yes' || arg === '-y') {
            assumeYes = true;
        } else if (arg === '--id' && args[i + 1]) {
            const parsed = BigInt(args[++i]);
            if (parsed < 1n) {
                throw new Error('--id must be >= 1');
            }
            shipStationId = parsed;
        } else if (arg === '--help' || arg === '-h') {
            console.log(`
Deploy System - TON Game Platform Deployment

Usage:
  pnpm deploy [options]

Modes (--mode):
  retro (default) Change-detection incremental update. Compiles, compares each
                  contract's on-chain code hash, and acts minimally:
                    • GM changed     -> REFUSE (re-run with --mode hard)
                    • R* changed     -> hot-swap R* (migrate counters + repoint GM)
                    • leaves changed -> redeploy + re-register on R* (orphans state!)
  hard            Classical full idempotent walk (deploy missing, seed all R*
                  registries). Same as the pre-mode behavior.

Options:
  --testnet       Deploy to testnet (default)
  --mainnet       Deploy to mainnet
  --mode <m>      'hard' or 'retro' (default: retro)
  --dry-run       Retro only: print the action plan against live state, send nothing
  --yes, -y       Retro only: skip the mainnet orphan-confirmation gate
  --offline       Regenerate deployment_latest.json OFFLINE (full ABI, placeholder
                  addrs, deployed:false). No RPC/keys. Same as 'pnpm abi'.
  --id <n>        Ship station ID (default: 1)
  --help, -h      Show this help

Environment Variables:
  PRIVATE_KEY          128-hex private key (required for sends)
  MNEMONIC             24-word mnemonic (alternative to PRIVATE_KEY)
  JETTON_CONTENT_URI   Jetton metadata URI
  OWNER_PUBLIC_KEY     Public key for external signatures

Examples:
  pnpm deploy                     # testnet, RETRO (incremental)
  pnpm deploy --dry-run           # testnet, print retro plan only (no sends)
  pnpm deploy --mode hard         # testnet, classical full deploy
  pnpm deploy --mainnet --mode hard
  pnpm deploy --mainnet --yes     # mainnet retro, accept orphaning
  pnpm deploy --id 5              # ship station ID 5
`);
            process.exit(0);
        }
    }

    // Also check SCRIPT_ID env var (for compatibility with runWithChainstack)
    const envId = process.env.SCRIPT_ID;
    if (envId) {
        const parsed = BigInt(envId);
        if (parsed >= 1n) {
            shipStationId = parsed;
        }
    }

    return { network, shipStationId, offline, mode, dryRun, assumeYes };
}

// ============================================================================
// Wallet/Key Management
// ============================================================================

interface WalletInfo {
    wallet: WalletContractV4;
    keyPair: { publicKey: Buffer; secretKey: Buffer };
}

async function loadWallet(): Promise<WalletInfo> {
    const privateKeyHex = (process.env.PRIVATE_KEY || '').trim();
    const mnemonic = (process.env.MNEMONIC || '').trim();

    let keyPair: { publicKey: Buffer; secretKey: Buffer };

    if (privateKeyHex) {
        // Load from private key
        const clean = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex;
        if (clean.length !== 128) {
            throw new Error(`PRIVATE_KEY must be 128 hex characters (64 bytes), got ${clean.length}`);
        }
        const secretKey = Buffer.from(clean, 'hex');
        keyPair = keyPairFromSecretKey(secretKey);
        console.log('Loaded wallet from PRIVATE_KEY');
    } else if (mnemonic) {
        // Load from mnemonic
        const words = mnemonic.split(/\s+/).filter(w => w.length > 0);
        if (words.length !== 24) {
            throw new Error(`MNEMONIC must be 24 words, got ${words.length}`);
        }
        keyPair = await mnemonicToPrivateKey(words);
        console.log('Loaded wallet from MNEMONIC');
    } else {
        throw new Error('Either PRIVATE_KEY or MNEMONIC must be set in .env');
    }

    const wallet = WalletContractV4.create({
        publicKey: keyPair.publicKey,
        workchain: 0,
    });

    return { wallet, keyPair };
}

function loadOwnerPublicKey(keyPair: { publicKey: Buffer; secretKey: Buffer }): bigint {
    // First, try to use OWNER_PUBLIC_KEY if explicitly set
    const pk = (process.env.OWNER_PUBLIC_KEY || '').trim();
    if (pk) {
        const clean = pk.startsWith('0x') ? pk.slice(2) : pk;
        if (clean.length === 64) {
            const publicKey = BigInt('0x' + clean);
            console.log(`Using OWNER_PUBLIC_KEY from env`);
            return publicKey;
        }
        console.warn(`OWNER_PUBLIC_KEY invalid length (${clean.length}), deriving from wallet...`);
    }

    // Derive from wallet's key pair
    const publicKey = BigInt('0x' + keyPair.publicKey.toString('hex'));
    console.log('Using public key derived from wallet');
    return publicKey;
}

// ============================================================================
// Transaction Helpers
// ============================================================================

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
    ]);
}

async function isContractDeployed(
    client: TonClient,
    address: Address,
    withRateLimit: <T>(fn: () => Promise<T>) => Promise<T>
): Promise<boolean> {
    try {
        const state = await withTimeout(
            withRateLimit(() => client.getContractState(address)),
            API_TIMEOUT,
            `Checking deployment status for ${address.toString()}`
        );
        return state.state === 'active';
    } catch (error: any) {
        if (error.message?.includes('timeout')) {
            return false;
        }
        console.warn(`Could not check deployment status: ${error.message}`);
        return false;
    }
}

async function waitForDeploy(
    client: TonClient,
    address: Address,
    withRateLimit: <T>(fn: () => Promise<T>) => Promise<T>,
    maxRetries: number = 30
): Promise<boolean> {
    for (let i = 0; i < maxRetries; i++) {
        if (await isContractDeployed(client, address, withRateLimit)) {
            return true;
        }
        await sleep(2000);
    }
    return false;
}

async function getSeqno(
    client: TonClient,
    walletAddress: Address,
    withRateLimit: <T>(fn: () => Promise<T>) => Promise<T>
): Promise<number> {
    try {
        const state = await withRateLimit(() => client.getContractState(walletAddress));
        if (state.state !== 'active') {
            return 0;
        }
        const result = await withRateLimit(() => client.runMethod(walletAddress, 'seqno'));
        return result.stack.readNumber();
    } catch {
        return 0;
    }
}

// The provider system hands back a single @ton/ton TonClient that is cached and
// PINNED to one endpoint, so its "failover" never re-routes an actual send — every
// retry re-hits the same (possibly dead) provider. We keep a reference to the
// ProviderManager and rebuild a client against whatever provider it currently
// considers best, so a 500 from one provider's /sendBoc is genuinely escaped.
let activeProviderManager: ProviderManager | undefined;
// Set when an explicit TON_RPC_ENDPOINT override is in effect; that URL carries its
// own auth, so we must NOT also attach a pooled provider's apiKey header.
let usingCustomEndpoint = false;

async function clientForCurrentProvider(fallback: TonClient): Promise<TonClient> {
    if (!activeProviderManager) return fallback;
    try {
        const endpoint = await activeProviderManager.getEndpoint();
        const apiKey = usingCustomEndpoint ? undefined : activeProviderManager.getActiveProvider()?.apiKey;
        return new TonClient({ endpoint, apiKey });
    } catch {
        return fallback;
    }
}

async function sendTransaction(
    client: TonClient,
    wallet: WalletContractV4,
    keyPair: { publicKey: Buffer; secretKey: Buffer },
    to: Address,
    value: bigint,
    withRateLimit: <T>(fn: () => Promise<T>) => Promise<T>,
    body?: Cell,
    stateInit?: { code: Cell; data: Cell },
    maxRetries: number = 6
): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        // Rebuild the client against the provider the ProviderManager currently
        // considers best. A previous attempt's failure already failed over (inside
        // withRateLimit -> reportError), so this re-routes the send to the NEXT
        // provider instead of re-hitting the dead one with the cached pinned client.
        const sendClient = await clientForCurrentProvider(client);
        try {
            // Get fresh seqno before each attempt
            const seqno = await getSeqno(sendClient, wallet.address, withRateLimit);

            const transfer = wallet.createTransfer({
                seqno,
                secretKey: keyPair.secretKey,
                messages: [
                    internal({
                        to,
                        value,
                        body,
                        init: stateInit,
                        bounce: false, // Don't bounce for deployments
                    }),
                ],
            });

            await withRateLimit(() => sendClient.sendExternalMessage(wallet, transfer));
            return; // Success
        } catch (error: any) {
            lastError = error;
            // @ton/ton's HttpApi uses axios, so the real RPC reason (e.g. toncenter's
            // {ok:false,error:...} on /sendBoc) lives in error.response.data and is
            // otherwise swallowed as a bare "Request failed with status code 500".
            const rpcBody = error?.response?.data;
            const rpcDetail = rpcBody
                ? ` | RPC: ${typeof rpcBody === 'string' ? rpcBody : JSON.stringify(rpcBody)}`
                : '';
            const errorMsg = (error.message || String(error)) + rpcDetail;

            // Check if it's a retryable error
            const isRetryable =
                errorMsg.includes('500') ||
                errorMsg.includes('502') ||
                errorMsg.includes('503') ||
                errorMsg.includes('429') ||
                errorMsg.includes('timeout') ||
                errorMsg.includes('ECONNRESET') ||
                errorMsg.includes('ETIMEDOUT');

            if (isRetryable && attempt < maxRetries) {
                // These failures (500/502/503/timeout) are provider/node health, not
                // our message — the next attempt rebuilds against the next provider
                // (see clientForCurrentProvider). So rotate FAST with a short fixed
                // delay rather than a long exponential backoff on the dead endpoint.
                const delay = Math.min(RETRY_DELAY, 3000);
                console.warn(`Transaction attempt ${attempt} failed: ${errorMsg}`);
                console.warn(`Rotating to next provider, retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${maxRetries})`);
                await sleep(delay);
                continue;
            }

            // Non-retryable error or max retries reached
            throw error;
        }
    }

    throw lastError || new Error('Transaction failed after retries');
}

async function checkAndDeploy(
    client: TonClient,
    wallet: WalletContractV4,
    keyPair: { publicKey: Buffer; secretKey: Buffer },
    contractAddress: Address,
    contractName: string,
    value: bigint,
    stateInit: { code: Cell; data: Cell },
    withRateLimit: <T>(fn: () => Promise<T>) => Promise<T>
): Promise<void> {
    // Check if already deployed
    if (await isContractDeployed(client, contractAddress, withRateLimit)) {
        console.log(`${contractName} is already deployed at ${contractAddress.toString()}`);
        return;
    }

    console.log(`Deploying ${contractName}...`);

    // Send deployment transaction
    await withTimeout(
        sendTransaction(client, wallet, keyPair, contractAddress, value, withRateLimit, undefined, stateInit),
        DEPLOYMENT_TIMEOUT,
        `Deploying ${contractName}`
    );

    console.log(`Deployment transaction sent for ${contractName}`);

    // Wait for deployment confirmation
    const deployed = await waitForDeploy(client, contractAddress, withRateLimit, 30);
    if (!deployed) {
        throw new Error(`${contractName} deployment not confirmed after 60 seconds`);
    }

    console.log(`${contractName} deployed successfully`);
    await sleep(TRANSACTION_WAIT_TIME);
}

async function sendContractMessage(
    client: TonClient,
    wallet: WalletContractV4,
    keyPair: { publicKey: Buffer; secretKey: Buffer },
    to: Address,
    value: bigint,
    body: Cell,
    withRateLimit: <T>(fn: () => Promise<T>) => Promise<T>
): Promise<void> {
    await sendTransaction(client, wallet, keyPair, to, value, withRateLimit, body, undefined, 6);
}

/**
 * Wait for seqno to increment (transaction processed)
 */
async function waitForSeqnoChange(
    client: TonClient,
    walletAddress: Address,
    currentSeqno: number,
    withRateLimit: <T>(fn: () => Promise<T>) => Promise<T>,
    maxWaitMs: number = 60000
): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
        try {
            const newSeqno = await getSeqno(client, walletAddress, withRateLimit);
            if (newSeqno > currentSeqno) {
                return true;
            }
        } catch {
            // Ignore errors, keep waiting
        }
        await sleep(2000);
    }
    return false;
}

/**
 * Send a message and wait for it to be processed
 */
async function sendAndWait(
    client: TonClient,
    wallet: WalletContractV4,
    keyPair: { publicKey: Buffer; secretKey: Buffer },
    to: Address,
    value: bigint,
    body: Cell,
    operationName: string,
    withRateLimit: <T>(fn: () => Promise<T>) => Promise<T>
): Promise<void> {
    const seqnoBefore = await getSeqno(client, wallet.address, withRateLimit);

    await sendContractMessage(client, wallet, keyPair, to, value, body, withRateLimit);
    console.log(`${operationName} transaction sent`);

    // Wait for seqno to change (transaction processed)
    const processed = await waitForSeqnoChange(client, wallet.address, seqnoBefore, withRateLimit, 60000);
    if (!processed) {
        console.warn(`Warning: ${operationName} may not have been processed yet`);
    } else {
        console.log(`${operationName} transaction confirmed`);
    }

    // Additional wait for state propagation
    await sleep(TRANSACTION_WAIT_TIME);
}

// ============================================================================
// Printers (GM-owned, R*-governed collections). admin == GameManager; they use
// their own editable item variants (NFTPrinterItem / SBTPrinterItem = standard
// item + a collection-gated SetContent handler) as their item code.
// ============================================================================

// createPrinters() + PRINTER_NFT_ROYALTY now live in scripts/lib/abiCore.ts (single
// assembly), imported above and reused by both the live deploy and the offline producer.

// v1 toolsInfo carries ONLY the printer addresses (fees stay off).
function buildToolsInfo(nftPrinter: Address, sbtPrinter: Address): ToolsInfo {
    return {
        feeNumerator: 0,
        feeDenominator: 1,
        feeCollector: null,
        nftPrinterAddress: nftPrinter,
        sbtPrinterAddress: sbtPrinter,
        extra: null,
    };
}

// Decode the two printer addresses out of a stored toolsInfo cell (null if unset).
function decodeToolsPrinters(cell: Cell | null): { nft: Address | null; sbt: Address | null } {
    if (!cell) return { nft: null, sbt: null };
    try {
        const s = cell.beginParse();
        s.loadUint(16); // feeNumerator
        s.loadUint(16); // feeDenominator
        s.loadAddressAny(); // feeCollector (addr_none when null)
        const nft = s.loadAddressAny();
        const sbt = s.loadAddressAny();
        return {
            nft: nft instanceof Address ? nft : null,
            sbt: sbt instanceof Address ? sbt : null,
        };
    } catch {
        return { nft: null, sbt: null };
    }
}

// ============================================================================
// Address Calculation
// ============================================================================

// calculateNetworkAddresses() now lives in scripts/lib/abiCore.ts (single assembly),
// imported above and shared by the live deploy + the offline producer.

// ============================================================================
// Main Deployment Logic
// ============================================================================

/**
 * `pnpm deploy --offline` (alias `pnpm abi`): regenerate deployment_latest.json OFFLINE.
 * Owner address from $DEPLOY_OWNER_ADDRESS or the existing json. No RPC/keys; placeholder
 * ship_station (pubkey=0); deployed:false. Uses the SAME shared assembly as the live deploy,
 * so the full contractCodes (incl. the code-only entries) is always written.
 */
async function runOfflineAbi(): Promise<void> {
    console.log('\n=== TON Game ABI (offline publish) ===');
    const existing = readDeploymentData();
    const ownerStr =
        process.env.DEPLOY_OWNER_ADDRESS ||
        existing.testnet?.ownerAddress?.nonBounceable ||
        existing.mainnet?.ownerAddress?.nonBounceable;
    if (!ownerStr) {
        throw new Error('No owner address found (set $DEPLOY_OWNER_ADDRESS or provide an existing deployment json).');
    }
    const ownerAddress = Address.parse(ownerStr);
    console.log('Compiling contracts (offline)...');
    const data = await buildOfflineDeploymentData(ownerAddress);
    writeFullDeploymentData(data);
    console.log('✅ ABI regenerated (offline, deployed:false). Run `pnpm deploy` to make addresses live.');
}

/**
 * HARD redeploy — the classical full idempotent walk (unchanged behavior): deploy
 * any missing contract (checkAndDeploy skips live ones) and seed ALL R* registries.
 * This is exactly what `pnpm deploy` did before `--mode` existed.
 */
async function hardRedeploy(options: CliOptions): Promise<void> {
    const { network, shipStationId } = options;
    const isTestnet = network === 'testnet';
    const timestamp = new Date().toISOString();

    console.log('\n=== TON Game System Deployment (mode: hard) ===');
    console.log(`Network: ${network}`);
    console.log(`Ship Station ID: ${shipStationId.toString()}`);
    console.log('');

    // Initialize provider system
    console.log('Initializing provider system...');
    const pm = ProviderManager.getInstance();
    await pm.init(network as ProviderNetwork);
    // Let the send path rebuild clients against the current provider on failover.
    activeProviderManager = pm;

    // Escape hatch for a degraded public testnet pool (e.g. a liteserver that can't
    // parse a network config param and rejects every external message): pin a
    // known-good RPC. The override URL must carry its own auth (api_key in the URL).
    const customRpcEndpoint = (process.env.TON_RPC_ENDPOINT || '').trim();
    if (customRpcEndpoint) {
        pm.setCustomEndpoint(customRpcEndpoint);
        usingCustomEndpoint = true;
        console.log('Using custom RPC endpoint override from TON_RPC_ENDPOINT (provider rotation disabled)');
    }

    const { client, withRateLimit } = await getTonClientWithRateLimit(pm);
    const endpoint = await pm.getEndpoint();
    console.log(`Connected to: ${endpoint}`);
    console.log('');

    // Load wallet
    const { wallet, keyPair } = await loadWallet();
    const ownerAddress = wallet.address;
    const ownerPublicKey = loadOwnerPublicKey(keyPair);

    console.log('Owner address (bounceable):', ownerAddress.toString({ bounceable: true }));
    console.log('Owner address (non-bounceable):', ownerAddress.toString({ bounceable: false }));
    console.log('');

    // Check wallet balance (with rate limiting)
    const walletBalance = await withRateLimit(() => client.getBalance(ownerAddress));
    console.log(`Wallet balance: ${(Number(walletBalance) / 1e9).toFixed(4)} TON`);
    if (walletBalance < toNano('1')) {
        console.error('ERROR: Wallet balance too low. Need at least 1 TON for deployment.');
        process.exit(1);
    }
    console.log('');

    // Read existing deployment data
    const existingData = readDeploymentData();

    try {
        // Compile all contracts (single source of truth — includes the code-only
        // contracts: ssmSlot, *Item).
        console.log('Compiling contracts...');
        const compiled = await compileAllContracts();
        const {
            gameManagerCode, retranslatorCode, gameCode, shipCode, coordinateCellCode,
            ssmCode, ssmSlotCode, jettonWalletCode, jettonMinterCode, subcontractCode,
            sbtItemCode, sbtCollectionCode, sbtnItemCode, sbtnCollectionCode, nftItemCode,
            nftPrinterItemCode, sbtPrinterItemCode, nftPrinterCode, sbtPrinterCode,
            ubpsCode, ubpsUnitCode, ubpsQuestionCode, ubpsAnswerCode, ubpsBeliefSetCode,
        } = compiled;
        console.log('Contracts compiled successfully');
        console.log('');

        const jettonContentUri = process.env.JETTON_CONTENT_URI || 'https://example.com/jetton.json';
        console.log(`Jetton content URI: ${jettonContentUri}`);

        // Build the COMPLETE contract codes (incl. the code-only entries) via the shared assembly.
        // Never hand-roll this list — that is how code-only entries got dropped.
        const contractCodes: ContractCodes = buildFullContractCodes(compiled);

        // Calculate addresses for both networks
        console.log('Calculating addresses...');
        const testnetAddresses = calculateNetworkAddresses(
            ownerAddress, gameManagerCode, retranslatorCode, gameCode, shipCode, coordinateCellCode,
            ssmCode, ssmSlotCode, jettonMinterCode, jettonWalletCode, subcontractCode,
            nftPrinterCode, sbtPrinterCode, nftPrinterItemCode, sbtPrinterItemCode,
            true, shipStationId, ownerPublicKey, jettonContentUri,
            ubpsCode, ubpsUnitCode, ubpsQuestionCode, ubpsAnswerCode, ubpsBeliefSetCode
        );
        const mainnetAddresses = calculateNetworkAddresses(
            ownerAddress, gameManagerCode, retranslatorCode, gameCode, shipCode, coordinateCellCode,
            ssmCode, ssmSlotCode, jettonMinterCode, jettonWalletCode, subcontractCode,
            nftPrinterCode, sbtPrinterCode, nftPrinterItemCode, sbtPrinterItemCode,
            false, shipStationId, ownerPublicKey, jettonContentUri,
            ubpsCode, ubpsUnitCode, ubpsQuestionCode, ubpsAnswerCode, ubpsBeliefSetCode
        );

        // Initialize deployment data
        const deploymentData: DeploymentData = {
            timestamp,
            // Non-secret constants (opcodes/errors/gas/amounts/enums) for sibling
            // projects. Placed between `timestamp` and `contractCodes`.
            constants: buildGameConstants(),
            contractCodes,
            testnet: network === 'testnet'
                ? { ...testnetAddresses, status: 'in_progress' }
                : existingData.testnet.deployed ? existingData.testnet : testnetAddresses,
            mainnet: network === 'mainnet'
                ? { ...mainnetAddresses, status: 'in_progress' }
                : existingData.mainnet.deployed ? existingData.mainnet : mainnetAddresses,
        };

        const networkData = network === 'testnet' ? deploymentData.testnet : deploymentData.mainnet;

        writeFullDeploymentData(deploymentData);
        console.log('Initial deployment data saved');
        console.log('');

        // Create contract instances
        const gameManager = GameManager.createFromConfig({ ownerAddress }, gameManagerCode);
        const retranslator = Retranslator.createFromConfig({
            gameManagerAddress: gameManager.address,
            ownerAddress,
            active: true,
        }, retranslatorCode);
        const game = Game.createFromConfig({
            managerAddress: gameManager.address,
            shipCode,
            coordinateCellCode,
        }, gameCode);
        const jettonMinter = JettonMinter.createFromConfig({
            admin: gameManager.address,
            content: jettonContentToCell({ type: 1, uri: jettonContentUri }),
            wallet_code: jettonWalletCode,
        }, jettonMinterCode);
        // Full SSM deploy wiring + registration are plan 3; here we only need a
        // type-correct, address-stable config (RUDA minter as the native origin).
        const ssm = SoullessSlotMachine.createFromConfig(
            {
                ownerAddress: gameManager.address,
                ssmSlotCode,
                rudaMasterAddress: jettonMinter.address,
            },
            ssmCode
        );
        // UBPS master (independent module — no GM/R* reward pipe). Owner = deployer
        // wallet (admin only). The master embeds the child codes for address calc.
        const ubps = UBPS.createFromConfig({
            ownerAddress,
            unitCode: ubpsUnitCode,
            questionCode: ubpsQuestionCode,
            answerCode: ubpsAnswerCode,
            beliefSetCode: ubpsBeliefSetCode,
        }, ubpsCode);
        const ownerJettonWallet = JettonWallet.createFromConfig({
            ownerAddress,
            minterAddress: jettonMinter.address,
        }, jettonWalletCode);
        const ownerShip = Ship.createFromConfig({
            userAddress: ownerAddress,
            gameAddress: game.address,
            coordinateCellCode,
        }, shipCode);
        const shipStation = Subcontract.createFromConfig({
            ownerAddress,
            id: shipStationId,
            ownerPublicKey,
        }, subcontractCode);
        const { nftPrinter, sbtPrinter } = createPrinters(
            ownerAddress, gameManager.address, nftPrinterCode, sbtPrinterCode, nftPrinterItemCode, sbtPrinterItemCode,
        );

        // ================================================================
        // Deploy contracts
        // ================================================================

        // 1. Deploy GameManager
        await checkAndDeploy(
            client, wallet, keyPair,
            gameManager.address, 'GameManager',
            toNano('1'),
            { code: gameManagerCode, data: gameManager.init!.data },
            withRateLimit
        );
        console.log('GameManager:', gameManager.address.toString());
        writeFullDeploymentData(deploymentData);

        // 1b. Deploy Retranslator (the swappable brain) and point GM at it.
        await checkAndDeploy(
            client, wallet, keyPair,
            retranslator.address, 'Retranslator',
            toNano('0.5'),
            { code: retranslatorCode, data: retranslator.init!.data },
            withRateLimit
        );
        console.log('Retranslator:', retranslator.address.toString());
        writeFullDeploymentData(deploymentData);

        const openedGameManagerForWiring = client.open(gameManager);
        const currentRetranslator = await withRateLimit(() => openedGameManagerForWiring.getRetranslatorAddress()).catch(() => null);
        if (!currentRetranslator?.equals(retranslator.address)) {
            await sendAndWait(
                client, wallet, keyPair,
                gameManager.address,
                GAS_COST_SET_RETRANSLATOR + toNano('0.05'),
                GameManager.setRetranslatorMessage(retranslator.address),
                'Set retranslator',
                withRateLimit
            );
        } else {
            console.log('Retranslator already wired');
        }

        // 2. Deploy Game
        await checkAndDeploy(
            client, wallet, keyPair,
            game.address, 'TON Race Game',
            toNano('0.5'),
            { code: gameCode, data: game.init!.data },
            withRateLimit
        );
        console.log('TON Race Game:', game.address.toString());
        writeFullDeploymentData(deploymentData);

        // 3. Deploy SSM
        await checkAndDeploy(
            client, wallet, keyPair,
            ssm.address, 'Soulless Slot Machine',
            toNano('0.5'),
            { code: ssmCode, data: ssm.init!.data },
            withRateLimit
        );
        console.log('Soulless Slot Machine:', ssm.address.toString());
        writeFullDeploymentData(deploymentData);

        // 3b. Deploy UBPS master (independent module; children deploy on demand).
        await checkAndDeploy(
            client, wallet, keyPair,
            ubps.address, 'UBPS',
            toNano('0.5'),
            { code: ubpsCode, data: ubps.init!.data },
            withRateLimit
        );
        console.log('UBPS:', ubps.address.toString());
        writeFullDeploymentData(deploymentData);

        // 4. Deploy JettonMinter
        await checkAndDeploy(
            client, wallet, keyPair,
            jettonMinter.address, 'JettonMinter',
            toNano('0.5'),
            { code: jettonMinterCode, data: jettonMinter.init!.data },
            withRateLimit
        );
        console.log('JettonMinter:', jettonMinter.address.toString());
        writeFullDeploymentData(deploymentData);

        // 5. Deploy owner's JettonWallet
        await checkAndDeploy(
            client, wallet, keyPair,
            ownerJettonWallet.address, 'Owner JettonWallet',
            toNano('0.5'),
            { code: jettonWalletCode, data: ownerJettonWallet.init!.data },
            withRateLimit
        );
        console.log('Owner JettonWallet:', ownerJettonWallet.address.toString());
        writeFullDeploymentData(deploymentData);

        // 5b. Deploy NFTPrinter (GM-owned, TEP-62 transferable collection).
        await checkAndDeploy(
            client, wallet, keyPair,
            nftPrinter.address, 'NFTPrinter',
            toNano('0.2'),
            { code: nftPrinterCode, data: nftPrinter.init!.data },
            withRateLimit
        );
        console.log('NFTPrinter:', nftPrinter.address.toString());
        writeFullDeploymentData(deploymentData);

        // 5c. Deploy SBTPrinter (GM-owned, soulbound/revocable collection).
        await checkAndDeploy(
            client, wallet, keyPair,
            sbtPrinter.address, 'SBTPrinter',
            toNano('0.2'),
            { code: sbtPrinterCode, data: sbtPrinter.init!.data },
            withRateLimit
        );
        console.log('SBTPrinter:', sbtPrinter.address.toString());
        writeFullDeploymentData(deploymentData);

        // 6. Configure Retranslator: jetton info (minter address + wallet code),
        //    relayed through GM.RedirectMessage (owner -> GM -> R*).
        console.log('Configuring Retranslator jetton info...');
        const openedRetranslator = client.open(retranslator);
        let jettonInfo = await withRateLimit(() => openedRetranslator.getJettonInfo()).catch(() => null);

        if (!jettonInfo?.jettonMinterAddress?.equals(jettonMinter.address)) {
            await sendAndWait(
                client, wallet, keyPair,
                gameManager.address,
                GAS_COST_REDIRECT_MESSAGE + toNano('0.1'),
                GameManager.redirectMessage(
                    retranslator.address,
                    Retranslator.setJettonInfoMessage({
                        jettonMinterAddress: jettonMinter.address,
                        jettonWalletCode,
                    }),
                    toNano('0.1'),
                ),
                'Set jetton info (R*)',
                withRateLimit
            );
        } else {
            console.log('Jetton info already configured');
        }

        // 7. Configure Retranslator: games info, also via GM relay.
        console.log('Setting games info on Retranslator...');
        const gamesInfo = await withRateLimit(() => openedRetranslator.getGamesInfo()).catch(() => null);

        if (!gamesInfo?.active_game?.equals(game.address)) {
            await sendAndWait(
                client, wallet, keyPair,
                gameManager.address,
                toNano('1'),
                GameManager.redirectMessage(
                    retranslator.address,
                    // Named slots: ton_race_game stays the default active reward game;
                    // ssm is the other reward slot; ubps is registration-only (never
                    // reward-authorized).
                    Retranslator.setGamesInfoMessage({
                        active_game: game.address,
                        ssm: ssm.address,
                        ton_race_game: game.address,
                        ubps: ubps.address,
                    }),
                    toNano('0.9'),
                ),
                'Set games info (R*)',
                withRateLimit
            );
        } else {
            console.log('Games info already configured');
        }

        // 7b. Configure Retranslator: toolsInfo (printer addresses), via GM relay.
        //     R* needs these so MintNft/MintSbt/RevokeSbt can target the printers.
        console.log('Setting tools info (printer addresses) on Retranslator...');
        const existingTools = await withRateLimit(() => openedRetranslator.getToolsInfo()).catch(() => null);
        const existingPrinters = decodeToolsPrinters(existingTools);
        const printersWired =
            existingPrinters.nft?.equals(nftPrinter.address) &&
            existingPrinters.sbt?.equals(sbtPrinter.address);

        if (!printersWired) {
            await sendAndWait(
                client, wallet, keyPair,
                gameManager.address,
                GAS_COST_REDIRECT_MESSAGE + toNano('0.1'),
                GameManager.redirectMessage(
                    retranslator.address,
                    Retranslator.setToolsInfoMessage(
                        buildToolsInfo(nftPrinter.address, sbtPrinter.address),
                    ),
                    toNano('0.1'),
                ),
                'Set tools info (R*)',
                withRateLimit
            );
        } else {
            console.log('Tools info (printers) already configured');
        }

        // 8. Verify configurations (on the Retranslator now).
        console.log('Verifying configurations...');
        await sleep(TRANSACTION_WAIT_TIME);

        const verifyJettonInfo = await withRateLimit(() => openedRetranslator.getJettonInfo()).catch(() => null);
        if (verifyJettonInfo?.jettonMinterAddress?.equals(jettonMinter.address)) {
            console.log('✓ JettonMinter address verified on R*');
        } else {
            console.warn('⚠ JettonMinter address not yet set on R* (may still be processing)');
        }

        const verifyGamesInfo = await withRateLimit(() => openedRetranslator.getGamesInfo()).catch(() => null);
        if (verifyGamesInfo?.active_game?.equals(game.address)) {
            console.log('✓ Active game address verified on R*');
        } else {
            console.warn('⚠ Active game not yet set on R* (may still be processing)');
        }
        if (verifyGamesInfo?.ubps?.equals(ubps.address)) {
            console.log('✓ UBPS registration slot verified on R* (registration-only)');
        } else {
            console.warn('⚠ UBPS slot not yet set on R* (may still be processing)');
        }

        const verifyTools = decodeToolsPrinters(
            await withRateLimit(() => openedRetranslator.getToolsInfo()).catch(() => null)
        );
        if (verifyTools.nft?.equals(nftPrinter.address) && verifyTools.sbt?.equals(sbtPrinter.address)) {
            console.log('✓ Printer addresses verified on R* (toolsInfo)');
        } else {
            console.warn('⚠ Printer addresses not yet set on R* (may still be processing)');
        }

        // 9. Mint initial jettons
        console.log('Checking jetton balance...');
        const openedOwnerJettonWallet = client.open(ownerJettonWallet);
        let currentBalance = 0n;
        try {
            currentBalance = await withRateLimit(() => openedOwnerJettonWallet.getJettonBalance());
        } catch {
            // Wallet may not be initialized yet
        }

        if (currentBalance < BASE_MINT_AMOUNT) {
            console.log('Minting initial jettons...');
            const redirectMessage = JettonMinter.mintMessage(
                jettonMinter.address,
                ownerAddress,
                BASE_MINT_AMOUNT,
                toNano('0.1'),
                toNano('0.2')
            );
            await sendAndWait(
                client, wallet, keyPair,
                gameManager.address,
                toNano('1'),
                GameManager.redirectMessage(jettonMinter.address, redirectMessage, toNano('0.1')),
                'Mint jettons',
                withRateLimit
            );

            // Check balance
            try {
                currentBalance = await withRateLimit(() => openedOwnerJettonWallet.getJettonBalance());
            } catch {
                currentBalance = 0n;
            }
        }
        networkData.ownerJettonBalance = currentBalance.toString();
        console.log(`Owner jetton balance: ${currentBalance.toString()}`);
        writeFullDeploymentData(deploymentData);

        // 10. Deploy Owner Ship
        await checkAndDeploy(
            client, wallet, keyPair,
            ownerShip.address, 'Owner Ship',
            toNano('0.5'),
            { code: shipCode, data: ownerShip.init!.data },
            withRateLimit
        );
        console.log('Owner Ship:', ownerShip.address.toString());
        writeFullDeploymentData(deploymentData);

        // 11. Deploy Ship Station
        const deployAmount = (GAS_COST_MANUAL_DEPLOY + BASIC_STORAGE_TAX) * 2n;
        await checkAndDeploy(
            client, wallet, keyPair,
            shipStation.address, 'Ship Station',
            deployAmount,
            { code: subcontractCode, data: shipStation.init!.data },
            withRateLimit
        );
        console.log('Ship Station:', shipStation.address.toString());
        writeFullDeploymentData(deploymentData);

        // Mark deployment as completed
        networkData.status = 'completed';
        networkData.deployed = true;
        writeFullDeploymentData(deploymentData);

        // ================================================================
        // Summary
        // ================================================================

        console.log('\n=== Deployment Summary ===');
        console.log('Network:', network);
        console.log('');
        console.log('Owner:', ownerAddress.toString());
        console.log('GameManager:', gameManager.address.toString());
        console.log('Retranslator:', retranslator.address.toString());
        console.log('NFTPrinter:', nftPrinter.address.toString());
        console.log('SBTPrinter:', sbtPrinter.address.toString());
        console.log('TON Race Game:', game.address.toString());
        console.log('Soulless Slot Machine:', ssm.address.toString());
        console.log('UBPS:', ubps.address.toString());
        console.log('JettonMinter:', jettonMinter.address.toString());
        console.log('Owner JettonWallet:', ownerJettonWallet.address.toString());
        console.log('Owner Ship:', ownerShip.address.toString());
        console.log('Ship Station:', shipStation.address.toString());
        console.log('Owner Jetton Balance:', currentBalance.toString());
        console.log('');
        console.log('Deployment info saved to: deployment_info/deployment_latest.json');
        console.log('========================\n');

    } catch (error: any) {
        // Update deployment data with error status
        try {
            const errorData = readDeploymentData();
            const errorNetworkData = network === 'testnet' ? errorData.testnet : errorData.mainnet;
            errorNetworkData.status = 'failed';
            errorNetworkData.error = error.message || String(error);
            errorNetworkData.deployed = false;
            writeFullDeploymentData(errorData);
        } catch {
            // Ignore errors when writing error state
        }

        console.error('\n=== Deployment Failed ===');
        console.error('Error:', error.message || error);
        console.error('========================\n');
        // Re-throw to let the bottom handler clean up and exit
        throw error;
    }
}

// ============================================================================
// RETRO update (change-detection-driven incremental deploy)
// ============================================================================

const JETTON_DEFAULT_URI = 'https://example.com/jetton.json';

/** Build the freshly-compiled contract instances retro may need to redeploy. */
function buildRetroInstances(
    compiled: CompiledContracts,
    ownerAddress: Address,
    ownerPublicKey: bigint,
    shipStationId: bigint,
    jettonContentUri: string,
) {
    const gameManager = GameManager.createFromConfig({ ownerAddress }, compiled.gameManagerCode);
    const game = Game.createFromConfig(
        { managerAddress: gameManager.address, shipCode: compiled.shipCode, coordinateCellCode: compiled.coordinateCellCode },
        compiled.gameCode,
    );
    const jettonMinter = JettonMinter.createFromConfig(
        {
            admin: gameManager.address,
            content: jettonContentToCell({ type: 1, uri: jettonContentUri }),
            wallet_code: compiled.jettonWalletCode,
        },
        compiled.jettonMinterCode,
    );
    const ssm = SoullessSlotMachine.createFromConfig(
        { ownerAddress: gameManager.address, ssmSlotCode: compiled.ssmSlotCode, rudaMasterAddress: jettonMinter.address },
        compiled.ssmCode,
    );
    const ubps = UBPS.createFromConfig(
        {
            ownerAddress,
            unitCode: compiled.ubpsUnitCode,
            questionCode: compiled.ubpsQuestionCode,
            answerCode: compiled.ubpsAnswerCode,
            beliefSetCode: compiled.ubpsBeliefSetCode,
        },
        compiled.ubpsCode,
    );
    const ownerShip = Ship.createFromConfig(
        { userAddress: ownerAddress, gameAddress: game.address, coordinateCellCode: compiled.coordinateCellCode },
        compiled.shipCode,
    );
    const shipStation = Subcontract.createFromConfig(
        { ownerAddress, id: shipStationId, ownerPublicKey },
        compiled.subcontractCode,
    );
    const { nftPrinter, sbtPrinter } = createPrinters(
        ownerAddress, gameManager.address, compiled.nftPrinterCode, compiled.sbtPrinterCode,
        compiled.nftPrinterItemCode, compiled.sbtPrinterItemCode,
    );
    return { gameManager, game, jettonMinter, ssm, ubps, ownerShip, shipStation, nftPrinter, sbtPrinter };
}

type RetroInstances = ReturnType<typeof buildRetroInstances>;

/** Map a tracked leaf key → its freshly-compiled instance + deploy value + state init. */
function leafDeployTarget(
    key: string,
    inst: RetroInstances,
): { address: Address; value: bigint; init: { code: Cell; data: Cell } } {
    switch (key) {
        case 'jettonMinter':
            return { address: inst.jettonMinter.address, value: toNano('0.5'), init: inst.jettonMinter.init! };
        case 'nftPrinter':
            return { address: inst.nftPrinter.address, value: toNano('0.2'), init: inst.nftPrinter.init! };
        case 'sbtPrinter':
            return { address: inst.sbtPrinter.address, value: toNano('0.2'), init: inst.sbtPrinter.init! };
        case 'games.ton_race_game.game':
            return { address: inst.game.address, value: toNano('0.5'), init: inst.game.init! };
        case 'games.soulless_slot_machine.ssm':
            return { address: inst.ssm.address, value: toNano('0.5'), init: inst.ssm.init! };
        case 'games.ubps.ubps':
            return { address: inst.ubps.address, value: toNano('0.5'), init: inst.ubps.init! };
        case 'games.ton_race_game.ownerShip':
            return { address: inst.ownerShip.address, value: toNano('0.5'), init: inst.ownerShip.init! };
        case 'ship_station':
            return {
                address: inst.shipStation.address,
                value: (GAS_COST_MANUAL_DEPLOY + BASIC_STORAGE_TAX) * 2n,
                init: inst.shipStation.init!,
            };
        default:
            throw new Error(`leafDeployTarget: unknown leaf key ${key}`);
    }
}

/** Human label for the re-registration setter a leaf triggers (Step 7). */
function setterLabel(kind: LeafKind): string {
    switch (kind) {
        case 'jettonMinter':
            return 'setJettonInfo (R*)';
        case 'nftPrinter':
        case 'sbtPrinter':
            return 'setToolsInfo (R*)';
        case 'ssm':
        case 'ton_race_game':
        case 'ubps':
            return 'setGamesInfo (R*)';
        case 'subcontract':
        case 'ownerShip':
            return 'none (not in an R* registry)';
    }
}

function printChangeReport(report: ChangeReport, descriptors: TrackedDescriptor[]): void {
    console.log('\n--- CHANGE DETECTION (on-chain code hash vs freshly compiled) ---');
    for (const d of descriptors) {
        const state =
            d.onChainHash === null ? 'NOT-DEPLOYED' : d.onChainHash === d.compiledHash ? 'unchanged' : 'CHANGED';
        console.log(`  ${state.padEnd(13)} ${d.key} (${d.role})`);
    }
    console.log(
        `Summary: gmChanged=${report.gmChanged} gmNotDeployed=${report.gmNotDeployed} ` +
        `rStarChanged=${report.rStarChanged} rStarNotDeployed=${report.rStarNotDeployed} ` +
        `leafChanges=${report.leafChanges.length} unchanged=${report.unchanged.length}`,
    );
}

/**
 * Refresh ONLY the contractCodes + constants in deployment_latest.json (addresses
 * and deployed flags preserved). Used on an up-to-date retro run when the checked-in
 * artifact's hashes have drifted from source (e.g. a comment-only recompile).
 */
function refreshArtifactCodes(compiled: CompiledContracts): void {
    const existing = readDeploymentData();
    existing.timestamp = new Date().toISOString();
    existing.constants = buildGameConstants();
    existing.contractCodes = buildFullContractCodes(compiled);
    writeFullDeploymentData(existing);
}

/** Write the new address of a redeployed leaf back into the network deployment data. */
function setLeafAddress(net: NetworkDeploymentData, key: string, address: Address, isTestnet: boolean): void {
    const info = formatAddress(address, isTestnet);
    const games = (net.games ??= {});
    switch (key) {
        case 'jettonMinter':
            net.jettonMinter = info; break;
        case 'nftPrinter':
            net.nftPrinter = info; break;
        case 'sbtPrinter':
            net.sbtPrinter = info; break;
        case 'ship_station':
            net.ship_station = info; break;
        case 'games.ton_race_game.game':
            games.ton_race_game = { ...games.ton_race_game, game: info }; break;
        case 'games.ton_race_game.ownerShip':
            // Preserve the existing game address (fall back to the new one if absent).
            games.ton_race_game = { game: games.ton_race_game?.game ?? info, ownerShip: info }; break;
        case 'games.soulless_slot_machine.ssm':
            games.soulless_slot_machine = { ssm: info }; break;
        case 'games.ubps.ubps':
            games.ubps = { ubps: info }; break;
        default:
            throw new Error(`setLeafAddress: unknown leaf key ${key}`);
    }
}

async function retroUpdate(options: CliOptions): Promise<void> {
    const { network, dryRun, assumeYes } = options;
    const isTestnet = network === 'testnet';

    console.log(`\n=== TON Game System — RETRO update (${network}${dryRun ? ', DRY-RUN' : ''}) ===`);

    // --- provider + read-only client (same setup as hard, minus the wallet) ---
    const pm = ProviderManager.getInstance();
    await pm.init(network as ProviderNetwork);
    activeProviderManager = pm;
    const customRpcEndpoint = (process.env.TON_RPC_ENDPOINT || '').trim();
    if (customRpcEndpoint) {
        pm.setCustomEndpoint(customRpcEndpoint);
        usingCustomEndpoint = true;
        console.log('Using custom RPC endpoint override from TON_RPC_ENDPOINT (provider rotation disabled)');
    }
    const { client, withRateLimit } = await getTonClientWithRateLimit(pm);
    console.log(`Connected to: ${await pm.getEndpoint()}`);

    // --- recorded deployment for this network ---
    const netData = readDeploymentData()[network];
    if (!netData?.gameManager) {
        console.error(
            `No recorded GameManager for ${network} in deployment_latest.json. Retro updates an existing system; ` +
            `for a first deploy use \`--mode hard\`.`,
        );
        process.exit(1);
    }

    // --- compile + detect on-chain code changes ---
    console.log('Compiling contracts + detecting on-chain code changes...');
    const compiled = await compileAllContracts();
    const { report, descriptors } = await detectChanges(client, withRateLimit, netData, compiled);
    printChangeReport(report, descriptors);

    // secondary (informational) signal: checked-in artifact vs source.
    try {
        const { ok, mismatches, missing } = await verifyDeploymentHashes();
        if (!ok) {
            console.log(
                `(secondary) deployment_latest.json artifact differs from source — ${mismatches.length} mismatch(es), ` +
                `${missing.length} missing. It will be refreshed by this run.`,
            );
        }
    } catch {
        // non-fatal — the on-chain comparison above is authoritative
    }

    const plan = planRetroActions(report);

    if (plan.refuse) {
        console.error(`\nREFUSE: ${plan.refuseReason}`);
        process.exit(2);
    }
    if (plan.upToDate) {
        console.log('\n✅ System is up to date — no GM / R* / leaf code changes detected on-chain.');
        if (!dryRun) {
            const { ok } = await verifyDeploymentHashes();
            if (!ok) {
                console.log('Refreshing deployment_latest.json contractCodes to match source (addresses unchanged)...');
                refreshArtifactCodes(compiled);
            }
        }
        return;
    }

    // --- print the ordered action plan + orphan warnings ---
    console.log('\n--- RETRO ACTION PLAN ---');
    if (plan.swap) {
        console.log('• Hot-swap Retranslator (R*): migrate counters + reseed registries + repoint GM.');
    }
    const orphaning = plan.leafRedeploys.some((l) => orphanWarning(l.kind) !== null);
    for (const leaf of plan.leafRedeploys) {
        console.log(
            `• Redeploy leaf ${leaf.key} (${leaf.kind}, ${leaf.status})` +
            `${leaf.oldAddr ? ` [old ${leaf.oldAddr}]` : ''}`,
        );
        const w = orphanWarning(leaf.kind);
        if (w) console.log(`    ⚠ ORPHAN WARNING: ${w}`);
        console.log(`    ↳ re-register via ${setterLabel(leaf.kind)}`);
    }

    if (dryRun) {
        console.log('\nDRY-RUN complete. No messages were sent. Re-run without --dry-run (operator) to apply.');
        return;
    }

    // ============ LIVE EXECUTION (operator only) ============
    // mainnet orphan gate: refuse to strand stateful child contracts without --yes.
    if (network === 'mainnet' && orphaning && !assumeYes) {
        throw new Error(
            'Refusing to orphan stateful contract(s) on mainnet without --yes. Review the ORPHAN WARNINGs above, ' +
            'then re-run with --yes to proceed.',
        );
    }

    const { wallet, keyPair } = await loadWallet();
    const ownerAddress = wallet.address;
    const ownerPublicKey = loadOwnerPublicKey(keyPair);
    const balance = await withRateLimit(() => client.getBalance(ownerAddress));
    console.log(`Operator wallet: ${ownerAddress.toString()}  balance ${(Number(balance) / 1e9).toFixed(3)} TON`);
    if (balance < toNano('1')) {
        console.error('ERROR: Wallet balance too low (need at least 1 TON).');
        process.exit(1);
    }

    const gmAddress = Address.parse(netData.gameManager.bounceable);
    const jettonContentUri = process.env.JETTON_CONTENT_URI || JETTON_DEFAULT_URI;
    const instances = buildRetroInstances(compiled, ownerAddress, ownerPublicKey, options.shipStationId, jettonContentUri);

    // Shared operator send primitive (deploy when stateInit is present, else a message).
    const send: SwapSend = async (to, value, body, op, stateInit) => {
        if (stateInit) {
            await withTimeout(
                sendTransaction(client, wallet, keyPair, to, value, withRateLimit, body, stateInit),
                DEPLOYMENT_TIMEOUT,
                op,
            );
            await waitForDeploy(client, to, withRateLimit, 30);
            console.log(`  · ${op}: deployed`);
        } else {
            await sendAndWait(client, wallet, keyPair, to, value, body, op, withRateLimit);
        }
    };

    // 1) R* hot-swap (if needed). Establishes the live R* the setters target.
    let currentRAddress = netData.retranslator ? Address.parse(netData.retranslator.bounceable) : null;
    if (plan.swap) {
        if (!currentRAddress) throw new Error('R* swap required but deployment_latest.json has no retranslator address.');
        const swapCtx: SwapContext = {
            client, withRateLimit, network, isTestnet,
            gmAddress, oldRAddress: currentRAddress, retranslatorCode: compiled.retranslatorCode, send,
        };
        const swapRes = await runRetranslatorSwap(swapCtx, { dryRun: false });
        currentRAddress = swapRes.newRAddress;
    }
    if (!currentRAddress) throw new Error('No live Retranslator to re-register leaves on; aborting.');

    // 2) Read the CURRENT (post-swap) R* registries so we preserve unchanged slots.
    const openedR = client.open(Retranslator.createFromAddress(currentRAddress));
    const curGames = await withRateLimit(() => openedR.getGamesInfo()).catch(() => null);
    const curToolsCell = await withRateLimit(() => openedR.getToolsInfo()).catch(() => null);
    const curPrinters = decodeToolsPrinters(curToolsCell);

    // 3) Redeploy each changed leaf + accumulate the registry updates.
    let gamesDirty = false;
    const newGames: GamesInfo = curGames
        ? { ...curGames }
        : { active_game: instances.game.address, ssm: instances.ssm.address, ton_race_game: instances.game.address, ubps: instances.ubps.address };
    let toolsDirty = false;
    // Default unchanged printers to their (deterministic) freshly-compiled address —
    // identical to the live address when the code didn't change.
    let nftAddr: Address = curPrinters.nft ?? instances.nftPrinter.address;
    let sbtAddr: Address = curPrinters.sbt ?? instances.sbtPrinter.address;
    let jettonDirty = false;

    const wasActive = (oldAddr: string | null): boolean =>
        !!(oldAddr && curGames?.active_game && curGames.active_game.equals(Address.parse(oldAddr)));

    for (const leaf of plan.leafRedeploys) {
        const target = leafDeployTarget(leaf.key, instances);
        const w = orphanWarning(leaf.kind);
        if (w) console.log(`⚠ ORPHANING (${leaf.key}): ${w}`);
        const alreadyActive = (await withRateLimit(() => client.getContractState(target.address))).state === 'active';
        if (alreadyActive) {
            console.log(`  · ${leaf.key}: already at ${target.address.toString()}; skipping deploy`);
        } else {
            await send(target.address, target.value, beginCell().endCell(), `deploy ${leaf.key}`, target.init);
        }

        switch (leaf.kind) {
            case 'jettonMinter':
                jettonDirty = true; break;
            case 'nftPrinter':
                nftAddr = instances.nftPrinter.address; toolsDirty = true; break;
            case 'sbtPrinter':
                sbtAddr = instances.sbtPrinter.address; toolsDirty = true; break;
            case 'ton_race_game':
                newGames.ton_race_game = instances.game.address;
                if (wasActive(leaf.oldAddr)) newGames.active_game = instances.game.address;
                gamesDirty = true; break;
            case 'ssm':
                newGames.ssm = instances.ssm.address;
                if (wasActive(leaf.oldAddr)) newGames.active_game = instances.ssm.address;
                gamesDirty = true; break;
            case 'ubps':
                newGames.ubps = instances.ubps.address; gamesDirty = true; break;
            case 'subcontract':
            case 'ownerShip':
                break; // not in any R* registry — redeploy only
        }
    }

    // 4) Re-register on the live R* via GM relay (only the registries that changed).
    const relay = (body: Cell, value: bigint, forward: bigint, op: string) =>
        send(gmAddress, GAS_COST_REDIRECT_MESSAGE + value, GameManager.redirectMessage(currentRAddress!, body, forward), op);

    if (jettonDirty) {
        await relay(
            Retranslator.setJettonInfoMessage({ jettonMinterAddress: instances.jettonMinter.address, jettonWalletCode: compiled.jettonWalletCode }),
            toNano('0.1'), toNano('0.1'), 'reregister jettonInfo',
        );
    }
    if (gamesDirty) {
        await relay(Retranslator.setGamesInfoMessage(newGames), toNano('1'), toNano('0.9'), 'reregister gamesInfo');
    }
    if (toolsDirty) {
        await relay(Retranslator.setToolsInfoMessage(buildToolsInfo(nftAddr, sbtAddr)), toNano('0.1'), toNano('0.1'), 'reregister toolsInfo');
    }

    // 5) Finalize the artifact: refresh contractCodes + write the new leaf addresses.
    const finalData = readDeploymentData();
    finalData.timestamp = new Date().toISOString();
    finalData.constants = buildGameConstants();
    finalData.contractCodes = buildFullContractCodes(compiled);
    const finalNet = finalData[network];
    for (const leaf of plan.leafRedeploys) {
        setLeafAddress(finalNet, leaf.key, leafDeployTarget(leaf.key, instances).address, isTestnet);
    }
    finalNet.status = 'completed';
    finalNet.deployed = true;
    writeFullDeploymentData(finalData);

    console.log('\n=== Retro update complete ===');
    console.log(`Network: ${network}`);
    if (plan.swap) console.log(`Retranslator (new): ${currentRAddress.toString()}`);
    for (const leaf of plan.leafRedeploys) {
        console.log(`${leaf.key}: ${leafDeployTarget(leaf.key, instances).address.toString()}`);
    }
    console.log('deployment_info/deployment_latest.json updated.');
}

async function main(): Promise<void> {
    const options = parseCliArgs();

    // OFFLINE ABI publish — no RPC, no keys. Independent of mode. Same producer +
    // shared assembly as a live deploy, with placeholder addresses + deployed:false.
    if (options.offline) {
        await runOfflineAbi();
        return;
    }

    if (options.mode === 'hard') {
        await hardRedeploy(options);
    } else {
        await retroUpdate(options);
    }
}

// Run main
main()
    .then(() => {
        // Cleanup provider system to allow process exit
        ProviderManager.resetInstance();
        process.exit(0);
    })
    .catch(() => {
        // Error already logged in main(), just cleanup and exit
        ProviderManager.resetInstance();
        process.exit(1);
    });
