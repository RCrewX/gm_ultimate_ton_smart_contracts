// SPDX-License-Identifier: UNLICENSED
// =============================================================================
// ssm_slot_static.tolk — SSMSlot errors + message surface. Storage, the shared
// roll protocol (RollStep/RollResult/RollContext), reserveValue, and the slot
// address calc all live in ssm_common.tolk (imported here and by the SSM).
// =============================================================================

import "ssm_common"

// Errors — SSMSlot's own range (1300..1309), distinct from SSM (940..959), GM
// (900..935) and the printers (960s) so codes never collide across contracts.
const ERR_SLOT_INVALID_SENDER = 1300; // RollStep not from SSM (reel 0) or the previous slot
