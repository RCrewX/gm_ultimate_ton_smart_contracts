// SPDX-License-Identifier: UNLICENSED
/**
 * UBPS Seed Format v1 — the standard.
 *
 * This module is the runtime mirror of `schema.json` / `SCHEMA.md`: the `UbpsSeed`
 * TypeScript type, the §6 validation rules (`validateSeed`), and the pure graph
 * topo-sort used both to reject cyclic `beliefSets[].sets` and to order BeliefSet
 * creation. It imports NOTHING on-chain (no wrappers / @ton/core) so the validator
 * stays dependency-light and unit-testable.
 *
 * Caps (MAX_A / MAX_BS / UBPS_MAX_STRING_BYTES) are RE-EXPORTED from the UBPS
 * wrapper types so the seeder and the contracts can never drift.
 */
import { MAX_A, MAX_BS, UBPS_MAX_STRING_BYTES } from '../../wrappers/ubps/types';

export { MAX_A, MAX_BS, UBPS_MAX_STRING_BYTES };

export const UBPS_SEED_VERSION = 1 as const;

export type SeedNetwork = 'testnet' | 'mainnet';
export type PointerType = 'belief' | 'unit' | 'none';

export interface SeedMeta {
    description?: string;
    generatedAt?: string;
    generator?: string;
    counts?: { users?: number; questions?: number; answers?: number; beliefSets?: number };
}

export interface SeedQuestion {
    id: string;
    text: string;
}

export interface SeedAnswer {
    id: string;
    question: string; // -> an existing SeedQuestion.id
    text: string;
}

export interface SeedBeliefSet {
    id: string;
    root: boolean;            // true => final Belief (public profile)
    answers: string[];        // -> existing SeedAnswer.id[]  (<= MAX_A)
    sets: string[];           // -> existing SeedBeliefSet.id[] (<= MAX_BS); ACYCLIC
}

export interface SeedPointer {
    type: PointerType;
    ref?: string | null;      // belief -> beliefSet id; unit -> user id; none -> null/omitted
}

export interface SeedUser {
    id: string;
    walletIndex: number;      // 0-based index into the derived test-wallet set
    pointer: SeedPointer;
}

export interface UbpsSeed {
    ubpsSeedVersion: 1;
    network: SeedNetwork;
    meta?: SeedMeta;
    questions: SeedQuestion[];
    answers: SeedAnswer[];
    beliefSets: SeedBeliefSet[];
    users: SeedUser[];
}

export interface ValidationResult {
    ok: boolean;
    errors: string[];
    /** Present (and typed) only when ok === true. */
    seed?: UbpsSeed;
}

// ---------------------------------------------------------------------------
//  Pure graph topo-sort over beliefSets[].sets (id -> its child set ids).
//  Returns a creation order (a set appears AFTER every set it references, so
//  referenced addresses exist first) and the first cycle found (if any).
// ---------------------------------------------------------------------------
export interface TopoResult {
    order: string[];          // leaf-first creation order (valid only when cycle === null)
    cycle: string[] | null;   // the offending id chain, or null if acyclic
}

export function topoSortBeliefSets(beliefSets: Array<{ id: string; sets: string[] }>): TopoResult {
    const children = new Map<string, string[]>();
    for (const bs of beliefSets) children.set(bs.id, bs.sets ?? []);

    const order: string[] = [];
    const state = new Map<string, 0 | 1 | 2>(); // 0/undef = unseen, 1 = on-stack, 2 = done
    const stack: string[] = [];

    const visit = (id: string): string[] | null => {
        const st = state.get(id) ?? 0;
        if (st === 2) return null;
        if (st === 1) {
            // back-edge -> cycle; slice the stack from the first occurrence of id
            const from = stack.indexOf(id);
            return stack.slice(from).concat(id);
        }
        state.set(id, 1);
        stack.push(id);
        for (const dep of children.get(id) ?? []) {
            // unknown deps are a reference error caught elsewhere; skip here
            if (!children.has(dep)) continue;
            const cyc = visit(dep);
            if (cyc) return cyc;
        }
        stack.pop();
        state.set(id, 2);
        order.push(id);
        return null;
    };

    for (const bs of beliefSets) {
        const cyc = visit(bs.id);
        if (cyc) return { order: [], cycle: cyc };
    }
    return { order, cycle: null };
}

// ---------------------------------------------------------------------------
//  validateSeed — enforces every §6 rule. `expectedNetwork` is the --network
//  flag; the JSON's `network` must equal it (and "mainnet" is refused by the
//  CLI before this is even called, but we still reject it here for safety).
// ---------------------------------------------------------------------------
export function validateSeed(
    input: unknown,
    expectedNetwork?: SeedNetwork,
    opts?: { allowMainnet?: boolean }, // read-only callers (deployer-info) may accept a mainnet seed
): ValidationResult {
    const errors: string[] = [];
    const push = (m: string) => errors.push(m);

    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { ok: false, errors: ['seed must be a JSON object'] };
    }
    const s = input as Record<string, unknown>;

    if (s.ubpsSeedVersion !== UBPS_SEED_VERSION) {
        push(`ubpsSeedVersion must be ${UBPS_SEED_VERSION}, got ${JSON.stringify(s.ubpsSeedVersion)}`);
    }

    const network = s.network;
    if (network !== 'testnet' && network !== 'mainnet') {
        push(`network must be "testnet" or "mainnet", got ${JSON.stringify(network)}`);
    } else {
        if (network === 'mainnet' && !opts?.allowMainnet) push('mainnet seeding not enabled (network: "mainnet" rejected)');
        if (expectedNetwork && network !== expectedNetwork) {
            push(`network "${network}" does not match the --${expectedNetwork} flag`);
        }
    }

    const questions = Array.isArray(s.questions) ? (s.questions as SeedQuestion[]) : null;
    const answers = Array.isArray(s.answers) ? (s.answers as SeedAnswer[]) : null;
    const beliefSets = Array.isArray(s.beliefSets) ? (s.beliefSets as SeedBeliefSet[]) : null;
    const users = Array.isArray(s.users) ? (s.users as SeedUser[]) : null;
    if (!questions) push('questions must be an array');
    if (!answers) push('answers must be an array');
    if (!beliefSets) push('beliefSets must be an array');
    if (!users) push('users must be an array');
    if (!questions || !answers || !beliefSets || !users) return { ok: false, errors };

    const checkBytes = (text: unknown, where: string): boolean => {
        if (typeof text !== 'string') { push(`${where}: text must be a string`); return false; }
        const n = Buffer.byteLength(text, 'utf8');
        if (n > UBPS_MAX_STRING_BYTES) {
            push(`${where}: text is ${n} utf-8 bytes > ${UBPS_MAX_STRING_BYTES} (on-chain cap)`);
            return false;
        }
        return true;
    };

    // --- unique ids within each array ---
    const uniq = (arr: Array<{ id?: unknown }>, kind: string): Set<string> => {
        const seen = new Set<string>();
        for (let i = 0; i < arr.length; i++) {
            const id = arr[i]?.id;
            if (typeof id !== 'string' || id.length === 0) { push(`${kind}[${i}].id must be a non-empty string`); continue; }
            if (seen.has(id)) push(`${kind}[${i}].id "${id}" is duplicated`);
            seen.add(id);
        }
        return seen;
    };
    const qIds = uniq(questions, 'questions');
    const aIds = uniq(answers, 'answers');
    const bsIds = uniq(beliefSets, 'beliefSets');
    const uIds = uniq(users, 'users');

    // --- questions ---
    for (let i = 0; i < questions.length; i++) checkBytes(questions[i]?.text, `questions[${i}]`);

    // --- answers: text + question reference ---
    for (let i = 0; i < answers.length; i++) {
        const a = answers[i];
        checkBytes(a?.text, `answers[${i}]`);
        if (typeof a?.question !== 'string' || !qIds.has(a.question)) {
            push(`answers[${i}].question "${a?.question}" does not resolve to a question id`);
        }
    }

    // --- beliefSets: refs, caps, root flag ---
    for (let i = 0; i < beliefSets.length; i++) {
        const bs = beliefSets[i];
        if (typeof bs?.root !== 'boolean') push(`beliefSets[${i}].root must be a boolean`);
        const bsAnswers = Array.isArray(bs?.answers) ? bs.answers : null;
        const bsSets = Array.isArray(bs?.sets) ? bs.sets : null;
        if (!bsAnswers) push(`beliefSets[${i}].answers must be an array`);
        if (!bsSets) push(`beliefSets[${i}].sets must be an array`);
        if (bsAnswers) {
            if (bsAnswers.length > MAX_A) push(`beliefSets[${i}].answers has ${bsAnswers.length} > MAX_A (${MAX_A})`);
            bsAnswers.forEach((ref, j) => {
                if (typeof ref !== 'string' || !aIds.has(ref)) push(`beliefSets[${i}].answers[${j}] "${ref}" does not resolve to an answer id`);
            });
        }
        if (bsSets) {
            if (bsSets.length > MAX_BS) push(`beliefSets[${i}].sets has ${bsSets.length} > MAX_BS (${MAX_BS})`);
            bsSets.forEach((ref, j) => {
                if (typeof ref !== 'string' || !bsIds.has(ref)) push(`beliefSets[${i}].sets[${j}] "${ref}" does not resolve to a beliefSet id`);
            });
        }
    }

    // --- acyclic sets DAG (only when refs are well-formed enough to walk) ---
    if (errors.length === 0 || beliefSets.every(bs => Array.isArray(bs?.sets))) {
        const topo = topoSortBeliefSets(
            beliefSets.map(bs => ({ id: bs.id, sets: Array.isArray(bs?.sets) ? bs.sets : [] })),
        );
        if (topo.cycle) push(`beliefSets[].sets contains a cycle: ${topo.cycle.join(' -> ')}`);
    }

    // --- users: walletIndex (unique, non-negative int), pointer ---
    const seenIdx = new Set<number>();
    for (let i = 0; i < users.length; i++) {
        const u = users[i];
        const wi = u?.walletIndex;
        if (typeof wi !== 'number' || !Number.isInteger(wi) || wi < 0) {
            push(`users[${i}].walletIndex must be a non-negative integer`);
        } else {
            if (seenIdx.has(wi)) push(`users[${i}].walletIndex ${wi} is duplicated`);
            seenIdx.add(wi);
        }
        const p = u?.pointer;
        if (typeof p !== 'object' || p === null) { push(`users[${i}].pointer must be an object`); continue; }
        const t = (p as SeedPointer).type;
        if (t !== 'belief' && t !== 'unit' && t !== 'none') { push(`users[${i}].pointer.type must be belief|unit|none, got ${JSON.stringify(t)}`); continue; }
        const ref = (p as SeedPointer).ref;
        if (t === 'none') {
            if (ref !== undefined && ref !== null) push(`users[${i}].pointer.ref must be null/omitted when type is "none"`);
        } else if (t === 'belief') {
            if (typeof ref !== 'string' || !bsIds.has(ref)) push(`users[${i}].pointer.ref "${ref}" does not resolve to a beliefSet id`);
        } else if (t === 'unit') {
            // Unit -> Unit subscription. Cycles are DELIBERATELY allowed (concept #2/#4).
            if (typeof ref !== 'string' || !uIds.has(ref)) push(`users[${i}].pointer.ref "${ref}" does not resolve to a user id`);
        }
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, errors: [], seed: input as UbpsSeed };
}
