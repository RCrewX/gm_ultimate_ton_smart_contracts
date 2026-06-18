# UBPS Seed Format v1 — the standard

The input file for `scripts/seedUbps.ts`. The machine-readable mirror is
[`schema.json`](./schema.json) (JSON Schema draft-07); the runtime validator is
`validateSeed()` in [`types.ts`](./types.ts). All three MUST stay in sync.

## Cross-reference model

Entities reference each other by **symbolic `id` labels**, never by address. The
seeder resolves every label to its deterministic on-chain address:

- `questionId = sha256(utf8(text))`, `address = questionAddress(questionId)`
- `answerId   = sha256(utf8(text))`, `address = answerAddress(qAddr, answerId)`
- a **BeliefSet's index is assigned by the master at creation** → its address is
  only known after it is created. The seeder topo-sorts the `sets` DAG, creates
  leaf-first, and captures each index. So BeliefSet addresses/indices are **not**
  in the input.
- a **Belief (B)** is just a BeliefSet with `root: true` — there is no separate array.

Strings (`questions[].text`, `answers[].text`) are capped at **127 utf-8 bytes**
(the on-chain single-cell `stringId` limit) — over that is a hard error.

## Shape

```jsonc
{
  "ubpsSeedVersion": 1,
  "network": "testnet",                  // MUST equal the --network flag; "mainnet" rejected
  "meta": {                              // optional provenance
    "description": "string",
    "generatedAt": "2026-06-17T00:00:00Z",
    "generator": "brain|manual",
    "counts": { "users": 100, "questions": 0, "answers": 0, "beliefSets": 0 }
  },
  "questions": [
    { "id": "q.happy", "text": "Are you happy?" }
  ],
  "answers": [
    { "id": "a.happy.yes", "question": "q.happy", "text": "Yes" }
  ],
  "beliefSets": [
    {
      "id": "bs.core",
      "root": false,                     // true => final Belief (public profile)
      "name": "My core beliefs",         // OPTIONAL display name (<= 256 utf-8 bytes); see below
      "answers": ["a.happy.yes"],        // <= MAX_A (100); existing answer ids
      "sets": ["bs.other"]               // <= MAX_BS (20); existing beliefSet ids; ACYCLIC (DAG)
    }
  ],
  "users": [
    {
      "id": "u.alice",
      "walletIndex": 0,                  // 0-based index into the derived test-wallet set
      "createViaMaster": true,           // OPTIONAL (default true); see below
      "pointer": { "type": "belief", "ref": "bs.core" }   // type in belief|unit|none
    }
  ]
}
```

### `beliefSets[].name` (optional)
A free-form display name/description for the BeliefSet, ≤ **256 utf-8 bytes**. It is
**non-unique, immutable** (set once at creation), **NOT hashed, NOT an id, and NOT
address-determining** — two BeliefSets with different names at the same index would
share the same address. Purely for friendly display. Omit it for an unnamed set.

### `users[].createViaMaster` (optional, default `true`)
Controls HOW the user's Unit is created:
- `true` (**default, recommended**) → **create THROUGH the master** (`CreateUnit`): a
  single user-signed message deploys the Unit *and* applies the initial pointer, and the
  master's tx history records the creation so the backend discovers the Unit via the
  master funnel. The Unit lands at the SAME deterministic address as a self-deploy.
- `false` → **self-deploy** the Unit (user-signed) then a separate user-signed
  `SetPointer`. Same final state, two messages, no master tx for the creation.

### `users[].pointer`
- `belief` → `ref` is a `beliefSets[].id` (usually a root one).
- `unit` → `ref` is another `users[].id` (a Unit→Unit subscription).
- `none` → `ref` is `null`/omitted (the user pointer is cleared).

## Validation rules (enforced by `validateSeed` and `--dry-run`)

- `ubpsSeedVersion === 1`; `network` matches the flag; `mainnet` rejected.
- All `id`s unique within their array; every reference resolves to an existing id
  of the right kind (`answers[].question`→question, `beliefSets[].answers`→answer,
  `beliefSets[].sets`→beliefSet, `users[].pointer.ref`→beliefSet|user per `type`).
- `beliefSets[].answers.length ≤ MAX_A` (100); `beliefSets[].sets.length ≤ MAX_BS` (20).
- The `beliefSets[].sets` graph is **acyclic** (topo-sortable).
- `users[].walletIndex` is a unique non-negative integer; `pointer.type ∈ {belief,unit,none}`.
- `text` ≤ 127 utf-8 bytes; `beliefSets[].name` (when present) ≤ 256 utf-8 bytes.
- `users[].createViaMaster` (when present) is a boolean.

**Deliberately NOT enforced** (per the UBPS concept): semantic belief
validity/optimality, and **Unit→Unit subscription cycles are ALLOWED** (only the
`beliefSets[].sets` DAG must be acyclic).

## Fragments (`--include`)

A **fragment** is a partial seed carrying only shared vocabulary —
`questions` / `answers` / `beliefSets` (no `users`, no `network`) — marked with
`"ubpsSeedFragment": 1`. The seeder's `--include <file>` flag merges one or more
fragments into the `--file` seed **before** validation, BY id and idempotently (an
id already present in the seed is skipped). This lets a seed reference shared ids
(e.g. the UBPS Canon's `"bs.canon"`) and pull their definitions from one place. The
merge helper is `mergeSeedFragments()` in [`types.ts`](./types.ts); the canon
fragment is [`canon.json`](./canon.json) (see [`CANON.md`](./CANON.md)).

## Manifest output

After a run the seeder writes `deployment_info/ubps-seed.<network>.manifest.json`
(gitignored) mapping every label → `{ id/index, address, status }` plus a run
summary. `--dry-run` prints the same structure as a preview without writing it.
