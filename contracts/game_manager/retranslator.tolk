// SPDX-License-Identifier: UNLICENSED
import "static"

/*
Retranslator (R*) = swappable BRAIN.

Rationale: for further updates in game logic and new system logics (NFT/SBT
printers, new uses of jettons, etc.) we want a contract that can be replaced
WITHOUT recompiling/redeploying the GameManager (GM). GM is a stable pipe and the
sole on-chain authority; R* holds the registries, validates, computes recipients,
and tells GM what to emit.

Wire protocol (defined in static.tolk):
    R1 - anyone -> GM
    R2 - GM -> R*   (GM attests the initiator; R2.data is opaque to GM)
    R3 - R* -> GM   (GM forwards R3.data to R3.recipient)
    R4 - GM -> recipient (just a send, no struct)

Classic flow:
    anyone -[R1]-> GM -[R2]-> R*  (verify + logic) -[R3]-> GM -[R4]-> recipient

The R2 arm parses the inner request and dispatches the implemented branches
(ForwardMintRequest mint, jetton-usage TransferNotification, owner RequestBurn).
R* never sends directly to a minter/wallet; it only returns R3 and GM sends outbound.
*/

const VERSION: uint64 = 1;

// TON forwarded to a printer ITEM at deploy/revoke. The collection keeps the rest
// of the carry-all balance; callers must attach enough to R1 (>= ~0.3 TON).
const PRINTER_ITEM_DEPLOY_AMOUNT: coins = ton("0.05"); // item storage + init gas
const PRINTER_REVOKE_FORWARD_AMOUNT: coins = ton("0.02"); // collection->item Revoke

// =============================================================================
//  ⚒  ANVIL RECIPE ENGINE — constants
//
//  The recipe rules are HARDCODED here (locked decision: no config registry).
//  Recipe codes flow in from the NFT printer (which has verified the input item
//  addresses); R* validates against the items' REPORTED on-chain attributes and
//  computes the new content (or the melt/mint amount).
// =============================================================================
const RECIPE_COMBINE: uint8 = 1;     // I(X|K|R)+I(X|K|R) -> I(X|K+1|R)   (two items)
const RECIPE_MULTISPLAV: uint8 = 2;  // I(5|K|N)+I(5|0|R) -> I(5|K+1|N)   (two items)
const RECIPE_ZERO_TYPE: uint8 = 3;   // I(X|K|R) -> I(0|K|R)              (one item)
const RECIPE_ZERO_TIER: uint8 = 4;   // I(X|K|R) -> I(X|0|R)              (one item)
const RECIPE_MELT: uint8 = 5;        // burn item -> mint RUDA            (one item)

// Outcome kinds returned by computeAnvil / the recipe getter.
const ANVIL_OUT_UPDATE: uint8 = 1;          // overwrite item1 content (single transform)
const ANVIL_OUT_UPDATE_DESTROY: uint8 = 2;  // overwrite item1 content + destroy item2 (combine)
const ANVIL_OUT_MELT: uint8 = 3;            // destroy item1 + mint rudaAmount RUDA to owner

// =============================================================================
//  ANVIL TYPE SPACE (the reference leaves `type` implicit — pinned here).
//  `type` is an opaque uint64. ONLY two values carry special rules:
//    TYPE_GENERIC   = 0 : generic item; combine tier-caps at TIER_CAP_TYPE0 (10).
//    TYPE_MULTISPLAV= 5 : multisplav — native-origin, provenance-filtered (`seen`
//                         Bloom), tier-up ONLY via the multisplav recipe, capped at
//                         the tighter MULTISPLAV_TIER_CAP.
//  EVERY other value is generic-with-no-special-rule (e.g. type 1 from the slot
//  reward rule): combine tier-caps at the high SAFETY_TIER_CAP. Do NOT invent
//  further semantics — the reference states none.
// =============================================================================
const TYPE_GENERIC: uint64 = 0;             // generic item (tier-cap 10 on combine)
const TYPE_MULTISPLAV: uint64 = 5;          // type 5 == multisplav alloy
const TIER_CAP_TYPE0: uint64 = 10;          // type-0 (generic) items cap at tier 10
// High safety ceiling for ALL non-generic types (type 1, 5, …) so combine can't grow
// tier unboundedly (storage/gas sanity). type-5 has its OWN tighter cap below
// (MULTISPLAV_TIER_CAP <= SAFETY_TIER_CAP), so this never contradicts the multisplav bound.
const SAFETY_TIER_CAP: uint64 = 1000;
const MELT_MAX_TIER: uint64 = 30;           // 10^K guard (10^30 < coins max) for native melt

// ⚒ Multisplav provenance Bloom filter (locked decision — see note_encrypt_multisplav.txt).
// The native item I(5|K|N) accumulates the SET of foreign origins already alloyed into
// it; a repeat of the same origin is rejected. Storage = ONE cell of 2 x uint256 (so the
// whole filter fits in a single <=1023-bit cell; raising BITS to 1024 would need a 2nd
// word/cell — keep it a single tunable). Append-only (set bits, never clear). The
// false-positive-only property is the intended trade: a real duplicate is ALWAYS caught
// (no false-negative); a brand-new origin may RARELY be mis-flagged as seen.
const MULTISPLAV_FILTER_BITS: int = 512;    // total filter width (tunable; <=512 = one cell)
const MULTISPLAV_FILTER_HALF: int = 256;    // word boundary: word A = bits [0,256), B = [256,512)
const MULTISPLAV_FILTER_K: int = 3;         // hash positions per origin
// ⚒ FLAGGED — coordinate with the sibling caps plan. Bounds the type-5 tier (== number of
// distinct foreign origins alloyed) so the 512-bit/k=3 filter stays in its low-FP zone
// (~3% at 64 origins). No sibling cap exists in-tree yet; this is the proposed value.
const MULTISPLAV_TIER_CAP: uint64 = 64;

// Melt economics. RUDA is 0-decimal / raw 1:1 — one whole RUDA == one raw unit.
// Native melt mints (10^K - 1) raw RUDA; the non-native type0/tier10 escape mints
// 100 RUDA (raw). Source is fresh mint via the GM mint path (NFT is burned),
// matching the SSM model.
const MELT_HUNDRED_RUDA: coins = 100 as coins;

// 1000 RUDA -> I(5|0|N): the user transfers RUDA to GM with a TAGGED forwardPayload
// (>=32 data bits). The normal game-usage payload carries 0 data bits, so the tag
// is unambiguous. The house keeps the 1000 RUDA (it lands in GM's wallet); a fresh
// type-5 tier-0 native item is minted to the depositor (burn-and-mint, SSM model).
const ANVIL_MULTISPLAV_MINT_TAG: uint32 = 0x4d756c74; // "Mult"
const MULTISPLAV_MINT_STAKE: coins = 1000 as coins;   // 1000 RUDA (raw; RUDA is 0-decimal)

// TON budgets for the ANVIL return chain (printer item ops + the melt mint).
const ANVIL_ITEM_OP_TON: coins = ton("0.05");   // collection -> item update/destroy hop
const ANVIL_DESTROY_TON: coins = ton("0.05");   // item1 -> item2 destroy hop

// ANVIL error codes — R*'s own ANVIL range (970..989), distinct from R* (901..935),
// SSM (940..959), SBT (950..959 are NOT used by R*), printers (399..405, 96x).
const ERR_ANVIL_UNKNOWN_RECIPE = 970;
const ERR_ANVIL_TYPE_MISMATCH = 971;          // combine inputs differ in type
const ERR_ANVIL_TIER_MISMATCH = 972;          // combine inputs differ in tier
const ERR_ANVIL_ORIGIN_MISMATCH = 973;        // combine inputs differ in origin
const ERR_ANVIL_TIER_CAP = 974;               // type-0 combine would exceed tier 10
const ERR_ANVIL_NOT_TYPE5 = 975;              // multisplav input is not type 5
const ERR_ANVIL_MULTISPLAV_PRIMARY_NOT_NATIVE = 976; // I(5|K|N) primary must be native
const ERR_ANVIL_MULTISPLAV_SACRIFICE_NOT_TIER0 = 977; // sacrifice must be I(5|0|R)
const ERR_ANVIL_SAME_ORIGIN_MULTISPLAV = 978; // sacrifice shares the native origin
const ERR_ANVIL_MELT_NON_NATIVE = 979;        // non-native melt allowed only for I(0|10|R)
const ERR_ANVIL_TIER_TOO_HIGH = 980;          // native melt 10^K guard
const ERR_ANVIL_NOT_PRINTER = 981;            // ANVIL request initiator is not the NFT printer
const ERR_ANVIL_BAD_MULTISPLAV_MINT_AMOUNT = 982; // 1000-RUDA mint: wrong stake
const ERR_ANVIL_MULTISPLAV_TIER_CAP = 983;    // type-5 alloy would exceed MULTISPLAV_TIER_CAP
const ERR_ANVIL_MULTISPLAV_ORIGIN_ALREADY_SEEN = 984; // sacrifice origin already in the native's filter
const ERR_ANVIL_SAFETY_TIER_CAP = 985;        // non-generic combine would exceed SAFETY_TIER_CAP
const ERR_ANVIL_RECIPE_ARITY = 986;           // recipe sent on the wrong arity arm (2-item vs 1-item)

// =============================================================================
//  R*-private registries & types (GM never imports these — decoupling invariant)
// =============================================================================

struct JettonInfo {
    jettonMinterAddress: address // jetton minter address
    jettonWalletCode: cell       // jetton wallet code for address calculation
}

// Non-reward / overflow slots live behind a ref so the root cell stays under the
// 1023-bit limit (four full addresses = 1068 bits would overflow). Reward
// authorization reads ONLY the root cell, so this ref is never loaded on the hot
// path. Future registration-only slots are added here without growing the root.
struct GamesInfoExtra {
    ubps: address?;   // registration-only; NEVER reward-authorized
}

struct GamesInfo {
    // Named-slot games registry (replaced the anonymous mode-tagged `all_games`
    // list). Reward authorization is O(1): an initiator is allowed iff it equals
    // one of the REWARD-game slots (ssm / ton_race_game). `ubps` (in `extra`) is
    // stored for discovery only and is NEVER reward-authorized.
    active_game: address;          // active REWARD game; MUST equal ssm OR ton_race_game
    ssm: address?;                 // reward-game slot (nullable for forward-safety)
    ton_race_game: address?;       // reward-game slot
    extra: Cell<GamesInfoExtra>;   // ubps (registration-only) + future non-reward slots
}

// ToolsInfo v1 — `extra` gives forward-extensibility (add fields inside `extra`
// without changing this struct's head, so on-chain layout stays stable).
struct ToolsInfo {
    feeNumerator: uint16        // protocol fee numerator (0 = off)
    feeDenominator: uint16      // denominator (>= 1)
    feeCollector: address?      // null BY DEFAULT (no fee routing)
    nftPrinterAddress: address? // future NFT printer
    sbtPrinterAddress: address? // future SBT printer
    extra: cell?                // open-ended; add fields here without changing the head
}

// =============================================================================
//  R*-private output bodies (R* builds them, packs into R3.data; GM emits as R4)
// =============================================================================

struct (0xd7610922) JettonUsed {
    jettonAmount: coins
    data: cell
}

struct (0x178d4519) InternalTransferStep {
    queryId: uint64
    jettonAmount: coins
    transferInitiator: address? // is null when minting
    sendExcessesTo: address?
    forwardTonAmount: coins
    forwardPayload: ForwardPayloadRemainder
}

struct (0x00000015) MintNewJettons {
    queryId: uint64
    mintRecipient: address
    tonAmount: coins
    internalTransferMsg: Cell<InternalTransferStep>
}

struct (0x595f07bc) AskToBurn {
    queryId: uint64
    jettonAmount: coins
    sendExcessesTo: address?
    customPayload: cell?
}

// ---- Printer output bodies (built here, packed into R3.data, emitted by GM) ----
// These MUST stay byte-compatible with the printer collection message structs:
//   PrinterDeployNft        <-> contracts/printers/nft_printer/messages.tolk DeployNft
//   PrinterNftItemInit      <-> nft_printer NftItemInitAtDeployment (opcode-less payload)
//   PrinterDeploySbtn       <-> contracts/printers/sbt_printer/messages.tolk DeploySbtn
//   PrinterRevokeSbtnItem   <-> sbt_printer RevokeSbtnItem
// DeployNft and DeploySbtn share opcode 0x00000001 but target DIFFERENT printers,
// so there is no ambiguity (these are build-only; never parsed in a union).

struct PrinterNftItemInit {
    ownerAddress: address
    content: cell        // Cell<SnakeString> on the item side; opaque to R*
}

struct (0x00000001) PrinterDeployNft {
    queryId: uint64
    itemIndex: uint64
    attachTonAmount: coins
    initParams: Cell<PrinterNftItemInit>
}

struct (0x00000001) PrinterDeploySbtn {
    queryId: uint64
    ownerAddress: address
    index: uint256
    attachTonAmount: coins
    individualContent: cell
}

struct (0x00000004) PrinterRevokeSbtnItem {
    queryId: uint64
    itemAddress: address
}

// =============================================================================
//  R*-private inbound request bodies (wrapped inside R2.data)
// =============================================================================

struct (0xf62ed009) ForwardMintRequest {
    receiver: address
    amount: coins
}

struct (0x8b9c0d1e) RequestBurn {
    queryId: uint64
    jettonAmount: coins
    sendExcessesTo: address?
    customPayload: cell?
}

// ⚒ SSM native-stake burn (game-gated). The SoullessSlotMachine burns the RUDA a
// player staked on a native roll (burn-and-mint economics). Authorized like a MINT
// — initiator must be a REGISTERED GAME (or owner) — because registered games
// already control the RUDA supply (ForwardMintRequest mints to arbitrary
// receivers), so letting them burn is no trust escalation. INTRINSIC to the roll,
// so it is NOT gated by allow_burn (which only governs owner-initiated RequestBurn).
// R* emits AskToBurn to GM's own RUDA wallet (sender == GM == owner).
struct (0x5362726e) SsmBurnStake {   // "Sbrn"
    queryId: uint64
    amount: coins
}

// ---- Printer recipe requests (wrapped inside R1.data -> R2.data) ----
// Opcodes verified unique vs the existing set. GM never parses these.
//   MintNft  : mint one transferable NFT to `receiver` (initiator = game OR owner)
//   MintSbt  : mint one soulbound SBT to `receiver`     (initiator = game OR owner)
//   RevokeSbt: revoke an SBT item by address            (initiator = OWNER ONLY)
struct (0x4d6e6674) MintNft {            // "Mnft"
    receiver: address
    content: cell                        // Cell<SnakeString> for the item; opaque to R*
}

struct (0x4d736274) MintSbt {            // "Msbt"
    receiver: address
    individualContent: cell              // set-once opaque content for the SBT item
}

struct (0x52766b73) RevokeSbt {          // "Rvks"
    queryId: uint64
    itemAddress: address                 // owner supplies the item address to revoke
}

// =============================================================================
//  ⚒  A N V I L  — NFT/SBT item editing (the on-chain workbench)
//
//  This is the SINGLE place where minted NFT/SBT items get re-forged. The whole
//  "allowed editings" policy lives here and ONLY here, so it can grow without
//  touching GM or the printers.
//
//  POLICY v1 (intentionally permissive): GM (the owner/admin) may edit EVERYTHING.
//  Admin -[R1{EditNft|EditSbt}]-> GM -[R2]-> R* (this ANVIL) -[R3]-> GM -[R4]->
//  printer collection -> item. The update is an OPAQUE `content` cell — R* never
//  inspects what's inside it (it just routes it). Finer-grained, field-level
//  "allowed editings" (e.g. only `tier`, only `tatoo`) will be added in THIS
//  section later, replacing the blanket owner check with per-field rules — still
//  without recompiling/redeploying GM.
//
//  Wire match: EditNft.content / EditSbt.content are forwarded verbatim into the
//  printer EditItem bodies below, whose opcodes mirror the printer collections:
//    PrinterEditNftItem (0x00000006) <-> nft_printer/messages.tolk EditNftItem
//    PrinterEditSbtItem (0x00000007) <-> sbt_printer/messages.tolk EditSbtItem
// =============================================================================

// ---- ANVIL inbound recipe requests (wrapped in R1.data -> R2.data) ----
struct (0x456e6674) EditNft {            // "Enft"
    itemAddress: address                 // which NFT item to re-forge
    content: cell                        // new Cell<NFTContent>; opaque to R*/GM
}

struct (0x45736274) EditSbt {            // "Esbt"
    itemAddress: address                 // which SBT item to re-forge
    content: cell                        // new Cell<SBTContent>; opaque to R*/GM
}

// ---- ANVIL output bodies (R* builds them, packs into R3.data; GM emits as R4) ----
struct (0x00000006) PrinterEditNftItem {
    queryId: uint64
    itemAddress: address
    newContent: cell
}

struct (0x00000007) PrinterEditSbtItem {
    queryId: uint64
    itemAddress: address
    newContent: cell
}

// =============================================================================
//  ⚒  ANVIL RECIPE ENGINE — request / result types + the pure rule engine
//
//  Inbound (wrapped in R1.data -> R2.data, sent by the NFT printer collection
//  AFTER it verified the input item addresses): the reported on-chain attributes
//  of the input item(s) + the chosen recipe. R* re-validates and computes.
//
//  Outbound: an R3 to the NFT printer collection (PrinterAnvilApply) telling it
//  to overwrite item1's content and/or destroy item2; for MELT, R* ALSO emits a
//  second R3 to the jetton minter to mint the RUDA payout to the owner.
//
//  Each item's attributes ride in a ref cell to keep the request under 1023 bits.
// =============================================================================

// NFT item content — MUST stay byte-identical to the NFTPrinter's NFTContent
// (contracts/printers/nft_printer/storage.tolk): {origin, itemType, tier, seen}.
// R* builds it here for ANVIL updates; the printer/item type it on the other side.
// `seen` is the multisplav (type-5) provenance Bloom filter (null for non-type-5).
struct NFTContent {
    origin: address
    itemType: uint64
    tier: uint64
    seen: cell?
}

// Reported on-chain attributes of one NFT item (from the item's stored content).
// `seen` rides up so the multisplav arm can check/extend the native's filter.
struct AnvilItemAttrs {
    index: uint64
    origin: address
    itemType: uint64
    tier: uint64
    seen: cell?
}

// Two-item recipes (combine / multisplav).
struct (0x416e7643) AnvilCombine {     // "AnvC"
    recipe: uint8
    owner: address                     // the user who owns both items (cashback target)
    item1: Cell<AnvilItemAttrs>
    item2: Cell<AnvilItemAttrs>
}

// Single-item content transforms (zero-type / zero-tier).
struct (0x416e7654) AnvilTransform {   // "AnvT"
    recipe: uint8
    owner: address
    item1: Cell<AnvilItemAttrs>
}

// Single-item melt (burn -> mint RUDA).
struct (0x416e764d) AnvilMelt {        // "AnvM"
    owner: address
    item1: Cell<AnvilItemAttrs>
}

// R* -> NFT printer collection: apply the computed ANVIL outcome.
//   kind == ANVIL_OUT_UPDATE          -> SetNftContent on item1
//   kind == ANVIL_OUT_UPDATE_DESTROY  -> update item1, then item1 destroys item2
//   kind == ANVIL_OUT_MELT            -> destroy item1 (RUDA minted by a 2nd R3)
struct (0x416e7641) PrinterAnvilApply { // "AnvA"
    queryId: uint64
    kind: uint8
    item1Index: uint64
    newContent: cell        // Cell<NFTContent>; ignored for MELT
    item2Index: uint64      // valid only for ANVIL_OUT_UPDATE_DESTROY
    owner: address          // cashback / prev-owner target
}

// Computed ANVIL outcome (also exposed verbatim through get_anvil_outcome).
struct AnvilOutcome {
    kind: uint8
    newOrigin: address
    newType: uint64
    newTier: uint64
    rudaAmount: coins
}

fun pow10(k: int): int {
    var r: int = 1;
    var i: int = 0;
    while (i < k) {
        r *= 10;
        i += 1;
    }
    return r;
}

// =============================================================================
//  ⚒ Multisplav provenance Bloom filter — R*-PRIVATE math (GM never sees these).
//
//  The 512-bit filter is held as ONE cell carrying two 256-bit words:
//    word A = bits [0, 256), word B = bits [256, 512).
//  An origin hashes to k=3 positions in [0, 512); set/test split across A/B.
//  Append-only: addOrigin only ever ORs bits in, so a real duplicate is ALWAYS
//  caught (no false-negative); a fresh origin may rarely collide (false-positive).
// =============================================================================

// An empty filter cell (all bits 0). The fresh native I(5|0|N) starts with this.
fun multisplavEmptyFilter(): cell {
    return beginCell().storeUint(0, 256).storeUint(0, 256).endCell();
}

// Hash an origin address to a 256-bit value (same shape as the design note).
fun multisplavHashOrigin(a: address): int {
    return beginCell().storeAddress(a).endCell().hash();
}

// k=3 bit positions in [0, MULTISPLAV_FILTER_BITS) derived from the hash.
fun multisplavIndices(h: int): (int, int, int) {
    val i1 = h % MULTISPLAV_FILTER_BITS;
    val i2 = (h / MULTISPLAV_FILTER_BITS) % MULTISPLAV_FILTER_BITS;
    val i3 = (h / (MULTISPLAV_FILTER_BITS * MULTISPLAV_FILTER_BITS)) % MULTISPLAV_FILTER_BITS;
    return (i1, i2, i3);
}

// Test bit `idx` across the two words (idx in [0, 512)).
fun multisplavBitGet(wordA: int, wordB: int, idx: int): bool {
    if (idx < MULTISPLAV_FILTER_HALF) {
        return (wordA & (1 << idx)) != 0;
    }
    return (wordB & (1 << (idx - MULTISPLAV_FILTER_HALF))) != 0;
}

// Set bit `idx`, returning the updated (wordA, wordB).
fun multisplavBitSet(wordA: int, wordB: int, idx: int): (int, int) {
    if (idx < MULTISPLAV_FILTER_HALF) {
        return (wordA | (1 << idx), wordB);
    }
    return (wordA, wordB | (1 << (idx - MULTISPLAV_FILTER_HALF)));
}

// Load the two words from a filter cell (null filter => both 0 / nothing seen).
fun multisplavLoadWords(filter: cell?): (int, int) {
    if (filter == null) {
        return (0, 0);
    }
    var s = filter.beginParse();
    val wordA = s.loadUint(256);
    val wordB = s.loadUint(256);
    return (wordA, wordB);
}

// Is `a` PROBABLY already in the filter? false-positive-only (never a false-negative).
fun multisplavProbablySeen(filter: cell?, a: address): bool {
    val (wordA, wordB) = multisplavLoadWords(filter);
    val h = multisplavHashOrigin(a);
    val (i1, i2, i3) = multisplavIndices(h);
    return multisplavBitGet(wordA, wordB, i1)
        && multisplavBitGet(wordA, wordB, i2)
        && multisplavBitGet(wordA, wordB, i3);
}

// Append `a` to the filter (sets its k bits), returning the new filter cell.
fun multisplavAddOrigin(filter: cell?, a: address): cell {
    val (wordA, wordB) = multisplavLoadWords(filter);
    val h = multisplavHashOrigin(a);
    val (i1, i2, i3) = multisplavIndices(h);
    val (a1, b1) = multisplavBitSet(wordA, wordB, i1);
    val (a2, b2) = multisplavBitSet(a1, b1, i2);
    val (a3, b3) = multisplavBitSet(a2, b2, i3);
    return beginCell().storeUint(a3, 256).storeUint(b3, 256).endCell();
}

// THE pure rule engine. Validates the recipe against the reported attributes and
// returns the new content / payout. Every rejection throws a distinct named code.
// `nativeOrigin` is the RUDA jetton master (== "N").
fun computeAnvil(
    recipe: uint8,
    i1Origin: address, i1Type: uint64, i1Tier: uint64,
    i2Origin: address, i2Type: uint64, i2Tier: uint64,
    nativeOrigin: address,
): AnvilOutcome {
    if (recipe == RECIPE_COMBINE) {
        // I(X|K|R) + I(X|K|R) -> I(X|K+1|R). Both inputs must match fully.
        assert (i1Type == i2Type) throw ERR_ANVIL_TYPE_MISMATCH;
        assert (i1Tier == i2Tier) throw ERR_ANVIL_TIER_MISMATCH;
        assert (i1Origin == i2Origin) throw ERR_ANVIL_ORIGIN_MISMATCH;
        // Two type-5 with the SAME origin is the forbidden multisplav case (type-5
        // only ever tiers up through the multisplav recipe, never plain combine).
        assert (i1Type != TYPE_MULTISPLAV) throw ERR_ANVIL_SAME_ORIGIN_MULTISPLAV;
        // Tier cap by type: generic (type 0) caps at 10; every other type caps at the
        // high SAFETY_TIER_CAP. Distinct errors so the reason is unambiguous on-chain.
        if (i1Type == TYPE_GENERIC) {
            assert (i1Tier + 1 <= TIER_CAP_TYPE0) throw ERR_ANVIL_TIER_CAP;
        } else {
            assert (i1Tier + 1 <= SAFETY_TIER_CAP) throw ERR_ANVIL_SAFETY_TIER_CAP;
        }
        return { kind: ANVIL_OUT_UPDATE_DESTROY, newOrigin: i1Origin, newType: i1Type, newTier: i1Tier + 1, rudaAmount: 0 };
    }

    if (recipe == RECIPE_MULTISPLAV) {
        // I(5|K|N) + I(5|0|R) -> I(5|K+1|N). Primary native, sacrifice tier-0 non-native.
        assert (i1Type == TYPE_MULTISPLAV) throw ERR_ANVIL_NOT_TYPE5;
        assert (i2Type == TYPE_MULTISPLAV) throw ERR_ANVIL_NOT_TYPE5;
        assert (i1Origin == nativeOrigin) throw ERR_ANVIL_MULTISPLAV_PRIMARY_NOT_NATIVE;
        assert (i2Tier == 0) throw ERR_ANVIL_MULTISPLAV_SACRIFICE_NOT_TIER0;
        // Sacrifice must be NON-native: alloying the native origin into a native item is
        // forbidden (structural guard; distinct from the provenance/duplicate check, which
        // is applied in the handler against the native's accumulated `seen` filter).
        assert (i2Origin != nativeOrigin) throw ERR_ANVIL_SAME_ORIGIN_MULTISPLAV;
        // Safety cap on the type-5 tier (== count of distinct origins alloyed) so the
        // Bloom filter stays in its low false-positive zone. FLAGGED — see the cap const.
        assert (i1Tier + 1 <= MULTISPLAV_TIER_CAP) throw ERR_ANVIL_MULTISPLAV_TIER_CAP;
        return { kind: ANVIL_OUT_UPDATE_DESTROY, newOrigin: nativeOrigin, newType: TYPE_MULTISPLAV, newTier: i1Tier + 1, rudaAmount: 0 };
    }

    if (recipe == RECIPE_ZERO_TYPE) {
        return { kind: ANVIL_OUT_UPDATE, newOrigin: i1Origin, newType: TYPE_GENERIC, newTier: i1Tier, rudaAmount: 0 };
    }

    if (recipe == RECIPE_ZERO_TIER) {
        return { kind: ANVIL_OUT_UPDATE, newOrigin: i1Origin, newType: i1Type, newTier: 0, rudaAmount: 0 };
    }

    if (recipe == RECIPE_MELT) {
        // MELT mints RUDA (the NFT is destroyed); it does NOT burn RUDA. This is the
        // deliberate counterpart to the burn paths (SSM native stake, 1000-RUDA mint),
        // where RUDA is CONSUMED -> burned. Keep the two distinct.
        if (i1Origin == nativeOrigin) {
            // Native melt: I(X|K|N) -> (10^K - 1) raw RUDA. The tier guard keeps the
            // arithmetic exact + overflow-safe: pow10 runs in 257-bit ints and
            // 10^MELT_MAX_TIER (10^30) < coins max (2^120), so 10^K - 1 never overflows
            // for K <= MELT_MAX_TIER. (A higher-tier native item must zero-tier first.)
            assert (i1Tier <= MELT_MAX_TIER) throw ERR_ANVIL_TIER_TOO_HIGH;
            val amt = pow10(i1Tier) - 1;
            return { kind: ANVIL_OUT_MELT, newOrigin: i1Origin, newType: i1Type, newTier: i1Tier, rudaAmount: amt as coins };
        }
        // Non-native cap-out: the ONLY non-native melt is I(0|10|R) -> 100 RUDA (a
        // deliberate exception to native-only melt; any origin at generic tier-10).
        assert (i1Type == TYPE_GENERIC && i1Tier == TIER_CAP_TYPE0) throw ERR_ANVIL_MELT_NON_NATIVE;
        return { kind: ANVIL_OUT_MELT, newOrigin: i1Origin, newType: i1Type, newTier: i1Tier, rudaAmount: MELT_HUNDRED_RUDA };
    }

    throw ERR_ANVIL_UNKNOWN_RECIPE;
}

// =============================================================================
//  R*-private config messages (opcodes verified unique vs the existing set)
// =============================================================================

struct (0x53455401) SetJettonInfo {
    jettonInfo: Cell<JettonInfo>
}

struct (0x7b2c3d4e) SetGamesInfo {
    gamesInfo: Cell<GamesInfo>
}

struct (0x7a8b9c0d) SetAllowBurn {
    allow_burn: bool
}

struct (0x53455403) SetToolsInfo {
    toolsInfo: Cell<ToolsInfo>
}

// =============================================================================
//  Retranslator storage
// =============================================================================

struct RetranslatorStorage {
    gameManagerAddress: address
    ownerAddress: address          // for owner-only actions (e.g. burn)
    version: uint64
    active: bool
    allow_burn: bool
    jettonInfo: Cell<JettonInfo>?
    gamesInfo: Cell<GamesInfo>?
    toolsInfo: Cell<ToolsInfo>?
    // R*-tracked printer mint counters (the chosen index scheme, O-C). Global
    // monotonic indices: NFT items are keyed by (collection,index); SBT items by
    // (collection,owner,index) — a GLOBALLY unique index guarantees per-owner SBT
    // uniqueness without a per-owner dict. R* increments on each successful mint.
    nextNftIndex: uint64
    nextSbtIndex: uint256
}

fun RetranslatorStorage.load() {
    return RetranslatorStorage.fromCell(contract.getData())
}

fun RetranslatorStorage.save(self) {
    contract.setData(self.toCell())
}

// =============================================================================
//  Message unions
// =============================================================================

type AllowedMessagesToRetranslator =
    | SetJettonInfo
    | SetGamesInfo
    | SetAllowBurn
    | SetToolsInfo
    | R2
    | ReturnExcessesBack
    | LiteralyAnything

// Inner request, parsed out of R2.data.
type AllowedRequests =
    | ForwardMintRequest
    | TransferNotificationForRecipient
    | RequestBurn
    | SsmBurnStake    // ⚒ SSM native-stake burn (registered-game gated)
    | MintNft
    | MintSbt
    | RevokeSbt
    | EditNft   // ⚒ ANVIL (opaque content edit, owner-only)
    | EditSbt   // ⚒ ANVIL (opaque content edit, owner-only)
    | AnvilCombine    // ⚒ ANVIL recipe engine (two-item)
    | AnvilTransform  // ⚒ ANVIL recipe engine (single-item transform)
    | AnvilMelt       // ⚒ ANVIL recipe engine (single-item burn -> RUDA)


fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessagesToRetranslator.fromSlice(in.body);
    var storage = lazy RetranslatorStorage.load();
    match (msg) {

        // -------- config (relayed from GM; sender must be GM) --------
        SetJettonInfo => {
            assert (in.senderAddress == storage.gameManagerAddress) throw ERR_INVALID_OWNER_SENDER;
            assert (in.valueCoins >= GAS_COST_SET_JETTON_INFO) throw ERR_MESSAGE_VALUE_TOO_LOW;
            storage.jettonInfo = msg.jettonInfo;
            storage.save();
            reserveValue(in.valueCoins);
            returnExcessesToGameManager(storage.gameManagerAddress);
        }

        SetGamesInfo => {
            assert (in.senderAddress == storage.gameManagerAddress) throw ERR_INVALID_OWNER_SENDER;
            assert (in.valueCoins >= GAS_COST_SET_GAMES_INFO) throw ERR_MESSAGE_VALUE_TOO_LOW;

            val gamesInfo = msg.gamesInfo.load();
            // Named-slot validation: active_game MUST equal one of the reward-game
            // slots (ssm or ton_race_game). ubps is registration-only and can never
            // be the active reward game.
            assert (
                (gamesInfo.ssm != null && gamesInfo.active_game == gamesInfo.ssm!) ||
                (gamesInfo.ton_race_game != null && gamesInfo.active_game == gamesInfo.ton_race_game!)
            ) throw ERR_INVALID_GAMES_INFO;

            storage.gamesInfo = msg.gamesInfo;
            storage.save();
            reserveValue(in.valueCoins);
            returnExcessesToGameManager(storage.gameManagerAddress);
        }

        SetAllowBurn => {
            assert (in.senderAddress == storage.gameManagerAddress) throw ERR_INVALID_OWNER_SENDER;
            assert (in.valueCoins >= GAS_COST_SET_ALLOW_BURN) throw ERR_MESSAGE_VALUE_TOO_LOW;
            storage.allow_burn = msg.allow_burn;
            storage.save();
            reserveValue(in.valueCoins);
            returnExcessesToGameManager(storage.gameManagerAddress);
        }

        SetToolsInfo => {
            assert (in.senderAddress == storage.gameManagerAddress) throw ERR_INVALID_OWNER_SENDER;
            assert (in.valueCoins >= GAS_COST_SET_TOOLS_INFO) throw ERR_MESSAGE_VALUE_TOO_LOW;
            storage.toolsInfo = msg.toolsInfo;
            storage.save();
            reserveValue(in.valueCoins);
            returnExcessesToGameManager(storage.gameManagerAddress);
        }

        // -------- the brain: GM -R2-> R* (shell + kill-switch only this job) --------
        R2 => {
            assert (in.senderAddress == storage.gameManagerAddress) throw ERR_INVALID_OWNER_SENDER;

            // Kill-switch: when inactive, bounce the value back to GM untouched.
            if (!storage.active) {
                reserveValue(in.valueCoins);
                val back = createMessage({
                    bounce: BounceMode.NoBounce,
                    dest: storage.gameManagerAddress,
                    value: 0,
                    body: beginCell().endCell()
                });
                back.send(SEND_MODE_IGNORE_ERRORS + SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
                return;
            }

            // R2.initiator = who sent the original R1 (GM-attested).
            // R2.data = opaque request body; parse it to dispatch.
            val request = lazy AllowedRequests.fromSlice(msg.data.beginParse());
            match (request) {

                // A game earned a reward -> mint jettons to the player.
                // initiator must be a registered game. R* builds MintNewJettons and
                // tells GM to emit it to the jetton minter (GM is the minter admin).
                ForwardMintRequest => {
                    assert (storage.jettonInfo != null) throw ERR_JETTON_MINTER_NOT_SET;
                    val jettonInfo = storage.jettonInfo!.load();
                    assert (storage.gamesInfo != null) throw ERR_GAMES_NOT_SET;
                    val gamesInfo = storage.gamesInfo!.load();

                    // active_game fast-path, then the O(1) named-slot reward check.
                    val isActiveGame = (msg.initiator == gamesInfo.active_game);
                    if (!isActiveGame) {
                        assert (isRewardGame(gamesInfo, msg.initiator)) throw ERR_GAME_NOT_FOUND;
                    }

                    // forwardPayload empty: the TransferNotification goes from the
                    // player's wallet to the player, not back to GM.
                    val forwardPayload: ForwardPayloadRemainder = beginCell().toSlice();
                    val forwardTonAmount = ton("0.05"); // enough for the notification
                    val internalTransferStep = InternalTransferStep {
                        queryId: 0,
                        jettonAmount: request.amount,
                        transferInitiator: null,        // null when minting
                        sendExcessesTo: request.receiver,
                        forwardTonAmount: forwardTonAmount,
                        forwardPayload: forwardPayload,
                    };
                    // Guard the unsigned `coins` subtraction below: without this, the active-game
                    // fast path (which skips the >=0.2 check) underflows on low value and throws an
                    // opaque arithmetic exception instead of a named error.
                    assert (in.valueCoins >= MINT_TON_AMOUNT + BASIC_STORAGE_TAX) throw ERR_MESSAGE_VALUE_TOO_LOW;
                    var dif = in.valueCoins - MINT_TON_AMOUNT - BASIC_STORAGE_TAX;
                    val mintNewJettons = MintNewJettons {
                        queryId: 0,
                        mintRecipient: request.receiver,
                        tonAmount: MINT_TON_AMOUNT + dif,
                        internalTransferMsg: internalTransferStep.toCell(),
                    };
                    reserveValue(in.valueCoins);
                    emitR3(storage.gameManagerAddress, jettonInfo.jettonMinterAddress, mintNewJettons.toCell());
                }

                // A player spent jettons (transfer notification arrived at GM's
                // native jetton wallet). R* verifies the wallet, decodes the
                // forwardPayload (game address + ship-usage data) and asks GM to
                // emit JettonUsed to that game.
                TransferNotificationForRecipient => {
                    assert (storage.jettonInfo != null) throw ERR_JETTON_MINTER_NOT_SET;
                    val jettonInfo = storage.jettonInfo!.load();
                    // initiator must be GM's OWN jetton wallet (owner == GM).
                    val expectedWalletAddress = calcAddressOfJettonWallet(
                        storage.gameManagerAddress, jettonInfo.jettonMinterAddress, jettonInfo.jettonWalletCode);
                    assert (msg.initiator == expectedWalletAddress) throw ERR_INVALID_JETTON_WALLET_SENDER;

                    // forwardPayload is RemainingBitsAndRefs: one ref to a payload
                    // cell that itself holds [gameAddress ref][data ref].
                    var forwardPayloadSlice: slice = request.forwardPayload;
                    if (forwardPayloadSlice.remainingRefsCount() < 1 ||
                        request.jettonAmount < MIN_JETTON_USAGE_AMOUNT) {
                        reserveValue(in.valueCoins);
                        sendEmptyBackToGameManager(storage.gameManagerAddress);
                        return;
                    }
                    val payloadCell = forwardPayloadSlice.loadRef();
                    var payloadSlice = payloadCell.beginParse();

                    // ⚒ ANVIL 1000-RUDA mint: a tagged payload (>=32 data bits) requests
                    // I(5|0|N). The wallet was already verified as GM's RUDA wallet above,
                    // so the deposit is real; the depositor (transferInitiator) gets the item.
                    //
                    // RUDA FLOW (burn-and-mint, SSM honest-burn model): the 1000 RUDA already
                    // landed in GM's OWN jetton wallet (the internal transfer completed before
                    // this notification). We emit TWO R3s in this one tx:
                    //   (1) DeployNft -> NFT printer: mint a fresh I(5|0|N) with an EMPTY filter
                    //       to the depositor (bounded value, just enough for the deploy hop).
                    //   (2) AskToBurn -> GM's own RUDA wallet: BURN the full 1000-RUDA stake
                    //       (sender == GM == wallet owner, so the burn is authorized). Carry-all
                    //       so the remaining forwarded TON funds the burn->minter chain.
                    // The stake is intrinsic to the mint, so this burn is NOT gated by
                    // allow_burn (that kill-switch only governs owner-initiated RequestBurn).
                    if (payloadSlice.remainingBitsCount() >= 32) {
                        val tag = payloadSlice.loadUint(32);
                        if (tag == ANVIL_MULTISPLAV_MINT_TAG) {
                            assert (request.jettonAmount == MULTISPLAV_MINT_STAKE) throw ERR_ANVIL_BAD_MULTISPLAV_MINT_AMOUNT;
                            assert (storage.toolsInfo != null) throw ERR_TOOLS_INFO_NOT_SET;
                            val toolsInfoM = storage.toolsInfo!.load();
                            assert (toolsInfoM.nftPrinterAddress != null) throw ERR_NFT_PRINTER_NOT_SET;
                            assert (request.transferInitiator != null) throw ERR_MISSING_REQUIRED_DATA;

                            val content: NFTContent = {
                                origin: jettonInfo.jettonMinterAddress, // native origin "N"
                                itemType: TYPE_MULTISPLAV,
                                tier: 0,
                                seen: multisplavEmptyFilter(), // fresh, empty provenance set
                            };
                            val index = storage.nextNftIndex;
                            val initParams = PrinterNftItemInit {
                                ownerAddress: request.transferInitiator!,
                                content: content.toCell(),
                            };
                            val deployNft = PrinterDeployNft {
                                queryId: 0,
                                itemIndex: index,
                                attachTonAmount: PRINTER_ITEM_DEPLOY_AMOUNT,
                                initParams: initParams.toCell(),
                            };
                            storage.nextNftIndex = index + 1;
                            storage.save();

                            // (2) Burn the 1000-RUDA stake from GM's own wallet.
                            val gameManagerWalletAddress = calcAddressOfJettonWallet(
                                storage.gameManagerAddress, jettonInfo.jettonMinterAddress, jettonInfo.jettonWalletCode);
                            val askToBurn = AskToBurn {
                                queryId: 0,
                                jettonAmount: MULTISPLAV_MINT_STAKE,
                                sendExcessesTo: storage.gameManagerAddress,
                                customPayload: null,
                            };

                            reserveValue(in.valueCoins);
                            // (1) Deploy the item with a bounded value (storage + the collection->item hop).
                            emitR3Value(storage.gameManagerAddress, toolsInfoM.nftPrinterAddress!, deployNft.toCell(),
                                PRINTER_ITEM_DEPLOY_AMOUNT + ANVIL_ITEM_OP_TON, SEND_MODE_PAY_FEES_SEPARATELY);
                            // (2) Burn carries the remaining balance (funds wallet->minter burn notification).
                            emitR3Value(storage.gameManagerAddress, gameManagerWalletAddress, askToBurn.toCell(),
                                0, SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
                            return;
                        }
                    }

                    if (payloadSlice.remainingRefsCount() < 2) {
                        reserveValue(in.valueCoins);
                        sendEmptyBackToGameManager(storage.gameManagerAddress);
                        return;
                    }
                    val gameAddressCell = payloadSlice.loadRef();
                    val gameAddress = gameAddressCell.beginParse().loadAddress();
                    val dataCell = payloadSlice.loadRef();

                    val jettonUsed = JettonUsed {
                        jettonAmount: request.jettonAmount,
                        data: dataCell,
                    };
                    reserveValue(in.valueCoins);
                    emitR3(storage.gameManagerAddress, gameAddress, jettonUsed.toCell());
                }

                // Owner-initiated burn of GM's native jettons. R* builds AskToBurn
                // and tells GM to emit it to GM's own jetton wallet.
                RequestBurn => {
                    assert (msg.initiator == storage.ownerAddress) throw ERR_INVALID_OWNER_SENDER;
                    assert (storage.allow_burn) throw ERR_BURN_NOT_ALLOWED;
                    assert (storage.jettonInfo != null) throw ERR_JETTON_MINTER_NOT_SET;
                    val jettonInfo = storage.jettonInfo!.load();
                    val gameManagerWalletAddress = calcAddressOfJettonWallet(
                        storage.gameManagerAddress, jettonInfo.jettonMinterAddress, jettonInfo.jettonWalletCode);
                    val askToBurn = AskToBurn {
                        queryId: request.queryId,
                        jettonAmount: request.jettonAmount,
                        sendExcessesTo: request.sendExcessesTo,
                        customPayload: request.customPayload,
                    };
                    reserveValue(in.valueCoins);
                    emitR3(storage.gameManagerAddress, gameManagerWalletAddress, askToBurn.toCell());
                }

                // ⚒ SSM native-stake burn. Same authorization as a MINT (registered
                // game OR owner) — registered games already control RUDA supply, so
                // burning is no escalation. Intrinsic to the roll -> NOT allow_burn
                // gated. R* builds AskToBurn and routes it to GM's own RUDA wallet.
                SsmBurnStake => {
                    assert (storage.jettonInfo != null) throw ERR_JETTON_MINTER_NOT_SET;
                    val jettonInfo = storage.jettonInfo!.load();
                    assertMintInitiatorAllowed(storage, msg.initiator);
                    val gameManagerWalletAddress = calcAddressOfJettonWallet(
                        storage.gameManagerAddress, jettonInfo.jettonMinterAddress, jettonInfo.jettonWalletCode);
                    val askToBurn = AskToBurn {
                        queryId: request.queryId,
                        jettonAmount: request.amount,
                        sendExcessesTo: storage.gameManagerAddress,
                        customPayload: null,
                    };
                    reserveValue(in.valueCoins);
                    emitR3(storage.gameManagerAddress, gameManagerWalletAddress, askToBurn.toCell());
                }

                // Mint one TEP-62 NFT to `receiver` via the NFTPrinter.
                // Recipe policy v1: initiator = a registered game OR the owner.
                // R* assigns the global nextNftIndex and tells GM to emit DeployNft
                // to the printer (sender == admin == GM). [extension point: richer
                // recipe registry lands here without touching GM.]
                MintNft => {
                    assert (storage.toolsInfo != null) throw ERR_TOOLS_INFO_NOT_SET;
                    val toolsInfo = storage.toolsInfo!.load();
                    assert (toolsInfo.nftPrinterAddress != null) throw ERR_NFT_PRINTER_NOT_SET;
                    assertMintInitiatorAllowed(storage, msg.initiator);

                    val index = storage.nextNftIndex;
                    val initParams = PrinterNftItemInit {
                        ownerAddress: request.receiver,
                        content: request.content,
                    };
                    val deployNft = PrinterDeployNft {
                        queryId: 0,
                        itemIndex: index,
                        attachTonAmount: PRINTER_ITEM_DEPLOY_AMOUNT,
                        initParams: initParams.toCell(),
                    };
                    storage.nextNftIndex = index + 1;
                    storage.save();
                    reserveValue(in.valueCoins);
                    emitR3(storage.gameManagerAddress, toolsInfo.nftPrinterAddress!, deployNft.toCell());
                }

                // Mint one soulbound SBT to `receiver` via the SBTPrinter.
                // Recipe policy v1: OWNER/GM ONLY (games may create NFTs, NOT SBTs).
                // Global nextSbtIndex guarantees per-owner item uniqueness.
                MintSbt => {
                    assert (msg.initiator == storage.ownerAddress) throw ERR_INVALID_OWNER_SENDER;
                    assert (storage.toolsInfo != null) throw ERR_TOOLS_INFO_NOT_SET;
                    val toolsInfo = storage.toolsInfo!.load();
                    assert (toolsInfo.sbtPrinterAddress != null) throw ERR_SBT_PRINTER_NOT_SET;

                    val index = storage.nextSbtIndex;
                    val deploySbtn = PrinterDeploySbtn {
                        queryId: 0,
                        ownerAddress: request.receiver,
                        index: index,
                        attachTonAmount: PRINTER_ITEM_DEPLOY_AMOUNT,
                        individualContent: request.individualContent,
                    };
                    storage.nextSbtIndex = index + 1;
                    storage.save();
                    reserveValue(in.valueCoins);
                    emitR3(storage.gameManagerAddress, toolsInfo.sbtPrinterAddress!, deploySbtn.toCell());
                }

                // Revoke an SBT item. OWNER-ONLY (high-value). The owner supplies the
                // item address; R* tells GM to emit RevokeSbtnItem to the SBTPrinter,
                // which forwards Revoke to the item (item checks sender == collection).
                RevokeSbt => {
                    assert (msg.initiator == storage.ownerAddress) throw ERR_INVALID_OWNER_SENDER;
                    assert (storage.toolsInfo != null) throw ERR_TOOLS_INFO_NOT_SET;
                    val toolsInfo = storage.toolsInfo!.load();
                    assert (toolsInfo.sbtPrinterAddress != null) throw ERR_SBT_PRINTER_NOT_SET;

                    val revokeItem = PrinterRevokeSbtnItem {
                        queryId: request.queryId,
                        itemAddress: request.itemAddress,
                    };
                    reserveValue(in.valueCoins);
                    emitR3(storage.gameManagerAddress, toolsInfo.sbtPrinterAddress!, revokeItem.toCell());
                }

                // ----------------------------------------------------------------
                //  ⚒  ANVIL arms — edit an existing NFT/SBT item's content.
                //  Policy v1: OWNER/GM ONLY may edit (everything). R* forwards the
                //  opaque `content` cell to the printer collection, which forwards
                //  SetNftContent/SetSbtContent to the item. R* never parses content.
                //  Future field-level "allowed editings" replace the owner check here.
                // ----------------------------------------------------------------
                EditNft => {
                    assert (msg.initiator == storage.ownerAddress) throw ERR_INVALID_OWNER_SENDER;
                    assert (storage.toolsInfo != null) throw ERR_TOOLS_INFO_NOT_SET;
                    val toolsInfo = storage.toolsInfo!.load();
                    assert (toolsInfo.nftPrinterAddress != null) throw ERR_NFT_PRINTER_NOT_SET;

                    val editItem = PrinterEditNftItem {
                        queryId: 0,
                        itemAddress: request.itemAddress,
                        newContent: request.content,
                    };
                    reserveValue(in.valueCoins);
                    emitR3(storage.gameManagerAddress, toolsInfo.nftPrinterAddress!, editItem.toCell());
                }

                EditSbt => {
                    assert (msg.initiator == storage.ownerAddress) throw ERR_INVALID_OWNER_SENDER;
                    assert (storage.toolsInfo != null) throw ERR_TOOLS_INFO_NOT_SET;
                    val toolsInfo = storage.toolsInfo!.load();
                    assert (toolsInfo.sbtPrinterAddress != null) throw ERR_SBT_PRINTER_NOT_SET;

                    val editItem = PrinterEditSbtItem {
                        queryId: 0,
                        itemAddress: request.itemAddress,
                        newContent: request.content,
                    };
                    reserveValue(in.valueCoins);
                    emitR3(storage.gameManagerAddress, toolsInfo.sbtPrinterAddress!, editItem.toCell());
                }

                // ----------------------------------------------------------------
                //  ⚒  ANVIL recipe engine arms. Initiator MUST be the NFT printer
                //  (it has verified the input item addresses up the gate chain).
                //  R* validates against the REPORTED attributes and computes the
                //  new content / payout, then returns the apply-R3 to the printer.
                // ----------------------------------------------------------------
                AnvilCombine => {
                    val toolsInfo = assertAnvilFromPrinter(storage, msg.initiator);
                    // ARITY GUARD: the two-item arm accepts ONLY two-item recipes. Without
                    // this, a user could send a single-item report tagged recipe=COMBINE (or
                    // vice-versa) and have computeAnvil emit an UPDATE_DESTROY with item2Index=0
                    // — a free tier-up that destroys NFT index 0. Reject the mismatch.
                    assert (request.recipe == RECIPE_COMBINE || request.recipe == RECIPE_MULTISPLAV) throw ERR_ANVIL_RECIPE_ARITY;
                    val nativeOrigin = anvilNativeOrigin(storage);
                    val i1 = request.item1.load();
                    val i2 = request.item2.load();
                    val outcome = computeAnvil(
                        request.recipe,
                        i1.origin, i1.itemType, i1.tier,
                        i2.origin, i2.itemType, i2.tier,
                        nativeOrigin);
                    // ⚒ Provenance: by default the surviving item keeps item1's filter. For a
                    // multisplav alloy, REJECT if the sacrifice's origin is already in the
                    // native's accumulated set (the real duplicate rule — replaces the naive
                    // two-item compare), else append it. Append-only, false-positive-only.
                    var newSeen: cell? = i1.seen;
                    if (request.recipe == RECIPE_MULTISPLAV) {
                        assert (!multisplavProbablySeen(i1.seen, i2.origin)) throw ERR_ANVIL_MULTISPLAV_ORIGIN_ALREADY_SEEN;
                        newSeen = multisplavAddOrigin(i1.seen, i2.origin);
                    }
                    val newContent: NFTContent = {
                        origin: outcome.newOrigin, itemType: outcome.newType, tier: outcome.newTier, seen: newSeen,
                    };
                    val apply = PrinterAnvilApply {
                        queryId: 0,
                        kind: outcome.kind,
                        item1Index: i1.index,
                        newContent: newContent.toCell(),
                        item2Index: i2.index,
                        owner: request.owner,
                    };
                    reserveValue(in.valueCoins);
                    emitR3(storage.gameManagerAddress, toolsInfo.nftPrinterAddress!, apply.toCell());
                }

                AnvilTransform => {
                    val toolsInfo = assertAnvilFromPrinter(storage, msg.initiator);
                    // ARITY GUARD: the single-item arm accepts ONLY single-item transforms.
                    // Blocks a single-item report tagged recipe=COMBINE/MULTISPLAV/MELT from
                    // reaching computeAnvil's two-item / melt branches on this path.
                    assert (request.recipe == RECIPE_ZERO_TYPE || request.recipe == RECIPE_ZERO_TIER) throw ERR_ANVIL_RECIPE_ARITY;
                    val nativeOrigin = anvilNativeOrigin(storage);
                    val i1 = request.item1.load();
                    val outcome = computeAnvil(
                        request.recipe,
                        i1.origin, i1.itemType, i1.tier,
                        i1.origin, i1.itemType, i1.tier, // i2 unused for single-item recipes
                        nativeOrigin);
                    // Single-item transforms (zero-type/zero-tier) preserve the provenance filter.
                    val newContent: NFTContent = {
                        origin: outcome.newOrigin, itemType: outcome.newType, tier: outcome.newTier, seen: i1.seen,
                    };
                    val apply = PrinterAnvilApply {
                        queryId: 0,
                        kind: outcome.kind,
                        item1Index: i1.index,
                        newContent: newContent.toCell(),
                        item2Index: 0,
                        owner: request.owner,
                    };
                    reserveValue(in.valueCoins);
                    emitR3(storage.gameManagerAddress, toolsInfo.nftPrinterAddress!, apply.toCell());
                }

                AnvilMelt => {
                    val toolsInfo = assertAnvilFromPrinter(storage, msg.initiator);
                    assert (storage.jettonInfo != null) throw ERR_JETTON_MINTER_NOT_SET;
                    val jettonInfo = storage.jettonInfo!.load();
                    val nativeOrigin = jettonInfo.jettonMinterAddress;
                    val i1 = request.item1.load();
                    val outcome = computeAnvil(
                        RECIPE_MELT,
                        i1.origin, i1.itemType, i1.tier,
                        i1.origin, i1.itemType, i1.tier,
                        nativeOrigin);

                    // (1) destroy item1 via the printer (cashback to owner happens there).
                    val apply = PrinterAnvilApply {
                        queryId: 0,
                        kind: outcome.kind, // ANVIL_OUT_MELT
                        item1Index: i1.index,
                        newContent: beginCell().endCell(),
                        item2Index: 0,
                        owner: request.owner,
                    };
                    reserveValue(in.valueCoins);
                    // Bounded value for the destroy hop; the rest funds the RUDA mint.
                    emitR3Value(storage.gameManagerAddress, toolsInfo.nftPrinterAddress!, apply.toCell(),
                        ANVIL_DESTROY_TON + ANVIL_ITEM_OP_TON, SEND_MODE_PAY_FEES_SEPARATELY);

                    // (2) mint the RUDA payout to the owner (skip if amount is 0).
                    if (outcome.rudaAmount > 0) {
                        val forwardPayload: ForwardPayloadRemainder = beginCell().toSlice();
                        val internalTransferStep = InternalTransferStep {
                            queryId: 0,
                            jettonAmount: outcome.rudaAmount,
                            transferInitiator: null,
                            sendExcessesTo: request.owner,
                            forwardTonAmount: ton("0.05"),
                            forwardPayload: forwardPayload,
                        };
                        val mintNewJettons = MintNewJettons {
                            queryId: 0,
                            mintRecipient: request.owner,
                            tonAmount: MINT_TON_AMOUNT,
                            internalTransferMsg: internalTransferStep.toCell(),
                        };
                        emitR3Value(storage.gameManagerAddress, jettonInfo.jettonMinterAddress,
                            mintNewJettons.toCell(), 0, SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
                    }
                }
            }
        }

        ReturnExcessesBack => {
            reserveValue(in.valueCoins);
            val cashbackMessage = createMessage({
                bounce: BounceMode.NoBounce,
                dest: storage.gameManagerAddress,
                value: 0,
                body: beginCell().endCell() // Empty body for simple transfer
            });
            cashbackMessage.send(SEND_MODE_IGNORE_ERRORS + SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
        }
        LiteralyAnything => {
            reserveValue(in.valueCoins);
        }
        else => {
            assert (in.body.isEmpty()) throw 0xFFFF
        }
    }
}

fun returnExcessesToGameManager(gameManagerAddress: address) {
    val responseMsg = createMessage({
        bounce: BounceMode.NoBounce,
        dest: gameManagerAddress,
        value: 0,
        body: ReturnExcessesBack {
            queryId: 0
        }
    });
    responseMsg.send(SEND_MODE_IGNORE_ERRORS + SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
}

// R* -[R3]-> GM. GM forwards `data` to `recipient` as R4. Carry-all so the whole
// remaining value travels with the reply.
fun emitR3(gameManagerAddress: address, recipient: address, data: cell) {
    val r3 = createMessage({
        bounce: BounceMode.NoBounce,
        dest: gameManagerAddress,
        value: 0,
        body: R3 {
            recipient: recipient,
            data: data,
        }
    });
    r3.send(SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
}

// R* -[R3]-> GM with an EXPLICIT value + send mode (used when one tx must emit
// MORE than one R3, e.g. MELT = destroy item1 (bounded) + mint RUDA (carry-all)).
fun emitR3Value(gameManagerAddress: address, recipient: address, data: cell, value: coins, mode: int) {
    val r3 = createMessage({
        bounce: BounceMode.NoBounce,
        dest: gameManagerAddress,
        value: value,
        body: R3 {
            recipient: recipient,
            data: data,
        }
    });
    r3.send(mode);
}

// ANVIL gate: the request initiator must be the configured NFT printer collection
// (which has already verified the input item addresses). Returns the ToolsInfo.
fun assertAnvilFromPrinter(storage: RetranslatorStorage, initiator: address): ToolsInfo {
    assert (storage.toolsInfo != null) throw ERR_TOOLS_INFO_NOT_SET;
    val toolsInfo = storage.toolsInfo!.load();
    assert (toolsInfo.nftPrinterAddress != null) throw ERR_NFT_PRINTER_NOT_SET;
    assert (initiator == toolsInfo.nftPrinterAddress!) throw ERR_ANVIL_NOT_PRINTER;
    return toolsInfo;
}

// The native origin "N" == the RUDA jetton master.
fun anvilNativeOrigin(storage: RetranslatorStorage): address {
    assert (storage.jettonInfo != null) throw ERR_JETTON_MINTER_NOT_SET;
    val jettonInfo = storage.jettonInfo!.load();
    return jettonInfo.jettonMinterAddress;
}

// Abort path: nothing to emit, just hand the remaining value back to GM.
fun sendEmptyBackToGameManager(gameManagerAddress: address) {
    val back = createMessage({
        bounce: BounceMode.NoBounce,
        dest: gameManagerAddress,
        value: 0,
        body: beginCell().endCell()
    });
    back.send(SEND_MODE_IGNORE_ERRORS + SEND_MODE_CARRY_ALL_REMAINING_BALANCE);
}

// =============================================================================
//  R*-private helpers
// =============================================================================

// Jetton wallet address calculation (redefined to avoid cross-project dependencies)
fun calcDeployedJettonWallet(ownerAddress: address, minterAddress: address, jettonWalletCode: cell): AutoDeployAddress {
    val emptyWalletStorage = beginCell()
        .storeCoins(0) // jettonBalance
        .storeAddress(ownerAddress) // ownerAddress
        .storeAddress(minterAddress) // minterAddress
        .endCell();

    return {
        stateInit: {
            code: jettonWalletCode,
            data: emptyWalletStorage
        }
    }
}

fun calcAddressOfJettonWallet(ownerAddress: address, minterAddress: address, jettonWalletCode: cell): address {
    val jwDeployed = calcDeployedJettonWallet(ownerAddress, minterAddress, jettonWalletCode);
    return jwDeployed.calculateAddress()
}

// Named-slot reward authorization: an address is reward-authorized iff it equals
// one of the REWARD-game slots. `ubps` is DELIBERATELY excluded — it is a
// registration-only slot and never authorizes a RUDA mint/burn or printer recipe.
// O(1) lookup (no list walk), so the prior gas precondition is gone.
fun isRewardGame(gamesInfo: GamesInfo, addr: address): bool {
    return (gamesInfo.ssm != null && addr == gamesInfo.ssm!)
        || (gamesInfo.ton_race_game != null && addr == gamesInfo.ton_race_game!);
}

// Recipe policy v1 for printer MINTS: initiator must be a registered reward game
// OR the owner. Cheap active-game fast-path first, then the O(1) named-slot check.
// THIS is the documented extension point for the future recipe registry.
fun assertMintInitiatorAllowed(storage: RetranslatorStorage, initiator: address) {
    if (initiator == storage.ownerAddress) {
        return;
    }
    assert (storage.gamesInfo != null) throw ERR_GAMES_NOT_SET;
    val gamesInfo = storage.gamesInfo!.load();
    if (initiator == gamesInfo.active_game) {
        return;
    }
    assert (isRewardGame(gamesInfo, initiator)) throw ERR_GAME_NOT_FOUND;
}

// =============================================================================
//  Get-methods
// =============================================================================

get fun get_version(): int {
    var storage = lazy RetranslatorStorage.load();
    return storage.version;
}

get fun get_active(): bool {
    var storage = lazy RetranslatorStorage.load();
    return storage.active;
}

get fun get_game_manager(): address {
    var storage = lazy RetranslatorStorage.load();
    return storage.gameManagerAddress;
}

get fun get_owner(): address {
    var storage = lazy RetranslatorStorage.load();
    return storage.ownerAddress;
}

get fun get_jetton_info(): Cell<JettonInfo>? {
    var storage = lazy RetranslatorStorage.load();
    return storage.jettonInfo;
}

get fun get_games_info(): Cell<GamesInfo>? {
    var storage = lazy RetranslatorStorage.load();
    return storage.gamesInfo;
}

get fun get_tools_info(): Cell<ToolsInfo>? {
    var storage = lazy RetranslatorStorage.load();
    return storage.toolsInfo;
}

get fun get_allow_burn(): bool {
    var storage = lazy RetranslatorStorage.load();
    return storage.allow_burn;
}

get fun get_next_nft_index(): int {
    var storage = lazy RetranslatorStorage.load();
    return storage.nextNftIndex;
}

get fun get_next_sbt_index(): int {
    var storage = lazy RetranslatorStorage.load();
    return storage.nextSbtIndex;
}

// ⚒ ANVIL recipe engine exposed for exhaustive unit testing. Returns
// (kind, newOrigin, newType, newTier, rudaAmount); rejections throw the named
// recipe error so tests can assert the exact exit code. `nativeOrigin` lets the
// test drive native vs non-native origins explicitly.
get fun get_anvil_outcome(
    recipe: int,
    i1Origin: address, i1Type: int, i1Tier: int,
    i2Origin: address, i2Type: int, i2Tier: int,
    nativeOrigin: address,
): (int, address, int, int, coins) {
    val o = computeAnvil(
        recipe as uint8,
        i1Origin, i1Type as uint64, i1Tier as uint64,
        i2Origin, i2Type as uint64, i2Tier as uint64,
        nativeOrigin,
    );
    return (o.kind, o.newOrigin, o.newType as int, o.newTier as int, o.rudaAmount);
}

// ⚒ ANVIL tier caps + type-space constants, exposed so the published ABI
// (deployment_latest.json) can be guard-checked against the ON-CHAIN values.
// Returns (genericCap, safetyCap, multisplavCap, meltMaxTier, typeGeneric, typeMultisplav).
get fun get_anvil_caps(): (int, int, int, int, int, int) {
    return (
        TIER_CAP_TYPE0 as int,
        SAFETY_TIER_CAP as int,
        MULTISPLAV_TIER_CAP as int,
        MELT_MAX_TIER as int,
        TYPE_GENERIC as int,
        TYPE_MULTISPLAV as int
    );
}

// ⚒ Multisplav Bloom helpers exposed for pure unit testing (side-effect-free).
// Filter width/params and the cap are surfaced so tests can assert them directly.
get fun get_multisplav_params(): (int, int, int) {
    return (MULTISPLAV_FILTER_BITS, MULTISPLAV_FILTER_K, MULTISPLAV_TIER_CAP);
}

get fun get_multisplav_empty_filter(): cell {
    return multisplavEmptyFilter();
}

// Returns -1 (true) / 0 (false): is `a` probably already in `filter`?
get fun get_multisplav_probably_seen(filter: cell, a: address): bool {
    return multisplavProbablySeen(filter, a);
}

// Returns the new filter cell after appending `a`.
get fun get_multisplav_add_origin(filter: cell, a: address): cell {
    return multisplavAddOrigin(filter, a);
}
