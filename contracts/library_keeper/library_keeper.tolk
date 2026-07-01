// SPDX-License-Identifier: UNLICENSED
// =============================================================================
// library_keeper.tolk — masterchain PUBLIC-LIBRARY publisher (SETLIBCODE).
//
// WHY THIS EXISTS (verified in the @ton/sandbox emulator):
//   Putting a `library` field in a fresh account's StateInit is REJECTED by the TVM
//   transaction executor — deploying such an account skips compute with
//   `cskip_bad_state` and the account never initializes. A public library must instead
//   be published by a RUNNING masterchain contract via the SETLIBCODE primitive.
//
// This contract's StateInit is a plain {code, data} (NO library field), so it deploys
// normally on workchain -1. Its data holds the real code cell to publish; on its first
// message it calls SETLIBCODE(code, 2) to register that code as a PUBLIC global library
// (mode 2). The account then holds the library and pays its masterchain storage rent.
//
// Deploy it the standard wallet way is not needed — any inbound message (internal or a
// signed-free external) triggers the publish; it is idempotent (publishing the same code
// again is harmless).
// =============================================================================

import "@stdlib/gas-payments"

struct LibraryKeeperStorage {
    // The real (full) code cell to publish as a public library.
    code: cell
    // Set once the library has been published (idempotency guard).
    published: bool
}

fun LibraryKeeperStorage.load() {
    return LibraryKeeperStorage.fromCell(contract.getData())
}

fun LibraryKeeperStorage.save(self) {
    contract.setData(self.toCell())
}

// TVM SETLIBCODE: (code:cell, mode:int) -> (). mode 2 = add as a PUBLIC library.
fun setLibCode(code: cell, mode: int): void
    asm "SETLIBCODE"

fun publishOnce() {
    var storage = lazy LibraryKeeperStorage.load();
    if (!storage.published) {
        setLibCode(storage.code, 2);
        storage.published = true;
        storage.save();
    }
}

fun onInternalMessage(in: InMessage) {
    publishOnce();
}

fun onExternalMessage(inMsg: slice) {
    // Allow an external self-deploy / poke to trigger the publish. The account holds no
    // secrets and only ever (re)publishes a fixed code, so an unauthenticated accept is safe.
    acceptExternalMessage();
    publishOnce();
}
