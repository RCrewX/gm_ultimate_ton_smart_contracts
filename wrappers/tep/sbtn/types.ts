// SPDX-License-Identifier: UNLICENSED
import { Address, beginCell, Cell, contractAddress } from '@ton/core';

/** Opcodes for SBTN (TEP-6666) — SBT-compatible + SbtnInit */
export const Op = {
    SbtnInit: 0x7e488f18,
    ProveOwnership: 0x04ded148,
    RequestOwner: 0xd0c3bfea,
    Destroy: 0x1f04537a,
    Revoke: 0x6f89f5e3,
    OwnershipProof: 0x0524c7ae,
    OwnerInfo: 0x0dd607e3,
    Excesses: 0xd53276db,
    RequestStaticData: 0x2fcb26a2,
    ResponseStaticData: 0x8b771735,
    DeploySbtn: 0x00000001,
    ChangeCollectionAdmin: 0x00000003,
    RevokeSbtnItem: 0x00000004,
    AskToChangeOwnership: 0x5fcc3d14,
} as const;

/** SBTN item address: StateInit data = SbtnItemStorage (index, collection, owner, active, revokedAt, individualContent) */
export function calcSbtnItemAddress(
    ownerAddress: Address,
    collectionAddress: Address,
    index: bigint | number,
    sbtnItemCode: Cell,
    workchain = 0
): Address {
    const data = beginCell()
        .storeUint(Number(index), 256)
        .storeAddress(collectionAddress)
        .storeAddress(ownerAddress)
        .storeBit(false)
        .storeUint(0, 64)
        .storeRef(beginCell().endCell())
        .endCell();
    const init = { code: sbtnItemCode, data };
    return contractAddress(workchain, init);
}

/** Build sbtn_init body: queryId, individualContent (ref). Authority = collection (not in message). */
export function buildSbtnInitBody(params: {
    queryId?: number | bigint;
    individualContent: Cell;
}): Cell {
    return beginCell()
        .storeUint(Op.SbtnInit, 32)
        .storeUint(Number(params.queryId ?? 0), 64)
        .storeRef(params.individualContent)
        .endCell();
}
