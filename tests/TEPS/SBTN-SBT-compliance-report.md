# SBTN SBT Standard Compliance Report

**Date:** 2026-06-03
**Tests:** `tests/TEPS/SBTN-SBT-compat.spec.ts` (SBT/TEP-85 wire compatibility)
and `tests/TEPS/SBTN-specific.spec.ts` (SBTN-specific behavior, TEP-6666)

## Summary

The SBTN contracts **pass all SBT standard (TEP-85) compatibility tests** and the
SBTN-specific security/spec tests. This report reflects the **actual on-chain behavior**
after the SBTN_02 spec-compliance fixes (collection-only `sbtn_init`; `destroy` retains
the storage reserve).

## Compliance Matrix

| Requirement | Status | Notes |
|-------------|--------|-------|
| get_nft_data() | Pass | Returns isInitialized, index, collection, owner, content, authority(=collection), revokedAt. After `destroy`, `isInitialized=false`; the TS wrapper surfaces owner/authority as `null` when not initialized (the on-chain owner field is retained; `get_authority_address` still returns the collection). |
| get_authority_address() | Pass | Always returns the collection address (this impl always has authority = collection). |
| get_revoked_time() | Pass | 0 if not revoked; `now()` after revoke. |
| sbtn_init | Pass | **Collection-only** (`sender == collection_address`, else 960 `ERROR_NOT_FROM_COLLECTION`); rejects re-init of an active item (961). This is the SBTN_02 §3.1 security boundary. |
| prove_ownership | Pass | Owner-only (962); rejects if `!active` (969); sends ownership_proof with item_id(=index), owner. |
| request_owner | Pass | Anyone can request while active; sends owner_info. **After `destroy` it is rejected with 969** (`ERROR_NOT_INITIALIZED`) — no owner_info is emitted. |
| destroy | Pass | Owner-only (962); sets `active=false` (owner field unchanged on-chain); **retains `MIN_TONS_FOR_STORAGE` (0.05 TON)** via an exact-amount reserve, then sends Excesses with the remainder. |
| revoke | Pass | Authority (collection) only (963); sets revoked_at; rejects second revoke (964). |
| transfer rejected | Pass | AskToChangeOwnership → ERROR_SBTN_TRANSFER_FORBIDDEN (967); owner unchanged. |

## Additional / corrected behavior (verified by tests)

- `sbtn_init` from a non-collection sender → rejected with **960**; the item stays inert
  (`active=false`), so content cannot be spoofed by a front-runner.
- `request_owner` after `destroy` → rejected with **969** (active=false), no owner_info.
- `get_nft_data` after `destroy` → `isInitialized=false`; authority getter still returns the
  collection. (The earlier claim of "owner→addr_none / authority null" was a wrapper artifact,
  not on-chain behavior.)
- `destroy` leaves the item account balance **≥ MIN_TONS_FOR_STORAGE (0.05 TON)** — the bare
  mode-128 carry-all drain bug is fixed.
