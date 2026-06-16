// SPDX-License-Identifier: UNLICENSED
import { Address, beginCell, Cell, contractAddress } from '@ton/core';

/** Opcodes for SBT (TEP-85) */
export const Op = {
    ProveOwnership: 0x04ded148,
    RequestOwner: 0xd0c3bfea,
    Destroy: 0x1f04537a,
    Revoke: 0x6f89f5e3,
    OwnershipProof: 0x0524c7ae,
    OwnerInfo: 0x0dd607e3,
    Excesses: 0xd53276db,
    RequestStaticData: 0x2fcb26a2,
    ResponseStaticData: 0x8b771735,
    DeploySbt: 0x00000001,
    BatchDeploySbt: 0x00000002,
    ChangeCollectionAdmin: 0x00000003,
    AskToChangeOwnership: 0x5fcc3d14,
} as const;

/** SbtItemStorageNotInitialized: itemIndex (uint64), collectionAddress */
export function calcSbtItemAddress(
    itemIndex: bigint,
    collectionAddress: Address,
    sbtItemCode: Cell,
    workchain = 0
): Address {
    const data = beginCell()
        .storeUint(Number(itemIndex), 64)
        .storeAddress(collectionAddress)
        .endCell();
    const init = { code: sbtItemCode, data };
    return contractAddress(workchain, init);
}

/** Build init params cell: owner, content (ref), authority (addr_none = 2 zero bits or full address) */
export function buildSbtItemInitParams(params: {
    ownerAddress: Address;
    content: Cell;
    authority?: Address | null;
}): Cell {
    const b = beginCell()
        .storeAddress(params.ownerAddress)
        .storeRef(params.content);
    if (params.authority != null && params.authority !== undefined) {
        return b.storeAddress(params.authority).endCell();
    }
    return b.storeUint(0, 2).endCell(); // addr_none
}
