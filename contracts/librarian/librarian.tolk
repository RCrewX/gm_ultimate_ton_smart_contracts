// SPDX-License-Identifier: UNLICENSED
// =============================================================================
// librarian.tolk — masterchain PUBLIC-LIBRARY publisher (SETLIBCODE), production.
//
// WHY THIS EXISTS (verified deterministically in the @ton/sandbox emulator):
//   Putting a `library` field in a fresh account's StateInit is REJECTED by the TVM
//   transaction executor — deploying such an account skips compute with
//   `cskip_bad_state` and the account never initializes. A public library must instead
//   be published by a RUNNING masterchain contract via the SETLIBCODE primitive.
//
// This contract's StateInit is a plain {code, data} (NO `library` field), so it deploys
// normally on workchain -1. Its data holds the real code cell to publish; on its first
// (deploy) message it calls SETLIBCODE(code, 2) to register that code as a PUBLIC global
// library (mode 2). The account then holds the library and pays its masterchain storage
// rent, so it MUST stay funded (below the rent floor the library is dropped and every
// referencing contract freezes).
//
// PRODUCTION HARDENING over the `library_keeper` draft (which this supersedes):
//   - admin-gated ops (Withdraw / RePublish / RemoveLib / SetAdmin) — sender must be admin;
//   - NO open external entrypoint (the draft's unauthenticated `onExternalMessage` accept
//     let a griefer burn gas per poke → drain the balance → rent lapse → library dropped);
//   - Withdraw reserves a rent floor and returns only the surplus to the admin, so the
//     funds are ALWAYS RECOVERABLE (the draft's WalletV4 keeper stranded ~7.14 TON);
//   - one librarian instance publishes ONE code (deterministic per-code wc-1 address).
//
// Mirrors the SETLIBCODE mode/flow of the canonical `ton-blockchain/stablecoin-contract`
// `LibraryDeployer` (mode 2 = add as a PUBLIC library).
// =============================================================================

import "@stdlib/gas-payments"

// Storage tax floor (matches the other contracts' BASIC_STORAGE_TAX).
const BASIC_STORAGE_TAX = ton("0.01");

// Masterchain library-storage rent floor the account always keeps back so the published
// library never lapses. Masterchain storage is ~1000x basechain; sized generously for
// testnet and recalibrated from the live storage phase + acceptance run. Keep in sync
// with LIBRARIAN_FUNDING in scripts/lib/librarian.ts.
const LIBRARIAN_RENT_FLOOR = ton("1.0");

const ERR_NOT_ADMIN = 401;
const ERR_BELOW_FLOOR = 402;

struct LibrarianStorage {
    // May withdraw funds / re-publish / remove / rotate admin. Set at genesis = deployer.
    adminAddress: address
    // The real (full) code cell to publish as a public library. Kept in data so the
    // address depends on the code (one deterministic wc-1 address per code) AND so the
    // library can be RE-published if masterchain rent ever lapses.
    code: cell
    // Set once the library has been published (idempotency guard).
    published: bool
}

fun LibrarianStorage.load() {
    return LibrarianStorage.fromCell(contract.getData());
}

fun LibrarianStorage.save(self) {
    contract.setData(self.toCell());
}

// TVM SETLIBCODE: (code:cell, mode:int) -> (). An OUTPUT ACTION (like SENDRAWMSG) applied
// in the action phase. mode 2 = add as a PUBLIC (globally-resolvable) library; mode 0 = remove.
fun setLibCode(code: cell, mode: int): void
    asm "SETLIBCODE"

// --- Admin ops (opcode-tagged bodies; all gated on sender == adminAddress) ---
struct (0x00000010) LibrarianWithdraw { queryId: uint64 }
struct (0x00000011) LibrarianRePublish { queryId: uint64 }
struct (0x00000012) LibrarianRemoveLib { queryId: uint64 }
struct (0x00000013) LibrarianSetAdmin { queryId: uint64; newAdmin: address }

type AllowedMessage =
    | LibrarianWithdraw
    | LibrarianRePublish
    | LibrarianRemoveLib
    | LibrarianSetAdmin

fun onInternalMessage(in: InMessage) {
    // Genesis / idempotent publish: an empty-body message (the deploy message) triggers
    // the one-time public-library publish. Harmless to repeat (guarded by `published`);
    // the incoming value is RETAINED on the balance to fund masterchain library rent.
    if (in.body.isEmpty()) {
        var storage = lazy LibrarianStorage.load();
        if (!storage.published) {
            setLibCode(storage.code, 2);
            storage.published = true;
            storage.save();
        }
        return;
    }

    // Any non-empty body must be a known, admin-authenticated op. An unknown opcode makes
    // `fromSlice` throw → the tx fails and bounces; it can NOT drain the balance.
    val msg = lazy AllowedMessage.fromSlice(in.body);

    match (msg) {
        LibrarianWithdraw => {
            var storage = lazy LibrarianStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERR_NOT_ADMIN;
            // Keep the rent floor on the account; return everything above it to the admin.
            // Reject if the balance is at/under the floor (nothing safely withdrawable) so
            // a withdraw can never breach the floor and drop the library.
            val balance = contract.getOriginalBalance();
            assert (balance > LIBRARIAN_RENT_FLOOR + BASIC_STORAGE_TAX) throw ERR_BELOW_FLOOR;
            reserveToncoinsOnBalance(LIBRARIAN_RENT_FLOOR, RESERVE_MODE_EXACT_AMOUNT);
            val out = createMessage({
                bounce: BounceMode.NoBounce,
                dest: storage.adminAddress,
                value: 0,
            });
            // Carry the whole remaining balance (after the reserve) to the admin.
            out.send(SEND_MODE_CARRY_ALL_BALANCE + SEND_MODE_IGNORE_ERRORS);
        }

        LibrarianRePublish => {
            var storage = lazy LibrarianStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERR_NOT_ADMIN;
            // Recover after a rent-lapse drop: re-add the code as a public library.
            setLibCode(storage.code, 2);
            if (!storage.published) {
                storage.published = true;
                storage.save();
            }
        }

        LibrarianRemoveLib => {
            var storage = lazy LibrarianStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERR_NOT_ADMIN;
            // Unpublish (mode 0 = remove). Clear `published` so a later empty-body / RePublish
            // can re-add it; then the admin may fully withdraw.
            setLibCode(storage.code, 0);
            storage.published = false;
            storage.save();
        }

        LibrarianSetAdmin => {
            var storage = lazy LibrarianStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERR_NOT_ADMIN;
            storage.adminAddress = msg.newAdmin;
            storage.save();
        }
    }
}

// A bounced message (e.g. a withdraw the admin could not accept) must not abort — just
// keep the funds. No state to roll back.
fun onBouncedMessage(in: InMessageBounced) {
}

// --- Get-methods (interface for tests, wrappers, and ops monitoring) ---

get fun get_published(): bool {
    val storage = lazy LibrarianStorage.load();
    return storage.published;
}

get fun get_admin(): address {
    val storage = lazy LibrarianStorage.load();
    return storage.adminAddress;
}

get fun get_code_hash(): int {
    val storage = lazy LibrarianStorage.load();
    return storage.code.hash();
}
