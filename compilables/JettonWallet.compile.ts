// SPDX-License-Identifier: UNLICENSED
import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    // lang: 'func',
    // targets: [
    //     'params.fc',
    //     'op-codes.fc',
    //     'jetton-utils.fc',
    //     'jetton-wallet.fc'
    // ],
    lang: 'tolk',
    entrypoint: 'contracts/tep/jetton/jetton-wallet-contract.tolk',
    withSrcLineComments: true,
    withStackComments: true,
};