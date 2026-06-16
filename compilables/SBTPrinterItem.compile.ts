// SPDX-License-Identifier: UNLICENSED
import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/printers/sbt_printer/sbt-printer-item.tolk',
    withSrcLineComments: true,
    withStackComments: true,
};
