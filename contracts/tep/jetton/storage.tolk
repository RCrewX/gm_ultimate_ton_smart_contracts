// SPDX-License-Identifier: UNLICENSED

struct WalletStorage {
    jettonBalance: coins
    ownerAddress: address
    minterAddress: address
}

struct MinterStorage {
    totalSupply: coins
    adminAddress: address
    content: cell
    jettonWalletCode: cell
    displayNumerator: uint256  // TEP-526: numerator for display multiplier (VarUInteger 32 in messages)
    displayDenominator: uint256  // TEP-526: denominator for display multiplier (VarUInteger 32 in messages)
}


fun MinterStorage.load() {
    return MinterStorage.fromCell(contract.getData())
}

fun MinterStorage.save(self) {
    contract.setData(self.toCell())
}


fun WalletStorage.load() {
    return WalletStorage.fromCell(contract.getData())
}

fun WalletStorage.save(self) {
    contract.setData(self.toCell())
}
