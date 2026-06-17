// SPDX-License-Identifier: UNLICENSED
/**
 * changeDetection.ts — RPC + compile glue around the PURE classifier
 * (scripts/lib/changeClassifier.ts).
 *
 * It compiles every contract, computes each one's TVM cell hash (`code.hash()`),
 * fetches the live on-chain code hash for the recorded address, and hands the pair
 * to `classifyChanges`. Keeping the diff logic pure (in changeClassifier) lets the
 * unit test exercise the branching with synthetic hashes and no blueprint/RPC.
 *
 * HASH SCHEME (read this): we compare the TVM **cell hash** (`cell.hash()`) on BOTH
 * sides — fresh compile vs the live `getContractState().code`. We do NOT compare
 * against the artifact's `contractCodes.*.hash` field, which is `sha256(toBoc())` (a
 * DIFFERENT scheme — see lib/buildOutput.getContractCodeData). The artifact hash is
 * only a SECONDARY offline signal, surfaced via `pnpm verify:hashes`.
 */
import { Address, Cell } from '@ton/core';
import { TonClient } from '@ton/ton';
import type { CompiledContracts } from './abiCore';
import { compileAllContracts } from './abiCore';
import type { NetworkDeploymentData } from '../../lib/buildOutput';
import {
    classifyChanges,
    ChangeReport,
    TrackedDescriptor,
    ContractRole,
    LeafKind,
} from './changeClassifier';

type RateLimit = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * The contracts retro tracks. Each maps a deployment_latest.json address to the
 * compiled code cell to hash against. ownerJettonWallet is deliberately NOT tracked:
 * its code is the jetton wallet code, and any change there is governed by the minter
 * (jettonInfo) — tracking it as an independent leaf would mis-redeploy a derived contract.
 */
interface DetectEntry {
    key: string;
    role: ContractRole;
    kind?: LeafKind;
    codeOf: (c: CompiledContracts) => Cell;
    addrOf: (net: NetworkDeploymentData) => string | undefined;
}

const DETECT_TABLE: DetectEntry[] = [
    { key: 'gameManager', role: 'gm', codeOf: (c) => c.gameManagerCode, addrOf: (n) => n.gameManager?.bounceable },
    { key: 'retranslator', role: 'rstar', codeOf: (c) => c.retranslatorCode, addrOf: (n) => n.retranslator?.bounceable },
    { key: 'jettonMinter', role: 'leaf', kind: 'jettonMinter', codeOf: (c) => c.jettonMinterCode, addrOf: (n) => n.jettonMinter?.bounceable },
    { key: 'nftPrinter', role: 'leaf', kind: 'nftPrinter', codeOf: (c) => c.nftPrinterCode, addrOf: (n) => n.nftPrinter?.bounceable },
    { key: 'sbtPrinter', role: 'leaf', kind: 'sbtPrinter', codeOf: (c) => c.sbtPrinterCode, addrOf: (n) => n.sbtPrinter?.bounceable },
    { key: 'games.ton_race_game.game', role: 'leaf', kind: 'ton_race_game', codeOf: (c) => c.gameCode, addrOf: (n) => n.games?.ton_race_game?.game?.bounceable },
    { key: 'games.soulless_slot_machine.ssm', role: 'leaf', kind: 'ssm', codeOf: (c) => c.ssmCode, addrOf: (n) => n.games?.soulless_slot_machine?.ssm?.bounceable },
    { key: 'games.ubps.ubps', role: 'leaf', kind: 'ubps', codeOf: (c) => c.ubpsCode, addrOf: (n) => n.games?.ubps?.ubps?.bounceable },
    { key: 'ship_station', role: 'leaf', kind: 'subcontract', codeOf: (c) => c.subcontractCode, addrOf: (n) => n.ship_station?.bounceable },
    { key: 'games.ton_race_game.ownerShip', role: 'leaf', kind: 'ownerShip', codeOf: (c) => c.shipCode, addrOf: (n) => n.games?.ton_race_game?.ownerShip?.bounceable },
];

/** TVM cell hash (hex) of a compiled code cell. */
export function tvmCodeHash(code: Cell): string {
    return code.hash().toString('hex');
}

/**
 * Fetch the live on-chain code's TVM cell hash for an address, or null when the
 * account is missing/inactive or has no code.
 */
export async function fetchOnChainCodeHash(
    client: TonClient,
    withRateLimit: RateLimit,
    addr: Address,
): Promise<string | null> {
    const st = await withRateLimit(() => client.getContractState(addr));
    if (st.state !== 'active' || !st.code) return null;
    return Cell.fromBoc(st.code)[0].hash().toString('hex');
}

/**
 * Build the tracked-contract descriptors (compiled hash + live on-chain hash) and
 * classify them. Reads the chain once per tracked address.
 */
export async function detectChanges(
    client: TonClient,
    withRateLimit: RateLimit,
    netData: NetworkDeploymentData,
    compiled: CompiledContracts,
): Promise<{ report: ChangeReport; descriptors: TrackedDescriptor[] }> {
    const descriptors: TrackedDescriptor[] = [];
    for (const e of DETECT_TABLE) {
        const compiledHash = tvmCodeHash(e.codeOf(compiled));
        const addrStr = e.addrOf(netData);
        let onChainHash: string | null = null;
        if (addrStr) {
            onChainHash = await fetchOnChainCodeHash(client, withRateLimit, Address.parse(addrStr));
        }
        descriptors.push({
            key: e.key,
            role: e.role,
            kind: e.kind,
            oldAddr: addrStr ?? null,
            compiledHash,
            onChainHash,
        });
    }
    return { report: classifyChanges(descriptors), descriptors };
}

/** Convenience for callers that have already compiled. */
export async function detectChangesAuto(
    client: TonClient,
    withRateLimit: RateLimit,
    netData: NetworkDeploymentData,
): Promise<{ report: ChangeReport; descriptors: TrackedDescriptor[]; compiled: CompiledContracts }> {
    const compiled = await compileAllContracts();
    const { report, descriptors } = await detectChanges(client, withRateLimit, netData, compiled);
    return { report, descriptors, compiled };
}
