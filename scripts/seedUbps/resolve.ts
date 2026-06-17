// SPDX-License-Identifier: UNLICENSED
/**
 * Label -> on-chain address resolution for the UBPS seeder.
 *
 * All functions here are PURE deterministic address calc (no RPC): they mirror the
 * UBPS get-methods via the wrapper's *Address helpers + stringId. The only piece
 * that cannot be precomputed offline is a BeliefSet's index (master-assigned at
 * creation) — `assignBeliefSetIndices` takes the starting nextBsIndex (and any
 * indices already recorded from a prior run) and assigns the rest sequentially.
 */
import { Address, Cell } from '@ton/core';
import { UBPS } from '../../wrappers/ubps/UBPS';
import { stringId, buildAddressSet, buildNameCell, MAX_A, MAX_BS } from '../../wrappers/ubps/types';
import {
    UbpsSeed,
    SeedBeliefSet,
    SeedPointer,
    topoSortBeliefSets,
} from './types';

export interface SeedCodes {
    unitCode: Cell;
    questionCode: Cell;
    answerCode: Cell;
    beliefSetCode: Cell;
}

export interface ResolvedQuestion {
    id: string;
    text: string;
    questionId: bigint;
    address: Address;
}
export interface ResolvedAnswer {
    id: string;
    text: string;
    questionLabel: string;
    answerId: bigint;
    address: Address;
}
export interface ResolvedBeliefSet {
    id: string;
    index: number;
    root: boolean;
    address: Address;
}

// --- Questions ---
export function buildQuestionMap(ubps: UBPS, code: Cell, seed: UbpsSeed): Map<string, ResolvedQuestion> {
    const m = new Map<string, ResolvedQuestion>();
    for (const q of seed.questions) {
        const questionId = stringId(q.text);
        m.set(q.id, { id: q.id, text: q.text, questionId, address: ubps.questionAddress(questionId, code) });
    }
    return m;
}

// --- Answers (need the resolved question addresses) ---
export function buildAnswerMap(
    ubps: UBPS,
    code: Cell,
    seed: UbpsSeed,
    qMap: Map<string, ResolvedQuestion>,
): Map<string, ResolvedAnswer> {
    const m = new Map<string, ResolvedAnswer>();
    for (const a of seed.answers) {
        const q = qMap.get(a.question);
        if (!q) throw new Error(`answer "${a.id}" references unknown question "${a.question}"`);
        const answerId = stringId(a.text);
        m.set(a.id, {
            id: a.id,
            text: a.text,
            questionLabel: a.question,
            answerId,
            address: ubps.answerAddress(q.address, answerId, code),
        });
    }
    return m;
}

// --- BeliefSets ---
/** Leaf-first creation order (every set appears AFTER the sets it references). Throws on a cycle. */
export function beliefSetCreationOrder(seed: UbpsSeed): string[] {
    const topo = topoSortBeliefSets(seed.beliefSets.map(bs => ({ id: bs.id, sets: bs.sets })));
    if (topo.cycle) throw new Error(`beliefSets[].sets cycle: ${topo.cycle.join(' -> ')}`);
    return topo.order;
}

/**
 * Assign each BeliefSet (in creation order) its master-assigned index + address.
 * `startIndex` is the master's current nextBsIndex. `existing` carries indices
 * already recorded by a prior run (so a resume reuses them and only new sets draw
 * fresh indices). New indices are handed out sequentially, skipping any taken by
 * `existing`.
 */
export function assignBeliefSetIndices(
    ubps: UBPS,
    code: Cell,
    seed: UbpsSeed,
    order: string[],
    startIndex: number,
    existing?: Map<string, number>,
): Map<string, ResolvedBeliefSet> {
    const byId = new Map<string, SeedBeliefSet>(seed.beliefSets.map(bs => [bs.id, bs]));
    const used = new Set<number>(existing ? [...existing.values()] : []);
    const out = new Map<string, ResolvedBeliefSet>();
    let next = startIndex;
    const nextFree = (): number => {
        while (used.has(next)) next++;
        const v = next;
        used.add(v);
        next++;
        return v;
    };
    for (const id of order) {
        const bs = byId.get(id)!;
        const index = existing?.has(id) ? existing.get(id)! : nextFree();
        out.set(id, { id, index, root: bs.root, address: ubps.beliefSetAddress(index, code) });
    }
    return out;
}

export interface BeliefSetSendArgs {
    root: boolean;
    aCount: number;
    bsCount: number;
    aSet: Cell;
    bsSet: Cell;
    name: Cell | null;        // optional display name (null when the seed omits it)
}

/** Build the sendCreateBeliefSet args for one BS (address sets from resolved maps). */
export function beliefSetSendArgs(
    bs: SeedBeliefSet,
    aMap: Map<string, ResolvedAnswer>,
    bsMap: Map<string, ResolvedBeliefSet>,
): BeliefSetSendArgs {
    if (bs.answers.length > MAX_A) throw new Error(`beliefSet "${bs.id}" answers ${bs.answers.length} > MAX_A`);
    if (bs.sets.length > MAX_BS) throw new Error(`beliefSet "${bs.id}" sets ${bs.sets.length} > MAX_BS`);
    const aAddrs: Address[] = bs.answers.map(ref => {
        const a = aMap.get(ref);
        if (!a) throw new Error(`beliefSet "${bs.id}" references unknown answer "${ref}"`);
        return a.address;
    });
    const bsAddrs: Address[] = bs.sets.map(ref => {
        const r = bsMap.get(ref);
        if (!r) throw new Error(`beliefSet "${bs.id}" references unknown beliefSet "${ref}"`);
        return r.address;
    });
    return {
        root: bs.root,
        aCount: aAddrs.length,
        bsCount: bsAddrs.length,
        aSet: buildAddressSet(aAddrs),
        bsSet: buildAddressSet(bsAddrs),
        name: bs.name != null && bs.name.length > 0 ? buildNameCell(bs.name) : null,
    };
}

// --- Users / Units / pointers ---
export function unitAddressFor(ubps: UBPS, code: Cell, userWallet: Address): Address {
    return ubps.unitAddress(userWallet, code);
}

/**
 * Resolve a user's pointer to its on-chain target address (or null for "none").
 * `unitAddrByUser` maps a user id -> that user's Unit address (for type "unit").
 */
export function resolvePointerTarget(
    pointer: SeedPointer,
    bsMap: Map<string, ResolvedBeliefSet>,
    unitAddrByUser: Map<string, Address>,
): Address | null {
    switch (pointer.type) {
        case 'none':
            return null;
        case 'belief': {
            const r = bsMap.get(pointer.ref ?? '');
            if (!r) throw new Error(`pointer belief ref "${pointer.ref}" not resolved`);
            return r.address;
        }
        case 'unit': {
            const a = unitAddrByUser.get(pointer.ref ?? '');
            if (!a) throw new Error(`pointer unit ref "${pointer.ref}" not resolved`);
            return a;
        }
    }
}
