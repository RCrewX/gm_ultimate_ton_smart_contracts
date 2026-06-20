# UBPS test-data seeder

Populates a live **UBPS** deployment from a JSON file in the
[UBPS Seed Format v1](./SCHEMA.md): questions, answers, beliefSets/beliefs, and
per-user Units + pointers. Idempotent and **resumable** — every entity is checked
on-chain first and skipped if already seeded, so a crash mid-run is recovered by
re-running the same command.

## Commands

```bash
# Deployer info — which address to fund + how much + current balance; SENDS NOTHING
pnpm seed:ubps:info --file scripts/seedUbps/examples/sample.json

# Plan only — computes addresses, topo order, fund/skip decisions; SENDS NOTHING
pnpm seed:ubps:dry --file scripts/seedUbps/examples/sample.json

# Live seed (testnet) — the USER runs this; it funds wallets + sends hundreds of txs
pnpm seed:ubps:testnet --file <generated.json>

# Direct
ts-node scripts/seedUbps.ts --testnet --file <seed.json> [--dry-run] [--users <n>]
ts-node scripts/seedUbps.ts --testnet --deployer-info [--file <seed.json>]
```

Flags: `--testnet` (default) · `--mainnet` (**refused for seeding**; allowed only with
`--deployer-info`, which is read-only) · `--file <path>` (required to seed; optional with
`--deployer-info`) · `--dry-run` · `--deployer-info` · `--users <n>` (cap users for a
partial run) · `--yes` (reserved).

Addresses are printed in the user-friendly form **correct for the target chain**:
testnet → `kQ…`/`0Q…` (testOnly), mainnet → `EQ…`/`UQ…`. The raw address is identical
either way — only the display flag differs — so copied addresses match the chain's
wallets/explorers (and the testnet master matches `deployment_latest.json`).

## Pre-funding the deployer (`--deployer-info`)

Run this **before** the live seed to learn which address to top up and verify the TON
arrived — it only reads the chain, sends nothing:

```bash
pnpm seed:ubps:info --file <generated.json>
```

It prints the **deployer (active) wallet** address (bounceable + non-bounceable) and its
current balance; with `--file`, also the **required** TON (worst-case estimate) and a
`SEND at least N TON` shortfall line, plus the derived user wallets and their balances
(the deployer funds those during the run — you only need to fund the deployer). Without
`--file` it prints just the deployer address + balance. Needs `MNEMONIC`/`PRIVATE_KEY`
(deployer) and, to list user wallets, `TEST_USERS_SEED`.

## UBPS Canon (`--include`)

The **UBPS Canon** — the five locked canonical Question→Answer pairs plus the single
canonical BeliefSet `bs.canon` (`name: "UBPS Canon"`) — ships as a reusable seed
**fragment** [`canon.json`](./canon.json). A user's final Belief declares UBPS
membership by listing `"bs.canon"` in its `sets[]`. Pull the fragment into any seed
with `--include` (repeatable; merge is by id and **idempotent**, so ids already in the
seed are skipped):

```bash
pnpm seed:ubps:dry \
  --file scripts/seedUbps/canon25.testnet.json \
  --include scripts/seedUbps/canon.json
```

> **Default seed.** [`canon25.testnet.json`](./canon25.testnet.json) is the **default UBPS
> seed** that the unified runner loads: `pnpm seed:testnet` now seeds UBPS by default (no
> `--ubps-file` needed), auto-including `canon.json` so the set always reflects the latest
> canon. This adds UBPS cost (deploys + sends) to a plain `pnpm seed:testnet` run — pass
> `--no-ubps` (or `--only tokens,race`) to skip it, or `--ubps-file <path>` to seed a
> different file. In `canon25` **every** one of the 25 users resolves to a final Belief that
> contains `bs.canon` (all 16 roots list it; unit-subscribers inherit it; the 2 belief-less
> users point at the canon-only root `b.canon-only`).

The canon strings are **address-determining — do not edit them.** Full convention docs
(the `Y|N|0|other` answer alphabet, the "shift via `A("0")` then the real `A`" rule,
and the membership pattern) are in [`CANON.md`](./CANON.md).

## Environment

| Var | Purpose |
|-----|---------|
| `MNEMONIC` *or* `PRIVATE_KEY` | Deployer wallet — signs Question/Answer/BeliefSet activations and **funds** the per-user test wallets. |
| `TEST_USERS_SEED` | **Testnet-only** master seed for the deterministic test wallets (hex or string). NEVER printed. |
| `TON_RPC_ENDPOINT` | Optional RPC override (must carry its own auth). |

The N user wallets are derived deterministically:

```
keyPairFromSeed( sha256( TEST_USERS_SEED ‖ uint32BE(index) ) ) -> WalletContractV4
```

Same seed + index ⇒ same address every run, so the deployer funds exactly the
wallets the seeder will sign `SetPointer` as (UP is user-gated on-chain). Only the
derived **public addresses** ever leave the process.

## Preflight gas check

Before any send, the seeder estimates the TON the **deployer (active) wallet** must
hold — `OP_VALUE` per Question/Answer/BeliefSet op + `FUND_AMOUNT` per user wallet +
a per-message fee margin and a base buffer (worst case: assumes nothing is seeded
yet; a resume skips work and over-reserves). On a live run it reads the deployer
balance and **aborts before sending** if it is below the estimate, telling you to
top up or run a smaller batch with `--users <n>`. `--dry-run` prints the estimate
without checking the balance.

## Seeding order

`Questions → Answers → BeliefSets (leaf-first topo; Beliefs/roots end up last) →
Users (fund → deploy Unit → SetPointer signed by the user wallet)`.

BeliefSet **indices are assigned by the master at creation**, so the seeder must be
the **sole BeliefSet creator** during a run — a concurrent external creation would
shift indices. Indices are persisted in the manifest and reused on resume.

## Manifest

A run writes `deployment_info/ubps-seed.<network>.manifest.json` (gitignored)
mapping every label → `{ id/index, address, status }` + a summary
(`deployed / skipped / funded / errors`). `--dry-run` prints the same structure as
a preview without writing it.

## Provider resilience (long unattended runs)

`ton-provider-system` already does per-request timeouts (30s/fetch, 45s/contract read)
+ rate-limit backoff + provider failover. When an error **escapes all of that**, the
seeder catches it, **closes the provider, waits 1 minute, brings up a fresh provider +
client, and retries** the action (up to a per-action budget). This sits *on top of*
`ton-provider-system` — that package is not modified.

Because every retried action **re-reads on-chain state before sending**, a restart is
idempotent — it never double-funds, double-deploys, or double-creates a BeliefSet. So
leaving the seeder running for 100 users won't die ~⅓ of the way through on a transient
provider outage; it pauses a minute, reconnects, and continues. The run summary prints
`Provider restarts during run: N` when any occurred.

## Notes

- **Mainnet is refused** (`--mainnet` → error). Testnet only.
- The UBPS master must already be deployed (`games.ubps.ubps` in
  `deployment_info/deployment_latest.json`); otherwise the seeder stops and asks you
  to deploy UBPS first.
- Re-runnable: re-running after a partial/failed run resumes from on-chain state.
