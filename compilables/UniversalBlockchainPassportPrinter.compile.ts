// SPDX-License-Identifier: UNLICENSED
import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/printers/universal_passport/universal-passport-collection.tolk',
    withSrcLineComments: true,
    withStackComments: true,
};
