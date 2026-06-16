// SPDX-License-Identifier: UNLICENSED
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { ContractSystem, initContractSystem } from '../test_utils';
import { Retranslator } from '../../wrappers/game_manager/Retranslator';
import { NFTPrinter } from '../../wrappers/printers/nft_printer/NFTPrinter';
import { NFTItem } from '../../wrappers/tep/nft/NFTItem';
import { encodeNftContent, decodeNftContent } from '../../wrappers/game_manager/RetranslatorTypes';

// =============================================================================
// Shared harness for the ANVIL integration specs: full GM/R*/NFTPrinter pipe,
// a user that owns the items, and helpers to mint items with chosen attributes
// and to drive / inspect the recipe flows.
// =============================================================================

export type AnvilSystem = ContractSystem & {
    nftPrinter: SandboxContract<NFTPrinter>;
    nftItemCode: Cell;
    user: SandboxContract<TreasuryContract>;
    nativeMaster: Address; // "N" — the RUDA jetton master (== jettonMinter.address)
};

export async function setupAnvil(): Promise<AnvilSystem> {
    const base = await initContractSystem();

    const nftItemCode = await compile('NFTPrinterItem');
    const nftCollectionCode = await compile('NFTPrinter');

    const nftPrinter = base.blockchain.openContract(
        NFTPrinter.createFromConfig(
            {
                nftItemCode,
                adminAddress: base.gameManager.address,
                royaltyParams: { numerator: 5, denominator: 100, royaltyAddress: base.ownerAccount.address },
            },
            nftCollectionCode,
        ),
    );
    await nftPrinter.sendDeploy(base.ownerAccount.getSender(), toNano('0.5'));

    // Register the NFT printer in R*.toolsInfo (via GM RedirectMessage -> SetToolsInfo).
    await base.gameManager.sendRedirectMessage(
        base.ownerAccount.getSender(),
        toNano('0.3'),
        base.retranslator.address,
        Retranslator.setToolsInfoMessage({
            feeNumerator: 0,
            feeDenominator: 1,
            feeCollector: null,
            nftPrinterAddress: nftPrinter.address,
            sbtPrinterAddress: null,
            extra: null,
        }),
        toNano('0.2'),
    );

    const user = await base.blockchain.treasury('anvilUser');

    return Object.assign(base, {
        nftPrinter,
        nftItemCode,
        user,
        nativeMaster: base.jettonMinter.address,
    });
}

// Mint one NFT item with chosen {origin, type, tier} to `owner`. Initiator is the
// owner account (allowed by R*'s recipe gate). Returns the new item index+address.
export async function mintItem(
    S: AnvilSystem,
    owner: Address,
    content: { origin: Address; type: number | bigint; tier: number | bigint },
): Promise<{ index: number; address: Address }> {
    const index = Number(await S.retranslator.getNextNftIndex());
    await S.gameManager.sendMintNft(
        S.ownerAccount.getSender(),
        toNano('1'),
        owner,
        encodeNftContent(content),
    );
    const address = await S.nftPrinter.getNftAddressByIndex(index);
    return { index, address };
}

// Body for AnvilInit (user -> item1). Matches messages.tolk AnvilInit.
export function anvilInitBody(recipe: number, hasSecond: boolean, item2Index: number, queryId = 0): Cell {
    return beginCell()
        .storeUint(0x416e7601, 32)
        .storeUint(queryId, 64)
        .storeUint(recipe, 8)
        .storeBit(hasSecond)
        .storeUint(item2Index, 64)
        .endCell();
}

// Read an item's structured content {origin, type, tier}.
export async function itemContent(S: AnvilSystem, address: Address) {
    const item = S.blockchain.openContract(NFTItem.createFromAddress(address));
    const data = await item.getNftData();
    return decodeNftContent(data.individualContent!);
}

// Is the item account still alive (not destroyed)?
export async function itemAlive(S: AnvilSystem, address: Address): Promise<boolean> {
    const c = await S.blockchain.getContract(address);
    return c.accountState !== undefined && c.accountState.type === 'active';
}

// Did the user receive a cashback transfer this run?
export function gotCashback(messageResult: any, user: Address): boolean {
    return messageResult.transactions.some(
        (tx: any) => tx.inMessage?.info.type === 'internal' && tx.inMessage?.info.dest?.equals(user),
    );
}
