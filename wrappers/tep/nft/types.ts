// SPDX-License-Identifier: UNLICENSED
import { Address, beginCell, Cell, contractAddress } from '@ton/core';

/** Opcodes for NFT collection and item (TEP-62) */
export const Op = {
    DeployNft: 0x00000001,
    BatchDeployNfts: 0x00000002,
    ChangeCollectionAdmin: 0x00000003,
    RequestRoyaltyParams: 0x693d3950,
    ResponseRoyaltyParams: 0xa8cb00ad,
    RequestStaticData: 0x2fcb26a2,
    ResponseStaticData: 0x8b771735,
    NotificationForNewOwner: 0x05138d91,
    ReturnExcessesBack: 0xd53276db,
    AskToChangeOwnership: 0x5fcc3d14,
} as const;

export type RoyaltyParams = {
    numerator: number;
    denominator: number;
    royaltyAddress: Address;
};

export function buildRoyaltyParamsCell(params: RoyaltyParams): Cell {
    return beginCell()
        .storeUint(params.numerator, 16)
        .storeUint(params.denominator, 16)
        .storeAddress(params.royaltyAddress)
        .endCell();
}

/** NftItemStorageNotInitialized: itemIndex (uint64), collectionAddress */
export function calcNftItemAddress(
    itemIndex: bigint,
    collectionAddress: Address,
    nftItemCode: Cell,
    workchain = 0
): Address {
    const data = beginCell()
        .storeUint(Number(itemIndex), 64)
        .storeAddress(collectionAddress)
        .endCell();
    const init = { code: nftItemCode, data };
    return contractAddress(workchain, init);
}
