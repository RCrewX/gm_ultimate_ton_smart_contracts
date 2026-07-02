// SPDX-License-Identifier: UNLICENSED
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { compile } from '@ton/blueprint';
import { SoullessSlotMachine } from '../../wrappers/soulless_slot_machine/SoullessSlotMachine';
import { SSMSlot } from '../../wrappers/soulless_slot_machine/SSMSlot';
import { Opcodes, SSM_REELS } from '../../wrappers/soulless_slot_machine/types';

// =============================================================================
// Lightweight SSM harness. The SSM "owner" is a GM stand-in treasury, so we can
// drive the native JettonUsed intake exactly as GM would (sender == owner) and
// assert the reward ENVELOPE SSM emits. The downstream R1 -> GM -> R* -> mint is
// proven by tests/printers/printers-e2e and the ton_race_game specs.
// =============================================================================

export type SsmLight = {
    blockchain: Blockchain;
    gm: SandboxContract<TreasuryContract>;        // GM stand-in (SSM owner)
    player: SandboxContract<TreasuryContract>;
    rudaMaster: SandboxContract<TreasuryContract>; // native NFT origin
    ssm: SandboxContract<SoullessSlotMachine>;
    ssmCode: Cell;
    slotCode: Cell;
    checkerCode: Cell;
};

export async function setupSsmLight(): Promise<SsmLight> {
    const blockchain = await Blockchain.create();
    const gm = await blockchain.treasury('gm');
    const player = await blockchain.treasury('player');
    const rudaMaster = await blockchain.treasury('rudaMaster');

    const ssmCode = await compile('SoullessSlotMachine');
    const slotCode = await compile('SSMSlot');
    const checkerCode = await compile('SSMChecker');

    const ssm = blockchain.openContract(
        SoullessSlotMachine.createFromConfig(
            { ownerAddress: gm.address, ssmSlotCode: slotCode, rudaMasterAddress: rudaMaster.address, ssmCheckerCode: checkerCode },
            ssmCode,
        ),
    );
    await ssm.sendDeploy(gm.getSender(), toNano('0.5'));

    return { blockchain, gm, player, rudaMaster, ssm, ssmCode, slotCode, checkerCode };
}

// Set a deterministic TVM random seed for the next message run.
export function setSeed(blockchain: Blockchain, seedByte: number) {
    blockchain.random = Buffer.alloc(32, seedByte & 0xff);
}

// Find the RollResult (lastSlot -> SSM) and return its packed symbols, or null.
export function readRollSymbols(messageResult: any, ssmAddress: Address): number | null {
    for (const tx of messageResult.transactions) {
        if (tx.inMessage?.info.type !== 'internal') continue;
        if (!tx.inMessage?.info.dest?.equals(ssmAddress)) continue;
        try {
            const s = tx.inMessage.body.beginParse();
            if (s.loadUint(32) !== Opcodes.OP_ROLL_RESULT) continue;
            s.loadRef(); // ctx
            return s.loadUint(8);
        } catch {
            /* not a RollResult */
        }
    }
    return null;
}

// Count how many distinct slot contracts got deployed this roll (expect SSM_REELS).
export function countSlotDeploys(messageResult: any, slotAddrs: Address[]): number {
    let n = 0;
    for (const addr of slotAddrs) {
        const deployed = messageResult.transactions.some(
            (tx: any) =>
                tx.inMessage?.info.type === 'internal' &&
                tx.inMessage?.info.dest?.equals(addr),
        );
        if (deployed) n++;
    }
    return n;
}

// The R1 envelope SSM emits to its owner (GM stand-in): returns the inner
// request {op, ...} parsed, or null if no R1 was emitted.
export type EmittedRequest =
    | { op: 'mintNft'; receiver: Address; origin: Address; type: bigint; tier: bigint }
    | { op: 'forwardMint'; receiver: Address; amount: bigint };

export function findEmittedRequest(messageResult: any, ownerAddress: Address): EmittedRequest | null {
    for (const tx of messageResult.transactions) {
        if (tx.inMessage?.info.type !== 'internal') continue;
        if (!tx.inMessage?.info.dest?.equals(ownerAddress)) continue;
        try {
            const s = tx.inMessage.body.beginParse();
            if (s.loadUint(32) !== Opcodes.OP_R1) continue;
            const inner = s.loadRef().beginParse();
            const op = inner.loadUint(32);
            if (op === Opcodes.OP_MINT_NFT) {
                const receiver = inner.loadAddress();
                const content = inner.loadRef().beginParse();
                const origin = content.loadAddress();
                const type = content.loadUintBig(64);
                const tier = content.loadUintBig(64);
                return { op: 'mintNft', receiver, origin, type, tier };
            }
            if (op === Opcodes.OP_FORWARD_MINT_REQUEST) {
                const receiver = inner.loadAddress();
                const amount = inner.loadCoins();
                return { op: 'forwardMint', receiver, amount };
            }
        } catch {
            /* not our R1 */
        }
    }
    return null;
}

// Did SSM send an AskToTransfer (escrow return) to `escrowWallet`?
export function findEscrowReturn(messageResult: any, escrowWallet: Address): { amount: bigint; recipient: Address } | null {
    for (const tx of messageResult.transactions) {
        if (tx.inMessage?.info.type !== 'internal') continue;
        if (!tx.inMessage?.info.dest?.equals(escrowWallet)) continue;
        try {
            const s = tx.inMessage.body.beginParse();
            if (s.loadUint(32) !== Opcodes.OP_ASK_TO_TRANSFER) continue;
            s.loadUint(64); // queryId
            const amount = s.loadCoins();
            const recipient = s.loadAddress();
            return { amount, recipient };
        } catch {
            /* not AskToTransfer */
        }
    }
    return null;
}

// Did SSM send cashback (ReturnExcessesBack) to `player`?
export function hasCashback(messageResult: any, player: Address): boolean {
    return messageResult.transactions.some((tx: any) => {
        if (tx.inMessage?.info.type !== 'internal') return false;
        if (!tx.inMessage?.info.dest?.equals(player)) return false;
        try {
            return tx.inMessage.body.beginParse().loadUint(32) === Opcodes.OP_RETURN_EXCESSES_BACK;
        } catch {
            return false;
        }
    });
}

// Did SSM emit the native-stake burn R1{SsmBurnStake} to its owner (GM stand-in)?
// Returns the burn amount, or null. (findEmittedRequest ignores this opcode, so the
// reward-routing assertions are unaffected by the burn.)
export function findBurnRequest(messageResult: any, ownerAddress: Address): { amount: bigint } | null {
    for (const tx of messageResult.transactions) {
        if (tx.inMessage?.info.type !== 'internal') continue;
        if (!tx.inMessage?.info.dest?.equals(ownerAddress)) continue;
        try {
            const s = tx.inMessage.body.beginParse();
            if (s.loadUint(32) !== Opcodes.OP_R1) continue;
            const inner = s.loadRef().beginParse();
            if (inner.loadUint(32) !== Opcodes.OP_SSM_BURN_STAKE) continue;
            inner.loadUint(64); // queryId
            return { amount: inner.loadCoins() };
        } catch {
            /* not our burn R1 */
        }
    }
    return null;
}

export { SSM_REELS };
