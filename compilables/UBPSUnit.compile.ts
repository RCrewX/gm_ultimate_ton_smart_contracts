// SPDX-License-Identifier: UNLICENSED
import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/ubps/unit.tolk',
    withStackComments: true,
    withSrcLineComments: true,
    experimentalOptions: '',
};
