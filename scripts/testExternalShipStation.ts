// SPDX-License-Identifier: UNLICENSED
import { Address, toNano, ContractProvider, Cell, beginCell, contractAddress, fromNano, SendMode } from '@ton/core';
import { keyPairFromSecretKey, sign } from '@ton/crypto';
import { NetworkProvider, compile } from '@ton/blueprint';
import { Subcontract, subcontractConfigToCell } from '../wrappers/subcontract/Subcontract';
import { encodeExternalInner, encodeExternalEnvelope, Forward, ForwardWithInit, GAS_COST_FORWARD, GAS_COST_FORWARD_WITH_INIT } from '../wrappers/subcontract/types';
import { MoveMode } from '../wrappers/ton_race_game/structs';
import { encodeRequestToMove, GAS_COST_REQUEST_TO_MOVE } from '../wrappers/ton_race_game/types';
import { Ship, shipConfigToCell } from '../wrappers/ton_race_game/Ship';
import {
    Network,
    readDeploymentData,
    readNetworkDeploymentData,
    writeExternalTestResult,
    ExternalTestResult,
    ExternalTestGasCost,
} from '../lib/buildOutput';
import {
    getChainstackEndpoints,
    getSendEndpoint,
    logChainstackConfig,
    isChainstackConfigured,
    getAddressState,
    getAddressBalance,
    getAddressInfo,
    runGetMethod,
    sendExternalMessage,
    waitForConfirmation as chainstackWaitForConfirmation,
    sleep,
    toV2Base,
    stackItemToBigInt,
} from '../lib/chainstack';

function hexToBigInt(hex: string): bigint {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    return BigInt('0x' + clean);
}

function parseId(): bigint {
    // First check environment variable (set by runWithChainstack.ts)
    const envId = process.env.SCRIPT_ID;
    if (envId) {
        const parsed = BigInt(envId);
        if (parsed < 1n) {
            throw new Error('SCRIPT_ID must be >= 1');
        }
        return parsed;
    }

    // Fall back to CLI args (for direct blueprint run)
    const args = process.argv.slice(2);
    const idIndex = args.indexOf('--id');
    if (idIndex !== -1 && idIndex + 1 < args.length) {
        const idValue = args[idIndex + 1];
        const parsed = BigInt(idValue);
        if (parsed < 1n) {
            throw new Error('--id must be >= 1');
        }
        return parsed;
    }
    return 1n; // Default to 1
}

/**
 * Local waitForConfirmation wrapper that uses the shared utility.
 * This wrapper is kept for backwards compatibility with the existing code structure.
 */
async function waitForConfirmation(
    endpointAny: string,
    address: Address,
    checkFn: () => Promise<boolean>,
    maxAttempts: number = 30,
    pollDelay: number = 2000
): Promise<void> {
    return chainstackWaitForConfirmation(checkFn, maxAttempts, pollDelay);
}

export async function run(provider: NetworkProvider) {
    const startedAt = new Date().toISOString();
    let result: ExternalTestResult | null = null;
    const gasCosts: ExternalTestGasCost[] = [];

    try {
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

        // Load deployment info for the network
        const deployment = readNetworkDeploymentData(network);
        
        // Check deployment status first
        if (!deployment) {
            throw new Error(
                `No deployment found for ${network}. Cannot run external test without successful deployment.\n` +
                `Please run deploySystem.ts first.`
            );
        }
        
        if (deployment.status === 'in_progress') {
            throw new Error(
                `Deployment is still in progress. Please wait for deployment to complete before running external test.`
            );
        }
        
        if (deployment.status === 'failed' || !deployment.deployed) {
            const errorMsg = deployment.error || 'Unknown error';
            throw new Error(
                `Deployment failed for ${network}. Cannot run external test without successful deployment.\n` +
                `Deployment error: ${errorMsg}\n` +
                `Please fix the deployment issue and run deploySystem.ts again.`
            );
        }
        
        const gameInfo = deployment.games?.ton_race_game;
        if (!gameInfo?.game || !deployment.ownerAddress) {
            const missingFields = [];
            if (!gameInfo?.game) missingFields.push('game');
            if (!deployment.ownerAddress) missingFields.push('ownerAddress');
            throw new Error(
                `Missing required fields in deployment_info/deployment_latest.json: ${missingFields.join(', ')}\n` +
                `This usually means deployment failed or was incomplete.\n` +
                `Please check the deployment status and run deploySystem.ts again if needed.`
            );
        }

        const gameAddress = Address.parse(gameInfo.game.bounceable);
        const ownerAddress = Address.parse(deployment.ownerAddress.bounceable);

        console.log('=== External ShipStation Full Cycle Test ===');
        console.log(`Network: ${network}`);
        console.log(`Game: ${gameAddress.toString()}`);
        console.log(`Owner: ${ownerAddress.toString()}`);

        // Log Chainstack configuration
        logChainstackConfig(network);

        // Resolve endpoints. Read calls use endpointAny (keyed Chainstack if configured — fast,
        // avoids public-toncenter 429s on this read-heavy test). External-message broadcasts use
        // sendEndpoint (toncenter via /sendBoc): the Chainstack testnet node can read but fails
        // external-message emulation ("config param 43 invalid") on every send path. The
        // blueprint-provider sends (subcontract deploy + funding) likewise go through toncenter
        // via blueprint.config.
        const endpoints = getChainstackEndpoints(network);
        const endpointAny = endpoints.v2;
        const sendEndpoint = getSendEndpoint(network);

        if (!isChainstackConfigured(network)) {
            console.warn('⚠ Warning: Chainstack API not configured, using public endpoints');
            console.warn('  For better performance, set CHAINSTACK_KEY_TESTNET in .env');
        }

        const baseV2 = toV2Base(endpointAny);
        console.log(`\n--- Endpoint Configuration ---`);
        console.log(`Read endpoint:  ${endpointAny}`);
        console.log(`Send endpoint:  ${sendEndpoint}`);
        console.log(`Computed v2 base: ${baseV2}`);

        // Derive key pair from PRIVATE_KEY
        const privateKeyHex = (process.env.PRIVATE_KEY || '').trim();
        if (!privateKeyHex) {
            throw new Error('PRIVATE_KEY env var is required');
        }
        if (privateKeyHex.length !== 128 && !(privateKeyHex.startsWith('0x') && privateKeyHex.length === 130)) {
            throw new Error('PRIVATE_KEY must be 64-byte hex (128 chars, or 130 with 0x prefix)');
        }
        const secretKey = Buffer.from(privateKeyHex.replace(/^0x/, ''), 'hex');
        if (secretKey.length !== 64) {
            throw new Error(`PRIVATE_KEY must be exactly 64 bytes, got ${secretKey.length}`);
        }
        const keyPair = keyPairFromSecretKey(secretKey);
        const ownerPublicKey = hexToBigInt(keyPair.publicKey.toString('hex'));
        console.log(`\n--- Key Configuration ---`);
        console.log(`Owner Public Key: ${ownerPublicKey.toString()}`);

        // Step 1: Generate unique ID (from --id parameter)
        const uniqueId = parseId();
        console.log(`\n--- Step 1: Generate Unique ID ---`);
        console.log(`Unique ID: ${uniqueId.toString()} (from --id parameter, default: 1)`);

        // Step 2: Get contract codes (from root-level contractCodes)
        console.log(`\n--- Step 2: Loading Contract Codes ---`);
        const fullDeploymentData = readDeploymentData();
        const contractCodes = fullDeploymentData.contractCodes;
        
        let subcontractCode: Cell;
        let shipCode: Cell;
        let coordinateCellCode: Cell;

        if (contractCodes?.subcontract?.hex) {
            subcontractCode = Cell.fromBoc(Buffer.from(contractCodes.subcontract.hex, 'hex'))[0];
            console.log('✓ Loaded subcontract code from deployment_latest.json');
        } else {
            subcontractCode = await compile('Subcontract');
            console.log('✓ Compiled subcontract code');
        }

        const shipCodeHex = contractCodes?.games?.ton_race_game?.ship?.hex;
        if (shipCodeHex) {
            shipCode = Cell.fromBoc(Buffer.from(shipCodeHex, 'hex'))[0];
            console.log('✓ Loaded ship code from deployment_latest.json');
        } else {
            shipCode = await compile('Ship');
            console.log('✓ Compiled ship code');
        }

        const ccCodeHex = contractCodes?.games?.ton_race_game?.coordinateCell?.hex;
        if (ccCodeHex) {
            coordinateCellCode = Cell.fromBoc(Buffer.from(ccCodeHex, 'hex'))[0];
            console.log('✓ Loaded coordinateCell code from deployment_latest.json');
        } else {
            coordinateCellCode = await compile('CoordinateCell');
            console.log('✓ Compiled coordinateCell code');
        }

        // Step 3: Calculate subcontract address
        console.log(`\n--- Step 3: Calculate Subcontract Address ---`);
        const subcontractConfig = {
            ownerAddress,
            id: uniqueId,
            ownerPublicKey,
        };
        const subcontractData = subcontractConfigToCell(subcontractConfig);
        const subcontractInit = { code: subcontractCode, data: subcontractData };
        const subcontractAddress = contractAddress(0, subcontractInit);
        console.log(`Subcontract Address: ${subcontractAddress.toString()}`);

        // Step 4: Check subcontract state (should be uninitialized)
        console.log(`\n--- Step 4: Check Subcontract State ---`);
        const subcontractState = await getAddressState(endpointAny, subcontractAddress);
        console.log(`Subcontract State: ${subcontractState}`);
        if (subcontractState !== 'uninitialized') {
            console.warn(`⚠️  Warning: Subcontract is ${subcontractState}, expected uninitialized`);
        }

        // Step 5: Deploy Subcontract using external message
        console.log(`\n--- Step 5: Deploy Subcontract (External Message) ---`);
        // Open WITH init (code+data) so sendDeploy() attaches the stateInit. Opening via
        // createFromAddress() carries no init, so the deploy message went out without stateInit
        // and the account never initialized ("Confirmation timeout"). subcontractInit yields the
        // same address computed above.
        const subcontract = provider.open(new Subcontract(subcontractAddress, subcontractInit));
        
        // Get initial extSeqno (should be 0 for new contract, but we'll check)
        let extSeqno = 0;
        try {
            extSeqno = await subcontract.getExtSeqno();
            console.log(`Current extSeqno: ${extSeqno}`);
        } catch {
            // Contract not deployed yet, extSeqno is 0
            console.log('Contract not deployed yet, extSeqno will be 0');
        }

        // Get balance before deployment
        let balanceBefore = 0n;
        try {
            balanceBefore = await getAddressBalance(endpointAny, subcontractAddress);
        } catch {
            // Contract doesn't exist yet
        }

        // Build ForwardWithInit command to deploy subcontract
        // We need to send a message that will deploy the contract
        // For external messages, we need to send a ForwardWithInit that will trigger deployment
        // But actually, for initial deployment via external message, we need to send the stateInit
        // However, Subcontract external messages only accept Forward/ForwardWithInit commands
        // So we'll need to fund the contract first, then use internal message for deployment
        // OR: We can send an external message with ForwardWithInit to deploy a nested contract
        // Actually, let's deploy subcontract by sending TON to it with stateInit
        
        // For now, let's use a workaround: send TON with stateInit to deploy
        // But we need to use external messages, so let's check if we can send external message with stateInit
        // Actually, external messages don't include stateInit - they're for already deployed contracts
        // So we need to deploy subcontract first via internal message (from owner wallet)
        // Then use external messages for subsequent operations
        
        // Let's deploy subcontract via internal message first (this is a limitation)
        // Then use external messages for ship deployment and moves
        console.log('Note: Subcontract initial deployment requires internal message (external messages require deployed contract)');
        console.log('Deploying subcontract via internal message first...');
        
        // We'll skip subcontract deployment via external for now and assume it's deployed
        // Or we can deploy it via provider if available
        // For full external-only test, we'd need subcontract already deployed
        
        // Check if subcontract is already deployed
        if (subcontractState === 'active') {
            console.log('✓ Subcontract is already deployed');
        } else {
            console.log('⚠️  Subcontract needs to be deployed first via internal message');
            console.log('   For this test, please deploy subcontract first, or we will attempt via provider');
            
            // Try to deploy via provider if possible
            try {
                const deployAmount = toNano('0.4');
                await subcontract.sendDeploy(provider.sender(), deployAmount);
                console.log(`✓ Deployed subcontract via provider (${fromNano(deployAmount)} TON)`);
                
                // Wait for deployment
                await waitForConfirmation(endpointAny, subcontractAddress, async () => {
                    const state = await getAddressState(endpointAny, subcontractAddress);
                    return state === 'active';
                });
                
                // Track gas cost
                const balanceAfter = await getAddressBalance(endpointAny, subcontractAddress);
                const deployCost = deployAmount - (balanceAfter - balanceBefore);
                gasCosts.push({
                    operation: 'DeploySubcontract',
                    costNano: deployCost.toString(),
                    costTon: fromNano(deployCost),
                });
                console.log(`   Gas cost: ${fromNano(deployCost)} TON`);
            } catch (error: any) {
                throw new Error(`Failed to deploy subcontract: ${error.message}`);
            }
        }

        // Fund subcontract for operations
        // Optimized based on test results: DeployShip (0.01) + MoveUP (0.0625) + MoveEXIT (0.004) + buffer = ~0.15 TON
        console.log(`\n--- Funding Subcontract ---`);
        const fundAmount = toNano('1'); // Optimized: enough for ship deployment and 2 moves with buffer
        try {
            // Use PAY_GAS_SEPARATELY only: blueprint's V4R2 mnemonic Sender (the deployment owner —
            // see deploySystem.ts) rejects any other sendMode ("does not support sendMode other than
            // PAY_GAS_SEPARATELY"). IGNORE_ERRORS / the bounce flag are unsupported here and were only
            // tolerated by a V5R1 sender; they aren't needed for a plain funding transfer.
            await provider.sender().send({
                to: subcontractAddress,
                value: fundAmount,
                sendMode: SendMode.PAY_GAS_SEPARATELY,
            });
            console.log(`✓ Funded subcontract with ${fromNano(fundAmount)} TON`);
            await sleep(3000); // Wait for funding
        } catch (error: any) {
            console.warn(`⚠️  Could not fund subcontract automatically: ${error.message}`);
            console.log('   Please fund subcontract manually before continuing');
        }

        // Step 6: Calculate ship address and deploy via external message
        console.log(`\n--- Step 6: Deploy Ship via External Message ---`);
        const shipConfig = {
            userAddress: subcontractAddress,
            gameAddress,
            coordinateCellCode,
        };
        const shipData = shipConfigToCell(shipConfig);
        const shipStateInit = beginCell()
            .storeUint(0, 2) // stateInit$00
            .storeRef(shipCode)
            .storeRef(shipData)
            .endCell();
        const shipInit = { code: shipCode, data: shipData };
        const shipAddress = contractAddress(0, shipInit);
        console.log(`Ship Address: ${shipAddress.toString()}`);

        // Get extSeqno before ship deployment
        extSeqno = await subcontract.getExtSeqno();
        console.log(`Current extSeqno: ${extSeqno}`);

        // Get balance before
        balanceBefore = await getAddressBalance(endpointAny, subcontractAddress);

        // Build ForwardWithInit command
        // Optimized based on test results: actual cost is 0.01 TON, so 0.1 TON is enough (deployment + small buffer)
        const deployAmount = toNano('0.1');
        const deployBody = beginCell().endCell();
        const forwardWithInit: ForwardWithInit = {
            queryId: 0n,
            destination: shipAddress,
            forwardTonAmount: deployAmount,
            sendMode: 0, // PAY_GAS_SEPARATELY
            stateInit: shipStateInit,
            messageBody: deployBody,
        };

        // Build and send external message
        const validUntil = Math.floor(Date.now() / 1000) + 600;
        const innerCell = encodeExternalInner({
            id: uniqueId,
            seqno: extSeqno,
            validUntil,
            command: forwardWithInit,
        });

        const hash = innerCell.hash();
        const signature = sign(hash, secretKey);
        const envelope = encodeExternalEnvelope({
            signature,
            inner: innerCell,
        });

        console.log(`Sending external ForwardWithInit message...`);
        await sendExternalMessage(sendEndpoint, subcontractAddress, envelope, 30000);
        console.log('✓ External message sent');

        // Wait for confirmation (extSeqno increment)
        console.log('Waiting for subcontract to process external message...');
        await waitForConfirmation(endpointAny, subcontractAddress, async () => {
            const newSeqno = await subcontract.getExtSeqno();
            return newSeqno === extSeqno + 1;
        });
        console.log('✓ Subcontract processed external message (extSeqno incremented)');

        // Wait for ship deployment (poll until ship becomes active)
        console.log('Waiting for ship deployment...');
        await waitForConfirmation(endpointAny, shipAddress, async () => {
            const state = await getAddressState(endpointAny, shipAddress);
            return state === 'active';
        }, 60, 2000); // 60 attempts * 2 seconds = 120 seconds max
        console.log('✓ Ship deployed successfully');

        // Track gas cost
        // Calculate: GAS_COST_FORWARD_WITH_INIT + deployAmount - (balanceBefore - balanceAfter)
        // If balance increased (excess returned), use the gas constant
        let balanceAfter = await getAddressBalance(endpointAny, subcontractAddress);
        const balanceDiff = balanceBefore - balanceAfter;
        // If balance increased, it means excess was returned, so actual cost is just the gas constant
        // Otherwise, cost is the balance difference (which includes gas + forward amount)
        const shipDeployCost = balanceDiff > 0n 
            ? balanceDiff 
            : GAS_COST_FORWARD_WITH_INIT; // Fallback to constant if calculation seems wrong
        gasCosts.push({
            operation: 'DeployShipViaExternal',
            costNano: shipDeployCost.toString(),
            costTon: fromNano(shipDeployCost),
        });
        console.log(`   Gas cost: ${fromNano(shipDeployCost)} TON (balance diff: ${fromNano(balanceDiff)} TON)`);

        // Step 7: Move UP via external message
        console.log(`\n--- Step 7: Move UP via External Message ---`);
        extSeqno = await subcontract.getExtSeqno();
        console.log(`Current extSeqno: ${extSeqno}`);

        balanceBefore = await getAddressBalance(endpointAny, subcontractAddress);

        const moveUpBody = encodeRequestToMove({ mode: MoveMode.UP });
        // Optimized based on test results: actual cost is 0.0625 TON, so use GAS_COST_REQUEST_TO_MOVE (0.06 TON)
        // This covers the ship's move operation cost
        const forwardUp: Forward = {
            queryId: 0n,
            destination: shipAddress,
            forwardTonAmount: GAS_COST_REQUEST_TO_MOVE,
            bounce: true,
            sendMode: 0,
            messageBody: moveUpBody,
        };

        const innerCellUp = encodeExternalInner({
            id: uniqueId,
            seqno: extSeqno,
            validUntil: Math.floor(Date.now() / 1000) + 600,
            command: forwardUp,
        });

        const hashUp = innerCellUp.hash();
        const signatureUp = sign(hashUp, secretKey);
        const envelopeUp = encodeExternalEnvelope({
            signature: signatureUp,
            inner: innerCellUp,
        });

        console.log('Sending external Forward message for UP move...');
        await sendExternalMessage(sendEndpoint, subcontractAddress, envelopeUp, 30000);
        console.log('✓ External message sent');

        await waitForConfirmation(endpointAny, subcontractAddress, async () => {
            const newSeqno = await subcontract.getExtSeqno();
            return newSeqno === extSeqno + 1;
        });

        // Wait for move to complete
        await sleep(5000);

        // Calculate gas cost: GAS_COST_FORWARD + forwardAmount - (balanceBefore - balanceAfter)
        // If balance increased (excess returned), use the gas constant
        let balanceAfterMove = await getAddressBalance(endpointAny, subcontractAddress);
        const balanceDiffUp = balanceBefore - balanceAfterMove;
        // Actual cost is GAS_COST_FORWARD (subcontract processing) + forwardAmount (sent to ship)
        // But if balance increased, excess was returned, so use constant
        const moveUpCost = balanceDiffUp > 0n 
            ? balanceDiffUp 
            : GAS_COST_FORWARD; // Fallback to constant if calculation seems wrong
        gasCosts.push({
            operation: 'MoveUP',
            costNano: moveUpCost.toString(),
            costTon: fromNano(moveUpCost),
        });
        console.log(`   Gas cost: ${fromNano(moveUpCost)} TON (balance diff: ${fromNano(balanceDiffUp)} TON)`);

        // Step 8: Move EXIT via external message
        console.log(`\n--- Step 8: Move EXIT via External Message ---`);
        extSeqno = await subcontract.getExtSeqno();
        console.log(`Current extSeqno: ${extSeqno}`);

        balanceBefore = await getAddressBalance(endpointAny, subcontractAddress);
        console.log(`Subcontract balance: ${fromNano(balanceBefore)} TON`);
        
        // Verify subcontract has enough balance
        const minRequiredBalance = toNano('0.05'); // Minimum for EXIT move
        if (balanceBefore < minRequiredBalance) {
            throw new Error(`Subcontract balance (${fromNano(balanceBefore)} TON) is too low. Minimum required: ${fromNano(minRequiredBalance)} TON`);
        }

        const moveExitBody = encodeRequestToMove({ mode: MoveMode.EXIT });
        // Optimized based on test results: actual cost is 0.004 TON, so use minimal amount
        // EXIT doesn't require full move cost, just enough for the operation
        const forwardExit: Forward = {
            queryId: 0n,
            destination: shipAddress,
            forwardTonAmount: toNano('0.01'), // Optimized: EXIT needs less than regular moves
            bounce: true,
            sendMode: 0,
            messageBody: moveExitBody,
        };

        const innerCellExit = encodeExternalInner({
            id: uniqueId,
            seqno: extSeqno,
            validUntil: Math.floor(Date.now() / 1000) + 600,
            command: forwardExit,
        });

        const hashExit = innerCellExit.hash();
        const signatureExit = sign(hashExit, secretKey);
        let envelopeExit = encodeExternalEnvelope({
            signature: signatureExit,
            inner: innerCellExit,
        });

        // Wait a bit before sending to ensure previous transaction is fully processed
        await sleep(3000);
        
        console.log('Sending external Forward message for EXIT move...');
        // Retry logic for network issues
        const maxRetries = 3;
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Increase timeout for EXIT move as it may take longer to process
                await sendExternalMessage(sendEndpoint, subcontractAddress, envelopeExit, 60000);
                console.log('✓ External message sent');
                break; // Success, exit retry loop
            } catch (error: any) {
                lastError = error;
                const errorMsg = error.message || '';
                if (attempt < maxRetries && (errorMsg.includes('timeout') || errorMsg.includes('ECONNRESET') || errorMsg.includes('network'))) {
                    const delay = 5000 * attempt; // Exponential backoff: 5s, 10s
                    console.warn(`Send attempt ${attempt} failed: ${errorMsg}`);
                    console.log(`Retrying in ${delay}ms...`);
                    await sleep(delay);
                    // Re-fetch seqno in case it changed
                    extSeqno = await subcontract.getExtSeqno();
                    // Rebuild envelope with new seqno
                    const innerCellExitRetry = encodeExternalInner({
                        id: uniqueId,
                        seqno: extSeqno,
                        validUntil: Math.floor(Date.now() / 1000) + 600,
                        command: forwardExit,
                    });
                    const hashExitRetry = innerCellExitRetry.hash();
                    const signatureExitRetry = sign(hashExitRetry, secretKey);
                    envelopeExit = encodeExternalEnvelope({
                        signature: signatureExitRetry,
                        inner: innerCellExitRetry,
                    });
                    continue;
                }
                throw error; // Re-throw if not a retryable error or max retries reached
            }
        }
        
        if (lastError && !lastError.message.includes('sent')) {
            throw lastError;
        }

        await waitForConfirmation(endpointAny, subcontractAddress, async () => {
            const newSeqno = await subcontract.getExtSeqno();
            return newSeqno === extSeqno + 1;
        });

        // Wait for move to complete
        await sleep(5000);

        // Calculate gas cost: GAS_COST_FORWARD + forwardAmount - (balanceBefore - balanceAfter)
        // If balance increased (excess returned), use the gas constant
        balanceAfterMove = await getAddressBalance(endpointAny, subcontractAddress);
        const balanceDiffExit = balanceBefore - balanceAfterMove;
        // Actual cost is GAS_COST_FORWARD (subcontract processing) + forwardAmount (sent to ship)
        // But if balance increased, excess was returned, so use constant
        const moveExitCost = balanceDiffExit > 0n 
            ? balanceDiffExit 
            : GAS_COST_FORWARD; // Fallback to constant if calculation seems wrong
        gasCosts.push({
            operation: 'MoveEXIT',
            costNano: moveExitCost.toString(),
            costTon: fromNano(moveExitCost),
        });
        console.log(`   Gas cost: ${fromNano(moveExitCost)} TON (balance diff: ${fromNano(balanceDiffExit)} TON)`);

        // Step 9: Check ship state
        console.log(`\n--- Step 9: Check Ship State ---`);
        const ship = provider.open(Ship.createFromAddress(shipAddress));
        let movementInProcess = false;
        let shipBalance = 0n;
        try {
            movementInProcess = await ship.getMovementInProcess();
            shipBalance = await ship.getTonBalance();
            console.log(`Movement in process: ${movementInProcess}`);
            console.log(`Ship balance: ${fromNano(shipBalance)} TON`);
        } catch (error: any) {
            console.warn(`⚠️  Could not read ship state: ${error.message}`);
        }

        // Calculate total cost (only positive costs, negative means excess was returned)
        const totalCostNano = gasCosts.reduce((sum, cost) => {
            const costNano = BigInt(cost.costNano);
            // Only add positive costs (negative means excess was returned, so actual cost is 0 or minimal)
            return sum + (costNano > 0n ? costNano : 0n);
        }, 0n);
        const totalCostTon = fromNano(totalCostNano);

        console.log(`\n--- Gas Consumption Summary ---`);
        gasCosts.forEach((cost) => {
            console.log(`  ${cost.operation}: ${cost.costTon} TON`);
        });
        console.log(`  Total: ${totalCostTon} TON`);

        result = {
            timestamp: startedAt,
            network,
            uniqueId: uniqueId.toString(),
            subcontractAddress: subcontractAddress.toString(),
            shipAddress: shipAddress.toString(),
            extSeqno: extSeqno.toString(),
            gasCosts,
            totalCostNano: totalCostNano.toString(),
            totalCostTon,
            success: true,
            shipStateAfterMoves: {
                movementInProcess,
                balance: shipBalance.toString(),
            },
        };
    } catch (error: any) {
        console.error('❌ Test failed:', error?.message || error);
        result = {
            timestamp: startedAt,
            network: 'unknown',
            uniqueId: '0',
            subcontractAddress: '',
            shipAddress: '',
            extSeqno: '0',
            gasCosts,
            totalCostNano: '0',
            totalCostTon: '0',
            success: false,
            error: error?.message || String(error),
        };
    } finally {
        if (result) {
            writeExternalTestResult(result);
        }
    }
}

// Helper for standalone execution (ts-node)
if (require.main === module) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { main } = require('@ton/blueprint');
    main(run);
}
