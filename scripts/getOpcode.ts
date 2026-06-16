// SPDX-License-Identifier: UNLICENSED
/**
 * CLI script: print opcode for a message name (deterministic, CRC32).
 * Usage: pnpm get_op <MessageName>
 * Example: pnpm get_op RequestMint
 */

import { opcodeFromMessageName } from '../lib/opcode';

function main(): void {
    const args = process.argv.slice(2);
    const name = args[0];

    if (!name || name.startsWith('-')) {
        console.error('Usage: pnpm get_op <MessageName>');
        console.error('Example: pnpm get_op RequestMint');
        process.exit(1);
    }

    const op = opcodeFromMessageName(name);
    const hex = '0x' + op.toString(16).padStart(8, '0');
    console.log(name + ': ' + hex + ' (' + op + ')');
}

main();
