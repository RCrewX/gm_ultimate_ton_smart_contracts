// SPDX-License-Identifier: UNLICENSED
import type { Blockchain } from '@ton/sandbox';
import type { Cell } from '@ton/core';
import type { Transaction } from '@ton/core';

/** No-op: sandbox default config already supports TVM 1.2. Kept for spec compatibility. */
export function activateTVM12(_blockchain: Blockchain): void {}

/** No-op gas logger for NFT spec; use writeGasCosts from lib/buildOutput for real gas tracking. */
export class GasLogAndSave {
    constructor(_folder: string) {}
    rememberBocSize(_name: string, _code: Cell): void {}
    rememberGas(_name: string, _transactions: Transaction[]): void {}
    saveCurrentRunAfterAll(): void {}
}
