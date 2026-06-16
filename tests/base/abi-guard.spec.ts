// SPDX-License-Identifier: UNLICENSED
import { readFileSync } from 'fs';
import { join } from 'path';
import { toNano } from '@ton/core';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { Retranslator } from '../../wrappers/game_manager/Retranslator';
import { AnvilErrors } from '../../wrappers/game_manager/RetranslatorTypes';
import { Opcodes as SsmOpcodes } from '../../wrappers/soulless_slot_machine/types';
import { mergeContractCodes, ContractCodes, ContractCodeInfo } from '../../lib/buildOutput';
import { Opcodes as GameOpcodes } from '../../wrappers/ton_race_game/types';

const hex8 = (op: number) => '0x' + (op >>> 0).toString(16).padStart(8, '0');

// =============================================================================
// ABI drift guard: the PUBLISHED deployment_latest.json must match the ON-CHAIN
// values. Catches a stale json after a contract change (the closing-plan
// deliverable for the uap consumer). Reads the json from disk and cross-checks
// the ANVIL caps / type space / multisplav filter against a live Retranslator,
// plus the live-parsed error codes and the SSM burn opcode.
//
// If this fails, run `pnpm abi` to regenerate the json.
// =============================================================================

function loadAbi(): any {
    const p = join(__dirname, '..', '..', 'deployment_info', 'deployment_latest.json');
    return JSON.parse(readFileSync(p, 'utf-8'));
}

describe('ABI guard (deployment_latest.json vs on-chain)', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let R: SandboxContract<Retranslator>;
    let abi: any;

    beforeAll(async () => {
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('abiOwner');
        const code = await compile('Retranslator');
        R = blockchain.openContract(
            Retranslator.createFromConfig({ gameManagerAddress: owner.address, ownerAddress: owner.address }, code),
        );
        await R.sendDeploy(owner.getSender(), toNano('0.5'));
        abi = loadAbi();
    }, 120000);

    it('schema version is current (v5)', () => {
        expect(abi.constants.schemaVersion).toBe(5);
        // `deployed` is deploy-STATE, not ABI schema: it is legitimately `true` after a
        // real testnet deploy and `false` on an offline `pnpm abi` publish. deployment_info/
        // is gitignored (a local artifact), so this guard — which is about ABI/on-chain drift —
        // must only assert the flag is structurally present, not pin a specific deploy state.
        expect(typeof abi.testnet.deployed).toBe('boolean');
    });

    it('published ANVIL tier caps + type space match the on-chain get_anvil_caps', async () => {
        const caps = await R.getAnvilCaps();
        const gc = abi.constants.gameConstants;
        expect(gc.ANVIL_TIER_CAP_TYPE0).toBe(caps.genericCap);
        expect(gc.ANVIL_SAFETY_TIER_CAP).toBe(caps.safetyCap);
        expect(gc.ANVIL_MULTISPLAV_TIER_CAP).toBe(caps.multisplavCap);
        expect(gc.ANVIL_MELT_MAX_TIER).toBe(caps.meltMaxTier);
        expect(gc.ANVIL_TYPE_GENERIC).toBe(caps.typeGeneric);
        expect(gc.ANVIL_TYPE_MULTISPLAV).toBe(caps.typeMultisplav);
        // The type-5 multisplav cap must NOT exceed the general safety ceiling.
        expect(caps.multisplavCap).toBeLessThanOrEqual(caps.safetyCap);
    });

    it('published multisplav filter geometry matches on-chain get_multisplav_params', async () => {
        const p = await R.getMultisplavParams();
        const gc = abi.constants.gameConstants;
        expect(gc.ANVIL_MULTISPLAV_FILTER_BITS).toBe(p.bits);
        expect(gc.ANVIL_MULTISPLAV_FILTER_K).toBe(p.k);
        expect(gc.ANVIL_MULTISPLAV_TIER_CAP).toBe(p.tierCap);
        // storageLayout advertises the `seen` field + filter width to the decoder.
        expect(abi.constants.storageLayout.NFT_CONTENT_SEEN_MAYBE_REF).toBe(1);
        expect(abi.constants.storageLayout.MULTISPLAV_FILTER_BITS).toBe(p.bits);
    });

    it('published retranslator error codes match the source-of-truth values', () => {
        const errs = abi.constants.errors.retranslator;
        // The engine throws exactly these (cross-checked in anvil-caps / multisplav specs).
        expect(errs.ERR_ANVIL_TIER_CAP).toBe(AnvilErrors.TIER_CAP);
        expect(errs.ERR_ANVIL_SAFETY_TIER_CAP).toBe(AnvilErrors.SAFETY_TIER_CAP);
        expect(errs.ERR_ANVIL_MULTISPLAV_TIER_CAP).toBe(AnvilErrors.MULTISPLAV_TIER_CAP);
        expect(errs.ERR_ANVIL_MULTISPLAV_ORIGIN_ALREADY_SEEN).toBe(AnvilErrors.MULTISPLAV_ORIGIN_ALREADY_SEEN);
        expect(errs.ERR_ANVIL_MELT_NON_NATIVE).toBe(AnvilErrors.MELT_NON_NATIVE);
        expect(errs.ERR_ANVIL_TIER_TOO_HIGH).toBe(AnvilErrors.TIER_TOO_HIGH);
        expect(errs.ERR_ANVIL_NOT_PRINTER).toBe(AnvilErrors.NOT_PRINTER);
        expect(errs.ERR_ANVIL_RECIPE_ARITY).toBe(AnvilErrors.RECIPE_ARITY);
    });

    it('published SSM burn opcode matches the wrapper', () => {
        const published = abi.constants.opcodes.soullessSlotMachine.OP_SSM_BURN_STAKE;
        expect(published).toBe('0x' + (SsmOpcodes.OP_SSM_BURN_STAKE >>> 0).toString(16).padStart(8, '0'));
    });

    // --- Native ship session (W5 ShipSession retired in v5) ------------------
    it('the retired shipSession code-only entry is gone from contractCodes + opcodes/errors', () => {
        expect(abi.contractCodes.shipSession).toBeUndefined();
        expect(abi.constants.opcodes.shipSession).toBeUndefined();
        expect(abi.constants.errors.shipSession).toBeUndefined();
        expect(abi.constants.gasCosts.shipSession).toBeUndefined();
    });

    it('published native session opcode (SetSessionKey) matches the wrapper', () => {
        expect(abi.constants.opcodes.tonRaceGame.OP_SET_SESSION_KEY).toBe(hex8(GameOpcodes.OP_SET_SESSION_KEY));
    });

    it('published native session error codes (950..960) are present + live-parsed', () => {
        const errs = abi.constants.errors.tonRaceGame;
        expect(errs.ERR_INVALID_SIGNATURE).toBe(950);
        expect(errs.ERR_BAD_SEQNO).toBe(951);
        expect(errs.ERR_EXPIRED).toBe(952);
        expect(errs.ERR_SESSION_EXPIRED).toBe(953);
        expect(errs.ERR_INVALID_MOVE_MODE).toBe(956);
        expect(errs.ERR_BUDGET_EXHAUSTED).toBe(957);
        expect(errs.ERR_INSUFFICIENT_FLOAT).toBe(958);
        expect(errs.ERR_NO_SESSION).toBe(960);
    });

    it('published native session wire widths match the storageLayout contract', () => {
        const sl = abi.constants.storageLayout;
        expect(sl.SHIP_SESSION_PUBKEY_BITS).toBe(256);
        expect(sl.SHIP_SESSION_SEQNO_BITS).toBe(32);
        expect(sl.SHIP_SESSION_VALID_UNTIL_BITS).toBe(32);
        expect(sl.SHIP_SESSION_MOVES_LEFT_BITS).toBe(16);
        expect(sl.SHIP_SESSION_MOVE_MODE_BITS).toBe(8);
        expect(sl.SHIP_SESSION_SIGNATURE_BITS).toBe(512);
    });
});

// =============================================================================
// Clobber-survival guard: the unified writer must NEVER strip a code-only entry
// (shipSession / ssmSlot / *Item). This is the structural defense behind the
// deploy/abi unification — a live deploy that hands a partial contractCodes set
// can no longer overwrite the complete offline publish.
// =============================================================================
describe('contractCodes clobber defense (mergeContractCodes)', () => {
    const ci = (h: string): ContractCodeInfo => ({ hex: '', hash: h, hashBase64: '' });

    const complete: ContractCodes = {
        gameManager: ci('gm'), retranslator: ci('r'), jettonWallet: ci('jw'), jettonMinter: ci('jm'),
        subcontract: ci('sc'),
        games: {
            ton_race_game: { game: ci('g'), ship: ci('sh'), coordinateCell: ci('cc') },
            soulless_slot_machine: { soullessSlotMachine: ci('ssm'), ssmSlot: ci('slot') },
        },
        sbtCollection: ci('sbtc'), sbtItem: ci('sbti'), sbtnCollection: ci('sbtnc'), sbtnItem: ci('sbtni'),
        nftItem: ci('nfti'), nftPrinterItem: ci('npi'), sbtPrinterItem: ci('spi'),
        nftPrinter: ci('np'), sbtPrinter: ci('sp'),
    };

    // The OLD deploySystem bug shape: a code set that forgot the code-only entries.
    const partial: ContractCodes = {
        gameManager: ci('gm2'), jettonWallet: ci('jw2'), jettonMinter: ci('jm2'), subcontract: ci('sc2'),
        games: {
            ton_race_game: { game: ci('g2'), ship: ci('sh2'), coordinateCell: ci('cc2') },
            soulless_slot_machine: { soullessSlotMachine: ci('ssm2') }, // ssmSlot OMITTED
        },
        sbtCollection: ci('sbtc'), sbtItem: ci('sbti'), sbtnCollection: ci('sbtnc'), sbtnItem: ci('sbtni'),
        nftItem: ci('nfti'), nftPrinterItem: ci('npi'), sbtPrinterItem: ci('spi'),
        nftPrinter: ci('np'), sbtPrinter: ci('sp'),
    };

    it('a partial write cannot strip the code-only ssmSlot entry (footgun closed)', () => {
        const merged = mergeContractCodes(complete, partial)!;
        // code-only entries absent from `incoming` SURVIVE from the existing set:
        expect(merged.games.soulless_slot_machine.ssmSlot?.hash).toBe('slot');
        // incoming values still win where present:
        expect(merged.gameManager.hash).toBe('gm2');
        expect(merged.games.ton_race_game.ship.hash).toBe('sh2');
    });

    it('undefined incoming preserves the full set unchanged', () => {
        expect(mergeContractCodes(complete, undefined)).toBe(complete);
    });
});
