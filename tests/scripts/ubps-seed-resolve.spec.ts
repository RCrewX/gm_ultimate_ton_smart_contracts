// SPDX-License-Identifier: UNLICENSED
// Pure-logic unit test for the UBPS seeder (no sandbox / no RPC):
// schema validation (good + bad), topo sort, cycle rejection, Unit->Unit cycle
// acceptance, cap enforcement, label resolution, deterministic wallet derivation.
import { Address, beginCell } from '@ton/core';
import {
    validateSeed,
    topoSortBeliefSets,
    UbpsSeed,
    MAX_A,
    MAX_BS,
    UBPS_MAX_STRING_BYTES,
    UBPS_MAX_NAME_BYTES,
} from '../../scripts/seedUbps/types';
import { stringId } from '../../wrappers/ubps/types';
import { UBPS } from '../../wrappers/ubps/UBPS';
import {
    buildQuestionMap,
    buildAnswerMap,
    beliefSetCreationOrder,
    assignBeliefSetIndices,
    beliefSetSendArgs,
} from '../../scripts/seedUbps/resolve';
import { deriveUserWallet } from '../../scripts/seedUbps/wallets';
import { estimateDeployerCost, fmtAddr, chunk } from '../../scripts/seedUbps/seedSteps';
import { runWithRestarts } from '../../scripts/seedUbps/provider';

// A tiny valid seed used as the base for "good" + mutated "bad" cases.
function baseSeed(): UbpsSeed {
    return {
        ubpsSeedVersion: 1,
        network: 'testnet',
        questions: [
            { id: 'q.happy', text: 'Are you happy?' },
            { id: 'q.coffee', text: 'Do you drink coffee?' },
        ],
        answers: [
            { id: 'a.yes', question: 'q.happy', text: 'Yes' },
            { id: 'a.no', question: 'q.coffee', text: 'No' },
        ],
        beliefSets: [
            { id: 'bs.core', root: false, answers: ['a.yes', 'a.no'], sets: [] },
            { id: 'b.profile', root: true, answers: ['a.yes'], sets: ['bs.core'] },
        ],
        users: [
            { id: 'u.alice', walletIndex: 0, pointer: { type: 'belief', ref: 'b.profile' } },
            { id: 'u.bob', walletIndex: 1, pointer: { type: 'unit', ref: 'u.alice' } },
            { id: 'u.carol', walletIndex: 2, pointer: { type: 'none' } },
        ],
    };
}

describe('validateSeed — good cases', () => {
    it('accepts a well-formed seed', () => {
        const r = validateSeed(baseSeed(), 'testnet');
        expect(r.ok).toBe(true);
        expect(r.errors).toHaveLength(0);
        expect(r.seed).toBeDefined();
    });

    it('accepts a Unit->Unit subscription cycle (deliberately allowed)', () => {
        const s = baseSeed();
        s.users = [
            { id: 'u.a', walletIndex: 0, pointer: { type: 'unit', ref: 'u.b' } },
            { id: 'u.b', walletIndex: 1, pointer: { type: 'unit', ref: 'u.a' } },
        ];
        const r = validateSeed(s, 'testnet');
        expect(r.ok).toBe(true);
    });

    it('accepts optional beliefSets[].name and users[].createViaMaster', () => {
        const s = baseSeed();
        s.beliefSets[0].name = 'My core beliefs';
        s.beliefSets[1].name = 'x'.repeat(UBPS_MAX_NAME_BYTES); // exactly at the cap
        s.users[0].createViaMaster = true;
        s.users[1].createViaMaster = false;
        // u.carol omits it (defaults to via-master)
        const r = validateSeed(s, 'testnet');
        expect(r.ok).toBe(true);
        expect(r.errors).toHaveLength(0);
    });
});

describe('validateSeed — bad cases', () => {
    it('rejects a wrong version', () => {
        const s = { ...baseSeed(), ubpsSeedVersion: 2 } as unknown;
        const r = validateSeed(s, 'testnet');
        expect(r.ok).toBe(false);
        expect(r.errors.join('\n')).toMatch(/ubpsSeedVersion/);
    });

    it('rejects mainnet', () => {
        const s = { ...baseSeed(), network: 'mainnet' } as UbpsSeed;
        const r = validateSeed(s, 'mainnet');
        expect(r.ok).toBe(false);
        expect(r.errors.join('\n')).toMatch(/mainnet seeding not enabled/);
    });

    it('rejects a network/flag mismatch', () => {
        const r = validateSeed(baseSeed(), 'mainnet');
        expect(r.ok).toBe(false);
        expect(r.errors.join('\n')).toMatch(/does not match/);
    });

    it('rejects a dangling answer->question reference', () => {
        const s = baseSeed();
        s.answers[0].question = 'q.nope';
        const r = validateSeed(s, 'testnet');
        expect(r.ok).toBe(false);
        expect(r.errors.join('\n')).toMatch(/does not resolve to a question/);
    });

    it('rejects a duplicate id', () => {
        const s = baseSeed();
        s.questions[1].id = 'q.happy';
        const r = validateSeed(s, 'testnet');
        expect(r.ok).toBe(false);
        expect(r.errors.join('\n')).toMatch(/duplicated/);
    });

    it('rejects a duplicate walletIndex', () => {
        const s = baseSeed();
        s.users[1].walletIndex = 0;
        const r = validateSeed(s, 'testnet');
        expect(r.ok).toBe(false);
        expect(r.errors.join('\n')).toMatch(/walletIndex 0 is duplicated/);
    });

    it('rejects a bad pointer ref kind', () => {
        const s = baseSeed();
        s.users[0].pointer = { type: 'belief', ref: 'u.alice' }; // user id, not a beliefSet
        const r = validateSeed(s, 'testnet');
        expect(r.ok).toBe(false);
        expect(r.errors.join('\n')).toMatch(/does not resolve to a beliefSet/);
    });

    it('rejects text over the 127-byte cap', () => {
        const s = baseSeed();
        s.questions[0].text = 'x'.repeat(UBPS_MAX_STRING_BYTES + 1);
        const r = validateSeed(s, 'testnet');
        expect(r.ok).toBe(false);
        expect(r.errors.join('\n')).toMatch(/utf-8 bytes/);
    });

    it('enforces MAX_A on beliefSets[].answers', () => {
        const s = baseSeed();
        const answers = Array.from({ length: MAX_A + 1 }, (_, i) => ({ id: `a.${i}`, question: 'q.happy', text: `t${i}` }));
        s.answers = answers;
        s.beliefSets = [{ id: 'bs.big', root: false, answers: answers.map(a => a.id), sets: [] }];
        s.users = [];
        const r = validateSeed(s, 'testnet');
        expect(r.ok).toBe(false);
        expect(r.errors.join('\n')).toMatch(/> MAX_A/);
    });

    it('enforces MAX_BS on beliefSets[].sets', () => {
        const s = baseSeed();
        const leaves = Array.from({ length: MAX_BS + 1 }, (_, i) => ({ id: `bs.${i}`, root: false, answers: [], sets: [] }));
        s.beliefSets = [...leaves, { id: 'bs.big', root: false, answers: [], sets: leaves.map(l => l.id) }];
        s.answers = [];
        s.users = [];
        const r = validateSeed(s, 'testnet');
        expect(r.ok).toBe(false);
        expect(r.errors.join('\n')).toMatch(/> MAX_BS/);
    });

    it('rejects a beliefSets[].name over the 256-byte cap', () => {
        const s = baseSeed();
        s.beliefSets[0].name = 'x'.repeat(UBPS_MAX_NAME_BYTES + 1);
        const r = validateSeed(s, 'testnet');
        expect(r.ok).toBe(false);
        expect(r.errors.join('\n')).toMatch(/name is \d+ utf-8 bytes > 256/);
    });

    it('rejects a non-string beliefSets[].name', () => {
        const s = baseSeed();
        (s.beliefSets[0] as unknown as { name: unknown }).name = 123;
        const r = validateSeed(s, 'testnet');
        expect(r.ok).toBe(false);
        expect(r.errors.join('\n')).toMatch(/name must be a string/);
    });

    it('rejects a non-boolean users[].createViaMaster', () => {
        const s = baseSeed();
        (s.users[0] as unknown as { createViaMaster: unknown }).createViaMaster = 'yes';
        const r = validateSeed(s, 'testnet');
        expect(r.ok).toBe(false);
        expect(r.errors.join('\n')).toMatch(/createViaMaster must be a boolean/);
    });

    it('rejects a cyclic sets graph', () => {
        const s = baseSeed();
        s.beliefSets = [
            { id: 'bs.a', root: false, answers: [], sets: ['bs.b'] },
            { id: 'bs.b', root: false, answers: [], sets: ['bs.a'] },
        ];
        s.answers = [];
        s.users = [];
        const r = validateSeed(s, 'testnet');
        expect(r.ok).toBe(false);
        expect(r.errors.join('\n')).toMatch(/cycle/);
    });
});

describe('topoSortBeliefSets', () => {
    it('orders dependencies before dependents (leaf-first)', () => {
        const { order, cycle } = topoSortBeliefSets([
            { id: 'root', sets: ['mid'] },
            { id: 'mid', sets: ['leaf'] },
            { id: 'leaf', sets: [] },
        ]);
        expect(cycle).toBeNull();
        expect(order.indexOf('leaf')).toBeLessThan(order.indexOf('mid'));
        expect(order.indexOf('mid')).toBeLessThan(order.indexOf('root'));
    });

    it('detects a cycle', () => {
        const { cycle } = topoSortBeliefSets([
            { id: 'a', sets: ['b'] },
            { id: 'b', sets: ['a'] },
        ]);
        expect(cycle).not.toBeNull();
        expect(cycle).toContain('a');
        expect(cycle).toContain('b');
    });
});

describe('label resolution', () => {
    const fakeCode = beginCell().storeUint(0xabc, 16).endCell();
    // Any deterministic master address is fine for pure address-calc tests.
    const ubps = UBPS.createFromAddress(Address.parse('kQBbdTP3Mn1LalPtL7eC_LmXeEC74rdiW2GUI-xVl6AZnNEm'));

    it('questionId = sha256(text) and addresses are deterministic + distinct', () => {
        const seed = baseSeed();
        const m1 = buildQuestionMap(ubps, fakeCode, seed);
        const m2 = buildQuestionMap(ubps, fakeCode, seed);
        expect(m1.get('q.happy')!.questionId).toBe(stringId('Are you happy?'));
        expect(m1.get('q.happy')!.address.equals(m2.get('q.happy')!.address)).toBe(true);
        expect(m1.get('q.happy')!.address.equals(m1.get('q.coffee')!.address)).toBe(false);
    });

    it('answers resolve via their question address', () => {
        const seed = baseSeed();
        const qMap = buildQuestionMap(ubps, fakeCode, seed);
        const aMap = buildAnswerMap(ubps, fakeCode, seed, qMap);
        expect(aMap.get('a.yes')!.answerId).toBe(stringId('Yes'));
        expect(aMap.get('a.yes')!.questionLabel).toBe('q.happy');
    });

    it('beliefSetCreationOrder is leaf-first', () => {
        const order = beliefSetCreationOrder(baseSeed());
        expect(order.indexOf('bs.core')).toBeLessThan(order.indexOf('b.profile'));
    });

    it('beliefSetSendArgs carries the optional name (cell when present, null when absent)', () => {
        const seed = baseSeed();
        seed.beliefSets[0].name = 'My core beliefs';
        const qMap = buildQuestionMap(ubps, fakeCode, seed);
        const aMap = buildAnswerMap(ubps, fakeCode, seed, qMap);
        const order = beliefSetCreationOrder(seed);
        const bsMap = assignBeliefSetIndices(ubps, fakeCode, seed, order, 0);

        const named = beliefSetSendArgs(seed.beliefSets[0], aMap, bsMap);
        expect(named.name).not.toBeNull();
        // the name cell is a snake string — decode it back
        expect(named.name!.beginParse().loadStringTail()).toBe('My core beliefs');

        const unnamed = beliefSetSendArgs(seed.beliefSets[1], aMap, bsMap);
        expect(unnamed.name).toBeNull();
    });

    it('the BeliefSet address does NOT depend on the name (same index, name-free address calc)', () => {
        // beliefSetAddress derives from (master, index) only; the name is post-creation
        // content. Two otherwise-identical seeds (one named) resolve to the SAME address.
        const named = baseSeed(); named.beliefSets[0].name = 'whatever';
        const plain = baseSeed();
        const order = beliefSetCreationOrder(named);
        const aNamed = assignBeliefSetIndices(ubps, fakeCode, named, order, 0).get('bs.core')!;
        const aPlain = assignBeliefSetIndices(ubps, fakeCode, plain, order, 0).get('bs.core')!;
        expect(aNamed.address.equals(aPlain.address)).toBe(true);
    });
});

describe('chunk (W4 batching grouping)', () => {
    it('groups into batches of at most the W4 cap (4), preserving order', () => {
        const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const batches = chunk(items, 4);
        expect(batches.map(b => b.length)).toEqual([4, 4, 2]);
        // order preserved within and across batches: flattening reproduces the input.
        expect(batches.flat()).toEqual(items);
        // no batch exceeds the cap.
        for (const b of batches) expect(b.length).toBeLessThanOrEqual(4);
    });

    it('returns no batches for an empty list and a single batch when under the cap', () => {
        expect(chunk([], 4)).toEqual([]);
        expect(chunk([1, 2, 3], 4)).toEqual([[1, 2, 3]]);
    });
});

describe('deterministic wallet derivation', () => {
    const seedBytes = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex');

    it('same seed + index => same address', () => {
        const a = deriveUserWallet(seedBytes, 7);
        const b = deriveUserWallet(seedBytes, 7);
        expect(a.wallet.address.equals(b.wallet.address)).toBe(true);
        expect(a.keyPair.publicKey.equals(b.keyPair.publicKey)).toBe(true);
    });

    it('different index => different address', () => {
        const a = deriveUserWallet(seedBytes, 0);
        const b = deriveUserWallet(seedBytes, 1);
        expect(a.wallet.address.equals(b.wallet.address)).toBe(false);
    });
});

describe('estimateDeployerCost (preflight gas)', () => {
    it('required = ops + funding + margin and stays positive for an empty seed', () => {
        const e = estimateDeployerCost({ questions: 2, answers: 2, beliefSets: 2, users: 3 });
        expect(e.required).toBe(e.ops + e.funding + e.margin);
        const empty = estimateDeployerCost({ questions: 0, answers: 0, beliefSets: 0, users: 0 });
        expect(empty.required).toBeGreaterThan(0n); // base buffer always reserved
    });

    it('scales up with more users (so --users <n> lowers the requirement)', () => {
        const small = estimateDeployerCost({ questions: 1, answers: 1, beliefSets: 1, users: 1 });
        const big = estimateDeployerCost({ questions: 1, answers: 1, beliefSets: 1, users: 100 });
        expect(big.required).toBeGreaterThan(small.required);
    });
});

describe('fmtAddr — chain-correct user-friendly form', () => {
    // Same raw address; only the testOnly display flag differs per network.
    const addr = Address.parse('EQCAwOrkCl6cPi_riCJAU3Bq3JzCsdGg3SA8_b-t76aqBo2q');

    it('testnet bounceable starts kQ, non-bounceable 0Q', () => {
        expect(fmtAddr(addr, 'testnet', true).startsWith('kQ')).toBe(true);
        expect(fmtAddr(addr, 'testnet', false).startsWith('0Q')).toBe(true);
    });

    it('mainnet bounceable starts EQ, non-bounceable UQ', () => {
        expect(fmtAddr(addr, 'mainnet', true).startsWith('EQ')).toBe(true);
        expect(fmtAddr(addr, 'mainnet', false).startsWith('UQ')).toBe(true);
    });

    it('both forms decode back to the SAME raw address (only the flag differs)', () => {
        const fromTestnet = Address.parse(fmtAddr(addr, 'testnet'));
        const fromMainnet = Address.parse(fmtAddr(addr, 'mainnet'));
        expect(fromTestnet.equals(addr)).toBe(true);
        expect(fromMainnet.equals(addr)).toBe(true);
    });
});

describe('runWithRestarts — provider recovery control flow', () => {
    it('retries after errors and succeeds (recover called once per failure)', async () => {
        let calls = 0;
        let recoveries = 0;
        const result = await runWithRestarts(
            'op',
            async () => { calls++; if (calls < 3) throw new Error('escaped failover'); return 'ok'; },
            async () => { recoveries++; },
            12,
        );
        expect(result).toBe('ok');
        expect(calls).toBe(3);
        expect(recoveries).toBe(2); // two failures → two restarts, third call succeeds
    });

    it('gives up after maxRestarts and rethrows a wrapped error', async () => {
        let recoveries = 0;
        await expect(runWithRestarts(
            'doomed',
            async () => { throw new Error('always down'); },
            async () => { recoveries++; },
            2,
        )).rejects.toThrow(/doomed: still failing after 2 provider restart/);
        expect(recoveries).toBe(2); // attempts at i=0,1 recover; i=2 exceeds budget → throw
    });

    it('never restarts when the action succeeds first try', async () => {
        let recoveries = 0;
        const r = await runWithRestarts('fine', async () => 42, async () => { recoveries++; }, 12);
        expect(r).toBe(42);
        expect(recoveries).toBe(0);
    });
});
