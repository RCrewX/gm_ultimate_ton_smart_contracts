// SPDX-License-Identifier: UNLICENSED
// UniversalBlockchainPassport errors — derived from tep/sbtn/errors.tolk so the item
// stays byte-compatible with the proven (gate-fixed) soulbound item behaviour.
// Range 960-971 (avoids overlap with SBT 950-959).

const ERROR_NOT_FROM_COLLECTION = 960
const ERROR_ALREADY_INITIALIZED = 961
const ERROR_NOT_FROM_OWNER = 962
const ERROR_NOT_AUTHORITY = 963
const ERROR_ALREADY_REVOKED = 964
const ERROR_INVALID_ITEM_INDEX = 965
const ERROR_BATCH_LIMIT_EXCEEDED = 966
const ERROR_SBTN_TRANSFER_FORBIDDEN = 967
const ERROR_NOT_FROM_ADMIN = 968
const ERROR_NOT_INITIALIZED = 969
const ERROR_UNKNOWN_MESSAGE = 970
// passport-specific: an OWNER-field write (SetPassportOwnerContent) targeted an item
// whose id has NO owner-writable field (e.g. a non-core id). System-only by default (§3.4).
const ERROR_FIELD_NOT_OWNER_WRITABLE = 971
