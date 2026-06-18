# UBPS Canon

The **UBPS Canon** is ordinary on-chain data — a fixed set of canonical
Question→Answer pairs and a single canonical BeliefSet (`bs.canon`, display name
**"UBPS Canon"**) — plus a few **off-chain** conventions. There is **no contract
change and no on-chain canon check**: the canon is just a reusable seed fragment
([`canon.json`](./canon.json)) any seed can pull in, and membership is signalled by
referencing the canon BeliefSet.

## The canonical Question→Answer pairs (LOCKED)

These five strings are **address-determining** (`id = sha256(utf8(text))`) — once
deployed they cannot change without producing new addresses. Do **not** edit the
text; treat [`canon.json`](./canon.json) as frozen.

| # | Question | Answer |
|---|----------|--------|
| 1 | `I am a part of UBPS.` | `Yes.` |
| 2 | `I use Canonical answer writing: [Y-yes\|N-no\|0-empty\|other].` | `Y` |
| 3 | `I use Canonical terms (U\|Q\|A\|BS)` | `Y` |
| 4 | `I consider BS invalid if there are different A for similar Q.` | `Y` |
| 5 | `I consider shift firstly to A("0") and then to A as canonical BS shift.` | `Y` |

All five answers live in one **non-root** BeliefSet `bs.canon` (`name: "UBPS Canon"`).

> **Ordering is an open design point.** The 1–5 order above is the default canonical
> reading order. Order does **not** affect addresses (each Q/A is hashed
> independently), but it is the published reading order — **confirm the exact text +
> order with the project owner before any mainnet deploy.**

## Declaring UBPS membership (composable)

A user's **final Belief** (a root BeliefSet) declares "I am part of UBPS" by listing
`"bs.canon"` in its `sets[]`. This is unrelated to the user's substantive beliefs —
it only signals participation in the same UBPS system. Because `bs.canon` is just a
BeliefSet, it composes like any other set (subject to `MAX_BS = 20` per BeliefSet).

A **negative** answer to `Question("I am a part of UBPS.")` is meaningless — it only
exists as a joke. Membership is "reference `bs.canon`", not "answer No".

## The answer convention `Y | N | 0 | other` (off-chain)

Answers are written in a small canonical alphabet so camps can read each other:

- **`Y`** — yes / affirmative.
- **`N`** — no / negative.
- **`0`** — the question is **acknowledged but intentionally unanswered**. Used to
  co-surface a *new* question across camps before anyone commits to an answer.
- **`other`** — free-form text (anything outside `Y`/`N`/`0`).

## The canonical BeliefSet shift (off-chain)

To adopt a new question canonically, **shift in two steps**:

1. Publish a new BeliefSet containing `A("0")` for the new question — this makes "this
   question matters" visible across all camps *before* anyone answers it.
2. Later publish a BeliefSet with the real answer (`A("Y")` / `A("N")`).

So the order is always **first `A("0")`, then the real `A`** — that is what "canonical
BS shift" (canon pair #5) refers to. BeliefSets are immutable, so each step is a new
BeliefSet (the previous one is never edited).

## Not enforced on-chain (by design)

Per the UBPS concept decisions, none of the above is checked on-chain:

- No contract validates membership, answer alphabet, or shift order.
- Belief validity/optimality (e.g. "no two different A for the same Q") is an
  off-chain (frontend/backend) concern — the chain only stores addresses.

## Using the canon in a seed

`canon.json` is a **seed fragment** (questions / answers / beliefSets only — no
`users`). Merge it into any seed at run time with `--include`; the merge is by id and
idempotent, so a seed just references shared ids like `"bs.canon"`:

```bash
# dry-run a seed whose root Beliefs reference "bs.canon", pulling the canon in:
pnpm seed:ubps:dry \
  --file scripts/seedUbps/examples/ubps-seed-small-canon.testnet.json \
  --include scripts/seedUbps/canon.json
```

See [`examples/ubps-seed-small-canon.testnet.json`](./examples/ubps-seed-small-canon.testnet.json)
for the ~25-user small set where six representative root Beliefs declare membership.
