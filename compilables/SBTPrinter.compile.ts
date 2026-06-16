// SPDX-License-Identifier: UNLICENSED
import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/printers/sbt_printer/sbt-printer-collection.tolk',
    withSrcLineComments: true,
    withStackComments: true,
};
