// SPDX-License-Identifier: UNLICENSED
import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/printers/nft_printer/nft-printer-item.tolk',
    withSrcLineComments: true,
    withStackComments: true,
};
