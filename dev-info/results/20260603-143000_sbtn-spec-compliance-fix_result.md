# SBTN spec-compliance & security fix — result

**Date:** 2026-06-03 · **Agent:** ton-blockchain-developer
**Plan:** `Files/results/20260603-123123_sbtn-spec-compliance-fix_plan.md` (§A–§E, code work)
**Repo:** `ton_game` · **Build + test only — no deploy, no commit/push.**

## Summary
Both SBTN_02 defects fixed in the in-repo standard `contracts/tep/sbtn`, tests extended (all green,
run one-file-at-a-time per test discipline), and the compliance report regenerated to match real behavior.

## Fixes applied
- **Fix #1 (security) — collection-only `sbtn_init`.** Added as the first line of the `SbtnInit` branch:
  `assert (in.senderAddress == storage.collectionAddress) throw ERROR_NOT_FROM_COLLECTION;`
  Reuses already-defined error **960** (previously unused). Closes the front-running/content-spoof hole
  (any sender could previously flip `active=true` with attacker-chosen content).
- **Fix #2 — `destroy` retains the storage reserve.** Replaced the buggy
  `restAmount = getOriginalBalance() − MIN_TONS_FOR_STORAGE` + **mode-128 carry-all** (which ignores `value`
  and drained the whole balance) with the canonical reserve-then-carry-all idiom:
  `reserveToncoinsOnBalance(MIN_TONS_FOR_STORAGE, RESERVE_MODE_EXACT_AMOUNT)` then `Excesses` sent
  `value: 0` with mode 128. Both helpers are stdlib `common.tolk` (auto-imported; same usage as the game
  contracts) — **no constant added to `fees-management.tolk`** was needed (`RESERVE_MODE_EXACT_AMOUNT = 0`).

## Files changed
1. `contracts/tep/sbtn/sbtn-item-contract.tolk` — Fix #1 (SbtnInit branch) + Fix #2 (Destroy branch).
2. `tests/TEPS/SBTN-specific.spec.ts` — renamed `sbtn_init once` → `sbtn_init access control`; rewrote the
   "already initialized" test to drive a second `DeploySbtn` (genuine collection sender → 961, since the
   prior owner→item direct send would now hit 960 first); added a **960 regression** (non-collection sender
   on an inert item → rejected, item stays `active=false`); added a **destroy-reserve** test (post-destroy
   balance ≥ 0.05 TON + owner receives `Excesses`). Added `buildSbtnInitBody` import.
3. `tests/TEPS/SBTN-SBT-compliance-report.md` — regenerated: corrected the false "owner→addr_none" /
   "authority null" / "init true after destroy" claims to the real behavior (destroy sets `active=false`
   only; `request_owner` after destroy → 969; reserve retained); fixed the stale `tests/base/...` path;
   documented the new collection-only `sbtn_init` rule.

Files **not** touched (already conformant, per plan): `storage.tolk`, `messages.tolk`, `errors.tolk`,
`fees-management.tolk`, `sbtn-collection-contract.tolk`, `wrappers/`.

## Commands run
- `npx blueprint build SBTNItem` → ✅ compiled clean (new code hash `339e7222…`).
- `npx blueprint build SBTNCollection` → ✅ compiled clean.
- `NODE_OPTIONS='--max-old-space-size=8192 --expose-gc' npx jest --runInBand tests/TEPS/SBTN-specific.spec.ts`
  → ✅ **8 passed**.
- `… npx jest --runInBand tests/TEPS/SBTN-SBT-compat.spec.ts` → ✅ **13 passed** (unchanged paths regression-clean).
- (Whole suite never run — test discipline observed. SBTN is referenced by no other spec file.)

## ⚠️ INTERFACE / `deployment_latest.json` — FLAG (plan assumption was incorrect)
The plan said "deployment_latest.json is unaffected." That is **partly wrong**: the json's `code` section
**embeds the compiled BOC + hash** of `sbtnItem` (and `sbtnCollection`). Fix #1/#2 change the **item code**,
so `sbtnItem`'s hash changed (`6519e72d…` → `339e7222…`). Because an SBTN item's address is derived from
its StateInit (code + data), **the deterministic item-address derivation changes** with the new code.

Mitigating facts (verified, not assumptions):
- **Opcodes, message layouts, error VALUES, getters, and bit-widths are UNCHANGED** by these edits (error
  960 was already defined; no struct/opcode/getter/storage-layout change).
- **SBTN is undeployed** — `grep sbtn deployment_latest.json` matches only the `code` section; there are NO
  testnet/mainnet deployed SBTN addresses. So no live item or consumer breaks.
- The json's `sbtnCollection` hash (`036290f9…`) **already** differed from a clean rebuild (`498d26a0…`)
  *before* my work (I never edited the collection) — i.e. the json's SBTN code section was already stale.

Action needed (NOT done here — out of scope, and the plan says don't hand-edit this json): the
`sbtnItem`/`sbtnCollection` code BOCs in `deployment_latest.json` should be **regenerated via the repo's
deploy tooling** at the next deploy. The `ultimate_amusement_park` consumer is safe (no opcode/error/layout
change), but anyone deriving SBTN item addresses from the old item code would compute stale addresses.

## Out of scope (recorded, not done)
- §F SBTN_02 spec edits → Vaults repo (user / Vaults-scoped agent), not this agent.
- §G `tep/sbt/sbt-item-contract.tolk:120,127` has the **identical** destroy-reserve bug — case-by-case, not
  this task; apply the same Fix #2 when addressed.
- §H open question (destroy↔re-init terminality) — left as-is per the plan's default; flagged for the user.

Committing/pushing left to the Git Agent.
