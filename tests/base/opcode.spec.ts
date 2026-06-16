// SPDX-License-Identifier: UNLICENSED
import { opcodeFromMessageName } from '../../lib/opcode';

describe('opcodeFromMessageName', () => {
    it('is deterministic: same name yields same opcode', () => {
        const a = opcodeFromMessageName('RequestMint');
        const b = opcodeFromMessageName('RequestMint');
        expect(a).toBe(b);
    });

    it('different names yield different opcodes', () => {
        const a = opcodeFromMessageName('RequestMint');
        const b = opcodeFromMessageName('RequestToMove');
        expect(a).not.toBe(b);
    });

    it('returns unsigned 32-bit value', () => {
        const op = opcodeFromMessageName('AnyMessage');
        expect(op).toBeGreaterThanOrEqual(0);
        expect(op).toBeLessThanOrEqual(0xffffffff);
        expect(Number.isInteger(op)).toBe(true);
    });

    it('matches CRC-32 (IEEE) for known strings', () => {
        // CRC32("RequestMint") with standard IEEE polynomial
        const requestMint = opcodeFromMessageName('RequestMint');
        expect(requestMint).toBe(0xa5f78b3e);
    });

    it('handles RequestToMint as in CLI example', () => {
        const op = opcodeFromMessageName('RequestToMint');
        expect(op).toBe(0xdb8093d1);
    });
});
