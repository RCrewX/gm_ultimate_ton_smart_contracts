// SPDX-License-Identifier: UNLICENSED
import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/tep/nft/nft-item-contract.tolk',
    withSrcLineComments: true,
    withStackComments: true,
};
