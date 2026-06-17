// SPDX-License-Identifier: UNLICENSED
// =============================================================================
// static.tolk — UBPS (Universal Belief & Political System) shared module surface:
// storage structs, deterministic address calc, constants, errors, opcodes and the
// message bodies. Imported by every UBPS contract (master + Unit + Question +
// Answer + BeliefSet). This is intra-module sharing (UBPS <-> its own children);
// it has NOTHING to do with the GM<->R* decoupling invariant.
//
// UBPS is an INDEPENDENT module: it has NO RUDA/jetton logic, never routes through
// the GM/R2/R3 pipe, and its R* registry slot is registration-only (the master
// address is stored for discovery and is NEVER reward-authorized).
//
// On-chain the system enforces ONLY structural rules (sender gates, the
// string.hash == id check, the MAX_A/MAX_BS caps, one-shot immutability). Belief
// validity, follow-cycle detection and content de-dup are OFF-CHAIN (frontend /
// backend) responsibilities by design (concept decisions #2 and #4).
// =============================================================================

const BASIC_STORAGE_TAX = ton("0.01");

const SEND_MODE_CARRY_ALL_REMAINING_BALANCE: uint8 = 128;

// BeliefSet size caps — enforced at creation (concept decision #5). Tunable.
const MAX_A: int = 100;    // max atomic beliefs (A addresses) in one BS/B
const MAX_BS: int = 20;    // max nested sets (BS addresses) in one BS/B

// Minimum TON to fund a master operation (a single child deploy + the activation
// message hop + cashback). Operations carry-all the remainder onward.
const UBPS_MIN_OP_VALUE: coins = ton("0.1");

// =============================================================================
//  Errors — UBPS's own range (600..619), distinct from GM (900s), SSM (940s),
//  the slot (1300s) and the printers (960s/980s) so codes never collide.
// =============================================================================
const ERR_UBPS_INVALID_SENDER = 600;        // message arrived from an unexpected sender
const ERR_UBPS_HASH_MISMATCH = 601;         // string.hash(string) != provided id
const ERR_UBPS_ALREADY_ACTIVE = 602;        // Q/A already activated (immutable)
const ERR_UBPS_ALREADY_CREATED = 603;       // BS/B already populated (immutable)
const ERR_UBPS_TOO_MANY_A = 604;            // aCount > MAX_A
const ERR_UBPS_TOO_MANY_BS = 605;           // bsCount > MAX_BS
const ERR_UBPS_INVALID_OWNER_SENDER = 606;  // Unit SetPointer not from the unit's user
const ERR_UBPS_VALUE_TOO_LOW = 607;         // operation underfunded
const ERR_UBPS_NOT_MASTER = 608;            // child activation/creation not from the master
const ERR_UBPS_BAD_STRING_CELL = 609;       // Q/A string cell has refs (must be a single byte-aligned cell)

// =============================================================================
//  Storage
// =============================================================================

// UBPS master — root authority. Stores the child codes (for deterministic address
// calc + deploys) and the monotonic BeliefSet index. Holds NO registries, NO RUDA.
struct UBPSStorage {
    ownerAddress: address     // system owner / deployer (admin; not used for rewards)
    unitCode: cell            // U   code — for get_unit_address
    questionCode: cell        // Q   code — activation address calc
    answerCode: cell          // A   code — activation address calc
    beliefSetCode: cell       // BS  code — creation address calc (B = BS + root)
    nextBsIndex: uint64       // monotonic; every BS/B is created at the next index
}

// Unit (U) — the user's representation. MUTABLE: only the single Unit Pointer (up)
// changes. `up` may point at a BS/B, at another Unit (follow), or be null (empty).
// NO on-chain check that `up` is a valid UBPS contract (concept decision #6).
//
// `up` is NEVER part of the address-determining init data: the address derives from
// (ubpsMaster, userAddress) with up=null, so a Unit has the SAME address whether the
// user self-deploys it OR creates it via the master (CreateUnit funnel). The optional
// initial pointer the master may set (InitUnitPointer) is applied AFTER the deterministic
// deploy, so it never shifts the address.
struct UnitStorage {
    ubpsMaster: address
    userAddress: address      // the owning user; only they may move the pointer
    up: address?              // unit pointer: BS/Unit/null. address calc uses up=null.
}

// Question (Q) — IMMUTABLE after activation. Deployed inactive by anyone; only the
// master flips it active (carrying the verified question bytes). Address derives
// from questionId only (active=false, questionBytes=null at deploy).
struct QuestionStorage {
    ubpsMaster: address
    questionId: uint256       // string.hash (sha256 of the question bytes)
    active: bool              // false at deploy; true once the master activates
    questionBytes: cell?      // null at deploy; the ASCII question, set on activation
}

// Answer (A) — IMMUTABLE after activation. Bound to its Question via questionAddress.
// Address derives from (questionAddress, answerId) only.
struct AnswerStorage {
    ubpsMaster: address
    questionAddress: address  // the Question this answer is bound to
    answerId: uint256         // string.hash (sha256 of the answer bytes)
    active: bool
    answerBytes: cell?
}

// BeliefSet (BS) — IMMUTABLE after creation. B is a BS with root=true. Created ONCE
// by the master at the next index with its full content. Address derives from
// bsIndex only (created=false, root=false, empty sets, name=null at deploy).
struct BeliefSetStorage {
    ubpsMaster: address
    bsIndex: uint64
    created: bool             // false at deploy; true once the master populates it
    root: bool                // true => this is a final B (public profile)
    aCount: uint16            // declared count of A addresses (<= MAX_A)
    bsCount: uint16           // declared count of BS addresses (<= MAX_BS)
    aSet: cell                // opaque set/list/tree of A addresses (off-chain shape)
    bsSet: cell               // opaque set/list/tree of BS addresses (recursion)
    name: cell?               // OPTIONAL display name/description (Maybe(^Cell)); non-unique,
                              // immutable, set once at creation; NOT hashed, NOT an id, and
                              // NOT address-determining (null at deploy). Display only.
}

// -----------------------------------------------------------------------------
//  Storage load/save helpers
// -----------------------------------------------------------------------------
fun UBPSStorage.load() { return UBPSStorage.fromCell(contract.getData()) }
fun UBPSStorage.save(self) { contract.setData(self.toCell()) }

fun UnitStorage.load() { return UnitStorage.fromCell(contract.getData()) }
fun UnitStorage.save(self) { contract.setData(self.toCell()) }

fun QuestionStorage.load() { return QuestionStorage.fromCell(contract.getData()) }
fun QuestionStorage.save(self) { contract.setData(self.toCell()) }

fun AnswerStorage.load() { return AnswerStorage.fromCell(contract.getData()) }
fun AnswerStorage.save(self) { contract.setData(self.toCell()) }

fun BeliefSetStorage.load() { return BeliefSetStorage.fromCell(contract.getData()) }
fun BeliefSetStorage.save(self) { contract.setData(self.toCell()) }

// =============================================================================
//  Gas — EXACT-reserve (keep priorBalance + storage tax, forward the rest). Same
//  pattern as the rest of the codebase; never drops below the 0.01 storage tax.
// =============================================================================
fun reserveValue(msgValue: coins, delta: coins = 0) {
    val base = (contract.getOriginalBalance() - msgValue) + BASIC_STORAGE_TAX;
    val reserveAmount = base + delta;
    var finalReserve: coins = reserveAmount;
    if (reserveAmount < BASIC_STORAGE_TAX) {
        finalReserve = BASIC_STORAGE_TAX;
    }
    reserveToncoinsOnBalance(finalReserve, RESERVE_MODE_EXACT_AMOUNT);
}

fun emptyCell(): cell {
    return beginCell().endCell();
}

// =============================================================================
//  Deterministic address calc. Each helper builds the child's INITIAL stateInit
//  (the address-determining data — never the mutable/content fields), so the
//  address is reproducible off-chain from the keys alone:
//    U  : (ubpsMaster, userAddress)
//    Q  : (ubpsMaster, questionId)
//    A  : (ubpsMaster, questionAddress, answerId)
//    BS : (ubpsMaster, bsIndex)
//  The distinct compiled code per child type is the type discriminator.
// =============================================================================
fun calcUnitDeploy(ubpsMaster: address, userAddress: address, unitCode: cell): AutoDeployAddress {
    val initStorage: UnitStorage = {
        ubpsMaster,
        userAddress,
        up: null,
    };
    return { stateInit: { code: unitCode, data: initStorage.toCell() } };
}
fun calcUnitAddress(ubpsMaster: address, userAddress: address, unitCode: cell): address {
    return calcUnitDeploy(ubpsMaster, userAddress, unitCode).calculateAddress();
}

fun calcQuestionDeploy(ubpsMaster: address, questionId: uint256, questionCode: cell): AutoDeployAddress {
    val initStorage: QuestionStorage = {
        ubpsMaster,
        questionId,
        active: false,
        questionBytes: null,
    };
    return { stateInit: { code: questionCode, data: initStorage.toCell() } };
}
fun calcQuestionAddress(ubpsMaster: address, questionId: uint256, questionCode: cell): address {
    return calcQuestionDeploy(ubpsMaster, questionId, questionCode).calculateAddress();
}

fun calcAnswerDeploy(ubpsMaster: address, questionAddress: address, answerId: uint256, answerCode: cell): AutoDeployAddress {
    val initStorage: AnswerStorage = {
        ubpsMaster,
        questionAddress,
        answerId,
        active: false,
        answerBytes: null,
    };
    return { stateInit: { code: answerCode, data: initStorage.toCell() } };
}
fun calcAnswerAddress(ubpsMaster: address, questionAddress: address, answerId: uint256, answerCode: cell): address {
    return calcAnswerDeploy(ubpsMaster, questionAddress, answerId, answerCode).calculateAddress();
}

fun calcBeliefSetDeploy(ubpsMaster: address, bsIndex: uint64, beliefSetCode: cell): AutoDeployAddress {
    val initStorage: BeliefSetStorage = {
        ubpsMaster,
        bsIndex,
        created: false,
        root: false,
        aCount: 0,
        bsCount: 0,
        aSet: emptyCell(),
        bsSet: emptyCell(),
        name: null,           // populated AFTER the deterministic deploy; never address-determining
    };
    return { stateInit: { code: beliefSetCode, data: initStorage.toCell() } };
}
fun calcBeliefSetAddress(ubpsMaster: address, bsIndex: uint64, beliefSetCode: cell): address {
    return calcBeliefSetDeploy(ubpsMaster, bsIndex, beliefSetCode).calculateAddress();
}

// =============================================================================
//  Inbound message bodies — TO the master (from any user / a Unit interface)
// =============================================================================

// Activate a Question: master verifies sha256(questionBytes) == questionId, then
// deploys+activates the deterministic Q. questionBytes MUST be a single byte-aligned
// cell (<= 127 ASCII chars) so SHA256U matches the off-chain sha256.
struct (0x55425001) ActivateQuestion {
    questionId: uint256
    questionBytes: cell
}

// Activate an Answer bound to a Question. Same hash check on answerBytes.
struct (0x55425002) ActivateAnswer {
    questionAddress: address
    answerId: uint256
    answerBytes: cell
}

// Create a BeliefSet (root=false) or a final B (root=true) at the next index.
// `name` is an OPTIONAL display string (Maybe(^Cell)) — non-unique, immutable, not
// hashed, not address-determining. The master forwards it verbatim into PopulateBeliefSet.
struct (0x55425003) CreateBeliefSet {
    root: bool
    aCount: uint16
    bsCount: uint16
    aSet: cell
    bsSet: cell
    name: cell?
}

// Create a Unit THROUGH the master (alternate funnel to a user self-deploy, so the
// master's tx history records the creation for backend discovery). The Unit is deployed
// at its deterministic address (= the self-deploy address; up is NOT in the stateInit)
// with userAddress = the CALLER (in.senderAddress), so a caller can only ever create
// their OWN Unit. `up` is an OPTIONAL initial pointer the master applies post-deploy
// (InitUnitPointer); omit/null to deploy an empty Unit.
struct (0x55425004) CreateUnit {
    up: address?
}

// =============================================================================
//  Inbound message bodies — FROM the master TO a child
// =============================================================================

// master -> Q: deploy-if-needed + activate (carries the verified bytes).
struct (0x55425011) ActivateQuestionMsg {
    questionBytes: cell
}

// master -> A: deploy-if-needed + activate (carries the verified bytes).
struct (0x55425012) ActivateAnswerMsg {
    answerBytes: cell
}

// master -> BS: deploy + populate the set ONCE (immutable thereafter). Carries the
// optional display `name` (Maybe(^Cell)) set at creation alongside the content.
struct (0x55425013) PopulateBeliefSet {
    root: bool
    aCount: uint16
    bsCount: uint16
    aSet: cell
    bsSet: cell
    name: cell?
}

// master -> Unit: apply the optional INITIAL pointer right after a CreateUnit deploy.
// The Unit accepts this ONLY from its master and ONLY while its pointer is still null
// (uninitialized), so it sets the user-requested starting pointer without ever being
// able to override a pointer the user has since set (the user-only-pointer invariant
// holds: only SetPointer, gated to userAddress, moves it thereafter).
struct (0x55425014) InitUnitPointer {
    up: address?
}

// =============================================================================
//  Inbound message bodies — TO a Unit (from its user)
// =============================================================================

// Set/clear the single Unit Pointer. up=null clears it. NO membership check.
struct (0x55425021) SetPointer {
    up: address?
}

// =============================================================================
//  Shared excess / catch-all bodies (opcodes match the rest of the system)
// =============================================================================
struct (0xd53276db) ReturnExcessesBack {
    queryId: uint64
}

struct (0x0a1b2c3d) LiteralyAnything {
    queryId: uint64
}
