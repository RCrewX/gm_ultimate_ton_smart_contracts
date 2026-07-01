// SPDX-License-Identifier: UNLICENSED
import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/library_keeper/library_keeper.tolk',
    withStackComments: true,
    withSrcLineComments: true,
    experimentalOptions: '',
};
