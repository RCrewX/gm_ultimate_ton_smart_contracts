// SPDX-License-Identifier: UNLICENSED
import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode, toNano } from '@ton/core';
import {
    encodeSetJettonInfo,
    encodeSetGamesInfo,
    encodeSetAllowBurn,
    encodeSetToolsInfo,
    encodeJettonInfo,
    encodeGamesInfo,
    encodeToolsInfo,
    GamesInfo,
    JettonInfo,
    ToolsInfo,
    AnvilGetInput,
    anvilGetArgs,
} from './RetranslatorTypes';

// =============================================================================
// Retranslator (R*) — the swappable brain. Holds the registries and logic; only
// GM may drive it. Storage (retranslator.tolk RetranslatorStorage):
//   gameManagerAddress, ownerAddress, version, active, allow_burn,
//   jettonInfo?, gamesInfo?, toolsInfo?
// =============================================================================

export type RetranslatorConfig = {
    gameManagerAddress: Address;
    ownerAddress: Address;
    version?: bigint;
    active?: boolean;
    allow_burn?: boolean;
    jettonInfo?: Cell | null; // Cell<JettonInfo>
    gamesInfo?: Cell | null; // Cell<GamesInfo>
    toolsInfo?: Cell | null; // Cell<ToolsInfo>
    nextNftIndex?: bigint | number; // R*-tracked printer mint counter (NFT)
    nextSbtIndex?: bigint | number; // R*-tracked printer mint counter (SBT)
};

export function retranslatorConfigToCell(config: RetranslatorConfig): Cell {
    return beginCell()
        .storeAddress(config.gameManagerAddress)
        .storeAddress(config.ownerAddress)
        .storeUint(config.version ?? 1n, 64)
        .storeBit(config.active ?? true)
        .storeBit(config.allow_burn ?? false)
        .storeMaybeRef(config.jettonInfo ?? null)
        .storeMaybeRef(config.gamesInfo ?? null)
        .storeMaybeRef(config.toolsInfo ?? null)
        .storeUint(config.nextNftIndex ?? 0, 64)
        .storeUint(config.nextSbtIndex ?? 0, 256)
        .endCell();
}

export class Retranslator implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Retranslator(address);
    }

    static createFromConfig(config: RetranslatorConfig, code: Cell, workchain = 0) {
        const data = retranslatorConfigToCell(config);
        const init = { code, data };
        return new Retranslator(contractAddress(workchain, init), init);
    }

    // ------------------------------------------------------------------
    // Config message builders. These are GameManager-gated on-chain, so in
    // practice they are relayed through GameManager.sendRedirectMessage.
    // ------------------------------------------------------------------
    static setJettonInfoMessage(info: JettonInfo): Cell {
        return encodeSetJettonInfo({ jettonInfo: encodeJettonInfo(info) });
    }
    static setGamesInfoMessage(info: GamesInfo): Cell {
        return encodeSetGamesInfo({ gamesInfo: encodeGamesInfo(info) });
    }
    static setAllowBurnMessage(allow_burn: boolean): Cell {
        return encodeSetAllowBurn({ allow_burn });
    }
    static setToolsInfoMessage(info: ToolsInfo): Cell {
        return encodeSetToolsInfo({ toolsInfo: encodeToolsInfo(info) });
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    // ------------------------------------------------------------------
    // Get methods
    // ------------------------------------------------------------------
    async getVersion(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('get_version', []);
        return result.stack.readBigNumber();
    }

    async getActive(provider: ContractProvider): Promise<boolean> {
        const result = await provider.get('get_active', []);
        return result.stack.readBoolean();
    }

    async getGameManager(provider: ContractProvider): Promise<Address> {
        const result = await provider.get('get_game_manager', []);
        return result.stack.readAddress();
    }

    async getOwner(provider: ContractProvider): Promise<Address> {
        const result = await provider.get('get_owner', []);
        return result.stack.readAddress();
    }

    async getAllowBurn(provider: ContractProvider): Promise<boolean> {
        const result = await provider.get('get_allow_burn', []);
        return result.stack.readBoolean();
    }

    async getJettonInfo(provider: ContractProvider): Promise<JettonInfo | null> {
        const result = await provider.get('get_jetton_info', []);
        const cell = result.stack.readCellOpt();
        if (!cell) return null;
        const s = cell.beginParse();
        return { jettonMinterAddress: s.loadAddress(), jettonWalletCode: s.loadRef() };
    }

    async getGamesInfo(provider: ContractProvider): Promise<GamesInfo | null> {
        const result = await provider.get('get_games_info', []);
        const cell = result.stack.readCellOpt();
        if (!cell) return null;
        const s = cell.beginParse();
        const active_game = s.loadAddress();
        const ssm = s.loadMaybeAddress();
        const ton_race_game = s.loadMaybeAddress();
        const extra = s.loadRef().beginParse();
        const ubps = extra.loadMaybeAddress();
        return { active_game, ssm, ton_race_game, ubps };
    }

    async getToolsInfo(provider: ContractProvider): Promise<Cell | null> {
        const result = await provider.get('get_tools_info', []);
        return result.stack.readCellOpt();
    }

    // Raw opaque registry cells — for a hot-swap migration that copies the
    // registries verbatim onto a new R* (see scripts/swapRetranslator.ts).
    async getJettonInfoCell(provider: ContractProvider): Promise<Cell | null> {
        const result = await provider.get('get_jetton_info', []);
        return result.stack.readCellOpt();
    }

    async getGamesInfoCell(provider: ContractProvider): Promise<Cell | null> {
        const result = await provider.get('get_games_info', []);
        return result.stack.readCellOpt();
    }

    async getNextNftIndex(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('get_next_nft_index', []);
        return result.stack.readBigNumber();
    }

    async getNextSbtIndex(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('get_next_sbt_index', []);
        return result.stack.readBigNumber();
    }

    // ⚒ ANVIL pure recipe engine (success path). Rejections throw the VM exit
    // code; tests assert those via blockchain.getContract(addr).get(...).
    async getAnvilOutcome(
        provider: ContractProvider,
        input: AnvilGetInput,
    ): Promise<{ kind: number; newOrigin: Address; newType: bigint; newTier: bigint; rudaAmount: bigint }> {
        const result = await provider.get('get_anvil_outcome', anvilGetArgs(input) as any);
        return {
            kind: result.stack.readNumber(),
            newOrigin: result.stack.readAddress(),
            newType: result.stack.readBigNumber(),
            newTier: result.stack.readBigNumber(),
            rudaAmount: result.stack.readBigNumber(),
        };
    }

    // ⚒ Multisplav Bloom filter — pure, side-effect-free getters (for unit tests).
    async getMultisplavParams(
        provider: ContractProvider,
    ): Promise<{ bits: number; k: number; tierCap: number }> {
        const result = await provider.get('get_multisplav_params', []);
        return {
            bits: result.stack.readNumber(),
            k: result.stack.readNumber(),
            tierCap: result.stack.readNumber(),
        };
    }

    async getMultisplavEmptyFilter(provider: ContractProvider): Promise<Cell> {
        const result = await provider.get('get_multisplav_empty_filter', []);
        return result.stack.readCell();
    }

    async getMultisplavProbablySeen(
        provider: ContractProvider,
        filter: Cell,
        addr: Address,
    ): Promise<boolean> {
        const result = await provider.get('get_multisplav_probably_seen', [
            { type: 'cell', cell: filter },
            { type: 'slice', cell: beginCell().storeAddress(addr).endCell() },
        ]);
        return result.stack.readBoolean();
    }

    async getMultisplavAddOrigin(
        provider: ContractProvider,
        filter: Cell,
        addr: Address,
    ): Promise<Cell> {
        const result = await provider.get('get_multisplav_add_origin', [
            { type: 'cell', cell: filter },
            { type: 'slice', cell: beginCell().storeAddress(addr).endCell() },
        ]);
        return result.stack.readCell();
    }

    // ⚒ ANVIL tier caps + type-space constants (for the ABI guard spec).
    async getAnvilCaps(provider: ContractProvider): Promise<{
        genericCap: number;
        safetyCap: number;
        multisplavCap: number;
        meltMaxTier: number;
        typeGeneric: number;
        typeMultisplav: number;
    }> {
        const result = await provider.get('get_anvil_caps', []);
        return {
            genericCap: result.stack.readNumber(),
            safetyCap: result.stack.readNumber(),
            multisplavCap: result.stack.readNumber(),
            meltMaxTier: result.stack.readNumber(),
            typeGeneric: result.stack.readNumber(),
            typeMultisplav: result.stack.readNumber(),
        };
    }
}
