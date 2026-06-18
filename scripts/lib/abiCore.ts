// SPDX-License-Identifier: UNLICENSED
/**
 * abiCore.ts — THE single source of truth for the deployment ABI assembly.
 *
 * Both producers build the COMPLETE artifact from here:
 *   - `pnpm deploy`            (live)    — real addresses/deployed/balances
 *   - `pnpm deploy --offline`  (alias: `pnpm abi`) — placeholder addresses, deployed:false, no RPC/keys
 *
 * Because every path calls `buildFullContractCodes()`, no producer can ever emit a
 * PARTIAL `contractCodes` set. This structurally removes the code-only clobber class
 * (a live deploy used to overwrite the offline publish with a code set that omitted
 * the code-only contracts like ssmSlot / *Item). To add a new contract: add it in ONE
 * place here (`compileAllContracts` + `buildFullContractCodes`) and every producer picks it up.
 */
import { Address, Cell } from '@ton/core';
import { compile } from '@ton/blueprint';
import { GameManager } from '../../wrappers/game_manager/GameManager';
import { Retranslator } from '../../wrappers/game_manager/Retranslator';
import { Game } from '../../wrappers/ton_race_game/Game';
import { Ship } from '../../wrappers/ton_race_game/Ship';
import { SoullessSlotMachine } from '../../wrappers/soulless_slot_machine/SoullessSlotMachine';
import { UBPS } from '../../wrappers/ubps/UBPS';
import { JettonMinter, jettonContentToCell } from '../../wrappers/tep/jetton/JettonMinter';
import { JettonWallet } from '../../wrappers/tep/jetton/JettonWallet';
import { Subcontract } from '../../wrappers/subcontract/Subcontract';
import { NFTPrinter } from '../../wrappers/printers/nft_printer/NFTPrinter';
import { UniversalBlockchainPassportPrinter } from '../../wrappers/printers/universal_passport/UniversalBlockchainPassportPrinter';
import {
    NetworkDeploymentData,
    DeploymentData,
    ContractCodes,
    formatAddress,
    getContractCodeData,
} from '../../lib/buildOutput';
import { buildGameConstants } from '../../lib/gameConstants';

// ============================================================================
// Compile — every contract in ONE place (incl. the code-only ones: ssmSlot,
// *Item — the entries a hand-rolled list keeps forgetting).
// ============================================================================

export interface CompiledContracts {
    gameManagerCode: Cell;
    retranslatorCode: Cell;
    gameCode: Cell;
    shipCode: Cell;
    coordinateCellCode: Cell;
    ssmCode: Cell;
    ssmSlotCode: Cell;
    // UBPS module (independent tree): master + 4 child types.
    ubpsCode: Cell;
    ubpsUnitCode: Cell;
    ubpsQuestionCode: Cell;
    ubpsAnswerCode: Cell;
    ubpsBeliefSetCode: Cell;
    jettonWalletCode: Cell;
    jettonMinterCode: Cell;
    subcontractCode: Cell;
    sbtItemCode: Cell;
    sbtCollectionCode: Cell;
    sbtnItemCode: Cell;
    sbtnCollectionCode: Cell;
    nftItemCode: Cell;
    nftPrinterItemCode: Cell;
    passportPrinterItemCode: Cell;
    nftPrinterCode: Cell;
    passportPrinterCode: Cell;
}

export async function compileAllContracts(): Promise<CompiledContracts> {
    // Sequential (tolk-js is compiled per call); the set is small and this runs once.
    return {
        gameManagerCode: await compile('GameManager'),
        retranslatorCode: await compile('Retranslator'),
        gameCode: await compile('Game'),
        shipCode: await compile('Ship'),
        coordinateCellCode: await compile('CoordinateCell'),
        ssmCode: await compile('SoullessSlotMachine'),
        ssmSlotCode: await compile('SSMSlot'),
        ubpsCode: await compile('UBPS'),
        ubpsUnitCode: await compile('UBPSUnit'),
        ubpsQuestionCode: await compile('UBPSQuestion'),
        ubpsAnswerCode: await compile('UBPSAnswer'),
        ubpsBeliefSetCode: await compile('UBPSBeliefSet'),
        jettonWalletCode: await compile('JettonWallet'),
        jettonMinterCode: await compile('JettonMinter'),
        subcontractCode: await compile('Subcontract'),
        sbtItemCode: await compile('SBTItem'),
        sbtCollectionCode: await compile('SBTCollection'),
        sbtnItemCode: await compile('SBTNItem'),
        sbtnCollectionCode: await compile('SBTNCollection'),
        nftItemCode: await compile('NFTItem'),
        nftPrinterItemCode: await compile('NFTPrinterItem'),
        passportPrinterItemCode: await compile('UniversalBlockchainPassport'),
        nftPrinterCode: await compile('NFTPrinter'),
        passportPrinterCode: await compile('UniversalBlockchainPassportPrinter'),
    };
}

// ============================================================================
// Assemble — the COMPLETE contractCodes. This is the only place codes are built,
// so a producer cannot drop a code-only entry.
// ============================================================================

export function buildFullContractCodes(c: CompiledContracts): ContractCodes {
    return {
        gameManager: getContractCodeData(c.gameManagerCode),
        retranslator: getContractCodeData(c.retranslatorCode),
        jettonWallet: getContractCodeData(c.jettonWalletCode),
        jettonMinter: getContractCodeData(c.jettonMinterCode),
        subcontract: getContractCodeData(c.subcontractCode),
        games: {
            ton_race_game: {
                game: getContractCodeData(c.gameCode),
                ship: getContractCodeData(c.shipCode),
                coordinateCell: getContractCodeData(c.coordinateCellCode),
            },
            soulless_slot_machine: {
                soullessSlotMachine: getContractCodeData(c.ssmCode),
                // SSM embeds this code in its storage to deploy ephemeral slots.
                ssmSlot: getContractCodeData(c.ssmSlotCode),
            },
            // UBPS module codes (master + 4 child types). Children deploy on demand;
            // the master embeds the child codes in its storage for address calc.
            ubps: {
                ubps: getContractCodeData(c.ubpsCode),
                unit: getContractCodeData(c.ubpsUnitCode),
                question: getContractCodeData(c.ubpsQuestionCode),
                answer: getContractCodeData(c.ubpsAnswerCode),
                beliefSet: getContractCodeData(c.ubpsBeliefSetCode),
            },
        },
        sbtCollection: getContractCodeData(c.sbtCollectionCode),
        sbtItem: getContractCodeData(c.sbtItemCode),
        sbtnCollection: getContractCodeData(c.sbtnCollectionCode),
        sbtnItem: getContractCodeData(c.sbtnItemCode),
        nftItem: getContractCodeData(c.nftItemCode),
        nftPrinterItem: getContractCodeData(c.nftPrinterItemCode),
        passportPrinterItem: getContractCodeData(c.passportPrinterItemCode),
        nftPrinter: getContractCodeData(c.nftPrinterCode),
        passportPrinter: getContractCodeData(c.passportPrinterCode),
    };
}

/** Non-secret source-of-truth constants (opcodes/errors/gas/enums/storage layout). */
export function buildConstants(): ReturnType<typeof buildGameConstants> {
    return buildGameConstants();
}

// ============================================================================
// Addresses — deterministic, RPC-free. Live deploy uses the real owner/pubkey;
// the offline producer passes placeholders (ownerPublicKey=0 → only ship_station
// is a placeholder; every other address is exact).
// ============================================================================

// v1: NFT royalty -> owner (5%). Tune as needed; off-chain only affects metadata.
const PRINTER_NFT_ROYALTY = { numerator: 5, denominator: 100 };

export function createPrinters(
    ownerAddress: Address,
    gameManagerAddress: Address,
    nftPrinterCode: Cell,
    passportPrinterCode: Cell,
    nftItemCode: Cell,
    passportItemCode: Cell,
) {
    const nftPrinter = NFTPrinter.createFromConfig(
        {
            nftItemCode,
            adminAddress: gameManagerAddress,
            royaltyParams: { ...PRINTER_NFT_ROYALTY, royaltyAddress: ownerAddress },
        },
        nftPrinterCode,
    );
    const passportPrinter = UniversalBlockchainPassportPrinter.createFromConfig(
        { passportItemCode, adminAddress: gameManagerAddress },
        passportPrinterCode,
    );
    return { nftPrinter, passportPrinter };
}

export function calculateNetworkAddresses(
    ownerAddress: Address,
    gameManagerCode: Cell,
    retranslatorCode: Cell,
    gameCode: Cell,
    shipCode: Cell,
    coordinateCellCode: Cell,
    ssmCode: Cell,
    ssmSlotCode: Cell,
    jettonMinterCode: Cell,
    jettonWalletCode: Cell,
    subcontractCode: Cell,
    nftPrinterCode: Cell,
    passportPrinterCode: Cell,
    nftItemCode: Cell,
    sbtnItemCode: Cell,
    isTestnet: boolean,
    shipStationId: bigint,
    ownerPublicKey: bigint,
    jettonContentUri: string,
    ubpsCode: Cell,
    ubpsUnitCode: Cell,
    ubpsQuestionCode: Cell,
    ubpsAnswerCode: Cell,
    ubpsBeliefSetCode: Cell,
): NetworkDeploymentData {
    const gameManager = GameManager.createFromConfig({ ownerAddress }, gameManagerCode);

    const retranslator = Retranslator.createFromConfig({
        gameManagerAddress: gameManager.address,
        ownerAddress,
        active: true,
    }, retranslatorCode);

    const game = Game.createFromConfig({
        managerAddress: gameManager.address,
        shipCode,
        coordinateCellCode,
    }, gameCode);

    const jettonMinter = JettonMinter.createFromConfig({
        admin: gameManager.address,
        content: jettonContentToCell({ type: 1, uri: jettonContentUri }),
        wallet_code: jettonWalletCode,
    }, jettonMinterCode);

    // SSM: GM is owner; the RUDA minter is the native NFT origin.
    const ssm = SoullessSlotMachine.createFromConfig(
        {
            ownerAddress: gameManager.address,
            ssmSlotCode,
            rudaMasterAddress: jettonMinter.address,
        },
        ssmCode,
    );

    const ownerJettonWallet = JettonWallet.createFromConfig({
        ownerAddress,
        minterAddress: jettonMinter.address,
    }, jettonWalletCode);

    const ownerShip = Ship.createFromConfig({
        userAddress: ownerAddress,
        gameAddress: game.address,
        coordinateCellCode,
    }, shipCode);

    const shipStation = Subcontract.createFromConfig({
        ownerAddress,
        id: shipStationId,
        ownerPublicKey,
    }, subcontractCode);

    const { nftPrinter, passportPrinter } = createPrinters(
        ownerAddress, gameManager.address, nftPrinterCode, passportPrinterCode, nftItemCode, sbtnItemCode,
    );

    // UBPS master (independent module). Owner = the deployer wallet (admin only;
    // the master never reward-authorizes). The master embeds the child codes so its
    // address depends on them.
    const ubps = UBPS.createFromConfig(
        {
            ownerAddress,
            unitCode: ubpsUnitCode,
            questionCode: ubpsQuestionCode,
            answerCode: ubpsAnswerCode,
            beliefSetCode: ubpsBeliefSetCode,
        },
        ubpsCode,
    );

    return {
        deployed: false,
        ownerAddress: formatAddress(ownerAddress, isTestnet),
        gameManager: formatAddress(gameManager.address, isTestnet),
        retranslator: formatAddress(retranslator.address, isTestnet),
        nftPrinter: formatAddress(nftPrinter.address, isTestnet),
        passportPrinter: formatAddress(passportPrinter.address, isTestnet),
        jettonMinter: formatAddress(jettonMinter.address, isTestnet),
        ownerJettonWallet: formatAddress(ownerJettonWallet.address, isTestnet),
        ship_station: formatAddress(shipStation.address, isTestnet),
        games: {
            ton_race_game: {
                game: formatAddress(game.address, isTestnet),
                ownerShip: formatAddress(ownerShip.address, isTestnet),
            },
            soulless_slot_machine: {
                ssm: formatAddress(ssm.address, isTestnet),
            },
            ubps: {
                ubps: formatAddress(ubps.address, isTestnet),
            },
        },
    };
}

/**
 * Build the COMPLETE offline DeploymentData (placeholder addresses, deployed:false).
 * No RPC, no keys. Owner address comes from $DEPLOY_OWNER_ADDRESS or the existing json.
 * This is exactly what `pnpm deploy --offline` (alias `pnpm abi`) writes.
 */
export async function buildOfflineDeploymentData(
    ownerAddress: Address,
    shipStationId: bigint = 0n,
    ownerPublicKey: bigint = 0n,
    jettonContentUri: string = process.env.JETTON_CONTENT_URI || 'https://example.com/jetton.json',
): Promise<DeploymentData> {
    const compiled = await compileAllContracts();
    const contractCodes = buildFullContractCodes(compiled);
    const testnet = calculateNetworkAddresses(
        ownerAddress, compiled.gameManagerCode, compiled.retranslatorCode, compiled.gameCode,
        compiled.shipCode, compiled.coordinateCellCode, compiled.ssmCode, compiled.ssmSlotCode,
        compiled.jettonMinterCode, compiled.jettonWalletCode, compiled.subcontractCode,
        compiled.nftPrinterCode, compiled.passportPrinterCode, compiled.nftPrinterItemCode, compiled.passportPrinterItemCode,
        true, shipStationId, ownerPublicKey, jettonContentUri,
        compiled.ubpsCode, compiled.ubpsUnitCode, compiled.ubpsQuestionCode, compiled.ubpsAnswerCode, compiled.ubpsBeliefSetCode,
    );
    const mainnet = calculateNetworkAddresses(
        ownerAddress, compiled.gameManagerCode, compiled.retranslatorCode, compiled.gameCode,
        compiled.shipCode, compiled.coordinateCellCode, compiled.ssmCode, compiled.ssmSlotCode,
        compiled.jettonMinterCode, compiled.jettonWalletCode, compiled.subcontractCode,
        compiled.nftPrinterCode, compiled.passportPrinterCode, compiled.nftPrinterItemCode, compiled.passportPrinterItemCode,
        false, shipStationId, ownerPublicKey, jettonContentUri,
        compiled.ubpsCode, compiled.ubpsUnitCode, compiled.ubpsQuestionCode, compiled.ubpsAnswerCode, compiled.ubpsBeliefSetCode,
    );
    return {
        timestamp: new Date().toISOString(),
        constants: buildConstants(),
        contractCodes,
        testnet: { ...testnet, status: undefined },
        mainnet: { ...mainnet, status: undefined },
    };
}
