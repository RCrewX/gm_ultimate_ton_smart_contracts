// SPDX-License-Identifier: UNLICENSED
/**
 * Race seeder — create `pilots` deterministic ships on ton_race_game, each exploring the
 * first `moves` cells of one of the 3 main directions (LEFT / UP / RIGHT) via NORMAL moves
 * (never hard travel). Each move does y+1; LEFT also x-1, RIGHT also x+1 — so a pilot opens
 * its OWN independent lane straight from origin (UP→(0,N), LEFT→(-N,N), RIGHT→(N,N)). Lanes
 * never depend on another ship's cells (each cell opens on the pilot's first visit).
 *
 * Pilots are derived from TEST_USERS_SEED via the existing deriveUserWallet(seed, index),
 * in a distinct high index namespace (default base 1000) so they never collide with the
 * UBPS test users. The pilot wallet signs its own ship deploy + every move (the ship is
 * user-gated); the deployer only FUNDS each pilot wallet to its requirement first.
 *
 * Idempotent / resumable: the ship's on-chain position (getCurrentGameData().xy.y == moves
 * done) is the resume signal — a re-run skips an already-deployed ship and continues from
 * the right move count. NORMAL moves only.
 *
 * COST: the move is a WALLET-signed RequestToMove (ship.tolk runMove isSessionMove=false) —
 * its MoveEnd refunds the unspent value to the PILOT WALLET, so the attached value RECYCLES
 * between sequential moves (only gas burned + a freshly-opened cell's storage is consumed).
 * The hold-requirement is therefore ship deploy + a small working-capital + moves×net-burn,
 * NOT moves×(full attach): ≈ ~2.8 TON/pilot, ~8.5 TON for 3 pilots×10 moves (sandbox-measured
 * real consumption is ~1.2 TON/pilot; the rest is safety cushion). See pilotFunding().
 * The runner's preflight reports this. Scale with --pilots/--moves.
 */
import { Address, Cell, toNano } from '@ton/core';
import { Ship } from '../../wrappers/ton_race_game/Ship';
import { MoveMode } from '../../wrappers/ton_race_game/structs';
import { GameFields } from '../../wrappers/ton_race_game/structs';
import { readTestUsersSeed, deriveUserWallet } from '../seedUbps/wallets';
import { ResilientProvider, LiveRpc, isActive, getBalance, curSeqno, waitSeqno } from './lib/rpc';
import {
    SeedContext, SeedOptions, SeedModule, CostEstimate, ManifestPart, fmtAddr, fmtTon, writeManifest,
} from './lib/context';

// --- funding model — anchored to contracts/ton_race_game/static/constants.tolk ---
// The contract is the single source of truth; the GAS_COST_* below MIRROR it (same figures —
// keep in sync if the contract changes). The seeder moves via the WALLET-signed RequestToMove
// path: ship.tolk runMove(…, isSessionMove=false) forwards (value − tax) down the move chain,
// and MoveEnd refunds the unspent remainder to the PILOT WALLET (cashback_to_ship=false). So
// each move's attached value RECYCLES between sequential moves — only the gas burned plus the
// storage a freshly-opened coordinate cell locks is actually CONSUMED per move. The deployer
// hold-requirement is thus ship-deploy + small working-capital + moves×net-burn, NOT moves×attach.
const GAS_COST_REQUEST_TO_MOVE = toNano('0.06');
const GAS_COST_MOVE_SHIP_TO_CC = toNano('0.12');
const GAS_COST_MOVE = toNano('0.12');
const GAS_COST_MOVE_END = toNano('0.06');
// Full wallet-move chain gas (Ship→CC→…→MoveEnd) — buffered MAX figures from the contract.
const PER_MOVE_GAS = GAS_COST_REQUEST_TO_MOVE + GAS_COST_MOVE_SHIP_TO_CC + GAS_COST_MOVE + GAS_COST_MOVE_END; // 0.36

// Value ATTACHED to each move: full-chain gas × 1.5 margin (well above the contract's
// TOTAL_GAS_TO_MOVE = 0.19 floor). The unspent part cashes back to the pilot wallet, so a
// generous attach does NOT inflate the hold-requirement — it just round-trips.
const MOVE_VALUE = (PER_MOVE_GAS * 3n) / 2n;          // 0.54 TON  (was 1 — over-attached; excess merely recycled)

// Net TON actually CONSUMED per move (gas burned + new-cell storage lock; the rest cashes back).
// Sandbox-measured in tests/seed/race-seeder.spec.ts at ~0.09 TON/move (deploy + 10 moves burned
// ~1.18 TON total); set to ~1.7× that for margin.
const NET_MOVE_COST = toNano('0.15');

// Ship self-deploy value: deploy gas + ship storage floor. The contract requires the ship's
// balance ≥ GAS_COST_REQUEST_TO_MOVE + GAS_COST_MOVE_SHIP_TO_CC (0.18) to move; 0.3 covers deploy
// + a moving floor. (test_utils.ts uses a generous 5 as a TEST value — NOT a hold figure to copy.)
const SHIP_DEPLOY_VALUE = toNano('0.3');

// Per-pilot working capital: keep one move's attach in flight so the wallet can always fund the
// next move before the prior MoveEnd cashback has fully landed, plus a small headroom buffer.
const RACE_PILOT_WORKING_CAPITAL = MOVE_VALUE;        // 0.54 TON (one move in flight)
const RACE_PILOT_BUFFER = toNano('0.5');              // headroom per pilot wallet

/**
 * Deployer hold-requirement to seed ONE pilot performing `remaining` moves. The move value
 * recycles (wallet cashback), so this is deploy(once) + working-capital + remaining×net-burn +
 * buffer — NOT remaining×MOVE_VALUE. Shared by estimateCost, run(), and the sandbox spec so the
 * funding model has a single definition. ~5 TON/pilot @10 moves; ~15 TON for 3 pilots.
 */
export function pilotFunding(remaining: number, needsDeploy: boolean): bigint {
    return (needsDeploy ? SHIP_DEPLOY_VALUE : 0n)
        + RACE_PILOT_WORKING_CAPITAL
        + NET_MOVE_COST * BigInt(remaining)
        + RACE_PILOT_BUFFER;
}

/** Exposed for the sandbox spec to assert against the exact per-move attach the seeder uses. */
export const RACE_MOVE_VALUE = MOVE_VALUE;
export const RACE_SHIP_DEPLOY_VALUE = SHIP_DEPLOY_VALUE;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Map a direction NAME to its MoveMode (the 3 main directions; EXIT is not a lane). */
export function directionMode(name: string): MoveMode {
    switch (name.toUpperCase()) {
        case 'LEFT': return MoveMode.LEFT;
        case 'UP': return MoveMode.UP;
        case 'RIGHT': return MoveMode.RIGHT;
        default: throw new Error(`Unknown race direction "${name}" (use LEFT|UP|RIGHT)`);
    }
}

/** The position a pilot reaches after `moves` normal moves in `dir` from origin. */
export function expectedPosition(dir: MoveMode, moves: number): { x: bigint; y: bigint } {
    const y = BigInt(moves);
    const x = dir === MoveMode.LEFT ? -y : dir === MoveMode.RIGHT ? y : 0n;
    return { x, y };
}

/** The deterministic ship for a pilot (userAddress = pilot wallet). */
export function pilotShip(userAddress: Address, gameAddress: Address, shipCode: Cell, coordinateCellCode: Cell): Ship {
    return Ship.createFromConfig({ userAddress, gameAddress, coordinateCellCode }, shipCode);
}

/** Read the race game master address from the deployment artifact. */
export function raceGameAddress(deployment: unknown, network: string): Address {
    const net = (deployment as any)?.[network];
    const b = net?.games?.ton_race_game?.game?.bounceable;
    if (!b) throw new Error(`No race game in deployment_latest.json for ${network} (games.ton_race_game.game). Deploy the system first.`);
    return Address.parse(b);
}

async function getGameData(prov: ResilientProvider | null, resilient: boolean, shipAddr: Address): Promise<GameFields | null> {
    if (!prov) return null;
    const fn = (r: LiveRpc) => r.withRateLimit(() => r.client.open(Ship.createFromAddress(shipAddr)).getCurrentGameData());
    return resilient ? prov.attempt('getCurrentGameData', fn) : prov.read('getCurrentGameData', fn, null);
}

/** Moves already done == the ship's current y (every move does y+1). 0 before the first move. */
function movesDoneFrom(gd: GameFields | null): number {
    return gd ? Number(gd.xy.y) : 0;
}

/** Poll the ship until its y reaches targetY (move cascade complete), time-bounded. */
async function waitShipReachedY(rpc: LiveRpc, shipAddr: Address, targetY: number, label: string, maxMs = 90000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try {
            const gd = await rpc.withRateLimit(() => rpc.client.open(Ship.createFromAddress(shipAddr)).getCurrentGameData());
            if (gd && Number(gd.xy.y) >= targetY) return;
        } catch { /* keep waiting */ }
        await sleep(3000);
    }
    console.warn(`  ! ${label}: ship did not reach y=${targetY} within ${maxMs}ms (continuing; resume will recover).`);
}

interface PilotManifestEntry {
    index: number;
    walletAddress: string;
    direction: string;
    shipAddress: string;
    movesPlanned: number;
    movesDone: number;
    finalPosition: { x: string; y: string } | null;
    status: string;
}

export const raceModule: SeedModule = {
    name: 'race',

    async estimateCost(_ctx: SeedContext, opts: SeedOptions): Promise<CostEstimate> {
        // Worst case (nothing seeded yet): every pilot needs a fresh ship + all moves.
        const perPilot = pilotFunding(opts.moves, true);
        const required = perPilot * BigInt(opts.pilots);
        return {
            required,
            breakdown: {
                pilots: String(opts.pilots),
                movesEach: String(opts.moves),
                perPilot: `${fmtTon(perPilot)} TON`,
                total: `${fmtTon(required)} TON  (testnet TON — move value recycles via wallet cashback)`,
            },
        };
    },

    async run(ctx: SeedContext, opts: SeedOptions): Promise<ManifestPart> {
        const { network, dryRun, live, prov, deployer, codes, deployment } = ctx;
        const manifest = { module: 'race', network, seededAt: new Date().toISOString(), pilots: [] as PilotManifestEntry[], summary: { deployed: 0, skipped: 0, funded: 0, errors: 0 } };

        if (!codes.shipCode || !codes.coordinateCellCode) throw new Error('race module: ship/coordinateCell codes not compiled');
        const gameAddr = raceGameAddress(deployment, network);

        console.log(`\n=== race seed (${network}) ${dryRun ? '[DRY-RUN — no sends]' : '[LIVE]'} ===`);
        console.log(`race game: ${fmtAddr(gameAddr, network)}`);

        // TEST_USERS_SEED needed to derive pilots (required for live; optional for dry-run).
        let seedBytes: Buffer | null = null;
        try { seedBytes = readTestUsersSeed(); } catch (e: any) {
            if (!dryRun) throw e;
            console.warn(`! ${e.message} — dry-run will skip pilot wallet/ship addresses.`);
        }

        const canSend = !dryRun && !!prov && !!deployer;

        for (let i = 0; i < opts.pilots; i++) {
            const dirName = opts.directions[i % opts.directions.length].toUpperCase();
            const dir = directionMode(dirName);
            const walletIndex = opts.pilotIndexBase + i;

            if (!seedBytes) {
                manifest.pilots.push({ index: walletIndex, walletAddress: '(TEST_USERS_SEED unset)', direction: dirName, shipAddress: '(unresolved)', movesPlanned: opts.moves, movesDone: 0, finalPosition: null, status: 'planned' });
                console.log(`  + pilot[${walletIndex}] dir=${dirName}: (wallet/ship unresolved — set TEST_USERS_SEED)`);
                continue;
            }

            const dw = deriveUserWallet(seedBytes, walletIndex);
            const ship = pilotShip(dw.wallet.address, gameAddr, codes.shipCode, codes.coordinateCellCode);
            const shipActive = await isActive(prov, live, ship.address);
            // An inactive ship has, by definition, made 0 moves — never run a get method on an
            // uninitialized account (it returns exit_code -13 on every node and storms the provider).
            const gd = shipActive ? await getGameData(prov, live, ship.address) : null;
            const alreadyDone = movesDoneFrom(gd);
            const remaining = Math.max(0, opts.moves - alreadyDone);
            const requirement = pilotFunding(remaining, !shipActive);

            const entry: PilotManifestEntry = {
                index: walletIndex,
                walletAddress: fmtAddr(dw.wallet.address, network),
                direction: dirName,
                shipAddress: fmtAddr(ship.address, network),
                movesPlanned: opts.moves,
                movesDone: alreadyDone,
                finalPosition: gd ? { x: gd.xy.x.toString(), y: gd.xy.y.toString() } : null,
                status: 'planned',
            };
            console.log(`  ${dryRun ? '+' : '>'} pilot[${walletIndex}] dir=${dirName} wallet=${fmtAddr(dw.wallet.address, network)} ship=${fmtAddr(ship.address, network)}`);
            console.log(`      ship:${shipActive ? 'deployed' : (dryRun ? '+deploy' : '>deploy')} movesDone:${alreadyDone}/${opts.moves} remaining:${remaining} fund≈${fmtTon(requirement)}TON`);

            if (canSend && remaining === 0 && shipActive) {
                entry.status = 'skipped';
                manifest.summary.skipped++;
                manifest.pilots.push(entry);
                continue;
            }

            if (canSend) {
                await prov!.attempt(`pilot ${walletIndex}`, async (rpc) => {
                    // fund the pilot to its requirement (skip if already covered)
                    const bal = await rpc.withRateLimit(() => rpc.client.getBalance(dw.wallet.address));
                    if (bal < requirement) {
                        const before = await curSeqno(rpc, deployer!.wallet);
                        const deployerSender = rpc.client.open(deployer!.wallet).sender(deployer!.keyPair.secretKey);
                        await deployerSender.send({ to: dw.wallet.address, value: requirement - bal + RACE_PILOT_BUFFER, bounce: false });
                        await waitSeqno(rpc, deployer!.wallet, before, `fund pilot ${walletIndex}`);
                    }
                    const pilotSender = rpc.client.open(dw.wallet).sender(dw.keyPair.secretKey);
                    // deploy the ship (pilot signs; first send also deploys the pilot wallet)
                    const active = (await rpc.withRateLimit(() => rpc.client.getContractState(ship.address))).state === 'active';
                    if (!active) {
                        const before = await curSeqno(rpc, dw.wallet);
                        await rpc.client.open(ship).sendDeploy(pilotSender, SHIP_DEPLOY_VALUE);
                        await waitSeqno(rpc, dw.wallet, before, `deploy ship ${walletIndex}`);
                    }
                    // resume from the real on-chain move count, then run the rest sequentially
                    const startGd = await rpc.withRateLimit(() => rpc.client.open(Ship.createFromAddress(ship.address)).getCurrentGameData());
                    let done = movesDoneFrom(startGd);
                    while (done < opts.moves) {
                        const targetY = done + 1;
                        const before = await curSeqno(rpc, dw.wallet);
                        await rpc.client.open(Ship.createFromAddress(ship.address)).sendMove(pilotSender, MOVE_VALUE, dir);
                        await waitSeqno(rpc, dw.wallet, before, `move ${walletIndex} #${targetY}`);
                        await waitShipReachedY(rpc, ship.address, targetY, `move ${walletIndex} #${targetY}`);
                        done = targetY;
                    }
                });
                if (!shipActive) { manifest.summary.deployed++; manifest.summary.funded++; }
                // re-read final position for the manifest
                const finalGd = await getGameData(prov, live, ship.address);
                entry.movesDone = movesDoneFrom(finalGd);
                entry.finalPosition = finalGd ? { x: finalGd.xy.x.toString(), y: finalGd.xy.y.toString() } : null;
                entry.status = entry.movesDone >= opts.moves ? 'done' : 'partial';
            }
            manifest.pilots.push(entry);
        }

        if (dryRun) {
            console.log('\n--- race manifest preview (dry-run; not written) ---');
            console.log(JSON.stringify(manifest, null, 2));
        } else {
            const p = writeManifest('race', network, manifest);
            console.log(`\nRace manifest written -> ${p}`);
        }
        console.log(`race summary: ${JSON.stringify(manifest.summary)}`);
        return manifest;
    },
};
