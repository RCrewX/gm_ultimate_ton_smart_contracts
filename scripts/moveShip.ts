// SPDX-License-Identifier: UNLICENSED
import { Address } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Ship } from '../wrappers/ton_race_game/Ship';
import { MoveMode } from '../wrappers/ton_race_game/structs';
import { GAS_COST_SEND_MOVE } from '../wrappers/ton_race_game/types';
import * as dotenv from 'dotenv';
import {
    Network,
    NetworkDeploymentData,
    readNetworkDeploymentData,
    getDeploymentLatestPath,
} from '../lib/buildOutput';
import { logChainstackConfig } from '../lib/chainstack';

// Load environment variables
dotenv.config();

function loadDeploymentData(network: Network): { data: NetworkDeploymentData; network: Network } {
    const data = readNetworkDeploymentData(network);
    if (!data) {
        throw new Error(`No deployment found for ${network}. Please deploy the system first.`);
    }
    
    // Check deployment status
    if (data.status === 'in_progress') {
        throw new Error(`Deployment is still in progress for ${network}. Please wait for deployment to complete.`);
    }
    
    if (data.status === 'failed' || !data.deployed) {
        const errorMsg = data.error || 'Unknown error';
        throw new Error(
            `Deployment failed for ${network}. Please fix and redeploy.\n` +
            `Error: ${errorMsg}`
        );
    }
    
    console.log(`Loading deployment data from: ${getDeploymentLatestPath()}`);
    console.log(`Network: ${network}`);
    return { data, network };
}

function parseDirection(): MoveMode {
    // First check environment variable (set by runWithChainstack.ts)
    const envDir = process.env.SCRIPT_DIRECTION;
    if (envDir) {
        switch (envDir.toLowerCase()) {
            case 'exit':
                return MoveMode.EXIT;
            case 'left':
                return MoveMode.LEFT;
            case 'right':
                return MoveMode.RIGHT;
            case 'up':
                return MoveMode.UP;
            case 'down':
                return MoveMode.EXIT; // down is alias for exit
        }
    }

    // Fall back to CLI args (for direct blueprint run)
    const args = process.argv.slice(2);

    if (args.includes('--exit')) {
        return MoveMode.EXIT;
    } else if (args.includes('--left')) {
        return MoveMode.LEFT;
    } else if (args.includes('--right')) {
        return MoveMode.RIGHT;
    } else if (args.includes('--up')) {
        return MoveMode.UP;
    } else {
        // Default to UP
        return MoveMode.UP;
    }
}

function parseMoveCount(): number {
    // First check environment variable (set by runWithChainstack.ts)
    const envCount = process.env.SCRIPT_COUNT;
    if (envCount) {
        const count = parseInt(envCount, 10);
        if (!isNaN(count) && count > 0 && count < 11) {
            return count;
        } else {
            console.warn(`Warning: Invalid SCRIPT_COUNT "${envCount}". Must be between 1 and 10. Using default: 5`);
            return 5;
        }
    }

    // Fall back to CLI args (for direct blueprint run)
    const args = process.argv.slice(2);

    // Find --moves or --count argument
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if ((arg === '--moves' || arg === '--count') && i + 1 < args.length) {
            const count = parseInt(args[i + 1], 10);
            if (!isNaN(count) && count > 0 && count < 11) {
                return count;
            } else {
                console.warn(`Warning: Invalid move count "${args[i + 1]}". Must be between 1 and 10. Using default: 5`);
                return 5;
            }
        }
    }

    // Default to 5
    return 5;
}

function calculateNextCoordinate(currentX: bigint, currentY: bigint, mode: MoveMode): { x: bigint; y: bigint } {
    switch (mode) {
        case MoveMode.UP:
            return { x: currentX, y: currentY + 1n };
        case MoveMode.LEFT:
            return { x: currentX - 1n, y: currentY + 1n };
        case MoveMode.RIGHT:
            return { x: currentX + 1n, y: currentY + 1n };
        case MoveMode.EXIT:
            return { x: currentX, y: currentY + 1n };
        default:
            return { x: currentX, y: currentY + 1n };
    }
}

function getDirectionName(mode: MoveMode): string {
    switch (mode) {
        case MoveMode.UP:
            return 'UP';
        case MoveMode.LEFT:
            return 'LEFT';
        case MoveMode.RIGHT:
            return 'RIGHT';
        case MoveMode.EXIT:
            return 'EXIT';
        default:
            return 'UNKNOWN';
    }
}

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getGameDataWithRetry(
    ship: ReturnType<typeof Ship.createFromAddress>,
    provider: NetworkProvider,
    retries: number = 5,
    delayMs: number = 2000
) {
    for (let i = 0; i < retries; i++) {
        try {
            const data = await ship.getCurrentGameData(provider.provider(ship.address));
            if (data) {
                return data;
            }
        } catch (e) {
            // Log error on last retry
            if (i === retries - 1) {
                console.warn(`  Warning: Failed to get game data after ${retries} retries:`, (e as Error).message);
            }
        }
        if (i < retries - 1) {
            await sleep(delayMs);
        }
    }
    return null;
}

async function waitForTransaction(
    provider: NetworkProvider,
    address: Address,
    timeoutMs: number = 30000,
    checkIntervalMs: number = 2000
): Promise<boolean> {
    // Simple approach: wait a bit for transaction to be processed
    // The actual verification happens by checking state changes
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
        await sleep(checkIntervalMs);
        // Check if contract state is accessible (transaction likely processed)
        try {
            const state = await provider.provider(address).getState();
            if (state.state.type === 'active') {
                return true; // Contract is active, transaction likely processed
            }
        } catch {
            // Continue waiting
        }
    }
    return false; // Timeout
}

async function verifyMoveSuccess(
    ship: ReturnType<typeof Ship.createFromAddress>,
    provider: NetworkProvider,
    expectedX: bigint,
    expectedY: bigint,
    maxRetries: number = 10,
    delayMs: number = 2000
): Promise<{ success: boolean; actualX: bigint; actualY: bigint; gameData: any }> {
    for (let i = 0; i < maxRetries; i++) {
        const gameData = await getGameDataWithRetry(ship, provider, 3, 1000);
        if (gameData) {
            const actualX = gameData.xy.x;
            const actualY = gameData.xy.y;
            // Check if coordinates changed (or match expected if first move)
            if (actualX === expectedX && actualY === expectedY) {
                return { success: true, actualX, actualY, gameData };
            }
        }
        if (i < maxRetries - 1) {
            await sleep(delayMs);
        }
    }
    // Return last known state or expected coordinates
    const lastGameData = await getGameDataWithRetry(ship, provider, 1, 500);
    if (lastGameData) {
        return { 
            success: false, 
            actualX: lastGameData.xy.x, 
            actualY: lastGameData.xy.y, 
            gameData: lastGameData 
        };
    }
    return { success: false, actualX: expectedX, actualY: expectedY, gameData: null };
}

export async function run(provider: NetworkProvider) {
    const direction = parseDirection();
    const directionName = getDirectionName(direction);
    let moveCount = parseMoveCount();
    
    // Exit mode always does only 1 move
    if (direction === MoveMode.EXIT) {
        if (moveCount !== 5) {
            console.warn(`Warning: --exit option is used. Move count (${moveCount}) is ignored. Exit will perform 1 move only.\n`);
        }
        moveCount = 1;
    }
    
    console.log('\n=== Ship Movement Script ===');
    console.log(`Direction: ${directionName}`);
    console.log(`Number of moves: ${moveCount}`);
    console.log('==========================\n');

    // Determine network from provider
    const providerAny = provider as any;
    const networkStr = 
        providerAny.network?.() || 
        providerAny.api?.endpoint || 
        providerAny.api?.baseURL ||
        process.env.TON_NETWORK ||
        '';
    const networkLower = networkStr.toLowerCase();
    const network: Network = (networkLower.includes('testnet') || networkLower.includes('test') || networkLower.includes('sandbox'))
        ? 'testnet'
        : 'mainnet';

    // Log Chainstack configuration
    logChainstackConfig(network);

    // Load deployment data
    const { data: deploymentData } = loadDeploymentData(network);

    // Log sender (wallet) address to ensure it matches deployment owner
    const senderAddress = provider.sender().address;
    if (senderAddress) {
        console.log(`Sender (wallet) address: ${senderAddress.toString()}`);
        if (deploymentData.ownerAddress && deploymentData.ownerAddress.nonBounceable) {
            console.log(
                `Deployment owner (non-bounceable): ${deploymentData.ownerAddress.nonBounceable}`
            );
        }
    }

    // Guard: moves are owner-gated on-chain. ship.tolk asserts
    // `in.senderAddress == storage.userAddress` (the deployment owner) BEFORE it would
    // initialize the game, so a non-owner move silently bounces with ERR_INVALID_USER_SENDER
    // and no game is ever created. The usual cause is a wallet-version mismatch:
    // deploySystem.ts derives the owner from Wallet V4R2, while `blueprint run --mnemonic`
    // defaults to V5R1 (a different address from the same seed). Fail loud here instead of
    // wasting a transaction.
    if (senderAddress && deploymentData.ownerAddress?.bounceable) {
        const ownerAddress = Address.parse(deploymentData.ownerAddress.bounceable);
        if (!senderAddress.equals(ownerAddress)) {
            throw new Error(
                `Sender wallet is not the deployment owner — the ship will reject every move ` +
                `(ERR_INVALID_USER_SENDER) and no game will be initialized.\n` +
                `  Sender:           ${senderAddress.toString()}\n` +
                `  Deployment owner: ${ownerAddress.toString()}\n` +
                `This is usually a wallet-version mismatch: deploySystem.ts uses Wallet V4R2, ` +
                `while "blueprint run --mnemonic" defaults to V5R1.\n` +
                `Fix: set WALLET_VERSION=v4r2 in your .env (or environment) so the move is sent ` +
                `from the owner wallet.`
            );
        }
    }

    const ownerShipAddress = deploymentData.games?.ton_race_game?.ownerShip;
    if (!ownerShipAddress) {
        throw new Error('Owner ship address not found in deployment data');
    }

    // Get ship address (use bounceable for contracts)
    const shipAddress = Address.parse(ownerShipAddress.bounceable);
    console.log(`Ship address (bounceable): ${shipAddress.toString()}`);
    console.log(`Network: ${network}\n`);

    // Open ship contract
    const ship = provider.open(Ship.createFromAddress(shipAddress));
    const shipContract = Ship.createFromAddress(shipAddress);

    // Get initial position (with a small retry to be robust to RPC lag)
    let gameData = await getGameDataWithRetry(shipContract, provider, 3, 1500);
    let currentX = 0n;
    let currentY = 0n;
    
    if (gameData) {
        currentX = gameData.xy.x;
        currentY = gameData.xy.y;
        console.log(`Initial position: (${currentX}, ${currentY})`);
        console.log(`Initial HP: ${gameData.hp}`);
        console.log(`Initial jetton amount: ${gameData.jettonAmount.toString()}\n`);
    } else {
        console.log('Initial position: (0, 0) - Ship not yet initialized\n');
    }

    // Track path
    const path: Array<{ x: bigint; y: bigint; move: number }> = [];
    if (gameData) {
        path.push({ x: currentX, y: currentY, move: 0 });
    } else {
        path.push({ x: 0n, y: 0n, move: 0 });
    }

    // Perform moves
    for (let i = 1; i <= moveCount; i++) {
        console.log(`--- Move ${i}/${moveCount} ---`);
        console.log(`From: (${currentX}, ${currentY})`);
        
        const nextCoord = calculateNextCoordinate(currentX, currentY, direction);
        console.log(`Direction: ${directionName}`);
        console.log(`Target Coordinate Cell: (${nextCoord.x}, ${nextCoord.y})`);
        
        // Send move request
        console.log('Sending move request...');
        let txSent = false;
        try {
            await ship.sendMove(provider.sender(), GAS_COST_SEND_MOVE, direction);
            txSent = true;
            console.log('✓ Transaction sent successfully');
        } catch (e: any) {
            console.error('✗ Failed to send move transaction.');
            if (e?.response?.data?.error) {
                console.error('RPC error:', e.response.data.error);
            } else if (e?.message) {
                console.error('Error message:', e.message);
            } else {
                console.error(e);
            }
            console.log('Stopping further moves due to error.\n');
            break;
        }
        
        if (!txSent) {
            break;
        }
        
        // Wait for transaction to be included in a block
        console.log('Waiting for transaction to be processed on-chain...');
        const txDetected = await waitForTransaction(provider, shipAddress, 30000, 2000);
        
        if (!txDetected) {
            console.warn('⚠ Warning: Transaction not detected within timeout. Continuing to check state...');
        } else {
            console.log('✓ Transaction detected on-chain');
        }
        
        // Verify move success by checking actual ship coordinates
        console.log('Verifying move and reading actual ship state...');
        const moveResult = await verifyMoveSuccess(
            shipContract,
            provider,
            nextCoord.x,
            nextCoord.y,
            10, // max retries
            2000 // delay between retries
        );
        
        if (moveResult.success) {
            currentX = moveResult.actualX;
            currentY = moveResult.actualY;
            gameData = moveResult.gameData;
            path.push({ x: currentX, y: currentY, move: i });
            console.log(`✓ Move ${i} completed successfully!`);
            console.log(`  Actual position: (${currentX}, ${currentY})`);
            if (gameData) {
                console.log(`  HP: ${gameData.hp}`);
                console.log(`  Jetton amount: ${gameData.jettonAmount.toString()}`);
            }
        } else {
            // Move may have failed or coordinates don't match expected
            if (moveResult.gameData) {
                currentX = moveResult.actualX;
                currentY = moveResult.actualY;
                gameData = moveResult.gameData;
                path.push({ x: currentX, y: currentY, move: i });
                console.log(`⚠ Move ${i} - Position mismatch or move may have failed`);
                console.log(`  Expected: (${nextCoord.x}, ${nextCoord.y})`);
                console.log(`  Actual: (${currentX}, ${currentY})`);
                if (gameData) {
                    console.log(`  HP: ${gameData.hp}`);
                    console.log(`  Jetton amount: ${gameData.jettonAmount.toString()}`);
                }
            } else {
                // Couldn't read state at all
                console.error(`✗ Move ${i} - Failed to verify: Could not read ship state`);
                console.error(`  Expected position: (${nextCoord.x}, ${nextCoord.y})`);
                console.log('Stopping further moves due to state read failure.\n');
                break;
            }
        }
        
        console.log('');
    }

    // Final summary
    console.log('=== Movement Summary ===');
    console.log(`Direction: ${directionName}`);
    console.log(`Total moves attempted: ${moveCount}`);
    console.log(`\nPath taken:`);
    path.forEach((point, index) => {
        if (index === 0) {
            console.log(`  Start: (${point.x}, ${point.y})`);
        } else {
            console.log(`  Move ${point.move}: (${point.x}, ${point.y})`);
        }
    });
    console.log(`\nFinal position: (${currentX}, ${currentY})`);
    if (gameData) {
        console.log(`Final HP: ${gameData.hp}`);
        console.log(`Final jetton amount: ${gameData.jettonAmount.toString()}`);
    }
    console.log('========================\n');
}

// Allow direct execution with ts-node
if (require.main === module) {
    // This will be called when using blueprint run
    // For direct execution, we need to create a NetworkProvider
    // But blueprint run handles this automatically
    console.log('Note: This script should be run with:');
    console.log('  npx blueprint run moveShip [--left|--up|--right|--exit] [--moves <1-10>]');
    console.log('  npm run move-ship [--left|--up|--right|--exit] [--moves <1-10>]');
    console.log('\nOptions:');
    console.log('  --left, --up, --right: Movement direction (default: --up)');
    console.log('  --exit: Safe exit move (performs 1 move only, ignores --moves)');
    console.log('  --moves <count>: Number of moves to perform (1-10, default: 5)');
    console.log('');
}

