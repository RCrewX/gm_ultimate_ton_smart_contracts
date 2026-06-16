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
import { ToolsInfo } from '../wrappers/game_manager/RetranslatorTypes';
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
} from '../lib/buildOutput';
import { buildGameConstants } from '../lib/gameConstants';
import {
    compileAllContracts,
    buildFullContractCodes,
    calculateNetworkAddresses,
    createPrinters,
    buildOfflineDeploymentData,
} from './lib/abiCore';
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

interface CliOptions {
    network: Network;
    shipStationId: bigint;
    /** Offline ABI publish: assemble the full artifact with placeholder addrs, no RPC/keys. */
    offline: boolean;
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let network: Network = 'testnet';
    let shipStationId = 1n;
    let offline = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--mainnet') {
            network = 'mainnet';
        } else if (arg === '--testnet') {
            network = 'testnet';
        } else if (arg === '--offline') {
            offline = true;
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

Options:
  --testnet       Deploy to testnet (default)
  --mainnet       Deploy to mainnet
  --offline       Regenerate deployment_latest.json OFFLINE (full ABI, placeholder
                  addrs, deployed:false). No RPC/keys. Same as 'pnpm abi'.
  --id <n>        Ship station ID (default: 1)
  --help, -h      Show this help

Environment Variables:
  PRIVATE_KEY          128-hex private key (required)
  MNEMONIC             24-word mnemonic (alternative to PRIVATE_KEY)
  JETTON_CONTENT_URI   Jetton metadata URI
  OWNER_PUBLIC_KEY     Public key for external signatures

Examples:
  pnpm deploy                     # Deploy to testnet
  pnpm deploy --mainnet           # Deploy to mainnet
  pnpm deploy --id 5              # Deploy with ship station ID 5
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

    return { network, shipStationId, offline };
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

async function main(): Promise<void> {
    const options = parseCliArgs();
    const { network, shipStationId } = options;
    const isTestnet = network === 'testnet';
    const timestamp = new Date().toISOString();

    // OFFLINE ABI publish — no RPC, no keys. Same producer + shared assembly as a live
    // deploy, but with placeholder addresses (ownerPublicKey=0 → only ship_station is a
    // placeholder) and deployed:false. This is what `pnpm abi` runs.
    if (options.offline) {
        await runOfflineAbi();
        return;
    }

    console.log('\n=== TON Game System Deployment ===');
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
