// SPDX-License-Identifier: UNLICENSED
import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/tep/sbt/sbt-collection-contract.tolk',
    withSrcLineComments: true,
    withStackComments: true,
};
