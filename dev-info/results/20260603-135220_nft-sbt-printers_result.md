# Result — NFTPrinter + SBTPrinter (GM-owned, R*-governed; v1 = mint + revoke)

Executes plan `Files/results/20260603-121223_nft-sbt-printers_plan.md`.
Agent: `ton-blockchain-developer` (build + test only; no deploy/commit/push).
Date: 2026-06-03. Tolk 1.2.0. All builds ✅, all tests run one-file-at-a-time ✅.

## One-line summary
Added two GM-owned collection contracts — **NFTPrinter** (TEP-62 transferable) and
**SBTPrinter** (sbtn soulbound, revocable) — driven by new Retranslator recipes over
the unchanged R1→R2→R3→R4 pipe; mint (game-or-owner) + revoke (owner-only) verified
end-to-end and on the auth gates. GM stays free of every printer/R\*-private type.

## Files created
| file | what |
|------|------|
| `contracts/printers/nft_printer/errors.tolk` | NFT errors (copy of tep/nft) |
| `contracts/printers/nft_printer/storage.tolk` | collection storage + feature-space (`version`,`extra`); item layout = tep/nft |
| `contracts/printers/nft_printer/messages.tolk` | DeployNft + ChangeCollectionAdmin + royalty/static/transfer structs |
| `contracts/printers/nft_printer/nft-printer-collection.tolk` | NFTPrinter collection entrypoint |
| `contracts/printers/sbt_printer/errors.tolk` | SBTN errors (copy of tep/sbtn) |
| `contracts/printers/sbt_printer/storage.tolk` | collection storage + feature-space; item layout = tep/sbtn |
| `contracts/printers/sbt_printer/messages.tolk` | DeploySbtn + RevokeSbtnItem + ChangeCollectionAdmin + sbtn item structs |
| `contracts/printers/sbt_printer/sbt-printer-collection.tolk` | SBTPrinter collection entrypoint |
| `compilables/NFTPrinter.compile.ts` | compile target |
| `compilables/SBTPrinter.compile.ts` | compile target |
| `wrappers/printers/nft_printer/NFTPrinter.ts` | wrapper (config/getters/sendDeployNft/sendChangeAdmin) |
| `wrappers/printers/sbt_printer/SBTPrinter.ts` | wrapper (config/getters/sendDeploySbtn/sendRevokeToItem/sendChangeAdmin) |
| `tests/printers/printers-e2e.spec.ts` | 10-case e2e + auth spec |
| `dev-info/results/20260603-135220_nft-sbt-printers_seam-delta.md` | seam note for uap consumer |
| `dev-info/results/20260603-135220_nft-sbt-printers_result.md` | this report |

## Files modified
| file | change |
|------|--------|
| `contracts/game_manager/static.tolk` | + errors 933/934/935 (shared consts; no R\*-private types) |
| `contracts/game_manager/retranslator.tolk` | + MintNft/MintSbt/RevokeSbt requests, printer output bodies, `nextNftIndex`/`nextSbtIndex` storage, 3 R2 dispatch arms, `assertMintInitiatorAllowed` helper, 2 getters, per-mint TON consts |
| `wrappers/game_manager/RetranslatorTypes.ts` | + printer opcodes + MintNft/MintSbt/RevokeSbt encoders/types |
| `wrappers/game_manager/Retranslator.ts` | + `nextNftIndex`/`nextSbtIndex` in config encoder + 2 getters |
| `wrappers/game_manager/GameManager.ts` | + `sendMintNft`/`sendMintSbt`/`sendRevokeSbt` (R1-wrap helpers) |
| `lib/buildOutput.ts` | + optional `nftPrinter`/`sbtPrinter` fields (addresses + code hashes) |
| `lib/gameConstants.ts` | + printer opcodes (`nftPrinter`/`sbtPrinter`) + printer errors in the constants section |
| `scripts/deploySystem.ts` | **printers folded into the single core deploy** (compile, address calc, deploy, `SetToolsInfo` wiring, manifest write, verify, summary) |

`game_manager.tolk` was **not** touched — decoupling invariant holds (grep for
`Printer|MintNft|DeployNft|ToolsInfo|…` in it returns nothing).

## Architecture / decisions (O-C, O-D resolved & documented)
- **Reuse, not copy, of item code (O-D).** Tolk has no inheritance and import paths are
  directory-relative (no `../` precedent), so each printer is a self-contained *collection*
  contract that carries the feature-space and **reuses the proven item code** (NFTItem /
  the gate-fixed SBTNItem) supplied as a stored `*ItemCode` cell. Item storage/derivation
  is byte-identical to tep so the reused item code interoperates. **Deviation from the
  plan's "new item compile targets":** none added — items are the proven tep items; the
  distinct contract + feature-space live on the collection; a future content-edit path is
  an admin-gated message needing no item-storage change. The SBTPrinter inherits the
  collection-only `sbtn_init` gate + EXACT destroy-reserve for free (item hash `339e7222…`,
  confirms the 2026-06-03 fix).
- **Index tracking R\*-side (O-C).** New `RetranslatorStorage` fields `nextNftIndex:uint64`,
  `nextSbtIndex:uint256` (NOT in `toolsInfo`, which is owner-set config — counters are
  per-mint-mutated R\* state). **Global monotonic** indices; the global-unique SBT index
  guarantees per-owner uniqueness without a per-owner dict (simpler scheme than the plan's
  "per-owner dict", same guarantee — documented).
- **Recipe policy v1.** Mint = registered game (`checkGame` pattern, cheap active-game check
  first, full walk only with ≥0.2 TON) **OR** owner. Revoke = **owner-only**. Lives in
  `assertMintInitiatorAllowed` in R\*, marked as THE extension point for the future recipe
  registry. GM never sees it.
- **RevokeSbt carries `itemAddress`** (not `{owner,index}`): the collection's revoke takes an
  explicit item address and R\* lacks the sbtn item code to derive it, so the owner-supplied
  address is the natural, safe input (item still checks `sender == collection`). Documented
  deviation from the plan's `{itemOwner,index}`.
- **GM↔R\* wire protocol unchanged.** New opcodes ride inside opaque `R1.data`/`R3.data`.

## Flows (all on the existing pipe)
```
game/owner -R1{MintNft|MintSbt|RevokeSbt}-> GM -R2{initiator,data}-> R*
  R*: validate recipe + (mint) assign global index -> build DeployNft|DeploySbtn|RevokeSbtnItem
R* -R3{recipient:<printer>, data:<body>}-> GM -R4-> printer (sender==admin==GM) -> item
```

## Validation
- `npx blueprint build` ✅ — NFTPrinter, SBTPrinter, Retranslator, GameManager.
- `npx tsc --noEmit` ✅ (whole project).
- Tests — **one spec file per command, foreground, memory flags** (never the full suite):

`NODE_OPTIONS='--max-old-space-size=8192 --expose-gc' npx jest --runInBand <file>`

| spec file | result |
|-----------|--------|
| `tests/printers/printers-e2e.spec.ts` | **10/10 PASS** (70.6s) |
| `tests/game_manager/game-manager-burn.spec.ts` | 7/7 PASS (regression) |
| `tests/game_manager/game-manager-new-features.spec.ts` | 5/5 PASS (regression) |
| `tests/ton_race_game/request-ship-to-mint.spec.ts` | 3/3 PASS (regression — jetton mint via R\*) |

Printer spec covers: toolsInfo carries both printers; mint-NFT (owner) deploys+inits item
to receiver & advances `nextNftIndex`; mint-SBT (owner) deploys soulbound item; mint-NFT by
a registered active game; revoke-SBT (owner) sets `revokedAt`; and gates — non-allowed mint
initiator → 930, non-owner revoke → 920, R3-not-from-R\* → 932 (GM), direct DeployNft
not-from-GM → 401, direct DeploySbtn not-from-GM → 968. Regression specs confirm the new
`RetranslatorStorage` layout (the 2 appended counters) did not break the existing R\* paths.

## Deploy integration (added 2026-06-03, after the user's first core-only deploy)
The printers are now part of the **single** core deploy — `pnpm build --all && pnpm
deploy:testnet` deploys everything (GM, R\*, games, printers, jetton, …) and writes the full
manifest. `scripts/deploySystem.ts` now: compiles `NFTItem`/`NFTPrinter`/`SBTPrinter`; records
their code hashes in `contractCodes` (`nftPrinter`/`sbtPrinter`/`nftItem`); derives + deploys
both printer collections (admin = GM); relays `SetToolsInfo` (printer addresses) to R\* via GM;
verifies it on-chain; and writes addresses to `deployment_latest.json`. The constants section
(`lib/gameConstants.ts`) now emits printer opcodes + errors. The standalone `deployPrinters.ts`
was removed (superseded — it didn't write the manifest). Offline-verified: `buildGameConstants()`
emits `opcodes.nftPrinter/sbtPrinter`, the R1 recipe opcodes, and printer/GM errors. The deploy
itself is the user's to run (agent does not deploy).

## ⚠ Deployment-interface / seam delta — FLAGGED LOUDLY
After the next `pnpm deploy:testnet`, `deployment_info/deployment_latest.json` gains the two
printer addresses + code hashes + the new opcodes, and the `sbtnItem`/`sbtnCollection` BOCs
refresh (the 2026-06-03 sbtn fix, item repr-hash `339e7222…`). The `ultimate_amusement_park`
consumer reads this json at boot — see the **seam-delta note**
(`…_nft-sbt-printers_seam-delta.md`). Do NOT edit uap from here. (The user's earlier deploy was
the core-only build BEFORE this integration, so its manifest has no printers yet — re-deploy.)

## NOT done here (out of safe scope / deferred)
- **No deploy / no commit / no push** — deploy logic is written + typechecked, not run.
- **Deferred features (per plan):** content-edit (NFT) / `individualContent`-edit (SBT) — kept
  set-once; the full recipe-registry spec; an SBTN edit schema. Feature-space (`version`,`extra`)
  on both collection storages reserves room to add these later without a GM redeploy.

## Git
Working tree left dirty (printer files + retranslator/wrapper edits + this dev-info). No
commit/push — the Git Agent owns ton_game git.
