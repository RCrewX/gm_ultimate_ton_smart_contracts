// SPDX-License-Identifier: UNLICENSED
import "storage"

// TEP-85 inbound: prove_ownership#04ded148
struct (0x04ded148) ProveOwnership {
    queryId: uint64
    destination: address
    forwardPayload: cell
    withContent: bool
}

// TEP-85 inbound: request_owner#d0c3bfea
struct (0xd0c3bfea) RequestOwner {
    queryId: uint64
    destination: address
    forwardPayload: cell
    withContent: bool
}

// TEP-85 inbound: destroy#1f04537a
struct (0x1f04537a) Destroy {
    queryId: uint64
}

// TEP-85 inbound: revoke#6f89f5e3
struct (0x6f89f5e3) Revoke {
    queryId: uint64
}

// TEP-85 outbound: ownership_proof#0524c7ae
struct (0x0524c7ae) OwnershipProof {
    queryId: uint64
    itemId: uint256
    owner: address
    data: cell
    revokedAt: uint64
    content: cell?
}

// TEP-85 outbound: owner_info#0dd607e3
struct (0x0dd607e3) OwnerInfo {
    queryId: uint64
    itemId: uint256
    initiator: address
    owner: address
    data: cell
    revokedAt: uint64
    content: cell?
}

// TEP-85 outbound: excesses#d53276db
struct (0xd53276db) Excesses {
    queryId: uint64
}

// Same opcodes as NFT for get_nft_data() compatibility
struct (0x2fcb26a2) RequestStaticData {
    queryId: uint64
}

struct (0x8b771735) ResponseStaticData {
    queryId: uint64
    itemIndex: uint256
    collectionAddress: address
}

// SBT Collection: DeploySbt (mirror DeployNft)
struct (0x00000001) DeploySbt {
    queryId: uint64
    itemIndex: uint64
    attachTonAmount: coins
    initParams: Cell<SbtItemInitAtDeployment>
}

struct (0x00000002) BatchDeploySbt {
    queryId: uint64
    deployList: map<uint64, BatchDeploySbtDictItem>
}

struct BatchDeploySbtDictItem {
    attachTonAmount: coins
    initParams: Cell<SbtItemInitAtDeployment>
}

struct (0x00000003) ChangeCollectionAdmin {
    queryId: uint64
    newAdminAddress: address
}

// TEP-62 opcode: SBT must reject transfer (match and throw)
struct (0x5fcc3d14) AskToChangeOwnership {
    queryId: uint64
    newOwnerAddress: address
    sendExcessesTo: address?
    customPayload: cell?
    forwardTonAmount: coins
    forwardPayload: RemainingBitsAndRefs
}
