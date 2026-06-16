# Result — NFTPrinter + SBTPrinter: structured content + ANVIL editing

Agent: `ton-blockchain-developer` (build + test only; no deploy/commit/push).
Date: 2026-06-03. Tolk 1.2.0. All builds ✅. tsc ✅. Tests run one-file-at-a-time ✅.
Continues `20260603-135220_nft-sbt-printers_result.md` (which deferred exactly this).

## One-line summary
Gave printer items **structured on-chain content** (NFT `{origin,type,tier}`, SBT
`{tatoo}`) and added an **owner/GM content-edit path** routed through a new visually
isolated **⚒ ANVIL** section of R\* (opaque `<Cell>` updates GM forwards without
parsing); also tightened **SBT creation to owner/GM-only** (games create NFTs only).
Done with **printer-specific editable item variants** so `tep/nft` + `tep/sbtn` stay pristine.

## Design decisions (confirmed with the user)
- **Editable item handler lives in NEW printer-specific item variants** (`NFTPrinterItem`,
  `SBTPrinterItem`) = the standard item + a collection-gated `SetContent` handler, with a
  WIRE-identical storage layout (so collection address derivation is unchanged). `tep/nft`
  and `tep/sbtn` are untouched (TEP compliance specs unaffected).
- **SBT create = owner/GM only.** `MintSbt` in R\* now asserts `initiator == owner`
  (was game-or-owner). NFT create stays game-or-owner. All EDITS are owner/GM-only.
- **NFT content typed `Cell<NFTContent>`** on the item; **SBT content stays an opaque
  `cell`** per the standard SBTN model (the `SBTContent` schema is enforced by the wrapper
  + parsed by a get-method). `type` is stored as Tolk field `itemType` (`type` is a Tolk
  keyword); the wire is just address+uint64+uint64 and the TS wrapper exposes it as `type`.

## Flows (all on the existing GM↔R\* pipe; GM unchanged)
```
mint:  game/owner -R1{MintNft|MintSbt}-> GM -R2-> R* (validate+index) -R3-> GM -R4-> printer -> item
edit:  owner/GM   -R1{EditNft|EditSbt}-> GM -R2-> R* ⚒ANVIL (owner-only; cell opaque)
                  -R3-> GM -R4-> printer.EditItem -> item.SetContent (sender==collection)
```

## Files created
| file | what |
|------|------|
| `contracts/printers/nft_printer/nft-printer-item.tolk` | NFTPrinter item = NFTItem + collection-gated `SetNftContent`; `Cell<NFTContent>` |
| `contracts/printers/nft_printer/fees-management.tolk` | `MIN_TONS_FOR_STORAGE` for the item |
| `contracts/printers/sbt_printer/sbt-printer-item.tolk` | SBTPrinter item = gate-fixed SBTNItem + collection-gated `SetSbtContent` |
| `contracts/printers/sbt_printer/fees-management.tolk` | `MIN_TONS_FOR_STORAGE` + `SEND_MODE_CARRY_ALL_REMAINING_BALANCE` + `addr_none` |
| `compilables/NFTPrinterItem.compile.ts` | compile target |
| `compilables/SBTPrinterItem.compile.ts` | compile target |
| `dev-info/results/20260603-160000_nft-sbt-printers-content-edit_result.md` | this report |

## Files modified
| file | change |
|------|--------|
| `contracts/printers/nft_printer/storage.tolk` | + `NFTContent{origin,itemType,tier}`; `content: Cell<NFTContent>`; item-storage loader helpers |
| `contracts/printers/nft_printer/messages.tolk` | init content → `Cell<NFTContent>`; + `SetNftContent`(0x05) + `EditNftItem`(0x06) |
| `contracts/printers/nft_printer/nft-printer-collection.tolk` | + `EditNftItem` admin arm (forwards `SetNftContent`); `get_nft_content` param typed |
| `contracts/printers/sbt_printer/storage.tolk` | + `SBTContent{tatoo}` + SnakeString helpers (content stays opaque `cell`) |
| `contracts/printers/sbt_printer/messages.tolk` | + `SetSbtContent`(0x6f89f5e4) + `EditSbtItem`(0x07) |
| `contracts/printers/sbt_printer/sbt-printer-collection.tolk` | + `EditSbtItem` admin arm (forwards `SetSbtContent`) |
| `contracts/game_manager/retranslator.tolk` | + **⚒ ANVIL** section: `EditNft`/`EditSbt` requests + `PrinterEditNftItem`/`PrinterEditSbtItem` bodies + 2 owner-only dispatch arms; **`MintSbt` tightened to owner-only** |
| `wrappers/game_manager/RetranslatorTypes.ts` | + edit opcodes; `EditNft`/`EditSbt` encoders; `NFTContent`/`SBTContent` types + `encode/decode` + `snakeString` |
| `wrappers/game_manager/GameManager.ts` | + `sendEditNft`/`sendEditSbt` (R1-wrap) |
| `wrappers/printers/nft_printer/NFTPrinter.ts` | + `SetNftContent`/`EditNftItem` opcodes + `sendEditNftItem` |
| `wrappers/printers/sbt_printer/SBTPrinter.ts` | + `SetSbtContent`/`EditSbtItem` opcodes + `sendEditSbtItem` |
| `lib/buildOutput.ts` | + optional `nftPrinterItem`/`sbtPrinterItem` code-hash fields |
| `scripts/deploySystem.ts` | printers now compile + deploy `NFTPrinterItem`/`SBTPrinterItem` as their item code (was `NFTItem`/`SBTNItem`); records both hashes |

`game_manager.tolk` was **not** touched — decoupling invariant holds (grep for
`Printer|MintNft|EditNft|DeployNft|ToolsInfo|NFTContent|…` in it returns nothing; the
4 `static.tolk` hits are pre-existing shared gas/error consts, not R\*-private types).

## Validation
- `npx blueprint build` ✅ — NFTPrinterItem, NFTPrinter, SBTPrinterItem, SBTPrinter,
  Retranslator, GameManager (each built individually).
- `npx tsc --noEmit` ✅ (whole project, incl. tests).
- Tests — one spec per command, foreground, memory flags
  (`NODE_OPTIONS='--max-old-space-size=8192 --expose-gc' npx jest --runInBand <file>`):

| spec file | result |
|-----------|--------|
| `tests/printers/printers-e2e.spec.ts` | **15/15 PASS** (111.8s) |
| `tests/ton_race_game/request-ship-to-mint.spec.ts` | 3/3 PASS (regression — jetton mint via R\*) |
| `tests/game_manager/game-manager-new-features.spec.ts` | 5/5 PASS (regression — R\* wiring/storage) |

New/updated coverage: NFT/SBT structured content round-trips through the item; mint-SBT
by a registered game now **rejected (920)**; ANVIL NFT edit + SBT edit end-to-end
(`EditNftItem`→`SetNftContent`, `EditSbtItem`→`SetSbtContent`, content updated); edit by
non-owner rejected (920); direct `EditNftItem` not-from-GM rejected (401).

## ⚠ Deployment-interface / seam delta — FLAGGED LOUDLY
`deployment_info/deployment_latest.json` is the published interface the
`ultimate_amusement_park` consumer reads at boot. After the next `pnpm deploy:testnet`:
- **Printer ITEM code hashes CHANGE** — printers no longer deploy `NFTItem`/`SBTNItem`;
  they deploy `NFTPrinterItem` (hash `336255b6…`) / `SBTPrinterItem` (hash `74b5586f…`).
  Because the printer COLLECTION config embeds the item code, the **printer collection
  addresses also change**. Consumers must re-derive cached NFT/SBT item addresses.
- **New opcodes:** R1 recipes `EditNft 0x456e6674`, `EditSbt 0x45736274`; printer
  `EditNftItem 0x06` / `SetNftContent 0x05`, `EditSbtItem 0x07` / `SetSbtContent 0x6f89f5e4`.
- **Content schema is now structured:** NFT individual content = `NFTContent{origin:address,
  type:uint64, tier:uint64}`; SBT individual content = `SBTContent{tatoo:SnakeString-ref}`.
- **Policy change:** SBT minting is owner/GM-only (games can mint NFTs only).
Do NOT hand-edit the json or touch uap from here — regenerate via the repo's deploy tooling.

## NOT done (out of safe scope)
- **No deploy / no commit / no push.** Deploy logic is written + typechecked, not run.
- Finer-grained "allowed editings" (field-level rules) are intentionally deferred — the
  ⚒ ANVIL section is the single documented home for them; adding them won't touch GM.
