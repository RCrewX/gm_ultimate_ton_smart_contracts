// SPDX-License-Identifier: UNLICENSED
import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/tep/nft/nft-collection-contract.tolk',
    withSrcLineComments: true,
    withStackComments: true,
};
