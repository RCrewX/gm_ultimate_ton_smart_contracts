# Retranslator (R*) hot-swap — operator runbook

**What this is.** A repeatable procedure to swap the **Retranslator (R\*)** — the swappable
game-logic "brain" — **without redeploying GameManager (GM)**. GM is the stable on-chain authority
(owner/admin of the minter + all SCs) and stores only the R\* address; R\* holds the registries and
mint logic. A swap deploys R\* v(N+1) with **migrated state**, seeds its registries via GM, repoints GM
atomically, and leaves the old R\* inert.

**Tooling:** `scripts/swapRetranslator.ts` (dry-run by default; `--execute` performs the swap).
**Proven by:** `tests/game_manager/retranslator-swap.spec.ts` (sandbox).

---

## ⚠️ Read first — three hard facts

1. **Migrate the mint counters or you corrupt the printers.** R\* holds `nextNftIndex` / `nextSbtIndex`,
   global monotonic indices incremented on every NFT/SBT mint. The new R\* MUST start from the old R\*'s
   **live** values. If it starts at 0, the next mint re-targets an already-used item address (the printer
   accepts `itemIndex <= nextItemIndex`, so it silently re-deploys onto an existing item rather than
   erroring) and the R\*↔printer counters desync. `swapRetranslator.ts` reads and migrates them for you —
   never hand-set them to 0. (Sandbox test "swap WITHOUT migrating the counter" demonstrates the corruption.)

2. **Do NOT run `pnpm abi` after a swap.** `pnpm abi` (= `deploy --offline`, via
   `scripts/lib/abiCore.ts`) recomputes every address from the *default* R\* config (version 1), so it
   would overwrite the swapped R\* address in `deployment_latest.json` with the stale version-1 address.
   The swap script already writes the correct new R\* address via the canonical writer. `pnpm abi` is only
   for ABI/contract-code changes, which a swap is not. (If you must run it for an unrelated ABI change,
   re-apply the R\* address afterwards.)

3. **`active` cannot be toggled on-chain.** There is no `SetActive` message (it is set only at deploy).
   "Disabling" the old R\* = GM simply stops routing to it after the repoint. Do not expect to freeze it.

---

## Procedure (mainnet)

### Phase 0 — Pre-flight (no sends)
```
# from the ton_game repo, with deployment_info/deployment_latest.json present for the network
npx ts-node scripts/swapRetranslator.ts --mainnet          # DRY-RUN: reads live R*, prints the plan
```
Confirm the printed plan:
- `version: N -> N+1`, `nextNftIndex`/`nextSbtIndex` copied verbatim, registries = copy,
- the computed **new R\* address** differs from the old one,
- GM currently points at the old R\* (the script aborts if it doesn't).

Also confirm operator wallet balance ≥ ~2 TON and that `PRIVATE_KEY` (or `MNEMONIC`) is set in env.

### Phase 1 — Quiesce + drain (mainnet only; avoids losing in-flight ops)
After the repoint, GM's `R3` handler asserts `sender == retranslatorAddress` (the NEW R\*). A late `R3`
from the OLD R\* — its reply to an `R2` GM sent just before the swap — is **rejected by GM with err 932**
and that operation is **lost**. So:
1. **Pause inbound traffic** that triggers mints/burns: stop the backend/relayer/cron that sends R1s
   (mints, SBT issue/revoke, jetton burns) into GM. Put the game UI mint paths into maintenance.
2. **Drain in-flight:** wait for the longest GM→R\*→GM round-trip to settle (a couple of minutes is ample
   on mainnet). Verify no pending mints by watching GM/old-R\* on the explorer go quiet.
3. Only then proceed to Phase 2. (On testnet you may skip the formal quiesce; the hazard is the same but low-stakes.)

### Phase 2 — Execute the swap
```
npx ts-node scripts/swapRetranslator.ts --mainnet --execute
```
The script, in order:
1. deploys the new R\* (state-init carries version N+1 + migrated counters),
2. seeds the registries on the new R\* by copying the opaque cells via `GM.RedirectMessage`
   (`SetJettonInfo` / `SetGamesInfo` / `SetToolsInfo` / `SetAllowBurn`),
3. repoints GM with `SetRetranslator(newR*)` (one owner tx, atomic),
4. **verifies** `GM -> newR*`, `version == N+1`, and counters == migrated values (aborts if not),
5. updates `deployment_info/deployment_latest.json` with the new R\* address (GM unchanged).

To override the version explicitly: `--version <N+1>`.

### Phase 3 — Post-swap verification (independent of the script)
- GM getter: `get_retranslator_address` == new R\* address.
- New R\* getters: `get_version` == N+1; `get_next_nft_index` / `get_next_sbt_index` == the old live values;
  `get_jetton_info` / `get_games_info` / `get_tools_info` / `get_allow_burn` match the old R\*.
- Smoke: run ONE real mint (NFT and/or SBT) and confirm the item deploys at the migrated index and the
  new R\* counter advances by 1 (no collision).
- Confirm the old R\* receives **no** traffic on subsequent ops.

### Phase 4 — Resume + downstream
- Un-pause inbound traffic (backend/relayer/UI).
- The **uap consumer** reads `deployment.json` (R\* address) at boot — refreshing it (copy + uap smoke) is a
  **separate task** (`uat-fullstack-developer`), not part of this runbook. Do that before users hit the new R\*.

---

## Rollback

The old R\* stays live; `SetRetranslator(oldR*)` repoints back instantly:
```
npx ts-node scripts/swapRetranslator.ts --mainnet      # dry-run to confirm state, then…
# repoint back is a single GM tx; do it via deploySystem/console or a one-off SetRetranslator send.
```
**Clean rollback only while NO state-advancing op (mint) has run on the new R\*.** Once the new R\*'s
counters have advanced past the old R\*'s, you must re-migrate (read new counters → redeploy old-logic R\*
with those counters) before rolling back, or you reintroduce the index-collision hazard. Keep the old R\*
address parked until the new one is proven in production.

---

## Quick reference — what a swap touches vs. leaves alone

| Touched | Left untouched (the point of the decoupling) |
|---|---|
| New R\* contract (deployed) | GameManager (no redeploy, no code change) |
| GM `retranslatorAddress` (one `SetRetranslator`) | Games (ton_race_game, SSM), printers, jetton minter |
| `deployment_latest.json` R\* address field | All opcodes / gas / bit-widths / enums / other addresses |
| (old R\* becomes inert — no message sent to it) | Mint-index continuity (preserved via migration) |
