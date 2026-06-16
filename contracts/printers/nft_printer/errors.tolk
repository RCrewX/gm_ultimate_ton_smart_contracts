// SPDX-License-Identifier: UNLICENSED
// NFTPrinter errors — copied verbatim from tep/nft/errors.tolk so the printer
// collection stays byte-compatible with the reused NFTItem code (which uses the
// same error codes). These are the FunC-legacy codes kept for TEP-62 conformance.

const ERROR_NOT_FROM_ADMIN = 401
const ERROR_NOT_FROM_OWNER = 401
const ERROR_NOT_FROM_COLLECTION = 405
const ERROR_BATCH_LIMIT_EXCEEDED = 399
const ERROR_INVALID_ITEM_INDEX = 402
const ERROR_INCORRECT_FORWARD_PAYLOAD = 708
const ERROR_INVALID_WORKCHAIN = 333
const ERROR_TOO_SMALL_REST_AMOUNT = 402

// ⚒ ANVIL — extra item/collection gates (distinct from the legacy TEP-62 codes).
const ERROR_NOT_FROM_PREV = 410        // ANVIL hop/destroy sender is not the real previous item
const ERROR_ANVIL_OWNER_MISMATCH = 411 // the two items are not owned by the same user
