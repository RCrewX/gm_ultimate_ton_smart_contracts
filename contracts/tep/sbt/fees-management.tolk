// SPDX-License-Identifier: UNLICENSED
// SBT item: min balance to keep before forwarding excess (BASECHAIN from stdlib)
const MIN_TONS_FOR_STORAGE = ton("0.05")

// Send mode 128 = carry all remaining balance (for destroy excesses)
const SEND_MODE_CARRY_ALL_REMAINING_BALANCE: uint8 = 128
