// SPDX-License-Identifier: UNLICENSED
import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/ubps/answer.tolk',
    withStackComments: true,
    withSrcLineComments: true,
    experimentalOptions: '',
};
