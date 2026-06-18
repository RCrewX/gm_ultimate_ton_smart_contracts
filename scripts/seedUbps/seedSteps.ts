// SPDX-License-Identifier: UNLICENSED
/**
 * UBPS seeder — bootstrap, planning (dry-run) and live, idempotent seeding.
 *
 * Dependency order: Questions -> Answers -> BeliefSets (leaf-first topo, root last)
 * -> Units + pointers. Every step checks on-chain state first and skips completed
 * work, so a crash mid-run is recovered by simply re-running. A persisted manifest
 * (deployment_info/ubps-seed.<network>.manifest.json, gitignored) records each
 * entity's address/index/status and lets a resume reuse master-assigned BS indices.
 *
 * The deployer (MNEMONIC / PRIVATE_KEY) signs Questions/Answers/BeliefSets + funds
 * the per-user test wallets. Each user's SetPointer is signed BY THAT USER's derived
 * wallet (UP is user-gated on-chain) — see wallets.ts for the derivation.
 *
 * --dry-run computes the full plan (addresses, topo order, fund/skip decisions from
 * best-effort read-only RPC) and SENDS NOTHING. The live run is the USER's; the
 * agent only authors + dry-runs this.
 *
 * Resilience: every live RPC action runs through ResilientProvider.attempt — if an
 * error escapes ton-provider-system's own retry/failover, it closes the provider,
 * waits 1 minute, restarts a fresh provider, and retries. Each retried action re-reads
 * on-chain state before sending, so a restart never double-sends. This lets an
 * unattended 100-user run survive transient provider outages instead of dying partway.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Address, Cell, toNano, internal } from '@ton/core';
import { WalletContractV4 } from '@ton/ton';
import { mnemonicToPrivateKey, keyPairFromSecretKey, KeyPair } from '@ton/crypto';
import { compile } from '@ton/blueprint';
import { ResilientProvider, LiveRpc } from './provider';
import { readDeploymentData } from '../../lib/buildOutput';
import {
    buildStringCell,
    encodeActivateQuestion,
    encodeActivateAnswer,
    encodeCreateBeliefSet,
} from '../../wrappers/ubps/types';
import { UBPS } from '../../wrappers/ubps/UBPS';
import { Question } from '../../wrappers/ubps/Question';
import { Answer } from '../../wrappers/ubps/Answer';
import { BeliefSet } from '../../wrappers/ubps/BeliefSet';
import { Unit } from '../../wrappers/ubps/Unit';
import { UbpsSeed, SeedNetwork } from './types';
import { readTestUsersSeed, deriveUserWallet, DerivedWallet } from './wallets';
import {
    SeedCodes,
    ResolvedBeliefSet,
    buildQuestionMap,
    buildAnswerMap,
    beliefSetCreationOrder,
    assignBeliefSetIndices,
    beliefSetSendArgs,
    unitAddressFor,
    resolvePointerTarget,
} from './resolve';

// --- tunable amounts ---
// activate Q / A, create BS. Floor is UBPS_MIN_OP_VALUE = 0.05 (contracts/ubps/static.tolk).
// The master forwards UBPS_CHILD_DEPLOY_VALUE (0.02) to the child, spends ~0.02 on its own
// gas+storage tax, and REFUNDS the excess back to the payer — so over-fronting only parks
// TON in-flight, it isn't lost. We front floor + ~10% (matches the uap UBPS buffer); the
// remainder returns. Keep this ABOVE 0.05 or every op asserts ERR_UBPS_VALUE_TOO_LOW (607).
const OP_VALUE = toNano('0.055');
const UNIT_DEPLOY_VALUE = toNano('0.1');   // self-deploy a Unit
const CREATE_UNIT_VALUE = toNano('0.15');  // create a Unit via the master (deploy + initial pointer hop)
const SET_POINTER_VALUE = toNano('0.1');   // SetPointer
const FUND_FLOOR = toNano('0.25');         // top up a user wallet below this
const FUND_AMOUNT = toNano('0.4');         // top-up amount (covers wallet deploy + unit create/deploy + setpointer)

// WalletContractV4 carries up to 4 internal messages per signed external. The
// deployer-driven master ops (ActivateQuestion / ActivateAnswer / CreateBeliefSet) are
// grouped into batches of this size: one signed external (one seqno advance) per batch
// instead of one per op — see sendDeployerBatch + the per-step batching below.
const W4_MAX_MSGS_PER_EXTERNAL = 4;

// --- preflight gas check (deployer / active wallet) ---
const GAS_PER_MSG_MARGIN = toNano('0.03'); // fee headroom per deployer-originated message
const PREFLIGHT_BASE_BUFFER = toNano('0.2'); // base buffer kept on the deployer wallet

const fmtTon = (n: bigint): string => (Number(n) / 1e9).toFixed(4);

// Render an address in the user-friendly form CORRECT for the target chain: testnet
// uses testOnly=true (kQ/0Q prefixes), mainnet testOnly=false (EQ/UQ). Same raw
// address either way — this only sets the display flag so copied addresses match the
// chain's explorers/wallets (mirrors lib/buildOutput.ts formatAddress).
export const fmtAddr = (addr: Address, network: SeedNetwork, bounceable = true): string =>
    addr.toString({ urlSafe: true, bounceable, testOnly: network === 'testnet' });

/**
 * Worst-case estimate of the TON the deployer (active wallet) must hold before a
 * run: it pays OP_VALUE for every Question/Answer/BeliefSet op and funds every user
 * wallet (assume ALL need funding — a resume skips some, so this only over-reserves),
 * plus a per-message fee margin and a base buffer left on the wallet.
 */
export function estimateDeployerCost(
    counts: { questions: number; answers: number; beliefSets: number; users: number },
): { required: bigint; ops: bigint; funding: bigint; margin: bigint } {
    const opMsgs = counts.questions + counts.answers + counts.beliefSets;
    const ops = OP_VALUE * BigInt(opMsgs);
    const funding = FUND_AMOUNT * BigInt(counts.users);
    const margin = GAS_PER_MSG_MARGIN * BigInt(opMsgs + counts.users) + PREFLIGHT_BASE_BUFFER;
    return { required: ops + funding + margin, ops, funding, margin };
}

export type SeedNetworkLive = 'testnet'; // mainnet is refused by the CLI before we get here

export interface SeedRunOptions {
    network: SeedNetworkLive;
    seed: UbpsSeed;
    dryRun: boolean;
    usersCap?: number; // --users <n>
}

// --- manifest shapes (mirror SCHEMA.md / plan §6) ---
interface ManifestQuestion { questionId: string; address: string; status: string }
interface ManifestAnswer { answerId: string; address: string; status: string }
interface ManifestBeliefSet { index: number; root: boolean; address: string; status: string }
interface ManifestUser { walletIndex: number; walletAddress: string; unitAddress: string; pointer: string | null; status: string }
export interface Manifest {
    network: string;
    ubpsMaster: string;
    seededAt: string;
    questions: Record<string, ManifestQuestion>;
    answers: Record<string, ManifestAnswer>;
    beliefSets: Record<string, ManifestBeliefSet>;
    users: Record<string, ManifestUser>;
    summary: { deployed: number; skipped: number; funded: number; errors: number };
}

function manifestPath(network: string): string {
    return join(process.cwd(), 'deployment_info', `ubps-seed.${network}.manifest.json`);
}

function loadManifest(network: string): Manifest | null {
    const p = manifestPath(network);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf-8')) as Manifest; } catch { return null; }
}

// ===========================================================================
//  Compile the 5 UBPS codes (children deploy on demand; we need them for addr calc).
// ===========================================================================
export async function compileUbpsCodes(): Promise<SeedCodes & { ubpsCode: Cell }> {
    return {
        ubpsCode: await compile('UBPS'),
        unitCode: await compile('UBPSUnit'),
        questionCode: await compile('UBPSQuestion'),
        answerCode: await compile('UBPSAnswer'),
        beliefSetCode: await compile('UBPSBeliefSet'),
    };
}

function masterAddressFromDeployment(network: string): Address {
    const data = readDeploymentData();
    const net = (data as any)[network];
    const b = net?.games?.ubps?.ubps?.bounceable;
    if (!b) throw new Error(`No UBPS master in deployment_latest.json for ${network} (games.ubps.ubps). Deploy UBPS first.`);
    return Address.parse(b);
}

// ===========================================================================
//  RPC helpers on top of the ResilientProvider.
//  - resilient=true  (live run): a thrown error → close + wait 1 min + restart.
//  - resilient=false (dry-run / read-only): best-effort, degrade to a fallback.
//  When prov is null (init failed) we assume an empty chain.
// ===========================================================================
async function isActive(prov: ResilientProvider | null, resilient: boolean, addr: Address): Promise<boolean> {
    if (!prov) return false;
    const fn = (r: LiveRpc) => r.withRateLimit(() => r.client.getContractState(addr));
    const st = resilient
        ? await prov.attempt(`getState ${addr.toString().slice(0, 8)}…`, fn)
        : await prov.read('getState', fn, null);
    return st ? st.state === 'active' : false;
}

async function getBalance(prov: ResilientProvider | null, resilient: boolean, addr: Address): Promise<bigint> {
    if (!prov) return 0n;
    const fn = (r: LiveRpc) => r.withRateLimit(() => r.client.getBalance(addr));
    return resilient
        ? prov.attempt(`getBalance ${addr.toString().slice(0, 8)}…`, fn)
        : prov.read('getBalance', fn, 0n);
}

async function getCreated(prov: ResilientProvider | null, resilient: boolean, addr: Address): Promise<boolean> {
    if (!prov) return false;
    const fn = (r: LiveRpc) => r.withRateLimit(() => r.client.open(BeliefSet.createFromAddress(addr)).getCreated());
    return resilient ? prov.attempt('getCreated', fn) : prov.read('getCreated', fn, false);
}

function loadDeployer(): { wallet: WalletContractV4; keyPair: KeyPair } {
    const pk = (process.env.PRIVATE_KEY || '').trim();
    const mn = (process.env.MNEMONIC || '').trim();
    let keyPair: KeyPair;
    if (pk) {
        const clean = pk.startsWith('0x') ? pk.slice(2) : pk;
        if (clean.length !== 128) throw new Error(`PRIVATE_KEY must be 128 hex chars, got ${clean.length}`);
        keyPair = keyPairFromSecretKey(Buffer.from(clean, 'hex'));
    } else if (mn) {
        throw new Error('MNEMONIC support requires async load — handled in run()');
    } else {
        throw new Error('Set PRIVATE_KEY or MNEMONIC for the deployer wallet');
    }
    return { wallet: WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 }), keyPair };
}

async function loadDeployerAsync(): Promise<{ wallet: WalletContractV4; keyPair: KeyPair }> {
    const mn = (process.env.MNEMONIC || '').trim();
    if (mn) {
        const words = mn.split(/\s+/).filter(Boolean);
        if (words.length !== 24) throw new Error(`MNEMONIC must be 24 words, got ${words.length}`);
        const keyPair = await mnemonicToPrivateKey(words);
        return { wallet: WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 }), keyPair };
    }
    return loadDeployer();
}

// These run INSIDE prov.attempt(...) against a live snapshot. curSeqno throws on error
// (so the enclosing attempt restarts); waitSeqno tolerates per-poll errors and is time-
// bounded — a missed confirmation is harmless (the next step re-reads real on-chain state).
async function curSeqno(r: LiveRpc, wallet: WalletContractV4): Promise<number> {
    return r.withRateLimit(() => r.client.open(wallet).getSeqno());
}

async function waitSeqno(r: LiveRpc, wallet: WalletContractV4, prev: number, label: string, maxMs = 60000): Promise<void> {
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

/** Split into chunks of at most `size` (order preserved). Exported for unit tests. */
export function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

interface BatchedOp { to: Address; value: bigint; body: Cell }

/**
 * Send up to W4_MAX_MSGS_PER_EXTERNAL master ops in ONE signed external (one seqno
 * advance) instead of one external per op. Runs inside a single prov.attempt: a restart
 * re-runs the whole batch, and the caller re-reads each op's on-chain done-state first
 * (so an op that already landed is excluded), making the batch idempotent. The internal
 * messages are delivered to the master in list order (sequential lt), so a batch
 * preserves any ordering dependency the caller encoded (e.g. BeliefSet leaf-first index
 * assignment). Returns the number of ops actually sent (0 if all were already done).
 */
async function sendDeployerBatch(
    r: LiveRpc,
    wallet: WalletContractV4,
    keyPair: KeyPair,
    ops: BatchedOp[],
    label: string,
): Promise<number> {
    if (ops.length === 0) return 0;
    if (ops.length > W4_MAX_MSGS_PER_EXTERNAL) {
        throw new Error(`sendDeployerBatch: ${ops.length} ops > W4 cap ${W4_MAX_MSGS_PER_EXTERNAL}`);
    }
    const opened = r.client.open(wallet);
    const before = await r.withRateLimit(() => opened.getSeqno());
    const transfer = wallet.createTransfer({
        seqno: before,
        secretKey: keyPair.secretKey,
        messages: ops.map(o => internal({ to: o.to, value: o.value, body: o.body, bounce: true })),
    });
    await r.withRateLimit(() => opened.send(transfer));
    await waitSeqno(r, wallet, before, label);
    return ops.length;
}

// ===========================================================================
//  Main entry — plan (always) then, unless dry-run, execute.
// ===========================================================================
export async function run(opts: SeedRunOptions): Promise<Manifest> {
    const { network, seed, dryRun, usersCap } = opts;
    const codes = await compileUbpsCodes();
    const masterAddr = masterAddressFromDeployment(network);
    const ubps = new UBPS(masterAddr);

    console.log(`\n=== UBPS seed (${network}) ${dryRun ? '[DRY-RUN — no sends]' : '[LIVE]'} ===`);
    console.log(`UBPS master: ${fmtAddr(masterAddr, network)}`);

    // Provider with restart-on-error resilience (closes + waits 1 min + restarts when an
    // error escapes ton-provider-system's own failover). resilient reads use prov.attempt;
    // dry-run uses best-effort prov.read.
    const prov = await ResilientProvider.start(network);
    const live = !dryRun; // resilient reads/sends only on the live run
    if (!dryRun) {
        if (!prov) throw new Error('Live seeding requires a working RPC; aborting.');
        if (!(await isActive(prov, live, masterAddr))) throw new Error('UBPS master is not deployed on-chain. Deploy UBPS first.');
    }

    const prior = loadManifest(network);
    const priorBsIndex = new Map<string, number>();
    if (prior) for (const [id, m] of Object.entries(prior.beliefSets)) priorBsIndex.set(id, m.index);

    // ---- Resolve addresses (pure) ----
    const qMap = buildQuestionMap(ubps, codes.questionCode, seed);
    const aMap = buildAnswerMap(ubps, codes.answerCode, seed, qMap);
    const bsOrder = beliefSetCreationOrder(seed); // throws on cycle
    const readNextBsIndex = (r: LiveRpc) => r.withRateLimit(() => r.client.open(ubps).getNextBsIndex());
    const startIndex = prov
        ? Number(live ? await prov.attempt('getNextBsIndex', readNextBsIndex) : await prov.read('getNextBsIndex', readNextBsIndex, 0n))
        : 0;
    const bsMap = assignBeliefSetIndices(ubps, codes.beliefSetCode, seed, bsOrder, startIndex, priorBsIndex);

    // ---- Derive user wallets (needs TEST_USERS_SEED; optional for dry-run) ----
    const allUsers = usersCap != null ? seed.users.slice(0, usersCap) : seed.users;
    let seedBytes: Buffer | null = null;
    try { seedBytes = readTestUsersSeed(); } catch (e: any) {
        if (!dryRun) throw e;
        console.warn(`! ${e.message} — dry-run will skip user wallet/unit addresses.`);
    }
    const walletByUser = new Map<string, DerivedWallet>();
    const unitAddrByUser = new Map<string, Address>();
    if (seedBytes) {
        for (const u of allUsers) {
            const dw = deriveUserWallet(seedBytes, u.walletIndex);
            walletByUser.set(u.id, dw);
            unitAddrByUser.set(u.id, unitAddressFor(ubps, codes.unitCode, dw.wallet.address));
        }
    }

    const manifest: Manifest = {
        network, ubpsMaster: fmtAddr(masterAddr, network), seededAt: new Date().toISOString(),
        questions: {}, answers: {}, beliefSets: {}, users: {},
        summary: { deployed: 0, skipped: 0, funded: 0, errors: 0 },
    };

    let deployer: { wallet: WalletContractV4; keyPair: KeyPair } | null = null;
    if (!dryRun) deployer = await loadDeployerAsync();
    // Senders are built per-attempt from the CURRENT live client (a restart swaps the
    // client, so a sender captured once would go stale).
    const canSend = !dryRun && !!prov && !!deployer;

    // ---- Preflight: the active (deployer) wallet must hold enough gas BEFORE any send ----
    const estimate = estimateDeployerCost({
        questions: seed.questions.length,
        answers: seed.answers.length,
        beliefSets: seed.beliefSets.length,
        users: allUsers.length,
    });
    console.log(`\n[Preflight] deployer must hold ~${fmtTon(estimate.required)} TON ` +
        `(ops ${fmtTon(estimate.ops)} + funding ${fmtTon(estimate.funding)} + margin ${fmtTon(estimate.margin)}; ` +
        `worst case — a resume skips already-seeded work).`);
    if (!dryRun && deployer && prov) {
        const balance = await getBalance(prov, live, deployer.wallet.address);
        console.log(`           deployer ${fmtAddr(deployer.wallet.address, network)} balance: ${fmtTon(balance)} TON`);
        if (balance < estimate.required) {
            throw new Error(
                `Insufficient deployer gas: balance ${fmtTon(balance)} TON < required ~${fmtTon(estimate.required)} TON. ` +
                `Top up the deployer wallet (or run a smaller batch with --users <n>) and retry.`,
            );
        }
        console.log('           ✓ deployer balance sufficient.');
    } else if (dryRun) {
        console.log('           (dry-run: balance not checked — set MNEMONIC/PRIVATE_KEY for the live run to enforce this.)');
    }

    // ---- Step 1: Questions (batched: <=4 activations per signed external) ----
    // Questions have NO inter-item ordering dependency, so any grouping is safe.
    console.log(`\n[Questions] ${seed.questions.length}`);
    const pendingQ: { id: string; address: Address; body: Cell }[] = [];
    for (const q of seed.questions) {
        const r = qMap.get(q.id)!;
        const active = await isActive(prov, live, r.address);
        if (active) {
            manifest.questions[q.id] = { questionId: '0x' + r.questionId.toString(16), address: fmtAddr(r.address, network), status: 'skipped' };
            manifest.summary.skipped++;
            console.log(`  = ${q.id} already active -> ${fmtAddr(r.address, network)}`);
        } else {
            manifest.questions[q.id] = { questionId: '0x' + r.questionId.toString(16), address: fmtAddr(r.address, network), status: 'active' };
            console.log(`  ${dryRun ? '+' : '>'} activate ${q.id} -> ${fmtAddr(r.address, network)}`);
            pendingQ.push({ id: q.id, address: r.address, body: encodeActivateQuestion(r.questionId, buildStringCell(q.text)) });
        }
    }
    if (canSend && pendingQ.length > 0) {
        const batches = chunk(pendingQ, W4_MAX_MSGS_PER_EXTERNAL);
        console.log(`  -> sending ${pendingQ.length} activation(s) in ${batches.length} batched external(s) (<=${W4_MAX_MSGS_PER_EXTERNAL}/external)`);
        for (const batch of batches) {
            await prov!.attempt(`activateQ batch [${batch.map(b => b.id).join(', ')}]`, async (rpc) => {
                const ops: BatchedOp[] = [];
                for (const item of batch) {
                    // re-read (restart-safe): skip any that already landed
                    const st = await rpc.withRateLimit(() => rpc.client.getContractState(item.address));
                    if (st.state === 'active') continue;
                    ops.push({ to: masterAddr, value: OP_VALUE, body: item.body });
                }
                await sendDeployerBatch(rpc, deployer!.wallet, deployer!.keyPair, ops, `activateQ batch (${ops.length} op)`);
            });
            manifest.summary.deployed += batch.length;
        }
    }

    // ---- Step 2: Answers (batched: <=4 per external) ----
    // Each Answer binds to its Question, which was activated in Step 1 (all Q before any
    // A). Answers have no inter-item ordering dependency among themselves, so any grouping
    // is safe.
    console.log(`\n[Answers] ${seed.answers.length}`);
    const pendingA: { id: string; address: Address; body: Cell }[] = [];
    for (const a of seed.answers) {
        const r = aMap.get(a.id)!;
        const active = await isActive(prov, live, r.address);
        if (active) {
            manifest.answers[a.id] = { answerId: '0x' + r.answerId.toString(16), address: fmtAddr(r.address, network), status: 'skipped' };
            manifest.summary.skipped++;
            console.log(`  = ${a.id} already active -> ${fmtAddr(r.address, network)}`);
        } else {
            const qAddr = qMap.get(a.question)!.address;
            manifest.answers[a.id] = { answerId: '0x' + r.answerId.toString(16), address: fmtAddr(r.address, network), status: 'active' };
            console.log(`  ${dryRun ? '+' : '>'} activate ${a.id} -> ${fmtAddr(r.address, network)}`);
            pendingA.push({ id: a.id, address: r.address, body: encodeActivateAnswer(qAddr, r.answerId, buildStringCell(a.text)) });
        }
    }
    if (canSend && pendingA.length > 0) {
        const batches = chunk(pendingA, W4_MAX_MSGS_PER_EXTERNAL);
        console.log(`  -> sending ${pendingA.length} activation(s) in ${batches.length} batched external(s) (<=${W4_MAX_MSGS_PER_EXTERNAL}/external)`);
        for (const batch of batches) {
            await prov!.attempt(`activateA batch [${batch.map(b => b.id).join(', ')}]`, async (rpc) => {
                const ops: BatchedOp[] = [];
                for (const item of batch) {
                    const st = await rpc.withRateLimit(() => rpc.client.getContractState(item.address));
                    if (st.state === 'active') continue;
                    ops.push({ to: masterAddr, value: OP_VALUE, body: item.body });
                }
                await sendDeployerBatch(rpc, deployer!.wallet, deployer!.keyPair, ops, `activateA batch (${ops.length} op)`);
            });
            manifest.summary.deployed += batch.length;
        }
    }

    // ---- Step 3: BeliefSets (leaf-first topo order; B (root) ends up last via the DAG) ----
    // ORDERING MATTERS: the master assigns each BS the next monotonic index in ARRIVAL
    // order, and the seeder precomputed indices in exactly bsOrder. So pending creates are
    // collected and batched STRICTLY in bsOrder, and the internal messages in one external
    // are delivered to the master in list order (sequential lt) → index assignment matches
    // bsMap. Once a batch's external is accepted (seqno advances) all of its creates are
    // guaranteed to process (TON delivery), so a batch is *less* prone to partial landing
    // than per-op sends. The re-read guard (active && getCreated) excludes any already
    // created, so a restart never double-creates within the same process.
    const byId = new Map(seed.beliefSets.map(bs => [bs.id, bs]));
    console.log(`\n[BeliefSets] ${seed.beliefSets.length} (creation order: ${bsOrder.join(', ')})`);
    const pendingBS: { id: string; address: Address; body: Cell }[] = [];
    for (const id of bsOrder) {
        const bs = byId.get(id)!;
        const rbs: ResolvedBeliefSet = bsMap.get(id)!;
        const created = (await isActive(prov, live, rbs.address)) && (await getCreated(prov, live, rbs.address));
        if (created) {
            manifest.beliefSets[id] = { index: rbs.index, root: rbs.root, address: fmtAddr(rbs.address, network), status: 'skipped' };
            manifest.summary.skipped++;
            console.log(`  = ${id} (idx ${rbs.index}${rbs.root ? ', root' : ''}) already created -> ${fmtAddr(rbs.address, network)}`);
        } else {
            const args = beliefSetSendArgs(bs, aMap, bsMap);
            manifest.beliefSets[id] = { index: rbs.index, root: rbs.root, address: fmtAddr(rbs.address, network), status: 'created' };
            console.log(`  ${dryRun ? '+' : '>'} create ${id} (idx ${rbs.index}${rbs.root ? ', root' : ''}, a=${args.aCount}, bs=${args.bsCount}${args.name ? ', named' : ''}) -> ${fmtAddr(rbs.address, network)}`);
            pendingBS.push({
                id,
                address: rbs.address,
                body: encodeCreateBeliefSet(args.root, args.aCount, args.bsCount, args.aSet, args.bsSet, args.name),
            });
        }
    }
    if (canSend && pendingBS.length > 0) {
        const batches = chunk(pendingBS, W4_MAX_MSGS_PER_EXTERNAL);
        console.log(`  -> sending ${pendingBS.length} create(s) in ${batches.length} batched external(s) (<=${W4_MAX_MSGS_PER_EXTERNAL}/external, in creation order)`);
        for (const batch of batches) {
            await prov!.attempt(`createBS batch [${batch.map(b => b.id).join(', ')}]`, async (rpc) => {
                const ops: BatchedOp[] = [];
                // Preserve bsOrder WITHIN the batch (the order this array was built in).
                for (const item of batch) {
                    const st = await rpc.withRateLimit(() => rpc.client.getContractState(item.address));
                    if (st.state === 'active'
                        && await rpc.withRateLimit(() => rpc.client.open(BeliefSet.createFromAddress(item.address)).getCreated())) continue;
                    ops.push({ to: masterAddr, value: OP_VALUE, body: item.body });
                }
                await sendDeployerBatch(rpc, deployer!.wallet, deployer!.keyPair, ops, `createBS batch (${ops.length} op)`);
            });
            manifest.summary.deployed += batch.length;
        }
    }

    // ---- Step 4: Users (Unit + pointer; SetPointer signed by the user wallet) ----
    console.log(`\n[Users] ${allUsers.length}${usersCap != null ? ` (capped at ${usersCap})` : ''}`);
    for (const u of allUsers) {
        const dw = walletByUser.get(u.id);
        if (!dw) { console.log(`  ? ${u.id}: (no wallet — TEST_USERS_SEED unset; dry-run only)`); continue; }
        const unitAddr = unitAddrByUser.get(u.id)!;
        const target = resolvePointerTarget(u.pointer, bsMap, unitAddrByUser);
        const targetStr = target ? fmtAddr(target, network) : null;
        const createViaMaster = u.createViaMaster !== false; // default true (recommended funnel)

        const balance = await getBalance(prov, live, dw.wallet.address);
        const needsFund = balance < FUND_FLOOR;
        const unitDeployed = await isActive(prov, live, unitAddr);
        const curPtr = (live && unitDeployed)
            ? await prov!.attempt(`getPointer ${u.id}`, (r) => r.withRateLimit(() => r.client.open(Unit.createFromAddress(unitAddr)).getPointer()))
            : null;
        // Compare raw addresses (flag-independent), NOT user-friendly strings.
        const ptrMatches = unitDeployed && (
            (curPtr === null && target === null) ||
            (!!curPtr && !!target && curPtr.equals(target))
        );

        manifest.users[u.id] = {
            walletIndex: u.walletIndex,
            walletAddress: fmtAddr(dw.wallet.address, network),
            unitAddress: fmtAddr(unitAddr, network),
            pointer: targetStr,
            status: ptrMatches ? 'skipped' : 'set',
        };
        const createMode = createViaMaster ? 'via-master' : 'self-deploy';
        console.log(`  ${u.id} wallet[${u.walletIndex}]=${fmtAddr(dw.wallet.address, network)} unit=${fmtAddr(unitAddr, network)} [${createMode}]`);
        console.log(`    fund:${needsFund ? `+${Number(FUND_AMOUNT) / 1e9}TON` : 'ok'} unit:${unitDeployed ? 'deployed' : (dryRun ? '+create' : '>create')} pointer:${ptrMatches ? 'skip' : `${u.pointer.type}->${targetStr ?? 'null'}`}`);

        if (ptrMatches) manifest.summary.skipped++;

        if (canSend) {
            // The whole user op (fund → create Unit → ensure pointer) is ONE resilient
            // unit: a provider restart re-runs it, and every sub-step re-reads on-chain
            // state first, so a retry never double-funds / double-creates / double-sets.
            // User-signed ops are inherently per-user (the Unit is user-owned + the pointer
            // user-gated), so they CANNOT be batched across users — each user is already a
            // single send in the via-master path (create+pointer in one CreateUnit op).
            await prov!.attempt(`user ${u.id}`, async (rpc) => {
                const deployerSender = rpc.client.open(deployer!.wallet).sender(deployer!.keyPair.secretKey);
                // 4a. fund (skip if already at/above the floor)
                if ((await rpc.withRateLimit(() => rpc.client.getBalance(dw.wallet.address))) < FUND_FLOOR) {
                    const before = await curSeqno(rpc, deployer!.wallet);
                    await deployerSender.send({ to: dw.wallet.address, value: FUND_AMOUNT, bounce: false });
                    await waitSeqno(rpc, deployer!.wallet, before, `fund ${u.id}`);
                }
                const userSender = rpc.client.open(dw.wallet).sender(dw.keyPair.secretKey);
                const alreadyActive = (await rpc.withRateLimit(() => rpc.client.getContractState(unitAddr))).state === 'active';
                if (!alreadyActive) {
                    // 4b. CREATE the Unit (first send from the user wallet also deploys the wallet).
                    const before = await curSeqno(rpc, dw.wallet);
                    if (createViaMaster) {
                        // ONE user-signed op: the master deploys the Unit at its deterministic
                        // address (== self-deploy address) AND applies the initial pointer
                        // (InitUnitPointer). No separate SetPointer this round — the master sets
                        // it; a later run verifies/corrects via 4c if it ever diverges.
                        await rpc.client.open(ubps).sendCreateUnit(userSender, CREATE_UNIT_VALUE, target);
                        await waitSeqno(rpc, dw.wallet, before, `createUnit ${u.id}`);
                    } else {
                        // self-deploy the Unit, then set the pointer below (4c).
                        await rpc.client.open(Unit.createFromConfig({ ubpsMaster: masterAddr, userAddress: dw.wallet.address }, codes.unitCode))
                            .sendDeploy(userSender, UNIT_DEPLOY_VALUE);
                        await waitSeqno(rpc, dw.wallet, before, `deploy unit ${u.id}`);
                        const before2 = await curSeqno(rpc, dw.wallet);
                        await rpc.client.open(Unit.createFromAddress(unitAddr)).sendSetPointer(userSender, SET_POINTER_VALUE, target);
                        await waitSeqno(rpc, dw.wallet, before2, `setPointer ${u.id}`);
                    }
                } else {
                    // 4c. Unit already exists — ensure the pointer equals target (user-gated).
                    // InitUnitPointer can NEVER override a set pointer, so a correction here is
                    // always an explicit user SetPointer.
                    const nowPtr = await rpc.withRateLimit(() => rpc.client.open(Unit.createFromAddress(unitAddr)).getPointer());
                    const nowMatches = (nowPtr === null && target === null) || (!!nowPtr && !!target && nowPtr.equals(target));
                    if (!nowMatches) {
                        const before = await curSeqno(rpc, dw.wallet);
                        await rpc.client.open(Unit.createFromAddress(unitAddr)).sendSetPointer(userSender, SET_POINTER_VALUE, target);
                        await waitSeqno(rpc, dw.wallet, before, `setPointer ${u.id}`);
                    }
                }
            });
            // approximate counters from the pre-plan reads (a resume skips landed work)
            if (needsFund) manifest.summary.funded++;
            if (!unitDeployed) manifest.summary.deployed++;
            if (!ptrMatches) manifest.summary.deployed++;
        }
    }

    // ---- Write / preview manifest ----
    if (dryRun) {
        console.log('\n--- manifest preview (dry-run; not written) ---');
        console.log(JSON.stringify(manifest, null, 2));
    } else {
        writeFileSync(manifestPath(network), JSON.stringify(manifest, null, 2), 'utf-8');
        console.log(`\nManifest written -> ${manifestPath(network)}`);
    }
    if (prov && prov.restarts > 0) console.log(`Provider restarts during run: ${prov.restarts}`);
    prov?.dispose();
    console.log(`\nSummary: ${JSON.stringify(manifest.summary)}`);
    return manifest;
}

// ===========================================================================
//  Deployer-info mode (READ-ONLY): print the addresses that need TON funded
//  before a live seed + their current balances. Sends nothing. Use this to fund
//  the deployer (and inspect the derived user wallets) before `seed:ubps:testnet`.
// ===========================================================================
export interface DeployerInfoOptions {
    network: SeedNetwork; // read-only mode — allowed on mainnet too (no sends)
    seed?: UbpsSeed | null; // optional — pass --file to also size the requirement + list user wallets
    usersCap?: number;
}

export async function deployerInfo(opts: DeployerInfoOptions): Promise<void> {
    const { network, seed, usersCap } = opts;
    console.log(`\n=== UBPS deployer info (${network}) [READ-ONLY — no sends] ===`);

    // Read-only: best-effort reads (no restart-on-error — this is a quick check, not a long run).
    const prov = await ResilientProvider.start(network);
    if (!prov) console.warn('! RPC unavailable — balances will read as 0.0000 TON (cannot query the chain).');

    // ---- Deployer (active) wallet — the one you fund ----
    const deployer = await loadDeployerAsync();
    const addr = deployer.wallet.address;
    const balance = await getBalance(prov, false, addr);
    console.log(`\n[Deployer / active wallet]  (FUND THIS ADDRESS on ${network})`);
    console.log(`  address (bounceable):     ${fmtAddr(addr, network, true)}`);
    console.log(`  address (non-bounceable): ${fmtAddr(addr, network, false)}`);
    console.log(`  current balance:          ${fmtTon(balance)} TON`);

    if (!seed) {
        console.log('\n  (pass --file <seed.json> to also compute the required amount + list the user wallets.)');
        console.log('\nDone.');
        return;
    }

    const allUsers = usersCap != null ? seed.users.slice(0, usersCap) : seed.users;
    const est = estimateDeployerCost({
        questions: seed.questions.length,
        answers: seed.answers.length,
        beliefSets: seed.beliefSets.length,
        users: allUsers.length,
    });
    console.log(`  required (worst case):    ~${fmtTon(est.required)} TON ` +
        `(ops ${fmtTon(est.ops)} + funding ${fmtTon(est.funding)} + margin ${fmtTon(est.margin)})`);
    const shortfall = est.required - balance;
    if (shortfall > 0n) {
        console.log(`  >> SEND at least ${fmtTon(shortfall)} TON to the deployer address above, then re-run --deployer-info to confirm it arrived.`);
    } else {
        console.log('  ✓ deployer balance already covers the run.');
    }

    // ---- Derived user wallets (the deployer funds these during the run; shown for verification) ----
    let seedBytes: Buffer | null = null;
    try { seedBytes = readTestUsersSeed(); } catch (e: any) {
        console.log(`\n[User test wallets] skipped: ${e.message} (set TEST_USERS_SEED to enumerate them).`);
        console.log('\nDone.');
        return;
    }
    console.log(`\n[User test wallets] ${allUsers.length} — the DEPLOYER funds these during the run (no direct action needed):`);
    let needFundTotal = 0n;
    let needFundCount = 0;
    for (const u of allUsers) {
        const dw = deriveUserWallet(seedBytes, u.walletIndex);
        const b = await getBalance(prov, false, dw.wallet.address);
        const needs = b < FUND_FLOOR;
        if (needs) { needFundTotal += FUND_AMOUNT; needFundCount++; }
        console.log(`  [${u.walletIndex}] ${u.id}: ${fmtAddr(dw.wallet.address, network)}  ${fmtTon(b)} TON  ${needs ? '(needs funding)' : '(ok)'}`);
    }
    console.log(`  -> ${needFundCount}/${allUsers.length} below the ${fmtTon(FUND_FLOOR)} TON floor; ` +
        `deployer will send ~${fmtTon(needFundTotal)} TON total (already inside the required estimate).`);
    prov?.dispose();
    console.log('\nDone.');
}
