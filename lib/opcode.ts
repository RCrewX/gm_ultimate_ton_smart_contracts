// SPDX-License-Identifier: UNLICENSED
/**
 * Deterministic opcode generation from message names.
 * Uses CRC-32 (IEEE polynomial) as in TON TL-B / Tact / Tolk when struct opcode is omitted.
 * Same input always produces the same 32-bit opcode.
 */

// CRC-32 table (reversed polynomial 0xEDB88320), computed once
const CRC32_TABLE = ((): number[] => {
    const table: number[] = [];
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c >>> 0;
    }
    return table;
})();

/**
 * Compute 32-bit opcode from a message/struct name (deterministic).
 * Uses CRC-32 with IEEE polynomial; result is unsigned 32-bit.
 * Matches TON TL-B / Tact / Tolk convention for struct ( ) MessageName { }.
 *
 * @param messageName - Exact struct/message name (e.g. "RequestMint", "RequestToMove")
 * @returns Opcode as number (0 .. 0xFFFFFFFF)
 */
export function opcodeFromMessageName(messageName: string): number {
    const bytes = Buffer.from(messageName, 'utf8');
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff]! ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
