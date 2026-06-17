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
      "answers": ["a.happy.yes"],        // <= MAX_A (100); existing answer ids
      "sets": ["bs.other"]               // <= MAX_BS (20); existing beliefSet ids; ACYCLIC (DAG)
    }
  ],
  "users": [
    {
      "id": "u.alice",
      "walletIndex": 0,                  // 0-based index into the derived test-wallet set
      "pointer": { "type": "belief", "ref": "bs.core" }   // type in belief|unit|none
    }
  ]
}
```

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
- `text` ≤ 127 utf-8 bytes.

**Deliberately NOT enforced** (per the UBPS concept): semantic belief
validity/optimality, and **Unit→Unit subscription cycles are ALLOWED** (only the
`beliefSets[].sets` DAG must be acyclic).

## Manifest output

After a run the seeder writes `deployment_info/ubps-seed.<network>.manifest.json`
(gitignored) mapping every label → `{ id/index, address, status }` plus a run
summary. `--dry-run` prints the same structure as a preview without writing it.
