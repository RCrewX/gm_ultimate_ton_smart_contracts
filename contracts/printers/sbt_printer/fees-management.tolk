// SPDX-License-Identifier: UNLICENSED
// SBTPrinter item: min balance to keep before forwarding excess. Mirrors
// tep/sbtn/fees-management.tolk.
const MIN_TONS_FOR_STORAGE = ton("0.05")

const SEND_MODE_CARRY_ALL_REMAINING_BALANCE: uint8 = 128

// addr_none (MsgAddress $00) — used for destroyed owner/authority.
fun addr_none(): address {
    return beginCell().storeUint(0, 2).endCell().beginParse().loadAddress()
}
